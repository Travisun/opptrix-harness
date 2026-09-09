/**
 * system-tools — 系统操作 MCP 工具目录（单一事实来源）。
 *
 * 把 Harness OS 的全部系统操作暴露为标准 MCP 工具（按域前缀命名：
 * skills_ / cron_ / notifications_ / extensions_ / files_ / mcp_ / plugins_ /
 * logs_ / update_ / system_），供两类调用方复用：
 * - 外部 LLM/系统：经 `/mcp` 端点（Streamable HTTP，见 system-server.ts）调用；
 * - 内部扩展：经 h.mcp 桥（serverId='system'，见 bridge.ts 的目录合并）调用。
 *
 * 设计约定：
 * - **全部经容器懒解析现有服务**（CONTAINER_KEYS / FACADE_CONTAINER_KEYS），工具层
 *   只做参数校验 + 编排 + 结果归一，不重复实现任何领域逻辑；
 * - **admin 身份执行**：工具运行时（SystemToolRuntime，见 system-server.ts）在入口
 *   已完成鉴权（root|admin 或 scopes 含 'mcp:call'/'*'），执行期固定为内核 admin
 *   语义——系统操作不按调用者再做行级过滤（信任模型见 system-server.ts 模块注释）；
 * - **永不抛错**：每个 execute 的失败统一转 `{ ok:false, error:{code,message} }`
 *   返回（isError 语义由网关层映射，MCP 工具本身不抛）；成功统一 `{ ok:true, ...结果 }`；
 * - **API Key 管理刻意不做成工具**（LLM providers 的 apiKey、secrets 读写等）——
 *   防密钥进入 LLM 上下文；密钥操作只保留 REST/UI 管理员面；
 * - inputSchema（JSON Schema draft 2020-12）由 zod shape 经 `z.toJSONSchema` 派生，
 *   单一事实来源：目录表（本文件）→ SDK 注册（system-server.ts）/ 目录下发（bridge.ts）。
 *
 * update_apply 刻意不暴露：apply 会切换 A/B slot 并触发进程重启——重启是宿主动作，
 * 交由管理员经 UI/运维链路显式触发，不开放给 LLM/扩展的自动化调用。
 */
import type { Knex } from 'knex';
import { z } from 'zod';

import { CONTAINER_KEYS, type Kernel, type UpdaterFacade } from '../Kernel.js';
import { FACADE_CONTAINER_KEYS } from '../Facades.js';
import type { HarnessConfig } from '../config/index.js';
import type { CronJobRecord } from '../cron/scheduler.js';
import type { CronRunEntry } from '../cron/store.js';
import { err, HarnessError } from '../errors/index.js';
import { NotificationStore } from '../notification/index.js';
import { runDoctor } from '../system/doctor.js';
import { writeSkill } from '../skills/index.js';
import {
  SKILL_BODY_MAX_BYTES,
  SKILL_DESCRIPTION_MAX_CHARS,
  SKILL_NAME_PATTERN,
} from '../skills/types.js';

// ---------------------------------------------------------------------------
// 目录契约
// ---------------------------------------------------------------------------

/**
 * 工具目录的容器登记键（SystemToolRuntime 实例；Kernel 在 /mcp 接线时登记，
 * bridge.ts 懒解析它实现 mcp.tools.list/call 的 system 合并）。
 */
export const SYSTEM_TOOLS_CONTAINER_KEY = 'system.tools';

/** system 工具在目录合并时的 serverId（h.mcp 桥与外部 /mcp 共用同一目录） */
export const SYSTEM_SERVER_ID = 'system';

/** 工具执行上下文：内核懒解析 + 升级器/执行历史两个闭包依赖（见 SystemToolRuntime） */
export interface SystemToolContext {
  /** 内核（容器 / config / logger 的懒解析根） */
  kernel: Kernel;
  /** 升级器门面（update_check / update_history 用；Kernel 接线时注入） */
  updater: UpdaterFacade;
  /** cron 执行历史读取（cron_history 用；Kernel 接线时注入 cronStore.history 绑定） */
  cronHistory: (jobId: string, limit?: number) => Promise<CronRunEntry[]>;
}

