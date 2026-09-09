/**
 * subagents — 子代理 REST API（/api/v1/subagents*）。
 *
 * 路由（全部要求已认证——会话或 API Key；role normal 也可用，子代理是 LLM 驱动核心面）：
 * - POST /api/v1/subagents             派生子代理 → 201 SubagentRecord（不等待完成）
 * - GET  /api/v1/subagents             列表（?parentId=&status=&depth=）
 * - GET  /api/v1/subagents/:id         读取单个子代理（未找到 → 404 HARNESS-3004）
 * - GET  /api/v1/subagents/:id/transcript 消息轨迹（JSON 数组；未找到 → 404）
 * - POST /api/v1/subagents/:id/cancel  取消（queued/running → cancelled；终态幂等）→ { ok, cancelled }
 *
 * 树校验（审计语义，v1）：caller 身份由 deps.checker 判定；主会话（外部 LLM 经 /mcp
 * 调用）caller='main'。**v1 REST 保持宽松**——单租户管理员语义下，任何已认证身份可
 * list/get 元数据；**跨代/兄弟的 transcript/result 读取在 MCP 工具层强制**
 * （manager.assertDirectParent，总控接线）——严格父子树：只有直接父（或 main）可读，
 * 兄弟/孙辈 → 403 FORBIDDEN `cross-generation or sibling access is not allowed
 * (strict parent-child tree)`。REST 不做该校验，仅以注释声明边界（未来多租户收紧点）。
 *
 * 约定：
 * - 鉴权：token 经 extractToken（Authorization: Bearer 优先，其次 ?token=）交
 *   deps.checker 校验；失败抛 HarnessError UNAUTHORIZED → 401 HARNESS-1005；
 * - 入参全部 zod 校验；body 非法 JSON（解析失败）与 zod 校验失败统一
 *   400 HARNESS-1008/1009；prompt 上限 64KB（manager 侧按 UTF-8 字节再次强制）；
 * - 树约束（深度/每父子代数）由 manager.spawn 强制：违反 → 400 BAD_REQUEST；
 *   并发达上限时**排队不拒绝**（status='queued'，终态释放槽位后 FIFO 消化）。
 */
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { extractToken } from '../kernel/auth/authProxy.js';
import { MAX_PROMPT_BYTES } from '../kernel/agents/manager.js';
import type { SubagentManager } from '../kernel/agents/manager.js';
import { SUBAGENT_STATUSES } from '../kernel/agents/types.js';
import { err, HarnessError } from '../kernel/errors/index.js';

// ---------------------------------------------------------------------------
// 依赖契约
// ---------------------------------------------------------------------------

/** registerSubagentRoutes 依赖集合 */
export interface SubagentRoutesDeps {
  /**
   * 统一认证入口（authProxy.createAuthChecker 的产物）。
   * 校验失败应抛 HarnessError(UNAUTHORIZED) → 401。v1 所有角色（normal 及以上）
   * 均可读写子代理面——单租户管理员语义；多租户收紧时在此插入角色门禁。
   */
  checker: (input: {
    token?: string;
    headers: Record<string, string | string[] | undefined>;
  }) => Promise<{ role: string }>;
  /** 子代理编排器（spawn/cancel/get/list 全部委托于此） */
  manager: SubagentManager;
}

// ---------------------------------------------------------------------------
// zod schema
// ---------------------------------------------------------------------------

/** POST /api/v1/subagents 请求体 */
const spawnBodySchema = z.object({
  /** 直接父：'main'（默认）或父 subagent id */
  parentId: z.string().min(1).max(128).default('main'),
  /** 任务提示词（≤64KB，UTF-8 字节口径由 manager 强制） */
  prompt: z.string().min(1).max(MAX_PROMPT_BYTES),
  systemPrompt: z.string().min(1).max(MAX_PROMPT_BYTES).optional(),
  model: z.string().min(1).max(256).optional(),
  toolNames: z.array(z.string().min(1).max(256)).max(64).optional(),
  maxIterations: z.number().int().min(1).max(1000).optional(),
});

/** GET /api/v1/subagents 查询参数 */
const listQuerySchema = z.object({
  parentId: z.string().min(1).optional(),
  status: z.enum(SUBAGENT_STATUSES).optional(),
  depth: z.coerce.number().int().min(0).max(128).optional(),
});

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

