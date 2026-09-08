/**
 * kernel-handlers — KERNEL_TOPICS 的内核服务实现表（worker→kernel RPC 网关的落点）。
 *
 * 由 Kernel 在 boot 期以 `createKernelHandlers({ kernel })` 装配，并经
 * ExtensionManager.deps.bridgeHandlers 透传给桥（bridge 按 `handlers[topic]` 分派）。
 * 每个 handler 收到 `(payload, from)`：`from` 为发起方端点（'ext:<id>' 或裸扩展 id——
 * 桥已去前缀；worker 自身的诊断日志以 'kernel' 发出）。
 *
 * 权限边界：
 * - `from === 'kernel'` 仅放行 `log`（worker 诊断通道）；其余 topic 一律
 *   RPC_PERMISSION_DENIED（内核自身不走 worker→kernel 通道）；
 * - `config.get` 的 path 命中敏感键（/token|secret|password|apikey/i）→ FORBIDDEN；
 * - `db.*` 每扩展独立 knex（openSqlite(<dataDir>/db/ext/<id>.sqlite)，Map 缓存）+
 *   forbidDangerousSql 双保险（沙箱侧已预检，内核侧复核）；
 * - `task.progress/complete/fail` 校验任务归属（tasks.get(id).extId === extId）；
 * - `host.call`（跨扩展 RPC，topic 与内核→worker 的 HOST_METHODS.callService 同名复用，
 *   靠信封方向区分）：经 ExtensionServiceRegistry.resolveCaller 做权限与目标解析；
 *   扩展侧 `method` 采用 `<service>.<method>` 线格式（如 'parse.run'），映射到注册中心
 *   全名 `ext.<targetExtId>.<service>`；
 * - `auth.*`（hashPassword/verifyPassword/registerProvider/unregisterProvider）：调用方
 *   manifest 必须声明 'auth:provider' 权限（缺 → FORBIDDEN）；register/unregister 经
 *   deps.auth 注入的回调落到 AuthProviderRegistry（provider 名 = 扩展 id）；
 *   密码哈希走内核 scrypt（ext-auth-support），支持缺 deps.auth 的裸装配（register → NOT_IMPLEMENTED）；
 * - `llm.chat`（阶段 10 接管）：容器 'llm' 网关非流式调用（payload 即 LlmChatInput；
 *   payload.stream===true → NOT_IMPLEMENTED——扩展流式走 REST SSE）；容器无 llm 服务时
 *   保持 NOT_IMPLEMENTED。`sandbox.exec`（阶段 11 接管）：调用方 manifest 必须声明
 *   'sandbox' 权限（缺 → FORBIDDEN）；容器无 SandboxManager（裸装配）→ NOT_IMPLEMENTED；
 *   manager 未启用（未配 Docker/配置禁用）透传 SANDBOX_DISABLED。workspaceId 缺省
 *   'ext-<extId>'（扩展的持久工作区家目录语义），不存在时懒创建后执行。
 *
 * 服务一律**懒解析**容器（createKernelHandlers 在 boot 早期执行，核心服务随后才登记；
 * 参照 providers/core-services.ts 的 resolve 模式，但推迟到首调用）。
 */
import * as os from 'node:os';

import type { Knex } from 'knex';
import { z } from 'zod';

import { HOST_METHODS, KERNEL_TOPICS } from '../../extension-host/protocol.js';
import { createPasswordSupport } from '../auth/ext-auth-support.js';
import { ChatService } from '../chat/service.js';
import { configGet } from '../config/index.js';
import { CONTAINER_KEYS, type Kernel } from '../Kernel.js';
import { FACADE_CONTAINER_KEYS } from '../Facades.js';
import { err } from '../errors/index.js';
import { FileService } from '../files/index.js';
import type { LlmGateway } from '../llm/gateway.js';
import { NotificationManager, type NotificationSendInput } from '../notification/index.js';
import type { SandboxManager } from '../sandbox/manager.js';
import { TaskManager } from '../tasks/index.js';
import { Counters } from '../system/info.js';
import { CronScheduler } from '../cron/scheduler.js';
import { extDbPath, forbidDangerousSql, openSqlite } from '../storage/db.js';
import type { ExtensionManager } from './manager.js';
import type { ExtensionServiceRegistry } from './registry.js';
import type { UiRegistry } from './ui-registry.js';

/** 内核版本（与 api/system.ts、openapi 文档保持一致的单一值；v1 无独立 constants 模块） */
const KERNEL_VERSION = '0.1.0';

/** 内核服务处理器表（bridge.deps.handlers 的形状） */
export type KernelBridgeHandlers = Record<string, (payload: unknown, from: string) => Promise<unknown>>;

