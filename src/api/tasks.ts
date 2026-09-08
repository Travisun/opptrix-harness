/**
 * tasks — 长任务管理 REST API（/api/v1/tasks*）。
 *
 * 路由（全部要求已认证；dispatch/cancel 仅 admin/root，查询任意角色）：
 * - POST /api/v1/tasks/dispatch      派发任务 → 201 TaskRecord
 *                                    （v1 仅开放内置 'echo'；其他 name → 400 HARNESS-1008
 *                                    BAD_REQUEST "task type not registered"）
 * - GET  /api/v1/tasks               列表（?extId=&status=&limit=，limit 缺省 50）
 * - GET  /api/v1/tasks/:id           读取单个任务（未找到 → 404 HARNESS-3004 形状）
 * - POST /api/v1/tasks/:id/cancel    取消（queued 直接取消；running 标记后等迟到回调丢弃）→ { ok: true }
 *
 * 约定：
 * - 鉴权：token 经 extractToken（Authorization: Bearer 优先，其次 ?token=）交
 *   deps.checker 校验；dispatch/cancel 要求 role 为 'root'|'admin'，否则 403 HARNESS-1007；
 * - 入参全部 zod 校验；body 非法 JSON（解析失败）与 zod 校验失败统一
 *   400 HARNESS-1009 VALIDATION_FAILED（detail = issues）。
 */
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { extractToken } from '../kernel/auth/authProxy.js';
import type { TaskManager } from '../kernel/tasks/manager.js';
import { TASK_STATUSES } from '../kernel/tasks/store.js';
import { err, HarnessError } from '../kernel/errors/index.js';

// ---------------------------------------------------------------------------
// 依赖契约
// ---------------------------------------------------------------------------

/** registerTaskRoutes 依赖集合 */
export interface TaskRoutesDeps {
  /**
   * 统一认证入口（authProxy.createAuthChecker 的产物）。
   * 校验失败应抛 HarnessError(UNAUTHORIZED) → 401；返回的 role 非
   * 'root'|'admin' 时受管路由抛 FORBIDDEN → 403。
   */
  checker: (input: {
    token?: string;
    headers: Record<string, string | string[] | undefined>;
  }) => Promise<{ role: string }>;
  /** 任务编排器（dispatch/cancel/get/list 全部委托于此） */
  manager: TaskManager;
}

// ---------------------------------------------------------------------------
// zod schema
// ---------------------------------------------------------------------------

/** POST /api/v1/tasks/dispatch 请求体 */
const dispatchBodySchema = z.object({
  name: z.string().min(1).max(128),
  args: z.unknown().optional(),
  extId: z.string().min(1).max(256).optional(),
});

/** GET /api/v1/tasks 查询参数 */
const listQuerySchema = z.object({
  extId: z.string().min(1).optional(),
  status: z.enum(TASK_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

/** 任务未找到（EXT_NOT_FOUND 语义贴切 → 404 HARNESS-3004） */
function taskNotFound(id: string): HarnessError {
  return err('EXT_NOT_FOUND', { message: `task "${id}" not found`, detail: { id } });
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
 * 向 Fastify 实例注册任务管理 API 路由。
 * 必须在 app.ready() 之前调用（路由注册期）；重复注册会因路由冲突抛错。
 */
export function registerTaskRoutes(app: FastifyInstance, deps: TaskRoutesDeps): void {
  // 统一鉴权（任意已认证角色）
  const requireAuth = async (request: FastifyRequest): Promise<{ role: string }> => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    return deps.checker({
      token: extractToken(request.headers, query),
      headers: request.headers,
    });
  };

  // 鉴权 + 角色门禁：dispatch/cancel 要求 admin 及以上（root 放行）
  const requireAdmin = async (request: FastifyRequest): Promise<void> => {
    const identity = await requireAuth(request);
    if (identity.role !== 'root' && identity.role !== 'admin') {
      throw err('FORBIDDEN', {
        message: `task dispatch/cancel requires role admin or root (got "${identity.role}")`,
        detail: { role: identity.role },
      });
    }
  };

  const routeOptions = { schema: { tags: ['tasks'] } };

  // POST /api/v1/tasks/dispatch — 派发任务（201 + TaskRecord，不等待完成）
  app.post(
    '/api/v1/tasks/dispatch',
    { ...routeOptions, errorHandler: mapBodyParseError },
    async (request, reply) => {
      await requireAdmin(request);
      const parsed = dispatchBodySchema.safeParse(request.body);
      if (!parsed.success) {
        throw err('VALIDATION_FAILED', { detail: parsed.error.issues });
      }
      const { name } = parsed.data;
      if (name !== 'echo') {
        // v1 仅开放内置 echo；真实扩展执行器在阶段 9 接入
        throw err('BAD_REQUEST', {
          message: `task type not registered: "${name}" (v1 ships the built-in "echo" task only; extension task executors are not available in v1 (planned))`,
          detail: { name, registered: ['echo'] },
        });
      }
      const record = await deps.manager.dispatch({
        name: parsed.data.name,
        args: parsed.data.args,
        extId: parsed.data.extId,
      });
      reply.code(201);
      return record;
    },
  );

  // GET /api/v1/tasks — 列表（?extId=&status=&limit=；空串视同未提供）
  app.get('/api/v1/tasks', routeOptions, async (request) => {
    await requireAuth(request);
    const query = (request.query ?? {}) as Record<string, unknown>;
    const parsed = listQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw err('VALIDATION_FAILED', { detail: parsed.error.issues });
    }
    return deps.manager.list({
      extId: parsed.data.extId,
      status: parsed.data.status,
      limit: parsed.data.limit,
    });
  });

  // GET /api/v1/tasks/:id — 读取单个任务
  app.get('/api/v1/tasks/:id', routeOptions, async (request) => {
    await requireAuth(request);
    const { id } = request.params as { id: string };
    const record = await deps.manager.get(id);
    if (record === null) throw taskNotFound(id);
    return record;
  });

  // POST /api/v1/tasks/:id/cancel — 取消（queued 直接取消；running 标记等迟到回调丢弃）
  app.post('/api/v1/tasks/:id/cancel', routeOptions, async (request, reply) => {
    await requireAdmin(request);
    const { id } = request.params as { id: string };
    const record = await deps.manager.cancel(id);
    if (record === null) throw taskNotFound(id);
    reply.code(200);
    return { ok: true };
  });
}
