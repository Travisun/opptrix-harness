/**
 * update — 内核升级 REST API（/api/v1/system/update*）。
 *
 * 路由（全部要求 admin 及以上角色，root 亦放行）：
 * - GET  /api/v1/system/update         检查更新（网络/feed 失败也 200，body.feedOk=false + error）
 * - POST /api/v1/system/update/apply   执行升级 → 202 {accepted:true,...}（重启异步发生）；
 *                                      失败按 stage 映射：verify→400 HARNESS-8002、
 *                                      preflight→500 HARNESS-8003、download/extract→500 INTERNAL
 * - GET  /api/v1/system/update/history 发布历史
 *
 * 约定：
 * - 鉴权：token 经 extractToken（Authorization: Bearer 优先，其次 ?token=）交
 *   deps.checker 校验；通过后 role 非 'root'|'admin' → 403 HARNESS-1007；
 * - apply body 全部字段可选（可空对象 / 无 body）；非法 body → 400 HARNESS-1009；
 * - 并发 apply 抛 HARNESS-8004（409），无可用目标抛 HARNESS-8001（502）。
 */
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { extractToken } from '../kernel/auth/authProxy.js';
import { err, HarnessError } from '../kernel/errors/index.js';
import type {
  UpdateApplyResult,
  UpdateCheckResult,
  UpdateHistoryEntry,
} from '../kernel/update/updater.js';

// ---------------------------------------------------------------------------
// 依赖契约
// ---------------------------------------------------------------------------

/** registerUpdateRoutes 依赖集合 */
export interface UpdateRoutesDeps {
  /**
   * 统一认证入口（authProxy.createAuthChecker 的产物）。
   * 校验失败应抛 HarnessError(UNAUTHORIZED) → 401；返回的 role 非
   * 'root'|'admin' 时本模块抛 FORBIDDEN → 403。
   */
  checker: (input: {
    token?: string;
    headers: Record<string, string | string[] | undefined>;
  }) => Promise<{ role: string }>;
  /** 升级器门面（内核 Updater 实例或测试替身） */
  updater: {
    check(): Promise<UpdateCheckResult>;
    apply(target?: { version?: string; url?: string; sha256?: string }): Promise<UpdateApplyResult>;
    history(): Promise<UpdateHistoryEntry[]>;
  };
}

// ---------------------------------------------------------------------------
// zod schema
// ---------------------------------------------------------------------------

/** POST /api/v1/system/update/apply 请求体（全部可选；无 body 视同空对象；未知字段拒绝——防 pin 字段笔误被静默丢弃） */
const applyBodySchema = z
  .object({
    version: z.string().min(1).optional(),
    url: z.string().min(1).optional(),
    sha256: z.string().min(1).optional(),
  })
  .strict()
  .optional();

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

/** fastify JSON body 解析类错误码（仅这两个映射为 VALIDATION_FAILED，其余交回全局兜底） */
const JSON_PARSE_ERROR_CODES = new Set(['FST_ERR_CTP_INVALID_JSON_BODY', 'FST_ERR_CTP_EMPTY_JSON_BODY']);

/**
 * POST 路由级错误处理：非法 JSON body 映射为 400 VALIDATION_FAILED；
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

/** apply 失败结果 → 对应 HarnessError（按 stage 决定状态码与错误码形状） */
function applyFailureToError(result: Extract<UpdateApplyResult, { ok: false }>): HarnessError {
  switch (result.stage) {
    case 'verify':
      return err('UPDATE_CHECKSUM_MISMATCH', { detail: result.error });
    case 'preflight':
      return err('UPDATE_PREFLIGHT_FAILED', { detail: result.error });
    case 'download':
    case 'extract':
      // 对外保持 INTERNAL 固定文案（原始错误仅在 detail，供服务端日志定位）
      return err('INTERNAL', { detail: { stage: result.stage, error: result.error } });
  }
}

// ---------------------------------------------------------------------------
// 路由注册
// ---------------------------------------------------------------------------

/**
 * 向 Fastify 实例注册升级 API 路由。
 * 必须在 app.ready() 之前调用（路由注册期）；重复注册会因路由冲突抛错。
 */
export function registerUpdateRoutes(app: FastifyInstance, deps: UpdateRoutesDeps): void {
  // 统一鉴权 + 角色门禁：checker 通过后要求 admin 及以上（root 放行）
  const requireAdmin = async (request: FastifyRequest): Promise<void> => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    const identity = await deps.checker({
      token: extractToken(request.headers, query),
      headers: request.headers,
    });
    if (identity.role !== 'root' && identity.role !== 'admin') {
      throw err('FORBIDDEN', {
        message: `update management requires role admin or root (got "${identity.role}")`,
        detail: { role: identity.role },
      });
    }
  };

  const routeOptions = { schema: { tags: ['system'] } };

  // GET /api/v1/system/update — 检查更新（网络失败也 200，feedOk=false 表达）
  app.get('/api/v1/system/update', routeOptions, async (request) => {
    await requireAdmin(request);
    return deps.updater.check();
  });

  // POST /api/v1/system/update/apply — 执行升级（202 即返回，重启异步发生）
  app.post(
    '/api/v1/system/update/apply',
    { ...routeOptions, errorHandler: mapBodyParseError },
    async (request, reply) => {
      await requireAdmin(request);
      const parsed = applyBodySchema.safeParse(request.body);
      if (!parsed.success) {
        throw err('VALIDATION_FAILED', { detail: parsed.error.issues });
      }
      const result = await deps.updater.apply(parsed.data);
      if (result.ok) {
        reply.code(202);
        return { accepted: true, slot: result.slot, version: result.version };
      }
      throw applyFailureToError(result);
    },
  );

  // GET /api/v1/system/update/history — 发布历史
  app.get('/api/v1/system/update/history', routeOptions, async (request) => {
    await requireAdmin(request);
    return deps.updater.history();
  });
}
