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
import { createPasswordSupport, safeEqualStrings } from '../auth/ext-auth-support.js';
import { ChatService } from '../chat/service.js';
import { configGet } from '../config/index.js';
import { CONTAINER_KEYS, type Kernel } from '../Kernel.js';
import { FACADE_CONTAINER_KEYS } from '../Facades.js';
import { generateSecret as totpGenerateSecret, generate as totpGenerateToken, verify as totpVerifyToken, generateURI as totpGenerateURI } from 'otplib';
import { lookup } from 'node:dns/promises';
import { createHash } from 'node:crypto';
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
 * sandbox.exec 的线格式 payload（SEC-4：workspaceId 不再由调用方指定——工作区归属
 * 强制为 `ext-<extId>`（扩展的持久工作区家目录），payload 中的 workspaceId 字段被
 * 内核侧忽略，防止跨扩展读写他人工作区）。
 */
const sandboxExecPayloadSchema = z.object({
  cmd: z.array(z.string()).min(1).max(128),
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
/** 出站目标是否为私网/环回地址（SSRF 防护） */
function isPrivateIp(ip: string): boolean {
  if (ip === '::1' || ip === '::' || ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80')) return true;
  const parts = ip.split('.').map((x) => Number(x));
  if (parts.length !== 4 || parts.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return false;
  const a = parts[0]!;
  const b = parts[1]!;
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** manifest 权限是否允许访问该主机：net:out:<host> 精确匹配，或 net:out（仅公网） */
function netOutAllowed(permissions: string[], hostname: string, resolvedIps: string[]): { allowed: boolean; reason?: string } {
  const lower = hostname.toLowerCase();
  const exact = permissions.find((p) => p.startsWith('net:out:'));
  if (exact !== undefined) {
    const allowedHost = exact.slice('net:out:'.length).toLowerCase();
    return lower === allowedHost
      ? { allowed: true }
      : { allowed: false, reason: `host "${hostname}" does not match net:out permission "${allowedHost}"` };
  }
  if (!permissions.includes('net:out')) {
    return { allowed: false, reason: `requires "net:out" or "net:out:${lower}" permission in manifest.permissions` };
  }
  const privateHit = resolvedIps.find((ip) => isPrivateIp(ip));
  return privateHit === undefined
    ? { allowed: true }
    : { allowed: false, reason: `net:out blocks private/reserved address "${privateHit}" (use an explicit net:out:${lower} permission to override)` };
}

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

  /**
   * 细粒度权限运行时复核（fail-closed）：topic → 所需 manifest 权限。
   * 高危能力（auth:provider / sandbox / rpc:call）另有专门闸；未列入矩阵的 topic
   * （log/config/system/ui 等低敏面）不做运行时复核。
   */
  const requirePermission = (extId: string, topic: string, permission: string): void => {
    const permissions = extManager().getManifest(extId)?.permissions ?? [];
    if (!permissions.includes(permission)) {
      throw err('FORBIDDEN', {
        message: `kernel service "${topic}" requires the "${permission}" permission in the extension manifest (add it to manifest.permissions)`,
        detail: { topic, extId, requiredPermission: permission },
      });
    }
  };

  const TOPIC_PERMISSIONS: Record<string, string> = {
    [KERNEL_TOPICS.storageGet]: 'storage',
    [KERNEL_TOPICS.storageSet]: 'storage',
    [KERNEL_TOPICS.storageDelete]: 'storage',
    [KERNEL_TOPICS.dbAll]: 'db',
    [KERNEL_TOPICS.dbGet]: 'db',
    [KERNEL_TOPICS.dbRun]: 'db',
    [KERNEL_TOPICS.dbSchema]: 'db',
    [KERNEL_TOPICS.notifySend]: 'notify:send',
    [KERNEL_TOPICS.chatSend]: 'chat:write',
    [KERNEL_TOPICS.chatPatch]: 'chat:write',
    [KERNEL_TOPICS.filesSave]: 'files:write',
    [KERNEL_TOPICS.filesRead]: 'files:read',
    [KERNEL_TOPICS.filesGet]: 'files:read',
    [KERNEL_TOPICS.tasksDispatch]: 'tasks',
    [KERNEL_TOPICS.taskProgress]: 'tasks',
    [KERNEL_TOPICS.taskComplete]: 'tasks',
    [KERNEL_TOPICS.taskFail]: 'tasks',
    [KERNEL_TOPICS.cronSchedule]: 'cron',
    [KERNEL_TOPICS.cronUnschedule]: 'cron',
    [KERNEL_TOPICS.llmChat]: 'llm',
    [KERNEL_TOPICS.uiRegister]: 'ui',
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
      const extId = requireExtId(from, KERNEL_TOPICS.chatPatch);
      const record = asRecord(payload);
      const id = strField(record, 'id');
      if (id === '') throw err('BAD_REQUEST', { message: 'chat.patch requires a non-empty "id"' });
      // SEC-4（跨扩展窃取）：扩展无 admin 身份——仅允许改写自己发送的消息。
      // 归属不匹配（含消息不存在）统一 EXT_NOT_FOUND，不泄露目标消息的存在性。
      const existing = await chatService().getMessage(id);
      if (existing === null || existing.senderId !== extId) {
        throw err('EXT_NOT_FOUND', {
          message: `chat.patch: message "${id}" not found or not sent by extension "${extId}"`,
          detail: { id, extId },
        });
      }
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
      const extId = requireExtId(from, KERNEL_TOPICS.filesRead);
      const id = strField(asRecord(payload), 'id');
      if (id === '') throw err('BAD_REQUEST', { message: 'files.read requires a non-empty "id"' });
      const { record, data } = await fileService().read(id, { allowPrivate: true });
      // SEC-4（跨扩展窃取）：private 文件仅归属扩展可读；归属不匹配统一 EXT_NOT_FOUND
      //（不泄露存在性）。public 文件保持任意扩展可读。
      if (record.visibility === 'private' && record.extId !== extId) {
        throw err('EXT_NOT_FOUND', {
          message: `file "${id}" not found`,
          detail: { id, extId },
        });
      }
      return data.toString('base64');
    },

    [KERNEL_TOPICS.filesGet]: async (payload, from) => {
      const extId = requireExtId(from, KERNEL_TOPICS.filesGet);
      const id = strField(asRecord(payload), 'id');
      if (id === '') throw err('BAD_REQUEST', { message: 'files.get requires a non-empty "id"' });
      const record = await fileService().get(id);
      // SEC-4（跨扩展窃取）：与 files.read 同规则——private 仅归属扩展可见
      if (record.visibility === 'private' && record.extId !== extId) {
        throw err('EXT_NOT_FOUND', {
          message: `file "${id}" not found`,
          detail: { id, extId },
        });
      }
      return record;
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
      // 家目录语义（SEC-4 归属强制）：workspaceId 一律为 `ext-<extId>`（调用方的持久
      // 工作区），payload.workspaceId 被刻意忽略——扩展不能指定他人工作区（跨扩展窃取）。
      // manager.get 未启用时抛 SANDBOX_DISABLED（透传）；启用且不存在 → 懒创建后执行，
      // 之后的 exec 复用同一工作区（家目录随 <dataDir>/sandbox/ 持久化，重启按目录恢复）。
      const workspaceId = `ext-${extId}`;
      if (manager.get(workspaceId) === null) {
        // 网络与权限联动：声明 net:out* → bridge（可出网）；未声明 → none（无网容器）
        const permissions = extManager().getManifest(extId)?.permissions ?? [];
        const networkMode = permissions.some((x) => x === 'net:out' || x.startsWith('net:out:'))
          ? ('bridge' as const)
          : ('none' as const);
        await manager.createWorkspace({ id: workspaceId, networkMode });
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
    [KERNEL_TOPICS.httpFetch]: async (payload, from) => {
      const extId = requireExtId(from, KERNEL_TOPICS.httpFetch);
      const record = asRecord(payload);
      const url = strField(record, 'url');
      if (url === '') throw err('BAD_REQUEST', { message: 'http.fetch requires a non-empty "url"' });
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw err('BAD_REQUEST', { message: `http.fetch: invalid url "${url.slice(0, 120)}"` });
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw err('BAD_REQUEST', { message: `http.fetch: only http/https is supported (got ${parsed.protocol})` });
      }
      const hostname = parsed.hostname.toLowerCase();
      const permissions = extManager().getManifest(extId)?.permissions ?? [];
      let resolved: { address: string }[] = [];
      try {
        resolved = (await lookup(hostname, { all: true })) as { address: string }[];
      } catch {
        throw err('BAD_REQUEST', { message: `http.fetch: cannot resolve host "${hostname}"` });
      }
      const gate = netOutAllowed(permissions, hostname, resolved.map((r) => r.address));
      if (!gate.allowed) {
        throw err('FORBIDDEN', { message: `http.fetch: ${gate.reason ?? 'blocked'}`, detail: { url: url.slice(0, 200), extId } });
      }
      const timeoutMs = typeof record['timeoutMs'] === 'number' ? Math.min(Math.max(record['timeoutMs'] as number, 1000), 60_000) : 30_000;
      const method = typeof record['method'] === 'string' ? record['method'] : 'GET';
      const headers = (record['headers'] ?? {}) as Record<string, string>;
      const body = typeof record['body'] === 'string' ? record['body'] : undefined;
      const res = await fetch(parsed, {
        method,
        headers,
        body: method === 'GET' || method === 'HEAD' ? undefined : body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = (await res.text()).slice(0, 8 * 1024 * 1024);
      const outHeaders: Record<string, string> = {};
      for (const h of ['content-type', 'content-length', 'x-request-id']) {
        const v = res.headers.get(h);
        if (v !== null) outHeaders[h] = v;
      }
      return { status: res.status, headers: outHeaders, text };
    },

    [KERNEL_TOPICS.authTotpGenerate]: async (payload, from) => {
      const extId = requireExtId(from, KERNEL_TOPICS.authTotpGenerate);
      requireAuthProviderPermission(extId, KERNEL_TOPICS.authTotpGenerate);
      const record = asRecord(payload);
      const account = strField(record, 'account') || 'user';
      const secret = totpGenerateSecret();
      const uri = totpGenerateURI({ issuer: 'Opptrix Harness', label: account, secret });
      return { secret, uri };
    },

    [KERNEL_TOPICS.authTotpVerify]: async (payload, from) => {
      const extId = requireExtId(from, KERNEL_TOPICS.authTotpVerify);
      requireAuthProviderPermission(extId, KERNEL_TOPICS.authTotpVerify);
      const record = asRecord(payload);
      const secret = strField(record, 'secret');
      const token = strField(record, 'token');
      if (secret === '' || token === '') {
        throw err('BAD_REQUEST', { message: 'auth.totpVerify requires non-empty "secret" and "token"' });
      }
      try {
        const result = await totpVerifyToken({ token, secret });
        return { ok: result.valid === true, delta: result.valid === true ? result.delta ?? null : null };
      } catch {
        return { ok: false, delta: null };
      }
    },

    [KERNEL_TOPICS.authVerifyRootToken]: async (payload, from) => {
      const extId = requireExtId(from, KERNEL_TOPICS.authVerifyRootToken);
      requireAuthProviderPermission(extId, KERNEL_TOPICS.authVerifyRootToken);
      const record = asRecord(payload);
      const token = strField(record, 'token');
      const identity = kernel.container.has(CONTAINER_KEYS.authIdentity)
        ? (kernel.container.resolve(CONTAINER_KEYS.authIdentity) as { token: string })
        : null;
      const expected = identity?.token ?? '';
      const ok = expected !== '' && safeEqualStrings(token, expected);
      return { ok };
    },

    [KERNEL_TOPICS.authHashToken]: async (payload, from) => {
      const extId = requireExtId(from, KERNEL_TOPICS.authHashToken);
      requireAuthProviderPermission(extId, KERNEL_TOPICS.authHashToken);
      const record = asRecord(payload);
      const value = strField(record, 'value');
      if (value === '') throw err('BAD_REQUEST', { message: 'auth.hashToken requires a non-empty "value"' });
      return { hash: createHash('sha256').update(value).digest('hex') };
    },
  };

  /** 任务归属校验：任务存在且属于调用方扩展（否则 FORBIDDEN） */
  // 细粒度权限运行时复核：对矩阵内的 topic 统一包裹权限闸（fail-closed）
  for (const [topic, permission] of Object.entries(TOPIC_PERMISSIONS)) {
    const inner = handlers[topic];
    if (inner === undefined) continue;
    handlers[topic] = async (payload, from) => {
      const extId = requireExtId(from, topic);
      requirePermission(extId, topic, permission);
      return inner(payload, from);
    };
  }

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