/** 单个系统工具定义 */
export interface SystemTool {
  /** 全局工具名（域前缀：skills_/cron_/…，MCP tools/list 原样下发） */
  name: string;
  /** 中文描述（面向 LLM 的用途说明） */
  description: string;
  /** 入参 JSON Schema（draft 2020-12；由 input zod shape 派生，勿手改） */
  inputSchema: Record<string, unknown>;
  /** 入参 zod shape（inputSchema 的单一事实来源；SDK registerTool 直用） */
  input: z.ZodRawShape;
  /**
   * 执行器：入参已由调用方（SDK 网关 / bridge / runtime）按 input 校验。
   * **约定：永不抛错**——失败一律返回 `{ ok:false, error:{code,message} }`。
   */
  execute(args: Record<string, unknown>, ctx: SystemToolContext): Promise<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// 结果归一辅助
// ---------------------------------------------------------------------------

/** 统一成功形状 */
function ok(value: Record<string, unknown>): Record<string, unknown> {
  return { ok: true, ...value };
}

/** 统一失败形状（code 用 HarnessError 全码如 'HARNESS-3004'，或 'VALIDATION'/'INTERNAL'） */
function fail(code: string, message: string, detail?: unknown): Record<string, unknown> {
  return { ok: false, error: { code, message, ...(detail !== undefined ? { detail } : {}) } };
}

/**
 * 执行器兜底包装：HarnessError → { ok:false, error:{code,message,detail} }；
 * 其余异常 → INTERNAL。工具层任何遗漏的抛错路径都收敛为结果对象（MCP 工具不抛）。
 */
async function guard(run: () => Promise<Record<string, unknown>>): Promise<Record<string, unknown>> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof HarnessError) {
      return fail(e.code, e.message, e.detail);
    }
    return fail('INTERNAL', e instanceof Error ? e.message : String(e));
  }
}

/** 容器懒解析（键未登记 → INTERNAL，提示装配缺失而非裸 TypeError） */
function required<T>(ctx: SystemToolContext, key: string): T {
  if (!ctx.kernel.container.has(key)) {
    throw err('INTERNAL', { message: `kernel service "${key}" is not registered in this kernel assembly` });
  }
  return ctx.kernel.container.resolve<T>(key);
}

/** 目录条目工厂：inputSchema 由 zod shape 派生（draft 2020-12） */
function defineTool(
  name: string,
  description: string,
  input: z.ZodRawShape,
  execute: SystemTool['execute'],
): SystemTool {
  const jsonSchema = z.toJSONSchema(z.object(input)) as Record<string, unknown>;
  return { name, description, inputSchema: jsonSchema, input, execute };
}

// ---------------------------------------------------------------------------
// 通用入参 schema 片段
// ---------------------------------------------------------------------------

/** 分页 limit 片段（1..500，与各 REST 模块的上下限一致） */
const limitShape: z.ZodRawShape = {
  limit: z.number().int().min(1).max(500).optional(),
};

/** 通知级别（与 ChannelLevel / NotificationManager 的 zod 枚举一致） */
const notifyLevelSchema = z.enum(['info', 'success', 'warn', 'error']);

/** 日志级别（pino 级别，与 api/system.ts logsQuerySchema 一致） */
const logLevelSchema = z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);

// ---------------------------------------------------------------------------
// 工具目录（37 项；顺序即 tools/list 下发顺序，按域分组）
// ---------------------------------------------------------------------------

/**
 * 构建系统工具目录（每次调用返回全新数组；定义本身无状态，可安全复用）。
 * execute 的入参已在 runtime/SDK 层校验，此处再以 guard 兜底保证「工具不抛」。
 */
