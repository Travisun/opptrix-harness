/**
 * cron — 定时任务管理 REST API（/api/v1/cron*）。
 *
 * 路由（全部要求 admin 及以上角色，root 亦放行）：
 * - GET    /api/v1/cron               列出任务（?extId= 按扩展过滤；空/缺省不过滤）
 * - POST   /api/v1/cron               创建任务 → 201 + record（tz 缺省 'UTC'、enabled 缺省 true）
 * - GET    /api/v1/cron/:id           读取单个任务（未找到 → 404 HARNESS-3004）
 * - PATCH  /api/v1/cron/:id           部分更新（只改 body 中给出的字段）
 * - DELETE /api/v1/cron/:id           删除 → { deleted: true }（未找到 → 404 HARNESS-3004）
 * - POST   /api/v1/cron/:id/run       立即触发一次 → 202 { started: true }（不等待执行完成）
 * - GET    /api/v1/cron/:id/history   执行历史（?limit=1..500，默认 50，最新在前）
 *
 * 约定：
 * - 鉴权：token 经 extractToken（Authorization: Bearer 优先，其次 ?token=）交
 *   deps.checker 校验；通过后 role 非 'root'|'admin' → 403 HARNESS-1007；
 * - 入参全部 zod 校验；body 非法 JSON（解析失败）与 zod 校验失败统一
 *   400 HARNESS-1009 VALIDATION_FAILED（detail = issues）；
 * - payload 校验为放宽 discriminated：`payload.kind === 'llm'` 走 LLM 提示词自动化
 *   结构校验（prompt 必填 ≤8KB、model/notify/channelSlug 可选）；其余形状
 *   （含 kind 缺省的 v1 普通任务=仅事件广播）维持自由 JSON 现状；
 * - 存储与调度委托 deps.scheduler（内核 CronScheduler 门面），执行历史经
 *   deps.history（通常为 store.history 绑定）透传。
 */
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { extractToken } from '../kernel/auth/authProxy.js';
import { LLM_JOB_PROMPT_MAX_BYTES } from '../kernel/cron/llm-job.js';
import type { CronJobRecord, CronRunEntry } from '../kernel/cron/store.js';
import { err, HarnessError } from '../kernel/errors/index.js';

/** history 查询参数默认 limit（与 CronJobStore.history 的默认一致） */
const DEFAULT_HISTORY_LIMIT = 50;

// ---------------------------------------------------------------------------
// 依赖契约
// ---------------------------------------------------------------------------

/** POST /api/v1/cron 的规范化创建入参（所有字段齐备，缺省值由 REST 层补齐） */
export interface CronJobCreateInput {
  name: string;
  expr: string;
  /** IANA 时区；REST 层缺省补 'UTC' */
  tz: string;
  /** 任务负载；缺省 null */
  payload: unknown;
  /** 缺省 true */
  enabled: boolean;
  /** 在途重叠策略；缺省 'skip' */
  overlap: 'skip' | 'queue';
  /** 错过触发策略；缺省 'skip' */
  misfire: 'skip' | 'runOnce';
  /** 缺省 null（内核级任务） */
  extId: string | null;
}

/** PATCH 允许修改的字段集合（id/createdAt/水位字段不可经 REST 修改） */
export type CronJobPatch = Partial<
  Pick<CronJobRecord, 'name' | 'expr' | 'tz' | 'payload' | 'enabled' | 'overlap' | 'misfire' | 'extId'>
>;

/**
 * 调度器门面契约（与内核 CronScheduler 结构兼容：同步/异步返回皆可）。
 * 实现方负责持久化（CronJobStore）与 croner 调度的联动。
 */
export interface CronSchedulerLike {
  /** 创建并注册新任务（生成 id、落库、排期），返回落库后的完整记录 */
  schedule(input: CronJobCreateInput): CronJobRecord | Promise<CronJobRecord>;
  /** 列出任务；opts.extId 给定时按扩展过滤 */
  list(opts?: { extId?: string | null }): CronJobRecord[] | Promise<CronJobRecord[]>;
  /** 按 ID 读取任务；不存在返回 null */
  get(id: string): CronJobRecord | null | Promise<CronJobRecord | null>;
  /** 部分更新（返回更新后记录；不存在返回 null），实现方需联动重排期 */
  update(id: string, patch: CronJobPatch): CronJobRecord | null | Promise<CronJobRecord | null>;
  /** 移除任务（出堆 + 删库）；返回是否确有删除 */
  unschedule(id: string): boolean | Promise<boolean>;
  /** 立即触发一次执行（不等待执行完成） */
  runNow(id: string): void | Promise<void>;
}

