/**
 * extensions — 扩展生命周期管理 REST API（/api/v1/extensions*）。
 *
 * 路由（全部要求 role root|admin；无 token → 401 HARNESS-1006，normal → 403 HARNESS-1007）：
 * - GET  /api/v1/extensions           扩展清单 → manager.list()
 * - GET  /api/v1/extensions/routes    扩展注册的 HTTP 路由 → manager.getRoutes()
 * - GET  /api/v1/extensions/registry  服务注册目录 → registry.list()
 * - POST /api/v1/extensions/:id/enable | disable | reload → { ok: true }
 *       失败时 HarnessError 原样状态码透传（EXT_ACTIVATION_FAILED 500 / EXT_DEPENDENCY_MISSING 409 等），
 *       body 统一错误形状 { code, message, detail, retryable }
 * - POST /api/v1/extensions/:id/uninstall（?purge=1 连持久化数据一并清除）→ { ok: true }
 * - GET  /api/v1/extensions/:id       单个扩展详情（在 manager.list() 中查找；无 → 404 HARNESS-3004）
 *
 * 约定：
 * - 鉴权：token 经 extractToken（Authorization: Bearer 优先，其次 ?token=）交
 *   deps.checker 校验；失败抛 UNAUTHORIZED → 401；
 * - 入参全部 zod 校验（:id 与 ?purge）；本模块路由不接收 JSON body；
 * - 写操作挂路由级 errorHandler：HarnessError 按自身状态码下发（即使宿主未装
 *   全局 HarnessError 处理器也保持透传语义），其余异常交回全局兜底。
 */
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { extractToken } from '../kernel/auth/authProxy.js';
import { err, HarnessError } from '../kernel/errors/index.js';

// ---------------------------------------------------------------------------
// 依赖契约
// ---------------------------------------------------------------------------

/** 扩展清单条目（形状由 ExtensionManager 决定，本模块只要求携带 id） */
export interface ExtSummaryLike {
  id: string;
  [key: string]: unknown;
}

/** registerExtensionRoutes 依赖集合 */
export interface ExtensionsApiDeps {
  /**
   * 统一认证入口（authProxy.createAuthChecker 的产物）。
   * 校验失败应抛 HarnessError(UNAUTHORIZED) → 401；返回的 role 非
   * 'root'|'admin' 时本模块抛 FORBIDDEN → 403。
   */
  checker: (input: {
    token?: string;
    headers: Record<string, string | string[] | undefined>;
  }) => Promise<{ role: string }>;
  /** 扩展生命周期管理器（ExtensionManager 门面） */
  manager: {
    /** 扩展清单（GET / 与 GET /:id 的数据源） */
    list(): ExtSummaryLike[];
    /** 启用扩展；失败抛 HarnessError（状态码原样透传） */
    enable(id: string): Promise<void>;
    /** 停用扩展；失败抛 HarnessError（状态码原样透传） */
    disable(id: string): Promise<void>;
    /** 重载扩展；失败抛 HarnessError（状态码原样透传） */
    reload(id: string): Promise<void>;
    /** 卸载扩展；opts.purge=true 时连同持久化数据清除 */
    uninstall(id: string, opts?: { purge?: boolean }): Promise<void>;
    /** 扩展注册的 HTTP 路由清单（管理台内省用） */
    getRoutes(): unknown[];
  };
  /** 扩展服务注册中心门面（服务目录只读视图） */
  registry: {
    list(): unknown[];
  };
}

// ---------------------------------------------------------------------------
// zod schema
// ---------------------------------------------------------------------------

/** 路径参数 :id（扩展标识） */
const idParamSchema = z.object({
  id: z.string().min(1).max(256),
});

/** POST /api/v1/extensions/:id/uninstall 查询参数（?purge=1 连数据清除） */
const uninstallQuerySchema = z.object({
  purge: z.enum(['1', 'true']).optional(),
});

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

/** 扩展未找到（EXT_NOT_FOUND → 404 HARNESS-3004，与 tasks/notifications 模块一致） */
function extensionNotFound(id: string): HarnessError {
  return err('EXT_NOT_FOUND', { message: `extension "${id}" not found`, detail: { id } });
}

/**
 * POST 路由级错误处理：HarnessError 按自身状态码 + 统一错误形状下发
 * （生命周期操作失败——EXT_ACTIVATION_FAILED 500 / EXT_DEPENDENCY_MISSING 409 等——原样透传）；
 * 其余异常重新抛出交回全局错误处理器兜底。
 */