export function createSystemTools(): SystemTool[] {
  return [
    // ------------------------------------------------------------ skills ----
    defineTool(
      'skills_list',
      '列出技能目录全部条目（id 升序；不含正文）。',
      {},
      (args, ctx) =>
        guard(async () => {
          void args;
          const registry = required<{
            list(filter?: { source?: string; tag?: string; q?: string }): unknown[];
          }>(ctx, CONTAINER_KEYS.skillsRegistry);
          const skills = registry.list();
          return ok({ skills, total: skills.length });
        }),
    ),
    defineTool(
      'skills_get',
      '读取单个技能（含 SKILL.md 正文）。',
      { id: z.string().min(1).max(256) },
      (args, ctx) =>
        guard(async () => {
          const registry = required<{
            get(id: string): Promise<{ entry: unknown; body: string } | null>;
          }>(ctx, CONTAINER_KEYS.skillsRegistry);
          const found = await registry.get(String(args['id']));
          if (found === null) {
            return fail('HARNESS-3004', `skill "${String(args['id'])}" not found`, { id: args['id'] });
          }
          const entry = found.entry as Record<string, unknown>;
          return ok({ skill: { ...entry, body: found.body } });
        }),
    ),
    defineTool(
      'skills_create',
      '创建数据域技能：写 <dataDir>/skills/<id>/SKILL.md（frontmatter 由 name/description 组装，注册 id = 目录 id），并重扫目录使其立即可见。',
      {
        id: z.string().regex(SKILL_NAME_PATTERN, `id must match ${SKILL_NAME_PATTERN.source}`),
        name: z.string().min(1).max(200),
        description: z.string().min(1).max(SKILL_DESCRIPTION_MAX_CHARS),
        body: z.string().min(1).max(SKILL_BODY_MAX_BYTES),
      },
      (args, ctx) =>
        guard(async () => {
          const config = required<HarnessConfig>(ctx, CONTAINER_KEYS.config);
          const registry = required<{ refresh(): Promise<unknown[]> }>(ctx, CONTAINER_KEYS.skillsRegistry);
          // 委托 skills/writer 的受控写面（单一事实来源：校验 + frontmatter 组装 + 原子语义 +
          // 已存在拒绝 + 失败回滚）；写后 refresh 让 REST/桥/工具三面立即一致
          const written = await writeSkill(
            { dataDir: config.dataDir },
            {
              id: String(args['id']),
              name: String(args['name']),
              description: String(args['description']),
              body: String(args['body']),
            },
          );
          await registry.refresh();
          return ok({ id: written.id, dir: written.path });
        }),
    ),
    defineTool(
      'skills_refresh',
      '重扫技能库全部根目录（builtin + data）并重放扩展贡献。',
      {},
      (args, ctx) =>
        guard(async () => {
          void args;
          const registry = required<{ refresh(): Promise<unknown[]> }>(ctx, CONTAINER_KEYS.skillsRegistry);
          const entries = await registry.refresh();
          return ok({ total: entries.length, skills: entries });
        }),
    ),

    // ------------------------------------------------------------- cron ----
    defineTool(
      'cron_list',
      '列出全部定时任务（含扩展任务）。',
      {},
      (args, ctx) =>
        guard(async () => {
          void args;
          const scheduler = required<{ list(opts?: { extId?: string }): CronJobRecord[] }>(
            ctx,
            FACADE_CONTAINER_KEYS.cronScheduler,
          );
          return ok({ jobs: scheduler.list() });
        }),
    ),
    defineTool(
      'cron_create',
      '创建内核级定时任务（cron 表达式 + IANA 时区；payload 随触发事件广播）。',
      {
        name: z.string().min(1).max(128),
        expr: z.string().min(1).max(256),
        tz: z.string().min(1).max(64).optional(),
        payload: z.unknown().optional(),
      },
      (args, ctx) =>
        guard(async () => {
          const scheduler = required<{
            schedule(input: {
              name: string;
              expr: string;
              tz?: string;
              payload?: unknown;
              enabled?: boolean;
              extId?: string | null;
            }): Promise<CronJobRecord>;
          }>(ctx, FACADE_CONTAINER_KEYS.cronScheduler);
          const job = await scheduler.schedule({
            name: String(args['name']),
            expr: String(args['expr']),
            ...(args['tz'] !== undefined ? { tz: String(args['tz']) } : {}),
            ...(args['payload'] !== undefined ? { payload: args['payload'] } : {}),
            enabled: true,
            extId: null, // 系统工具创建的任务恒为内核级
          });
          return ok({ job });
        }),
    ),
    defineTool(
      'cron_update',
      '部分更新定时任务（只改给出的字段；enabled 走启停语义并联动重排期）。',
      {
        id: z.string().min(1).max(128),
        name: z.string().min(1).max(128).optional(),
        expr: z.string().min(1).max(256).optional(),
        tz: z.string().min(1).max(64).optional(),
        payload: z.unknown().optional(),
        enabled: z.boolean().optional(),
      },
      (args, ctx) =>
        guard(async () => {
          const id = String(args['id']);
          const scheduler = required<{
            get(id: string): Promise<CronJobRecord | null>;
            update(id: string, patch: { name?: string; expr?: string; tz?: string; payload?: unknown }): Promise<CronJobRecord | null>;
            setEnabled(id: string, enabled: boolean): Promise<CronJobRecord | null>;
          }>(ctx, FACADE_CONTAINER_KEYS.cronScheduler);
          const patch: { name?: string; expr?: string; tz?: string; payload?: unknown } = {};
          if (args['name'] !== undefined) patch.name = String(args['name']);
          if (args['expr'] !== undefined) patch.expr = String(args['expr']);
          if (args['tz'] !== undefined) patch.tz = String(args['tz']);
          if (args['payload'] !== undefined) patch.payload = args['payload'];
          let job: CronJobRecord | null =
            Object.keys(patch).length > 0 ? await scheduler.update(id, patch) : await scheduler.get(id);
          if (job !== null && args['enabled'] !== undefined) {
            job = await scheduler.setEnabled(id, args['enabled'] === true);
          }
          if (job === null) {
            return fail('HARNESS-3004', `cron job "${id}" not found`, { id });
          }
          return ok({ job });
        }),
    ),
    defineTool(
      'cron_delete',
      '删除定时任务（出堆 + 删库，立即生效）。',
      { id: z.string().min(1).max(128) },
      (args, ctx) =>
        guard(async () => {
          const id = String(args['id']);
          const scheduler = required<{ unschedule(id: string): Promise<boolean>; get(id: string): Promise<CronJobRecord | null> }>(
            ctx,
            FACADE_CONTAINER_KEYS.cronScheduler,
          );
          // 存在性先行：unschedule 对未知 id 返回 false，无法区分「已删」与「从未存在」
          const job = await scheduler.get(id);
          if (job === null) {
            return fail('HARNESS-3004', `cron job "${id}" not found`, { id });
          }
          await scheduler.unschedule(id);
          return ok({ id, deleted: true });
        }),
    ),
    defineTool(
      'cron_run',
      '立即触发一次定时任务（不等待执行完成；结果经 cron_history 查看）。',
      { id: z.string().min(1).max(128) },
      (args, ctx) =>
        guard(async () => {
          const id = String(args['id']);
          const scheduler = required<{ get(id: string): Promise<CronJobRecord | null>; runNow(id: string): Promise<void> }>(
            ctx,
            FACADE_CONTAINER_KEYS.cronScheduler,
          );
          const job = await scheduler.get(id);
          if (job === null) {
            return fail('HARNESS-3004', `cron job "${id}" not found`, { id });
          }
          await scheduler.runNow(id);
          return ok({ id, started: true });
        }),
    ),
    defineTool(
      'cron_history',
      '读取定时任务执行历史（最新在前）。',
      { id: z.string().min(1).max(128), ...limitShape },
      (args, ctx) =>
        guard(async () => {
          const id = String(args['id']);
          const scheduler = required<{ get(id: string): Promise<CronJobRecord | null> }>(
            ctx,
            FACADE_CONTAINER_KEYS.cronScheduler,
          );
          if ((await scheduler.get(id)) === null) {
            return fail('HARNESS-3004', `cron job "${id}" not found`, { id });
          }
          const history = await ctx.cronHistory(id, typeof args['limit'] === 'number' ? args['limit'] : undefined);
          return ok({ id, history });
        }),
    ),

    // ----------------------------------------------------- notifications ----
    defineTool(
      'notifications_send',
      '发送一条通知（入库 + SSE 广播；渠道投递按默认路由规则执行）。',
      {
        title: z.string().min(1).max(256),
        body: z.string().max(10_000).optional(),
        level: notifyLevelSchema.optional(),
      },
      (args, ctx) =>
        guard(async () => {
          const notify = required<{
            send(input: { title: string; body?: string; level?: string; data?: unknown; channels?: unknown[] }): Promise<unknown>;
          }>(ctx, CONTAINER_KEYS.notify);
          const notification = await notify.send({
            title: String(args['title']),
            body: args['body'] !== undefined ? String(args['body']) : '',
            level: args['level'] !== undefined ? String(args['level']) : 'info',
            data: null,
            channels: [], // 系统工具直发只入库 + SSE；外发渠道路由交给默认规则
          });
          return ok({ notification });
        }),
    ),
    defineTool(
      'notifications_list',
      '列出通知（最新在前）与未读计数。',
      {
        ...limitShape,
        unreadOnly: z.boolean().optional(),
        level: notifyLevelSchema.optional(),
      },
      (args, ctx) =>
        guard(async () => {
          const db = required<Knex>(ctx, CONTAINER_KEYS.db);
          const store = new NotificationStore(db);
          const opts: { unreadOnly?: boolean; level?: string; limit?: number } = {
            limit: typeof args['limit'] === 'number' ? args['limit'] : 50,
          };
          if (args['unreadOnly'] === true) opts.unreadOnly = true;
          if (args['level'] !== undefined) opts.level = String(args['level']);
          const [items, unread] = await Promise.all([store.list(opts), store.unreadCount()]);
          return ok({ items, unread });
        }),
    ),
    defineTool(
      'notifications_mark_read',
      '标记单条通知为已读。',
      { id: z.string().min(1).max(128) },
      (args, ctx) =>
        guard(async () => {
          const db = required<Knex>(ctx, CONTAINER_KEYS.db);
          const store = new NotificationStore(db);
          const read = await store.markRead(String(args['id']));
          if (!read) {
            return fail('HARNESS-3004', `notification "${String(args['id'])}" not found`, { id: args['id'] });
          }
          return ok({ id: args['id'] });
        }),
    ),
    defineTool(
      'notifications_mark_all_read',
      '全部通知标记为已读。',
      {},
      (args, ctx) =>
        guard(async () => {
          void args;
          const db = required<Knex>(ctx, CONTAINER_KEYS.db);
          const updated = await new NotificationStore(db).markAllRead();
          return ok({ updated });
        }),
    ),

    // ------------------------------------------------------- extensions ----
    defineTool(
      'extensions_list',
      '列出全部扩展（含启用状态、宿主池、挂载与最近错误）。',
      {},
      (args, ctx) =>
        guard(async () => {
          void args;
          const manager = required<{ list(): unknown[] }>(ctx, CONTAINER_KEYS.extManager);
          return ok({ extensions: manager.list() });
        }),
    ),
    defineTool(
      'extensions_enable',
      '启用扩展（第三方目录扩展首次启用需先在管理台授信）。',
      { id: z.string().min(1).max(128) },
      (args, ctx) =>
        guard(async () => {
          const id = String(args['id']);
          const manager = required<{ enable(id: string, input?: { confirmTrust?: boolean }): Promise<void> }>(
            ctx,
            CONTAINER_KEYS.extManager,
          );
          await manager.enable(id);
          return ok({ id, enabled: true });
        }),
    ),
    defineTool(
      'extensions_disable',
      '停用扩展。builtin 内置扩展不可停用（返回 ok:false 的 builtin locked，而非抛错）。',
      { id: z.string().min(1).max(128) },
      (args, ctx) =>
        guard(async () => {
          const id = String(args['id']);
          const manager = required<{
            list(): Array<{ id: string; builtin: boolean }>;
            disable(id: string): Promise<void>;
          }>(ctx, CONTAINER_KEYS.extManager);
          const summary = manager.list().find((s) => s.id === id);
          if (summary === undefined) {
            return fail('HARNESS-3004', `extension "${id}" not found`, { id });
          }
          if (summary.builtin) {
            // 约定形状：{ ok:false, error:{...message:'builtin locked'} } —— 不抛错
            return fail('HARNESS-1007', 'builtin locked', { id, reason: 'core-builtin' });
          }
          await manager.disable(id);
          return ok({ id, enabled: false });
        }),
    ),
    defineTool(
      'extensions_reload',
      '重载扩展（disable → enable；仅对已启用扩展有意义，disabled 扩展为 no-op）。',
      { id: z.string().min(1).max(128) },
      (args, ctx) =>
        guard(async () => {
          const id = String(args['id']);
          const manager = required<{ reload(id: string): Promise<void> }>(ctx, CONTAINER_KEYS.extManager);
          await manager.reload(id);
          return ok({ id, reloaded: true });
        }),
    ),
    defineTool(
      'extensions_rescan',
      '重扫扩展目录（发现新增/移除已消失的扩展）。',
      {},
      (args, ctx) =>
        guard(async () => {
          void args;
          const manager = required<{ rescan(): Promise<{ discovered: string[] }> }>(ctx, CONTAINER_KEYS.extManager);
          const report = await manager.rescan();
          return ok(report);
        }),
    ),

    // ------------------------------------------------------------ files ----
    defineTool(
      'files_list',
      '列出已存文件（按创建时间倒序，不含内容）。',
      { ...limitShape },
      (args, ctx) =>
        guard(async () => {
          const files = required<{ list(opts?: { limit?: number }): Promise<unknown[]> }>(ctx, CONTAINER_KEYS.files);
          const records = await files.list({ limit: typeof args['limit'] === 'number' ? args['limit'] : 50 });
          return ok({ files: records });
        }),
    ),
    defineTool(
      'files_read',
      '按 id 读取文件内容（base64 返回，admin 身份可读 private 文件）。',
      { id: z.string().min(1).max(128) },
      (args, ctx) =>
        guard(async () => {
          const files = required<{
            read(id: string, opts?: { allowPrivate?: boolean }): Promise<{
              record: { id: string; origName: string; mime: string; size: number };
              data: Buffer;
            }>;
          }>(ctx, CONTAINER_KEYS.files);
          const { record, data } = await files.read(String(args['id']), { allowPrivate: true });
          return ok({
            id: record.id,
            origName: record.origName,
            mime: record.mime,
            size: record.size,
            contentBase64: data.toString('base64'),
          });
        }),
    ),
    defineTool(
      'files_write',
      '写入一个文件（base64 内容；落盘 + 落库，返回文件记录）。',
      {
        origName: z.string().min(1).max(512),
        contentBase64: z.string().min(1),
        mime: z.string().min(1).max(255).optional(),
      },
      (args, ctx) =>
        guard(async () => {
          const files = required<{
            store(input: { data: Buffer; origName: string; mime?: string }): Promise<unknown>;
          }>(ctx, CONTAINER_KEYS.files);
          const data = Buffer.from(String(args['contentBase64']), 'base64');
          if (data.byteLength === 0) {
            return fail('HARNESS-1009', 'contentBase64 is not valid base64 (decoded to 0 bytes)');
          }
          const record = await files.store({
            data,
            origName: String(args['origName']),
            ...(args['mime'] !== undefined ? { mime: String(args['mime']) } : {}),
          });
          return ok({ file: record });
        }),
    ),
    defineTool(
      'files_delete',
      '删除文件（磁盘 + 数据库行）。',
      { id: z.string().min(1).max(128) },
      (args, ctx) =>
        guard(async () => {
          const id = String(args['id']);
          const files = required<{ remove(id: string): Promise<unknown> }>(ctx, CONTAINER_KEYS.files);
          await files.remove(id);
          return ok({ id, deleted: true });
        }),
    ),

    // --------------------------------------------------------------- mcp ----
    defineTool(
      'mcp_servers_list',
      '列出全部外部 MCP server 配置与连接状态（env/headers 凭据字段刻意裁剪，防密钥进上下文）。',
      {},
      (args, ctx) =>
        guard(async () => {
          void args;
          const registry = required<{
            list(): Promise<Array<Record<string, unknown> & { id: string }>>;
          }>(ctx, CONTAINER_KEYS.mcpRegistry);
          const servers = (await registry.list()).map((s) => {
            // 安全裁剪：env/headers 可含凭据，永不经工具目录下发（admin 修改走 REST/UI）
            const { env: _env, headers: _headers, ...safe } = s;
            return safe;
          });
          return ok({ servers });
        }),
    ),
    defineTool(
      'mcp_server_add',
      '新增外部 MCP server 配置并立即连接（id 由 name 派生 slug；stdio 需 command，远程需 url）。',
      {
        name: z.string().min(1).max(200),
        transport: z.enum(['stdio', 'streamable-http', 'sse']),
        command: z.string().min(1).max(2048).optional(),
        args: z.array(z.string().min(1).max(4096)).max(128).optional(),
        url: z.string().min(1).max(2048).optional(),
        headers: z.record(z.string(), z.string()).optional(),
        env: z.record(z.string(), z.string()).optional(),
      },
      (args, ctx) =>
        guard(async () => {
          const configStore = required<{
            add(cfg: Record<string, unknown>): Promise<Record<string, unknown>>;
            get(id: string): Promise<Record<string, unknown> | undefined>;
          }>(ctx, CONTAINER_KEYS.mcpConfig);
          const registry = required<{
            connect(id: string): Promise<unknown>;
          }>(ctx, CONTAINER_KEYS.mcpRegistry);
          // id 由 name 派生：小写、非法字符折叠为 '-'，保证 ^[a-z0-9][a-z0-9_-]*$；冲突追加序号
          const baseId = String(args['name'])
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .slice(0, 48)
            .replace(/^-+|-+$/g, '');
          const stem = baseId === '' ? 'server' : baseId;
          let id = stem;
          for (let n = 2; (await configStore.get(id)) !== undefined; n += 1) id = `${stem}-${n}`;
          const added = await configStore.add({
            id,
            name: String(args['name']),
            transport: args['transport'],
            ...(args['command'] !== undefined ? { command: String(args['command']) } : {}),
            ...(args['args'] !== undefined ? { args: args['args'] } : {}),
            ...(args['url'] !== undefined ? { url: String(args['url']) } : {}),
            ...(args['headers'] !== undefined ? { headers: args['headers'] } : {}),
            ...(args['env'] !== undefined ? { env: args['env'] } : {}),
            enabled: true,
          });
          // 与 REST 面不同：工具语义是「加好即用」，连接失败如实上报（配置保留，可修复后重连）
          try {
            const status = await registry.connect(id);
            return ok({ server: added, status });
          } catch (e) {
            const reason = e instanceof Error ? e.message : String(e);
            return fail(
              'INTERNAL',
              `mcp server "${id}" was added (config persisted) but the initial connect failed: ${reason}`,
              { id },
            );
          }
        }),
    ),
    defineTool(
      'mcp_server_remove',
      '删除外部 MCP server（断开连接 + 删配置）。',
      { id: z.string().min(1).max(64) },
      (args, ctx) =>
        guard(async () => {
          const id = String(args['id']);
          const configStore = required<{ remove(id: string): Promise<boolean> }>(ctx, CONTAINER_KEYS.mcpConfig);
          const registry = required<{ disconnect(id: string): Promise<void> }>(ctx, CONTAINER_KEYS.mcpRegistry);
          const removed = await configStore.remove(id);
          if (!removed) {
            return fail('HARNESS-3004', `mcp server "${id}" is not configured`, { id });
          }
          await registry.disconnect(id);
          return ok({ id, deleted: true });
        }),
    ),
    defineTool(
      'mcp_server_connect',
      '（重）连接外部 MCP server（refresh 语义：每次都是新会话）。',
      { id: z.string().min(1).max(64) },
      (args, ctx) =>
        guard(async () => {
          const registry = required<{ connect(id: string): Promise<unknown> }>(ctx, CONTAINER_KEYS.mcpRegistry);
          const status = await registry.connect(String(args['id']));
          return ok({ status });
        }),
    ),
    defineTool(
      'mcp_tools_list',
      '列出外部 MCP server 的工具目录（serverId 缺省 = 全部已连接 server 合并）。',
      { serverId: z.string().min(1).max(64).optional() },
      (args, ctx) =>
        guard(async () => {
          const registry = required<{
            listTools(filter?: { serverId?: string }): Promise<unknown[]>;
          }>(ctx, CONTAINER_KEYS.mcpRegistry);
          const tools = await registry.listTools(
            args['serverId'] !== undefined ? { serverId: String(args['serverId']) } : undefined,
          );
          return ok({ tools });
        }),
    ),
    defineTool(
      'mcp_tools_call',
      '调用外部 MCP server 的工具（归一 CallToolResult；isError 由 server 声明）。',
      {
        serverId: z.string().min(1).max(64),
        toolName: z.string().min(1).max(256),
        args: z.record(z.string(), z.unknown()).optional(),
      },
      (args, ctx) =>
        guard(async () => {
          const registry = required<{
            callTool(serverId: string, toolName: string, args?: Record<string, unknown>): Promise<unknown>;
          }>(ctx, CONTAINER_KEYS.mcpRegistry);
          const result = await registry.callTool(
            String(args['serverId']),
            String(args['toolName']),
            args['args'] !== undefined ? (args['args'] as Record<string, unknown>) : undefined,
          );
          return ok({ result });
        }),
    ),

    // ----------------------------------------------------------- plugins ----
    defineTool(
      'plugins_list',
      '列出已安装插件（含贡献的 skills / mcpServers / scripts 摘要）。',
      {},
      (args, ctx) =>
        guard(async () => {
          void args;
          const registry = required<{ list(): unknown[] }>(ctx, CONTAINER_KEYS.pluginsRegistry);
          return ok({ plugins: registry.list() });
        }),
    ),
    defineTool(
      'plugins_remove',
      '卸载插件（有贡献在用且未给 force 时会被拒绝，先看 plugins_list 的贡献摘要）。',
      { id: z.string().min(1).max(128), force: z.boolean().optional() },
      (args, ctx) =>
        guard(async () => {
          const id = String(args['id']);
          const registry = required<{ remove(id: string, opts?: { force?: boolean }): Promise<void> }>(
            ctx,
            CONTAINER_KEYS.pluginsRegistry,
          );
          await registry.remove(id, { force: args['force'] === true });
          return ok({ id, removed: true });
        }),
    ),
    defineTool(
      'plugins_refresh',
      '重扫插件目录并重建贡献注入（幂等）。',
      {},
      (args, ctx) =>
        guard(async () => {
          void args;
          const registry = required<{ refresh(): Promise<unknown[]> }>(ctx, CONTAINER_KEYS.pluginsRegistry);
          const plugins = await registry.refresh();
          return ok({ total: plugins.length, plugins });
        }),
    ),

    // -------------------------------------------------------------- logs ----
    defineTool(
      'logs_list',
      '查询内核日志（SQLite 日志汇，倒序最新在前；与 GET /api/v1/system/logs 同源）。',
      { ...limitShape, level: logLevelSchema.optional() },
      (args, ctx) =>
        guard(async () => {
          // 与 Kernel.ts registerExtra 里 logs.list 闭包同款实现：logs 表倒序，损坏 data → null
          const db = required<Knex>(ctx, CONTAINER_KEYS.db);
          const limit = typeof args['limit'] === 'number' ? args['limit'] : 200;
          const base = db('logs');
          const filtered = args['level'] !== undefined ? base.where('level', String(args['level'])) : base;
          const rows = (await filtered
            .select('ts', 'level', 'scope', 'message', 'data')
            .orderBy('id', 'desc')
            .limit(limit)) as Array<{
            ts: number;
            level: string;
            scope: string | null;
            message: string;
            data: string | null;
          }>;
          const logs = rows.map((row) => {
            let data: unknown = null;
            if (typeof row.data === 'string' && row.data !== '') {
              try {
                data = JSON.parse(row.data);
              } catch {
                data = null; // 损坏行不拖垮整个列表
              }
            }
            return {
              ts: Number(row.ts),
              level: String(row.level),
              scope: row.scope == null ? '' : String(row.scope),
              message: row.message == null ? '' : String(row.message),
              data,
            };
          });
          return ok({ logs });
        }),
    ),

    // ------------------------------------------------------------ update ----
    // update_apply 刻意不暴露：apply 提交新 slot 后会触发进程重启——重启动作交由
    // 管理员经 UI/运维链路显式触发，不开放给 LLM/扩展的自动化调用（防误触发重启）。
    defineTool(
      'update_check',
      '检查升级：拉取升级 feed，报告当前版本与可用更新。',
      {},
      (args, ctx) =>
        guard(async () => {
          void args;
          const check = await ctx.updater.check();
          return ok({ check });
        }),
    ),
    defineTool(
      'update_history',
      '读取升级历史（slot 发布记录）。',
      {},
      (args, ctx) =>
        guard(async () => {
          void args;
          const history = await ctx.updater.history();
          return ok({ history });
        }),
    ),

    // ------------------------------------------------------------ system ----
    defineTool(
      'system_info',
      '内核运行时信息（版本、运行时长、Node 版本、时区）。',
      {},
      (args, ctx) =>
        guard(async () => {
          void args;
          const config = required<{ env: string; timezone: string }>(ctx, CONTAINER_KEYS.config);
          return ok({
            info: {
              name: 'opptrix-harness',
              env: config.env,
              version: '0.1.0',
              uptimeMs: Math.round(process.uptime() * 1000),
              node: process.versions.node,
              timezone: config.timezone,
              state: ctx.kernel.isReady() ? 'ready' : ctx.kernel.state(),
            },
          });
        }),
    ),
    defineTool(
      'system_doctor',
      '运行环境体检（磁盘 / Node 版本 / 内存 / 数据目录可写等检查项）。',
      {},
      (args, ctx) =>
        guard(async () => {
          void args;
          const config = required<HarnessConfig>(ctx, CONTAINER_KEYS.config);
          const report = await runDoctor(config);
          return ok({ report });
        }),
    ),
  ];
}