/** registerCronRoutes 依赖集合 */
export interface CronRoutesDeps {
  /**
   * 统一认证入口（authProxy.createAuthChecker 的产物）。
   * 校验失败应抛 HarnessError(UNAUTHORIZED) → 401；返回的 role 非
   * 'root'|'admin' 时本模块抛 FORBIDDEN → 403。
   */
  checker: (input: {
    token?: string;
    headers: Record<string, string | string[] | undefined>;
  }) => Promise<{ role: string }>;
  /** 调度器门面（任务的增删改查与立即触发全部委托于此） */
  scheduler: CronSchedulerLike;
  /** 执行历史读取（通常为 cronStore.history 绑定），limit 透传 */
  history: (jobId: string, limit?: number) => Promise<CronRunEntry[]>;
}

// ---------------------------------------------------------------------------
// zod schema
// ---------------------------------------------------------------------------

/** overlap / misfire 的合法取值（与 CronScheduler 的策略枚举对齐） */
const overlapSchema = z.enum(['skip', 'queue']);
const misfireSchema = z.enum(['skip', 'runOnce']);

/**
 * payload.kind === 'llm'（LLM 提示词自动化）的结构约束：
 * prompt 必填（非空、UTF-8 ≤8KB，上限常量 LLM_JOB_PROMPT_MAX_BYTES 定义见内核
 * cron/llm-job.ts）；model / notify / channelSlug 可选。
 * 执行语义见 src/kernel/cron/llm-job.ts（channelSlug 为 v1 预留字段，随 payload 原样落库）。
 */
const llmJobPayloadSchema = z.object({
  kind: z.literal('llm'),
  prompt: z
    .string()
    .min(1, 'payload.prompt is required for kind:"llm" (LLM prompt automation) jobs')
    .refine((value) => Buffer.byteLength(value, 'utf8') <= LLM_JOB_PROMPT_MAX_BYTES, {
      error: `payload.prompt exceeds ${LLM_JOB_PROMPT_MAX_BYTES} bytes (8KB UTF-8)`,
    }),
  model: z.string().min(1).max(256).optional(),
  notify: z.boolean().optional(),
  channelSlug: z.string().min(1).max(128).optional(),
});

/** payload 是否为 LLM 提示词自动化形状（对象且 kind === 'llm'；数组/标量一律视为普通负载） */
function isLlmJobPayload(payload: unknown): payload is Record<string, unknown> {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    !Array.isArray(payload) &&
    (payload as Record<string, unknown>)['kind'] === 'llm'
  );
}

/**
 * payload 的放宽 discriminated 校验：
 * - 缺省 / null / 非对象 / kind !== 'llm' → 返回 null（v1 普通任务维持自由 JSON 现状）；
 * - kind === 'llm' → 必须满足 llmJobPayloadSchema，失败返回 zod 错误（调用方转 400）。
 */
function validateJobPayload(payload: unknown): z.ZodError | null {
  if (!isLlmJobPayload(payload)) return null;
  const parsed = llmJobPayloadSchema.safeParse(payload);
  return parsed.success ? null : parsed.error;
}

/** POST /api/v1/cron 请求体 */
const createBodySchema = z.object({
  name: z.string().min(1).max(128),
  expr: z.string().min(1),
  tz: z.string().min(1).optional(),
  payload: z.unknown().optional(),
  enabled: z.boolean().optional(),
  overlap: overlapSchema.optional(),
  misfire: misfireSchema.optional(),
  extId: z.string().min(1).nullable().optional(),
});

/** PATCH /api/v1/cron/:id 请求体（全部字段可选） */
const patchBodySchema = createBodySchema.partial();

/** GET /api/v1/cron/:id/history 查询参数（字符串 → 数字） */
const historyQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

/** 任务未找到（EXT_NOT_FOUND 语义贴切 → 404 HARNESS-3004） */
function jobNotFound(id: string): HarnessError {
  return err('EXT_NOT_FOUND', { message: `cron job "${id}" not found`, detail: { id } });
}

/** fastify JSON body 解析类错误码（仅这两个映射为 VALIDATION_FAILED，其余交回全局兜底） */
const JSON_PARSE_ERROR_CODES = new Set(['FST_ERR_CTP_INVALID_JSON_BODY', 'FST_ERR_CTP_EMPTY_JSON_BODY']);

/**
 * POST/PATCH 路由级错误处理：非法 JSON body 映射为 400 VALIDATION_FAILED；
 * HarnessError 按自身状态码下发；其余异常重新抛出交回全局错误处理器兜底。
 */
function mapBodyParseError(error: FastifyError, _request: FastifyRequest, reply: FastifyReply): void {
  if (error instanceof HarnessError) {
    reply.code(error.status).send(error.toJSON());
    return;
  }
  if (typeof error.code === 'string' && JSON_PARSE_ERROR_CODES.has(error.code)) {
    const invalid = err('VALIDATION_FAILED', {
      message: 'request body is not valid JSON — fix the JSON syntax and send content-type: application/json',
      detail: [{ code: error.code, message: error.message }],
    });
    reply.code(invalid.status).send(invalid.toJSON());
    return;
  }
  throw error;
}

// ---------------------------------------------------------------------------
// 路由注册
// ---------------------------------------------------------------------------

