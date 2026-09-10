/**
 * flows — 传入 Webhook（FlowTrigger）REST API（/api/v1/flows/endpoints*）+ 公开入站回调
 * （POST /hooks/flow/:slug，不认证——slug 定位 + HMAC 签名即凭据）。
 *
 * 端点管理（全部要求 admin 及以上，root 放行）：
 * - POST   /api/v1/flows/endpoints                     创建端点 → 201 + **一次性明文 secret**
 * - GET    /api/v1/flows/endpoints                     端点列表（不含 secret）
 * - GET    /api/v1/flows/endpoints/:id                 读取单个（未找到 → 404 HARNESS-3004）
 * - PATCH  /api/v1/flows/endpoints/:id                 部分更新（name/enabled/flowType/flowConfig/llmPrompt）
 * - DELETE /api/v1/flows/endpoints/:id                 删除（级联删 events + secrets 清理）→ { deleted: true }
 * - POST   /api/v1/flows/endpoints/:id/rotate-secret   轮换 HMAC 密钥 → 200 { secret }（一次性）
 * - GET    /api/v1/flows/endpoints/:id/events          事件列表（?limit=&before=；脱敏：只有
 *                                                      payload 摘要/status/result/error，无原始 payload）
 *
 * 公开入站（不认证；签名方案 Stripe 风格）：
 * - POST /hooks/flow/:slug   头 `x-harness-signature: sha256=<hex hmac(rawBody, secret)>`
 *                            （时序安全比较）。端点无密钥 → 跳过校验；缺失/篡改 → 401
 *                            HARNESS-1006；disabled → 403；未知 slug → 404 HARNESS-3004；
 *                            受理后按 flow_type 分派（log/notify/llm），分派失败不影响
 *                            HTTP 应答——恒 200 回 { eventId, status }（processed | failed）。
 *
 * 约定：
 * - 管理面鉴权：token 经 extractToken（Authorization: Bearer 优先，其次 ?token=）交
 *   deps.checker 校验；要求 role 'root'|'admin'，否则 403 HARNESS-1007（与 chat 管理面同款门禁）；
 * - 入参全部 zod 校验；body 非法 JSON 与校验失败统一 400 HARNESS-1009 VALIDATION_FAILED；
 * - 入站路由注册在**兄弟封装上下文**：application/json 与通配 content-type 解析为
 *   **Buffer**（HMAC 需要精确原始字节；JSON.stringify 往返会破坏字节一致性），与 asr
 *   octet-stream 同款封装隔离手法——父上下文默认 JSON 解析不受影响。
 */
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { extractToken } from '../kernel/auth/authProxy.js';
import { err, HarnessError } from '../kernel/errors/index.js';
import type { FlowManager } from '../kernel/flow/index.js';
import type { FlowHeaders } from '../kernel/flow/types.js';

// ---------------------------------------------------------------------------
// 依赖契约
// ---------------------------------------------------------------------------

/** registerFlowRoutes 依赖集合 */
export interface FlowRoutesDeps {
  /**
   * 统一认证入口（authProxy.createAuthChecker 的产物）。
   * 校验失败应抛 HarnessError(UNAUTHORIZED) → 401。
   */
  checker: (input: {
    token?: string;
    headers: Record<string, string | string[] | undefined>;
  }) => Promise<{ role: string }>;
  /** FlowTrigger 编排器（端点 CRUD / 入站管线全部委托于此） */
  manager: FlowManager;
}

// ---------------------------------------------------------------------------
// zod schema
// ---------------------------------------------------------------------------

/** POST /api/v1/flows/endpoints 请求体 */
const createBodySchema = z.object({
  name: z.string().min(1).max(128),
  flowType: z.enum(['log', 'notify', 'llm']),
  flowConfig: z.unknown().optional(),
  llmPrompt: z.string().min(1).max(65_536).optional(),
});

/** PATCH /api/v1/flows/endpoints/:id 请求体（全字段可选） */
const patchBodySchema = z.object({
  name: z.string().min(1).max(128).optional(),
  enabled: z.boolean().optional(),
  flowType: z.enum(['log', 'notify', 'llm']).optional(),
  flowConfig: z.unknown().optional(),
  llmPrompt: z.string().min(1).max(65_536).nullable().optional(),
});

/** GET events 查询参数（字符串 → 数字） */
const eventsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  before: z.coerce.number().int().positive().optional(),
});

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

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

/**
 * 入站 body 归一化为 Buffer（HMAC 与摘要都按原始字节计算）。
 * 本路由上下文把常见 content-type 都解析为 Buffer；此处只兜底缺 content-type
 * （body 为 undefined）与解析为字符串的边角形态。
 */
function rawBodyOf(body: unknown): Buffer {
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (body === undefined || body === null) return Buffer.alloc(0);
  try {
    return Buffer.from(JSON.stringify(body), 'utf8');
  } catch {
    return Buffer.alloc(0);
  }
}

// ---------------------------------------------------------------------------
// 路由注册
// ---------------------------------------------------------------------------

/**
 * 向 Fastify 实例注册 FlowTrigger 管理面与公开入站回调。
 * 必须在 app.ready() 之前调用（路由注册期）；重复注册会因路由冲突抛错。
 */
