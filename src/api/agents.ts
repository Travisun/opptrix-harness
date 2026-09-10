/**
 * agents — Agent 会话 REST API（/api/v1/agents/sessions*）。
 *
 * 路由（全部要求已认证——会话或 API Key；单租户管理员语义，任意角色可用）：
 * - POST   /api/v1/agents/sessions                创建会话 {title?, model?, systemPrompt?} → 201
 * - GET    /api/v1/agents/sessions?status=        会话列表（按最后消息时间降序）
 * - GET    /api/v1/agents/sessions/:id            读取单个会话（未找到 → 404 HARNESS-3004）
 * - PATCH  /api/v1/agents/sessions/:id            部分更新 {title?, status?}（归档/恢复/改名）
 * - DELETE /api/v1/agents/sessions/:id            删除会话（级联删消息）→ { ok, deleted }
 * - GET    /api/v1/agents/sessions/:id/messages   消息列表（?before=<消息id游标>&limit=，升序）
 * - POST   /api/v1/agents/sessions/:id/messages   发送用户消息 {content} → 驱动 LLM 回复
 *          （SSE topic `agent:{id}` 实时推送 message.created）→ 200 最终 assistant 消息
 * - POST   /api/v1/agents/sessions/:id/cancel     取消进行中的生成 → 202 { ok, cancelled }
 *
 * 约定：
 * - 鉴权：token 经 extractToken（Authorization: Bearer 优先，其次 ?token=）交 deps.checker
 *   校验；失败抛 HarnessError UNAUTHORIZED → 401 HARNESS-1005；
 * - 入参全部 zod 校验；body 非法 JSON 与 zod 校验失败统一 400 HARNESS-1008/1009；
 * - POST messages 同步等待 LLM 回复（长耗时）；进行中的重复发送 → 429 TOO_MANY_CONCURRENT，
 *   被 cancel 中断 → 503 SERVICE_UNAVAILABLE，LLM 失败按网关错误码原样下发；
 * - deps.systemRuntime 为保留依赖位（系统 MCP 工具目录的只读投影；当前路由面未消费）。
 */
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { extractToken } from '../kernel/auth/authProxy.js';
import type { AgentSessionManager } from '../kernel/agents/session.js';
import { AGENT_SESSION_STATUSES } from '../kernel/agents/session-store.js';
import { err, HarnessError } from '../kernel/errors/index.js';

// ---------------------------------------------------------------------------
// 依赖契约
// ---------------------------------------------------------------------------

/** registerAgentRoutes 依赖集合 */
export interface AgentRoutesDeps {
  /**
   * 统一认证入口（authProxy.createAuthChecker 的产物）。
   * 校验失败应抛 HarnessError(UNAUTHORIZED) → 401。
   */
  checker: (input: {
    token?: string;
    headers: Record<string, string | string[] | undefined>;
  }) => Promise<{ role: string }>;
  /** Agent 会话管理器（全部业务语义委托于此） */
  sessionManager: AgentSessionManager;
  /** 系统工具运行时（保留依赖位：工具目录只读投影；当前路由面未消费） */
  systemRuntime?: unknown;
}

// ---------------------------------------------------------------------------
// zod schema
// ---------------------------------------------------------------------------

/** 消息/系统提示的字节上限（64KB，与子代理 prompt 上限一致；zod 按字符计，管理器面不重复校验） */
const TEXT_MAX_CHARS = 65_536;

/** POST /api/v1/agents/sessions 请求体 */
const createSessionBodySchema = z.object({
  title: z.string().min(1).max(200).optional(),
  model: z.string().min(1).max(256).optional(),
  systemPrompt: z.string().min(1).max(TEXT_MAX_CHARS).optional(),
});

/** GET /api/v1/agents/sessions 查询参数（空串视同未提供） */
const listSessionsQuerySchema = z.object({
  status: z.enum(AGENT_SESSION_STATUSES).optional(),
});

/** PATCH /api/v1/agents/sessions/:id 请求体（至少一个字段） */
const patchSessionBodySchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    status: z.enum(AGENT_SESSION_STATUSES).optional(),
  })
  .refine((v) => v.title !== undefined || v.status !== undefined, {
    error: 'at least one of title/status is required',
  });

/** GET /api/v1/agents/sessions/:id/messages 查询参数 */
const listMessagesQuerySchema = z.object({
  before: z.string().min(1).max(128).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
});

/** POST /api/v1/agents/sessions/:id/messages 请求体 */
const sendMessageBodySchema = z.object({
  content: z.string().min(1).max(TEXT_MAX_CHARS),
});

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