function mapHarnessError(error: FastifyError, _request: FastifyRequest, reply: FastifyReply): void {
  if (error instanceof HarnessError) {
    reply.code(error.status).send(error.toJSON());
    return;
  }
  throw error;
}

// ---------------------------------------------------------------------------
// 路由注册
// ---------------------------------------------------------------------------

/**
 * 向 Fastify 实例注册扩展管理 API 路由。
 * 必须在 app.ready() 之前调用（路由注册期）；重复注册会因路由冲突抛错。
 */
export function registerExtensionRoutes(app: FastifyInstance, deps: ExtensionsApiDeps): void {
  // 统一鉴权
  const authenticate = async (request: FastifyRequest): Promise<{ role: string }> => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    return deps.checker({
      token: extractToken(request.headers, query),
      headers: request.headers,
    });
  };

  // 门禁：扩展管理全部要求 admin 及以上（root 放行），否则 FORBIDDEN
  const requireAdmin = async (request: FastifyRequest): Promise<void> => {
    const identity = await authenticate(request);
    if (identity.role !== 'root' && identity.role !== 'admin') {
      throw err('FORBIDDEN', {
        message: `extension management requires role admin or root (got "${identity.role}")`,
        detail: { role: identity.role },
      });
    }
  };

  /** :id 参数校验（校验失败 → 400 HARNESS-1009） */
  const parseIdParam = (request: FastifyRequest): string => {
    const parsed = idParamSchema.safeParse(request.params);
    if (!parsed.success) {
      throw err('VALIDATION_FAILED', { detail: parsed.error.issues });
    }
    return parsed.data.id;
  };

  const routeOptions = { schema: { tags: ['extensions'] } };
  const writeOptions = { ...routeOptions, errorHandler: mapHarnessError };

  // GET /api/v1/extensions — 扩展清单
  app.get('/api/v1/extensions', routeOptions, async (request) => {
    await requireAdmin(request);
    return deps.manager.list();
  });

  // GET /api/v1/extensions/routes — 扩展注册的 HTTP 路由
  app.get('/api/v1/extensions/routes', routeOptions, async (request) => {
    await requireAdmin(request);
    return deps.manager.getRoutes();
  });

  // GET /api/v1/extensions/registry — 服务注册目录
  app.get('/api/v1/extensions/registry', routeOptions, async (request) => {
    await requireAdmin(request);
    return deps.registry.list();
  });

  // POST /api/v1/extensions/:id/enable — 启用扩展
  app.post('/api/v1/extensions/:id/enable', writeOptions, async (request, reply) => {
    await requireAdmin(request);
    await deps.manager.enable(parseIdParam(request));
    reply.code(200);
    return { ok: true };
  });

  // POST /api/v1/extensions/:id/disable — 停用扩展
  app.post('/api/v1/extensions/:id/disable', writeOptions, async (request, reply) => {
    await requireAdmin(request);
    await deps.manager.disable(parseIdParam(request));
    reply.code(200);
    return { ok: true };
  });

  // POST /api/v1/extensions/:id/reload — 重载扩展
  app.post('/api/v1/extensions/:id/reload', writeOptions, async (request, reply) => {
    await requireAdmin(request);
    await deps.manager.reload(parseIdParam(request));
    reply.code(200);
    return { ok: true };
  });

  // POST /api/v1/extensions/:id/uninstall — 卸载扩展（?purge=1 连数据清除）
  app.post('/api/v1/extensions/:id/uninstall', writeOptions, async (request, reply) => {
    await requireAdmin(request);
    const id = parseIdParam(request);
    const query = (request.query ?? {}) as Record<string, unknown>;
    const parsed = uninstallQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw err('VALIDATION_FAILED', {
        message: 'query.purge only accepts "1" or "true"',
        detail: parsed.error.issues,
      });
    }
    await deps.manager.uninstall(id, { purge: parsed.data.purge !== undefined });
    reply.code(200);
    return { ok: true };
  });

  // GET /api/v1/extensions/:id — 单个扩展详情（须在字面量路由之后注册，避免遮蔽）
  app.get('/api/v1/extensions/:id', routeOptions, async (request) => {
    await requireAdmin(request);
    const id = parseIdParam(request);
    const found = deps.manager.list().find((summary) => summary.id === id);
    if (found === undefined) throw extensionNotFound(id);
    return found;
  });
}