export function registerFlowRoutes(app: FastifyInstance, deps: FlowRoutesDeps): void {
  /** 认证：checker 失败直接抛（全局错误处理器 → 401） */
  const authenticate = async (request: FastifyRequest): Promise<{ role: string }> => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    return deps.checker({
      token: extractToken(request.headers, query),
      headers: request.headers,
    });
  };

  /** 认证 + admin 门禁（root 放行）：端点是宿主级自动化资源（密钥/入站面），仅 root/admin */
  const requireAdmin = async (request: FastifyRequest): Promise<{ role: string }> => {
    const identity = await authenticate(request);
    if (identity.role !== 'root' && identity.role !== 'admin') {
      throw err('FORBIDDEN', {
        message: `flow management requires role admin or root (got "${identity.role}")`,
        detail: { role: identity.role },
      });
    }
    return identity;
  };

  const routeOptions = { schema: { tags: ['flows'] } };

  // -------------------------------------------------------------------------
  // 公开入站回调（不认证；slug 定位 + HMAC 签名即凭据）。
  // 兄弟封装上下文 + Buffer 解析器（原始字节透传给 handleInbound；父上下文不受污染）。
  // -------------------------------------------------------------------------

  app.register((hookCtx) => {
    // HMAC 需要精确原始字节：本子上下文内 application/json 与通配 content-type 一律解析为 Buffer
    hookCtx.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer' },
      (_request, body: unknown, done: (err: Error | null, result?: unknown) => void) => {
        done(null, body);
      },
    );
    hookCtx.addContentTypeParser(
      '*',
      { parseAs: 'buffer' },
      (_request, body: unknown, done: (err: Error | null, result?: unknown) => void) => {
        done(null, body);
      },
    );
    hookCtx.post(
      '/hooks/flow/:slug',
      routeOptions,
      async (request) =>
        deps.manager.handleInbound(
          (request.params as { slug: string }).slug,
          rawBodyOf(request.body),
          request.headers as FlowHeaders,
          request.ip || undefined,
        ),
    );
  });

  // -------------------------------------------------------------------------
  // 端点管理（admin）
  // -------------------------------------------------------------------------

  // POST /api/v1/flows/endpoints — 创建端点（201 + 一次性明文 secret）
  app.post(
    '/api/v1/flows/endpoints',
    { ...routeOptions, errorHandler: mapBodyParseError },
    async (request, reply) => {
      await requireAdmin(request);
      const parsed = createBodySchema.safeParse(request.body);
      if (!parsed.success) {
        throw err('VALIDATION_FAILED', { detail: parsed.error.issues });
      }
      const record = await deps.manager.createEndpoint({
        name: parsed.data.name,
        flowType: parsed.data.flowType,
        ...(parsed.data.flowConfig !== undefined ? { flowConfig: parsed.data.flowConfig } : {}),
        ...(parsed.data.llmPrompt !== undefined ? { llmPrompt: parsed.data.llmPrompt } : {}),
      });
      reply.code(201);
      return record; // 含一次性 secret；之后的读取面只有 secretRef
    },
  );

  // GET /api/v1/flows/endpoints — 列表（不含 secret）
  app.get('/api/v1/flows/endpoints', routeOptions, async (request) => {
    await requireAdmin(request);
    return deps.manager.listEndpoints();
  });

  // GET /api/v1/flows/endpoints/:id — 读取单个（不含 secret）
  app.get('/api/v1/flows/endpoints/:id', routeOptions, async (request) => {
    await requireAdmin(request);
    const { id } = request.params as { id: string };
    const record = await deps.manager.getEndpoint(id);
    if (record === null) throw err('EXT_NOT_FOUND', { message: `flow endpoint "${id}" not found`, detail: { id } });
    return record;
  });

  // PATCH /api/v1/flows/endpoints/:id — 部分更新（admin）
  app.patch(
    '/api/v1/flows/endpoints/:id',
    { ...routeOptions, errorHandler: mapBodyParseError },
    async (request) => {
      await requireAdmin(request);
      const { id } = request.params as { id: string };
      const parsed = patchBodySchema.safeParse(request.body);
      if (!parsed.success) {
        throw err('VALIDATION_FAILED', { detail: parsed.error.issues });
      }
      const record = await deps.manager.updateEndpoint(id, parsed.data);
      if (record === null) throw err('EXT_NOT_FOUND', { message: `flow endpoint "${id}" not found`, detail: { id } });
      return record;
    },
  );

  // DELETE /api/v1/flows/endpoints/:id — 删除（级联 events + secrets 清理）
  app.delete('/api/v1/flows/endpoints/:id', routeOptions, async (request) => {
    await requireAdmin(request);
    const { id } = request.params as { id: string };
    const deleted = await deps.manager.deleteEndpoint(id);
    if (!deleted) throw err('EXT_NOT_FOUND', { message: `flow endpoint "${id}" not found`, detail: { id } });
    return { deleted: true };
  });

  // POST /api/v1/flows/endpoints/:id/rotate-secret — 轮换密钥（200 + 一次性明文 secret）
  app.post(
    '/api/v1/flows/endpoints/:id/rotate-secret',
    { ...routeOptions, errorHandler: mapBodyParseError },
    async (request) => {
      await requireAdmin(request);
      const { id } = request.params as { id: string };
      return deps.manager.rotateSecret(id);
    },
  );

  // GET /api/v1/flows/endpoints/:id/events — 事件列表（脱敏：仅摘要/status/result/error）
  app.get('/api/v1/flows/endpoints/:id/events', routeOptions, async (request) => {
    await requireAdmin(request);
    const { id } = request.params as { id: string };
    const endpoint = await deps.manager.getEndpoint(id);
    if (endpoint === null) throw err('EXT_NOT_FOUND', { message: `flow endpoint "${id}" not found`, detail: { id } });
    const query = (request.query ?? {}) as Record<string, unknown>;
    const parsed = eventsQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw err('VALIDATION_FAILED', { detail: parsed.error.issues });
    }
    return deps.manager.listEvents(id, parsed.data);
  });
}