/** 会话未找到（EXT_NOT_FOUND 语义贴切 → 404 HARNESS-3004） */
function sessionNotFound(id: string): HarnessError {
  return err('EXT_NOT_FOUND', { message: `agent session "${id}" not found`, detail: { id } });
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
 * 向 Fastify 实例注册 Agent 会话 API 路由。
 * 必须在 app.ready() 之前调用（路由注册期）；重复注册会因路由冲突抛错。
 */
export function registerAgentRoutes(app: FastifyInstance, deps: AgentRoutesDeps): void {
  // 统一鉴权（任意已认证角色；会话面是 LLM 驱动核心面）
  const requireAuth = async (request: FastifyRequest): Promise<{ role: string }> => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    return deps.checker({
      token: extractToken(request.headers, query),
      headers: request.headers,
    });
  };

  const routeOptions = { schema: { tags: ['agents'] } };
  const bodyRouteOptions = { ...routeOptions, errorHandler: mapBodyParseError };

  // POST /api/v1/agents/sessions — 创建会话（201 + SessionRecord）
  app.post('/api/v1/agents/sessions', bodyRouteOptions, async (request, reply) => {
    await requireAuth(request);
    const parsed = createSessionBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw err('VALIDATION_FAILED', { detail: parsed.error.issues });
    }
    const record = await deps.sessionManager.createSession({
      ...(parsed.data.title !== undefined ? { title: parsed.data.title } : {}),
      ...(parsed.data.model !== undefined ? { model: parsed.data.model } : {}),
      ...(parsed.data.systemPrompt !== undefined ? { systemPrompt: parsed.data.systemPrompt } : {}),
    });
    reply.code(201);
    return record;
  });

  // GET /api/v1/agents/sessions?status= — 会话列表（按最后消息时间降序）
  app.get('/api/v1/agents/sessions', routeOptions, async (request) => {
    await requireAuth(request);
    const query = (request.query ?? {}) as Record<string, unknown>;
    const parsed = listSessionsQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw err('VALIDATION_FAILED', { detail: parsed.error.issues });
    }
    return deps.sessionManager.listSessions(
      parsed.data.status !== undefined ? { status: parsed.data.status } : undefined,
    );
  });

  // GET /api/v1/agents/sessions/:id — 读取单个会话
  app.get('/api/v1/agents/sessions/:id', routeOptions, async (request) => {
    await requireAuth(request);
    const { id } = request.params as { id: string };
    const record = await deps.sessionManager.getSession(id);
    if (record === null) throw sessionNotFound(id);
    return record;
  });

  // PATCH /api/v1/agents/sessions/:id — 部分更新（改名 / 归档恢复）
  app.patch('/api/v1/agents/sessions/:id', bodyRouteOptions, async (request) => {
    await requireAuth(request);
    const { id } = request.params as { id: string };
    const parsed = patchSessionBodySchema.safeParse(request.body);
    if (!parsed.success) {
      throw err('VALIDATION_FAILED', { detail: parsed.error.issues });
    }
    const record = await deps.sessionManager.updateSession(id, {
      ...(parsed.data.title !== undefined ? { title: parsed.data.title } : {}),
      ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {}),
    });
    if (record === null) throw sessionNotFound(id);
    return record;
  });

  // DELETE /api/v1/agents/sessions/:id — 删除会话（级联删消息）
  app.delete('/api/v1/agents/sessions/:id', routeOptions, async (request) => {
    await requireAuth(request);
    const { id } = request.params as { id: string };
    const deleted = await deps.sessionManager.deleteSession(id);
    if (!deleted) throw sessionNotFound(id);
    return { ok: true, deleted: true };
  });

  // GET /api/v1/agents/sessions/:id/messages — 消息列表（升序；before 游标分页）
  app.get('/api/v1/agents/sessions/:id/messages', routeOptions, async (request) => {
    await requireAuth(request);
    const { id } = request.params as { id: string };
    const query = (request.query ?? {}) as Record<string, unknown>;
    const parsed = listMessagesQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw err('VALIDATION_FAILED', { detail: parsed.error.issues });
    }
    return deps.sessionManager.getMessages(id, {
      limit: parsed.data.limit,
      ...(parsed.data.before !== undefined ? { before: parsed.data.before } : {}),
    });
  });

  // POST /api/v1/agents/sessions/:id/messages — 发送用户消息（同步等待 LLM 回复）
  app.post('/api/v1/agents/sessions/:id/messages', bodyRouteOptions, async (request) => {
    await requireAuth(request);
    const { id } = request.params as { id: string };
    const parsed = sendMessageBodySchema.safeParse(request.body);
    if (!parsed.success) {
      throw err('VALIDATION_FAILED', { detail: parsed.error.issues });
    }
    return deps.sessionManager.sendMessage(id, parsed.data.content);
  });

  // POST /api/v1/agents/sessions/:id/cancel — 取消进行中的生成（幂等；202 Accepted）
  app.post('/api/v1/agents/sessions/:id/cancel', routeOptions, async (request, reply) => {
    await requireAuth(request);
    const { id } = request.params as { id: string };
    if ((await deps.sessionManager.getSession(id)) === null) throw sessionNotFound(id);
    const cancelled = deps.sessionManager.cancelGeneration(id);
    reply.code(202);
    return { ok: true, cancelled };
  });
}