/** 端点 → 裸扩展 id；'kernel' 返回 null（worker 自身诊断通道） */
function extIdFrom(from: string): string | null {
  if (from === 'kernel') return null;
  return from.startsWith('ext:') ? from.slice('ext:'.length) : from;
}

/** 非日志 topic 的调用方闸：必须是扩展端点 */
function requireExtId(from: string, topic: string): string {
  const extId = extIdFrom(from);
  if (extId === null || extId === '') {
    throw err('RPC_PERMISSION_DENIED', {
      message: `kernel service "${topic}" is only callable by extension endpoints (got "${from}")`,
      detail: { topic, from },
    });
  }
  return extId;
}

/** payload 收窄为对象（非对象视为空负载） */
function asRecord(payload: unknown): Record<string, unknown> {
  return payload !== null && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}

/** 读取字符串字段（类型不符回退 ''） */
function strField(record: Record<string, unknown>, key: string): string {
  const v = record[key];
  return typeof v === 'string' ? v : '';
}

/** task.fail 等入口的 error 参数序列化（string/Error/对象/其他统一为文本） */
function errorTextOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value !== null && typeof value === 'object') {
    const message = (value as { message?: unknown }).message;
    if (typeof message === 'string' && message !== '') return message;
    try {
      return JSON.stringify(value) ?? String(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

/** knex better-sqlite3 raw 的 SELECT 结果 → 行数组（非数组结果按空处理） */
function rowsOf(result: unknown): Record<string, unknown>[] {
  if (!Array.isArray(result)) return [];
  return result.filter(
    (row): row is Record<string, unknown> => row !== null && typeof row === 'object',
  );
}

/** knex better-sqlite3 raw 的写语句结果 → { changes }（SELECT 结果按行数计） */
function changesOf(result: unknown): number {
  if (Array.isArray(result)) return result.length;
  if (result !== null && typeof result === 'object') {
    const changes = (result as { changes?: unknown }).changes;
    if (typeof changes === 'number' && Number.isFinite(changes)) return changes;
  }
  return 0;
}

/** 敏感配置键：path 命中即拒绝（密钥/令牌永不下发给扩展） */
const SENSITIVE_CONFIG_KEY = /token|secret|password|apikey/i;

// ---------------------------------------------------------------- auth.*（auth 内置扩展支撑）

/** auth.* 内核服务的统一权限名（manifest.permissions 必须声明） */
const AUTH_PROVIDER_PERMISSION = 'auth:provider';

/** sandbox.exec 的统一权限名（manifest.permissions 必须声明） */
const SANDBOX_PERMISSION = 'sandbox';

/** 内核 scrypt 密码支撑（模块级单例：参数基线一致，实例无状态） */
const passwords = createPasswordSupport();

/** auth.hashPassword 的线格式 payload */
const authHashPayloadSchema = z.object({ password: z.string() });
/** auth.verifyPassword 的线格式 payload */
const authVerifyPayloadSchema = z.object({ password: z.string(), hash: z.string() });

/**
 * llm.chat 的线格式 payload（与 REST /api/v1/llm/chat 的 body 同形状；
 * stream 字段刻意不在扩展线格式内——扩展流式不支持，见 llm.chat handler）。
 */
const llmChatPayloadSchema = z.object({
  model: z.string().min(1).max(256),
  messages: z
    .array(z.object({ role: z.enum(['system', 'user', 'assistant', 'tool']), content: z.unknown() }))
    .min(1)
    .max(256),
  maxTokens: z.number().int().min(1).max(1_000_000).optional(),
  temperature: z.number().min(0).max(2).optional(),
  topP: z.number().min(0).max(1).optional(),
  stop: z.array(z.string().min(1)).min(1).max(8).optional(),
  tools: z.array(z.unknown()).max(128).optional(),
  providerParams: z.record(z.string(), z.unknown()).optional(),
});

/**
 * 线上 params → knex raw 绑定：RPC 线格式只携带 JSON 值（string/number/boolean/null/
 * 数组/对象），驱动侧按结构传值；unknown → knex 绑定类型的收窄集中在此一处。
 */
function bindingsOf(record: Record<string, unknown>): Knex.RawBinding[] {
  const params = Array.isArray(record['params']) ? record['params'] : [];
  return params as Knex.RawBinding[];
}

/**
 * sandbox.exec 的线格式 payload（workspaceId 缺省 'ext-<extId>'——扩展的持久工作区家目录；
 * workspaceId 形态与 SandboxManager 家目录名约束一致，防目录穿越）。
 */
const sandboxExecPayloadSchema = z.object({
  cmd: z.array(z.string()).min(1).max(128),
  workspaceId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/).optional(),
  timeoutMs: z.number().int().min(1).max(600_000).optional(),
  isolated: z.boolean().optional(),
  workdir: z.string().min(1).max(1024).optional(),
  env: z.record(z.string(), z.string()).optional(),
});

/** cron.schedule 的 overlap 线格式 → 调度器枚举（沙箱 v1 传 boolean，true 视为 'queue'） */
function normalizeOverlap(raw: unknown): 'skip' | 'queue' | undefined {
  if (raw === true) return 'queue';
  if (raw === 'skip' || raw === 'queue') return raw;
  return undefined;
}

/** cron.schedule 的 misfire 线格式 → 调度器枚举 */
function normalizeMisfire(raw: unknown): 'skip' | 'runOnce' | undefined {
  if (raw === 'skip' || raw === 'runOnce') return raw;
  return undefined;
}

/** auth provider 注册/注销回调的形状（由集成接线层注入，落 AuthProviderRegistry） */
export interface AuthProviderRegistration {
  /** 把 extId 注册为 AuthProvider（provider 名 = extId；verify 经 host.authVerify 派发回扩展） */
  registerProvider(extId: string): void;
  /** 注销 extId 的 AuthProvider（未注册名幂等静默） */
  unregisterProvider(extId: string): void;
}

/**
 * 装配 KERNEL_TOPICS 的内核服务实现表（见模块头注释）。
 *
 * @param deps.kernel 内核实例（配置/logger/容器/DI 键的单一来源）
 * @param deps.auth auth provider 注册回调（可选；缺省时 auth.registerProvider → NOT_IMPLEMENTED，
 *   由集成接线层注入以打通 AuthProviderRegistry）
 * @returns 交给 ExtensionManager.deps.bridgeHandlers 的处理器表
 */
export function createKernelHandlers(deps: {
  kernel: Kernel;
  auth?: AuthProviderRegistration;
}): KernelBridgeHandlers {
  const { kernel } = deps;
  /** 每扩展专属 knex 连接缓存（进程生命周期内复用；v1 不做 LRU 关闭） */
  const extDbs = new Map<string, Knex>();

  // ---- 懒解析容器服务（boot 早期登记未完成，首次调用时才 resolve）----

  const kernelDb = (): Knex => kernel.container.resolve<Knex>(CONTAINER_KEYS.db);
  const notifyManager = (): NotificationManager => kernel.container.resolve<NotificationManager>(CONTAINER_KEYS.notify);
  const chatService = (): ChatService => kernel.container.resolve<ChatService>(CONTAINER_KEYS.chat);
  const fileService = (): FileService => kernel.container.resolve<FileService>(CONTAINER_KEYS.files);
  const taskManager = (): TaskManager => kernel.container.resolve<TaskManager>(CONTAINER_KEYS.tasks);
  const cronScheduler = (): CronScheduler =>
    kernel.container.resolve<CronScheduler>(FACADE_CONTAINER_KEYS.cronScheduler);
  const uiRegistry = (): UiRegistry => kernel.container.resolve<UiRegistry>(CONTAINER_KEYS.uiRegistry);
  const counters = (): Counters => kernel.container.resolve<Counters>(CONTAINER_KEYS.counters);
  const extManager = (): ExtensionManager => kernel.container.resolve<ExtensionManager>(CONTAINER_KEYS.extManager);
  const extSvcRegistry = (): ExtensionServiceRegistry =>
    kernel.container.resolve<ExtensionServiceRegistry>(CONTAINER_KEYS.extRegistrySvc);
  /** LLM 网关（容器未登记时返回 undefined，调用方保持 NOT_IMPLEMENTED 兼容） */
  const llmGateway = (): LlmGateway | undefined =>
    kernel.container.has(CONTAINER_KEYS.llm)
      ? kernel.container.resolve<LlmGateway>(CONTAINER_KEYS.llm)
      : undefined;
  /** 沙箱管理器（容器未登记——裸装配 kernel-handlers 时——返回 undefined，保持 NOT_IMPLEMENTED 兼容） */
  const sandboxManager = (): SandboxManager | undefined =>
    kernel.container.has(CONTAINER_KEYS.sandbox)
      ? kernel.container.resolve<SandboxManager>(CONTAINER_KEYS.sandbox)
      : undefined;

  /** 每扩展专属库（懒打开 + 缓存）；extId 非法由 extDbPath fail-fast */
  const extDatabase = async (extId: string): Promise<Knex> => {
    const cached = extDbs.get(extId);
    if (cached !== undefined) return cached;
    const opened = await openSqlite(extDbPath(kernel.config, extId));
    extDbs.set(extId, opened);
    return opened;
  };

  /**
   * auth.* 权限闸：调用方扩展 manifest 必须声明 'auth:provider'
   * （权限来源与 host.call 一致：extManager().getManifest(extId)?.permissions）。
   */
  const requireAuthProviderPermission = (extId: string, topic: string): void => {
    const permissions = extManager().getManifest(extId)?.permissions ?? [];
    if (!permissions.includes(AUTH_PROVIDER_PERMISSION)) {
      throw err('FORBIDDEN', {
        message: `kernel service "${topic}" requires the "${AUTH_PROVIDER_PERMISSION}" permission in the extension manifest (add it to manifest.permissions)`,
        detail: { topic, extId, requiredPermission: AUTH_PROVIDER_PERMISSION },
      });
    }
  };

  /** sandbox.exec 权限闸：调用方扩展 manifest 必须声明 'sandbox'（同 auth:provider 模式） */
  const requireSandboxPermission = (extId: string, topic: string): void => {
    const permissions = extManager().getManifest(extId)?.permissions ?? [];
    if (!permissions.includes(SANDBOX_PERMISSION)) {
      throw err('FORBIDDEN', {
        message: `kernel service "${topic}" requires the "${SANDBOX_PERMISSION}" permission in the extension manifest (add it to manifest.permissions)`,
        detail: { topic, extId, requiredPermission: SANDBOX_PERMISSION },
      });
    }
  };

  /** 扩展私有 KV：行 → 反序列化值（损坏/缺失一律 null） */
  const kvGet = async (extId: string, key: string): Promise<unknown> => {
    const row = await kernelDb()('ext_kv')
      .where({ ext_id: extId, key })
      .first('value');
    const raw = (row as { value?: unknown } | undefined)?.value;
    if (typeof raw !== 'string') return null;
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return null; // 损坏值置 null：不向扩展抛存储层内部错误
    }
  };

  const handlers: KernelBridgeHandlers = {
    // ---------------------------------------------------------------- 日志
    [KERNEL_TOPICS.log]: async (payload, from) => {
      // 'kernel' 端点放行：worker 自身诊断日志（logWorkerError）以 kernel 身份发出
      const scope = extIdFrom(from) === null ? 'kernel' : `ext:${extIdFrom(from)}`;
      const record = asRecord(payload);
      const rawLevel = strField(record, 'level');
      const level =
        rawLevel === 'warn' || rawLevel === 'error' || rawLevel === 'debug' ? rawLevel : 'info';
      const msg =
        strField(record, 'msg') !== ''
          ? strField(record, 'msg')
          : payload === undefined || payload === null
            ? ''
            : String(payload);
      kernel.logger[level]({ scope }, msg);
      return { ok: true };
    },

    // ---------------------------------------------------------------- storage（扩展私有 KV）
    [KERNEL_TOPICS.storageGet]: async (payload, from) => {
      const extId = requireExtId(from, KERNEL_TOPICS.storageGet);
      const key = strField(asRecord(payload), 'key');
      if (key === '') throw err('BAD_REQUEST', { message: 'storage.get requires a non-empty "key"' });
      return await kvGet(extId, key);
    },

    [KERNEL_TOPICS.storageSet]: async (payload, from) => {
      const extId = requireExtId(from, KERNEL_TOPICS.storageSet);
      const record = asRecord(payload);
      const key = strField(record, 'key');
      if (key === '') throw err('BAD_REQUEST', { message: 'storage.set requires a non-empty "key"' });
      const value = JSON.stringify(record['value'] ?? null);
      const table = kernelDb()('ext_kv');
      const updated = await table.where({ ext_id: extId, key }).update({ value, updated_at: Date.now() });
      if (updated === 0) {
        await table.insert({ ext_id: extId, key, value, updated_at: Date.now() });
      }
      return { ok: true };
    },

    [KERNEL_TOPICS.storageDelete]: async (payload, from) => {
      const extId = requireExtId(from, KERNEL_TOPICS.storageDelete);
      const key = strField(asRecord(payload), 'key');
      if (key === '') throw err('BAD_REQUEST', { message: 'storage.delete requires a non-empty "key"' });
      const removed = await kernelDb()('ext_kv').where({ ext_id: extId, key }).del();
      return { ok: true, removed };
    },

    // ---------------------------------------------------------------- config（敏感键拒绝）
    [KERNEL_TOPICS.configGet]: async (payload, from) => {
      requireExtId(from, KERNEL_TOPICS.configGet);
      const record = asRecord(payload);
      const path = strField(record, 'path');
      if (path === '') throw err('BAD_REQUEST', { message: 'config.get requires a non-empty "path"' });
      if (SENSITIVE_CONFIG_KEY.test(path)) {
        throw err('FORBIDDEN', {
          message: `config.get: "${path}" matches a sensitive key pattern (token/secret/password/apiKey); ` +
            'secrets never leave the kernel. Store extension secrets in the secrets store instead.',
          detail: { path },
        });
      }
      return configGet(kernel.config, path, record['fallback']);
    },

    // ---------------------------------------------------------------- db（每扩展独立库）
    [KERNEL_TOPICS.dbAll]: async (payload, from) => {
      const extId = requireExtId(from, KERNEL_TOPICS.dbAll);
      const record = asRecord(payload);
      const sql = strField(record, 'sql');
      if (sql === '') throw err('BAD_REQUEST', { message: 'db.all requires a non-empty "sql"' });
      forbidDangerousSql(sql);
      const db = await extDatabase(extId);
      return rowsOf(await db.raw(sql, bindingsOf(record)));
    },

    [KERNEL_TOPICS.dbGet]: async (payload, from) => {
      const extId = requireExtId(from, KERNEL_TOPICS.dbGet);
      const record = asRecord(payload);
      const sql = strField(record, 'sql');
      if (sql === '') throw err('BAD_REQUEST', { message: 'db.get requires a non-empty "sql"' });
      forbidDangerousSql(sql);
      const db = await extDatabase(extId);
      return rowsOf(await db.raw(sql, bindingsOf(record)))[0] ?? null;
    },

    [KERNEL_TOPICS.dbRun]: async (payload, from) => {
      const extId = requireExtId(from, KERNEL_TOPICS.dbRun);
      const record = asRecord(payload);
      const sql = strField(record, 'sql');
      if (sql === '') throw err('BAD_REQUEST', { message: 'db.run requires a non-empty "sql"' });
      forbidDangerousSql(sql);
      const db = await extDatabase(extId);
      const result = await db.raw(sql, bindingsOf(record));
      const lastInsertRowid =
        result !== null && typeof result === 'object' && !Array.isArray(result)
          ? (result as { lastInsertRowid?: unknown }).lastInsertRowid
          : undefined;
      return {
        changes: changesOf(result),
        ...(typeof lastInsertRowid === 'number' ? { lastInsertRowid } : {}),
      };
    },

    [KERNEL_TOPICS.dbSchema]: async (payload, from) => {
      const extId = requireExtId(from, KERNEL_TOPICS.dbSchema);
      const statements = asRecord(payload)['statements'];
      if (!Array.isArray(statements) || statements.some((s) => typeof s !== 'string')) {
        throw err('BAD_REQUEST', { message: 'db.schema requires "statements": string[]' });
      }
      const db = await extDatabase(extId);
      for (const statement of statements as string[]) {
        forbidDangerousSql(statement);
        await db.raw(statement);
      }
      return { ok: true, executed: statements.length };
    },

    // ---------------------------------------------------------------- notify / chat
    [KERNEL_TOPICS.notifySend]: async (payload, from) => {
      requireExtId(from, KERNEL_TOPICS.notifySend);
      const record = asRecord(payload);
      // 通知标题为必填单行摘要；其余字段按 NotificationSendInput 形状透传（manager 内部 zod 复核）
      return await notifyManager().send({
        title: strField(record, 'title'),
        ...(typeof record['body'] === 'string' ? { body: record['body'] } : {}),
        ...(record['level'] !== undefined ? { level: record['level'] as NotificationSendInput['level'] } : {}),
        ...(record['data'] !== undefined ? { data: record['data'] } : {}),
      });
    },

    [KERNEL_TOPICS.chatSend]: async (payload, from) => {
      const extId = requireExtId(from, KERNEL_TOPICS.chatSend);
      const record = asRecord(payload);
      const channelId = strField(record, 'channelId');
      const slug = strField(record, 'slug');
      if (channelId === '' && slug === '') {
        throw err('BAD_REQUEST', { message: 'chat.send requires "channelId" or "slug"' });
      }
      return await chatService().sendMessage({
        ...(channelId !== '' ? { channelId } : {}),
        ...(slug !== '' ? { slug } : {}),
        senderType: 'ext',
        senderId: extId,
        content: record['content'] ?? null,
        ...(record['attachments'] !== undefined ? { attachments: record['attachments'] } : {}),
      });
    },

    [KERNEL_TOPICS.chatPatch]: async (payload, from) => {
      requireExtId(from, KERNEL_TOPICS.chatPatch);
      const record = asRecord(payload);
      const id = strField(record, 'id');
      if (id === '') throw err('BAD_REQUEST', { message: 'chat.patch requires a non-empty "id"' });
      return await chatService().patchMessage(id, record['content']);
    },

    // ---------------------------------------------------------------- files
    [KERNEL_TOPICS.filesSave]: async (payload, from) => {
      const extId = requireExtId(from, KERNEL_TOPICS.filesSave);
      const record = asRecord(payload);
      const origName = strField(record, 'origName');
      const data = strField(record, 'data');
      if (origName === '' || data === '') {
        throw err('BAD_REQUEST', { message: 'files.save requires "origName" and base64 "data"' });
      }
      const mime = strField(record, 'mime');
      const visibility = record['visibility'] === 'public' ? 'public' : 'private';
      return await fileService().store({
        origName,
        data: Buffer.from(data, 'base64'),
        ...(mime !== '' ? { mime } : {}),
        visibility,
        extId,
      });
    },

    [KERNEL_TOPICS.filesRead]: async (payload, from) => {
      requireExtId(from, KERNEL_TOPICS.filesRead);
      const id = strField(asRecord(payload), 'id');
      if (id === '') throw err('BAD_REQUEST', { message: 'files.read requires a non-empty "id"' });
      const { data } = await fileService().read(id, { allowPrivate: true });
      return data.toString('base64');
    },

    [KERNEL_TOPICS.filesGet]: async (payload, from) => {
      requireExtId(from, KERNEL_TOPICS.filesGet);
      const id = strField(asRecord(payload), 'id');
      if (id === '') throw err('BAD_REQUEST', { message: 'files.get requires a non-empty "id"' });
      return await fileService().get(id);
    },

    // ---------------------------------------------------------------- tasks
    [KERNEL_TOPICS.tasksDispatch]: async (payload, from) => {
      const extId = requireExtId(from, KERNEL_TOPICS.tasksDispatch);
      const record = asRecord(payload);
      const name = strField(record, 'name');
      if (name === '') throw err('BAD_REQUEST', { message: 'tasks.dispatch requires a non-empty "name"' });
      return await taskManager().dispatch({ extId, name, args: record['args'] });
    },

    [KERNEL_TOPICS.taskProgress]: async (payload, from) => {
      const extId = requireExtId(from, KERNEL_TOPICS.taskProgress);
      const record = asRecord(payload);
      const taskId = strField(record, 'taskId');
      await requireOwnedTask(taskId, extId);
      const pct = typeof record['pct'] === 'number' ? record['pct'] : 0;
      const msg = strField(record, 'msg');
      taskManager().onProgress(taskId, pct, msg !== '' ? msg : undefined);
      return { ok: true };
    },

    [KERNEL_TOPICS.taskComplete]: async (payload, from) => {
      const extId = requireExtId(from, KERNEL_TOPICS.taskComplete);
      const record = asRecord(payload);
      const taskId = strField(record, 'taskId');
      await requireOwnedTask(taskId, extId);
      taskManager().onDone(taskId, record['result'] ?? null);
      return { ok: true };
    },

    [KERNEL_TOPICS.taskFail]: async (payload, from) => {
      const extId = requireExtId(from, KERNEL_TOPICS.taskFail);
      const record = asRecord(payload);
      const taskId = strField(record, 'taskId');
      await requireOwnedTask(taskId, extId);
      taskManager().onFailed(taskId, errorTextOf(record['error']));
      return { ok: true };
    },

    // ---------------------------------------------------------------- cron
    [KERNEL_TOPICS.cronSchedule]: async (payload, from) => {
      const extId = requireExtId(from, KERNEL_TOPICS.cronSchedule);
      const record = asRecord(payload);
      const name = strField(record, 'name');
      const expr = strField(record, 'expr');
      if (name === '' || expr === '') {
        throw err('BAD_REQUEST', { message: 'cron.schedule requires non-empty "name" and "expr"' });
      }
      // 内部名加 extId 前缀保证跨扩展唯一；应答给 worker 的 record 保持原名
      const stored = await cronScheduler().schedule({
        extId,
        name: `${extId}:${name}`,
        expr,
        ...(typeof record['tz'] === 'string' && record['tz'] !== '' ? { tz: record['tz'] } : {}),
        ...(record['payload'] !== undefined ? { payload: record['payload'] } : {}),
        ...(normalizeOverlap(record['overlap']) !== undefined ? { overlap: normalizeOverlap(record['overlap']) } : {}),
        ...(normalizeMisfire(record['misfire']) !== undefined ? { misfire: normalizeMisfire(record['misfire']) } : {}),
      });
      return { ...stored, name };
    },

    [KERNEL_TOPICS.cronUnschedule]: async (payload, from) => {
      const extId = requireExtId(from, KERNEL_TOPICS.cronUnschedule);
      const name = strField(asRecord(payload), 'name');
      if (name === '') throw err('BAD_REQUEST', { message: 'cron.unschedule requires a non-empty "name"' });
      const internalName = `${extId}:${name}`;
      const job = cronScheduler()
        .list({ extId })
        .find((entry) => entry.name === internalName);
      if (job === undefined) {
        throw err('EXT_NOT_FOUND', {
          message: `cron.unschedule: job "${name}" is not scheduled for extension "${extId}"`,
          detail: { extId, name },
        });
      }
      const removed = await cronScheduler().unschedule(job.id);
      return { ok: removed, removed };
    },

    // ---------------------------------------------------------------- ui
    [KERNEL_TOPICS.uiRegister]: async (payload, from) => {
      const extId = requireExtId(from, KERNEL_TOPICS.uiRegister);
      uiRegistry().register(extId, asRecord(payload) as Parameters<UiRegistry['register']>[1]);
      return { ok: true };
    },

    // ---------------------------------------------------------------- 跨扩展 RPC（host.call）
    [HOST_METHODS.callService]: async (payload, from) => {
      const extId = requireExtId(from, HOST_METHODS.callService);
      const record = asRecord(payload);
      const targetExtId = strField(record, 'targetExtId');
      const method = strField(record, 'method');
      if (targetExtId === '' || method === '') {
        throw err('BAD_REQUEST', { message: 'h.call requires payload { targetExtId, method, args }' });
      }
      // 线格式 '<service>.<method>' → 注册中心全名 'ext.<targetExtId>.<service>'
      const dot = method.indexOf('.');
      if (dot <= 0 || dot === method.length - 1) {
        throw err('BAD_REQUEST', {
          message: `h.call: method must look like "<service>.<method>" (e.g. "parse.run"), got "${method}"`,
          detail: { targetExtId, method },
        });
      }
      const service = method.slice(0, dot);
      const methodName = method.slice(dot + 1);
      const permissions = extManager().getManifest(extId)?.permissions ?? [];
      const resolve = extSvcRegistry().resolveCaller(extId, permissions);
      return await resolve(`ext.${targetExtId}.${service}`, methodName, record['args']);
    },

    // ---------------------------------------------------------------- auth（内置扩展支撑，需 'auth:provider'）
    [KERNEL_TOPICS.authHashPassword]: async (payload, from) => {
      const extId = requireExtId(from, KERNEL_TOPICS.authHashPassword);
      requireAuthProviderPermission(extId, KERNEL_TOPICS.authHashPassword);
      const parsed = authHashPayloadSchema.safeParse(payload);
      if (!parsed.success) {
        throw err('BAD_REQUEST', { message: 'auth.hashPassword requires payload { password: string }' });
      }
      return { hash: await passwords.hash(parsed.data.password) };
    },

    [KERNEL_TOPICS.authVerifyPassword]: async (payload, from) => {
      const extId = requireExtId(from, KERNEL_TOPICS.authVerifyPassword);
      requireAuthProviderPermission(extId, KERNEL_TOPICS.authVerifyPassword);
      const parsed = authVerifyPayloadSchema.safeParse(payload);
      if (!parsed.success) {
        throw err('BAD_REQUEST', { message: 'auth.verifyPassword requires payload { password, hash }: strings' });
      }
      return { ok: await passwords.verify(parsed.data.password, parsed.data.hash) };
    },

    [KERNEL_TOPICS.authRegisterProvider]: async (_payload, from) => {
      const extId = requireExtId(from, KERNEL_TOPICS.authRegisterProvider);
      requireAuthProviderPermission(extId, KERNEL_TOPICS.authRegisterProvider);
      if (deps.auth === undefined) {
        throw err('NOT_IMPLEMENTED', {
          message: 'auth.registerProvider is not wired: kernel handlers were assembled without an auth registration callback (integration layer must pass deps.auth)',
          detail: { topic: KERNEL_TOPICS.authRegisterProvider, extId },
        });
      }
      // provider 名 = 扩展 id（AuthProviderRegistry 同名重复注册视为替换）
      deps.auth.registerProvider(extId);
      return { ok: true, name: extId };
    },

    [KERNEL_TOPICS.authUnregisterProvider]: async (_payload, from) => {
      const extId = requireExtId(from, KERNEL_TOPICS.authUnregisterProvider);
      requireAuthProviderPermission(extId, KERNEL_TOPICS.authUnregisterProvider);
      // 未接线（deps.auth 缺省）时无可注销之物：幂等成功，不阻断扩展侧摘除流程
      deps.auth?.unregisterProvider(extId);
      return { ok: true, name: extId };
    },

    // ---------------------------------------------------------------- llm（阶段 10 接管：容器 'llm' 网关）
    [KERNEL_TOPICS.llmChat]: async (payload, from) => {
      requireExtId(from, KERNEL_TOPICS.llmChat);
      const gateway = llmGateway();
      if (gateway === undefined) {
        throw err('NOT_IMPLEMENTED', {
          message: 'llm.chat is not wired yet: the kernel has no LLM gateway registered (container "llm"). ' +
            'Track the kernel release notes for availability.',
        });
      }
      // 扩展线格式仅支持非流式：流式走 REST SSE（POST /api/v1/llm/chat + stream:true）
      if (asRecord(payload)['stream'] === true) {
        throw err('NOT_IMPLEMENTED', {
          message: 'llm.chat does not support stream:true for extensions; ' +
            'use the REST SSE endpoint POST /api/v1/llm/chat with stream:true instead',
          detail: { topic: KERNEL_TOPICS.llmChat },
        });
      }
      const parsed = llmChatPayloadSchema.safeParse(payload);
      if (!parsed.success) {
        throw err('VALIDATION_FAILED', {
          message: 'llm.chat requires payload { model: string, messages: [{ role: "system"|"user"|"assistant"|"tool", content }], maxTokens?, temperature?, topP?, stop?, tools?, providerParams? }',
          detail: parsed.error.issues,
        });
      }
      // payload 即 LlmChatInput（非流式）→ 网关按 model 路由 provider 并经 secrets 解析密钥
      return await gateway.chat(parsed.data);
    },

    // ---------------------------------------------------------------- sandbox（阶段 11 接管）
    [KERNEL_TOPICS.sandboxExec]: async (payload, from) => {
      const extId = requireExtId(from, KERNEL_TOPICS.sandboxExec);
      requireSandboxPermission(extId, KERNEL_TOPICS.sandboxExec);
      const manager = sandboxManager();
      if (manager === undefined) {
        throw err('NOT_IMPLEMENTED', {
          message: 'sandbox.exec is not wired: the kernel running this extension has no SandboxManager registered (container "sandbox")',
          detail: { topic: KERNEL_TOPICS.sandboxExec, extId },
        });
      }
      const parsed = sandboxExecPayloadSchema.safeParse(payload);
      if (!parsed.success) {
        throw err('VALIDATION_FAILED', {
          message: 'sandbox.exec requires payload { cmd: string[], workspaceId?, timeoutMs?, isolated?, workdir?, env? }',
          detail: parsed.error.issues,
        });
      }
      // 家目录语义：workspaceId 缺省 'ext-<extId>'（扩展的持久工作区）。
      // manager.get 未启用时抛 SANDBOX_DISABLED（透传）；启用且不存在 → 懒创建后执行，
      // 之后的 exec 复用同一工作区（家目录随 <dataDir>/sandbox/ 持久化，重启按目录恢复）。
      const workspaceId = parsed.data.workspaceId ?? `ext-${extId}`;
      if (manager.get(workspaceId) === null) {
        await manager.createWorkspace({ id: workspaceId });
      }
      return await manager.exec(workspaceId, parsed.data.cmd, {
        ...(parsed.data.timeoutMs !== undefined ? { timeoutMs: parsed.data.timeoutMs } : {}),
        ...(parsed.data.workdir !== undefined ? { workdir: parsed.data.workdir } : {}),
        ...(parsed.data.env !== undefined ? { env: parsed.data.env } : {}),
        ...(parsed.data.isolated !== undefined ? { isolated: parsed.data.isolated } : {}),
      });
    },

    // ---------------------------------------------------------------- system
    [KERNEL_TOPICS.systemInfo]: async (_payload, from) => {
      requireExtId(from, KERNEL_TOPICS.systemInfo);
      return {
        name: 'opptrix-harness',
        env: kernel.config.env,
        version: KERNEL_VERSION,
        uptimeMs: Math.round(process.uptime() * 1000),
        node: process.versions.node,
        timezone: kernel.config.timezone,
        state: kernel.state(),
        counters: counters().snapshot(),
      };
    },

    [KERNEL_TOPICS.systemStats]: async (_payload, from) => {
      requireExtId(from, KERNEL_TOPICS.systemStats);
      const memory = process.memoryUsage();
      return {
        pid: process.pid,
        platform: os.platform(),
        arch: os.arch(),
        node: process.versions.node,
        uptimeMs: Math.round(process.uptime() * 1000),
        processUptimeSec: Math.round(os.uptime()),
        memory: {
          rss: memory.rss,
          heapUsed: memory.heapUsed,
          heapTotal: memory.heapTotal,
          external: memory.external,
          totalMem: os.totalmem(),
          freeMem: os.freemem(),
        },
        loadavg: os.loadavg().map((v) => Number(v.toFixed(3))),
      };
    },
  };

  /** 任务归属校验：任务存在且属于调用方扩展（否则 FORBIDDEN） */
  async function requireOwnedTask(taskId: string, extId: string): Promise<void> {
    if (taskId === '') throw err('BAD_REQUEST', { message: 'task.* requires a non-empty "taskId"' });
    const record = await taskManager().get(taskId);
    if (record === null || record.extId !== extId) {
      throw err('FORBIDDEN', {
        message: `task "${taskId}" does not belong to extension "${extId}" (or does not exist)`,
        detail: { taskId, extId },
      });
    }
  }

  return handlers;
}