/** 子代理未找到（EXT_NOT_FOUND 语义贴切 → 404 HARNESS-3004） */
function subagentNotFound(id: string): HarnessError {
  return err('EXT_NOT_FOUND', { message: `subagent "${id}" not found`, detail: { id } });
}

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

// ---------------------------------------------------------------------------
// 路由注册
// ---------------------------------------------------------------------------

/**
 * 向 Fastify 实例注册子代理 API 路由。
 * 必须在 app.ready() 之前调用（路由注册期）；重复注册会因路由冲突抛错。
 */
export function registerSubagentRoutes(app: FastifyInstance, deps: SubagentRoutesDeps): void {
  // 统一鉴权（任意已认证角色；normal 放行——子代理是 LLM 驱动核心面）
  const requireAuth = async (request: FastifyRequest): Promise<{ role: string }> => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    return deps.checker({
      token: extractToken(request.headers, query),
      headers: request.headers,
    });
  };

  const routeOptions = { schema: { tags: ['subagents'] } };

  // POST /api/v1/subagents — 派生子代理（201 + SubagentRecord，不等待完成）
  app.post(
    '/api/v1/subagents',
    { ...routeOptions, errorHandler: mapBodyParseError },
    async (request, reply) => {
      await requireAuth(request);
      const parsed = spawnBodySchema.safeParse(request.body);
      if (!parsed.success) {
        throw err('VALIDATION_FAILED', { detail: parsed.error.issues });
      }
      const record = await deps.manager.spawn({
        parentId: parsed.data.parentId,
        prompt: parsed.data.prompt,
        ...(parsed.data.systemPrompt !== undefined ? { systemPrompt: parsed.data.systemPrompt } : {}),
        ...(parsed.data.model !== undefined ? { model: parsed.data.model } : {}),
        ...(parsed.data.toolNames !== undefined ? { toolNames: parsed.data.toolNames } : {}),
        ...(parsed.data.maxIterations !== undefined ? { maxIterations: parsed.data.maxIterations } : {}),
      });
      reply.code(201);
      return record;
    },
  );

  // GET /api/v1/subagents — 列表（?parentId=&status=&depth=；空串视同未提供）
  app.get('/api/v1/subagents', routeOptions, async (request) => {
    await requireAuth(request);
    const query = (request.query ?? {}) as Record<string, unknown>;
    const parsed = listQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw err('VALIDATION_FAILED', { detail: parsed.error.issues });
    }
    // 树校验（审计语义，v1 宽松）：任何已认证身份可列表；跨代/兄弟内容读取在 MCP 工具层强制
    return deps.manager.list({
      ...(parsed.data.parentId !== undefined ? { parentId: parsed.data.parentId } : {}),
      ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {}),
      ...(parsed.data.depth !== undefined ? { depth: parsed.data.depth } : {}),
    });
  });

  // GET /api/v1/subagents/:id — 读取单个子代理（v1 宽松：已认证即可读元数据）
  app.get('/api/v1/subagents/:id', routeOptions, async (request) => {
    await requireAuth(request);
    const { id } = request.params as { id: string };
    const record = await deps.manager.get(id);
    if (record === null) throw subagentNotFound(id);
    return record;
  });

  // GET /api/v1/subagents/:id/transcript — 消息轨迹
  // （v1 宽松 + 注释边界：跨代/兄弟禁令由 MCP 工具层经 assertDirectParent 强制）
  app.get('/api/v1/subagents/:id/transcript', routeOptions, async (request) => {
    await requireAuth(request);
    const { id } = request.params as { id: string };
    const record = await deps.manager.get(id);
    if (record === null) throw subagentNotFound(id);
    return { id: record.id, status: record.status, messages: record.transcript };
  });

  // POST /api/v1/subagents/:id/cancel — 取消（queued/running → cancelled；终态幂等 ok）
  app.post('/api/v1/subagents/:id/cancel', routeOptions, async (request) => {
    await requireAuth(request);
    const { id } = request.params as { id: string };
    const record = await deps.manager.get(id);
    if (record === null) throw subagentNotFound(id);
    const cancelled = await deps.manager.cancel(id);
    return { ok: true, cancelled };
  });
}