/**
 * 向 Fastify 实例注册 cron 管理 API 路由。
 * 必须在 app.ready() 之前调用（路由注册期）；重复注册会因路由冲突抛错。
 */
export function registerCronRoutes(app: FastifyInstance, deps: CronRoutesDeps): void {
  // 统一鉴权 + 角色门禁：checker 通过后要求 admin 及以上（root 放行）
  const requireAdmin = async (request: FastifyRequest): Promise<void> => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    const identity = await deps.checker({
      token: extractToken(request.headers, query),
      headers: request.headers,
    });
    if (identity.role !== 'root' && identity.role !== 'admin') {
      throw err('FORBIDDEN', {
        message: `cron management requires role admin or root (got "${identity.role}")`,
        detail: { role: identity.role },
      });
    }
  };

  const routeOptions = { schema: { tags: ['cron'] } };

  // GET /api/v1/cron — 列表（?extId= 过滤；空串视同未提供）
  app.get('/api/v1/cron', routeOptions, async (request) => {
    await requireAdmin(request);
    const query = (request.query ?? {}) as Record<string, unknown>;
    const raw = query['extId'];
    const extId = typeof raw === 'string' && raw !== '' ? raw : undefined;
    return deps.scheduler.list(extId === undefined ? undefined : { extId });
  });

  // POST /api/v1/cron — 创建（201 + record；缺省值在 REST 层规范化）
  app.post(
    '/api/v1/cron',
    { ...routeOptions, errorHandler: mapBodyParseError },
    async (request, reply) => {
      await requireAdmin(request);
      const parsed = createBodySchema.safeParse(request.body);
      if (!parsed.success) {
        throw err('VALIDATION_FAILED', { detail: parsed.error.issues });
      }
      const body = parsed.data;
      const payloadError = validateJobPayload(body.payload);
      if (payloadError !== null) {
        throw err('VALIDATION_FAILED', { detail: payloadError.issues });
      }
      const record = await deps.scheduler.schedule({
        name: body.name,
        expr: body.expr,
        tz: body.tz ?? 'UTC',
        payload: body.payload ?? null,
        enabled: body.enabled ?? true,
        overlap: body.overlap ?? 'skip',
        misfire: body.misfire ?? 'skip',
        extId: body.extId ?? null,
      });
      reply.code(201);
      return record;
    },
  );

  // GET /api/v1/cron/:id — 读取单个
  app.get('/api/v1/cron/:id', routeOptions, async (request) => {
    await requireAdmin(request);
    const { id } = request.params as { id: string };
    const record = await deps.scheduler.get(id);
    if (record === null) throw jobNotFound(id);
    return record;
  });

  // PATCH /api/v1/cron/:id — 部分更新
  app.patch(
    '/api/v1/cron/:id',
    { ...routeOptions, errorHandler: mapBodyParseError },
    async (request) => {
      await requireAdmin(request);
      const { id } = request.params as { id: string };
      const parsed = patchBodySchema.safeParse(request.body);
      if (!parsed.success) {
        throw err('VALIDATION_FAILED', { detail: parsed.error.issues });
      }
      // payload 键给出时才做 llm 结构校验（缺省 = 不修改负载，维持现状）
      if (parsed.data.payload !== undefined) {
        const payloadError = validateJobPayload(parsed.data.payload);
        if (payloadError !== null) {
          throw err('VALIDATION_FAILED', { detail: payloadError.issues });
        }
      }
      const record = await deps.scheduler.update(id, parsed.data);
      if (record === null) throw jobNotFound(id);
      return record;
    },
  );

  // DELETE /api/v1/cron/:id — 删除
  app.delete('/api/v1/cron/:id', routeOptions, async (request) => {
    await requireAdmin(request);
    const { id } = request.params as { id: string };
    const deleted = await deps.scheduler.unschedule(id);
    if (!deleted) throw jobNotFound(id);
    return { deleted: true };
  });

  // POST /api/v1/cron/:id/run — 立即触发（202 即返回，不等待执行完成）
  app.post('/api/v1/cron/:id/run', routeOptions, async (request, reply) => {
    await requireAdmin(request);
    const { id } = request.params as { id: string };
    const record = await deps.scheduler.get(id);
    if (record === null) throw jobNotFound(id);
    await deps.scheduler.runNow(id);
    reply.code(202);
    return { started: true };
  });

  // GET /api/v1/cron/:id/history — 执行历史（?limit=1..500，默认 50）
  app.get('/api/v1/cron/:id/history', routeOptions, async (request) => {
    await requireAdmin(request);
    const { id } = request.params as { id: string };
    const query = (request.query ?? {}) as Record<string, unknown>;
    const parsed = historyQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw err('VALIDATION_FAILED', { detail: parsed.error.issues });
    }
    const record = await deps.scheduler.get(id);
    if (record === null) throw jobNotFound(id);
    return deps.history(id, parsed.data.limit ?? DEFAULT_HISTORY_LIMIT);
  });
}
