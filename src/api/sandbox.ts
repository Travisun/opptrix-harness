/**
 * sandbox — Docker 工作区沙箱 REST API（/api/v1/sandbox*，全部 admin/root）。
 *
 * 路由：
 * - GET    /api/v1/sandbox/workspaces                工作区列表
 * - POST   /api/v1/sandbox/workspaces                创建 {id?, image?} → 201 WorkspaceInfo
 * - DELETE /api/v1/sandbox/workspaces/:id            删除（{force?} 暂经 query 无需暴露）→ { deleted: true }
 * - POST   /api/v1/sandbox/workspaces/:id/exec       执行 {cmd, timeoutMs?, workdir?, env?, isolated?}
 *                                                    → SandboxExecResult JSON
 * - PUT    /api/v1/sandbox/workspaces/:id/files?path= 写文件 {contentBase64} → { ok: true, path }
 * - GET    /api/v1/sandbox/workspaces/:id/files?path= 读文件 → { path, contentBase64 }
 * - GET    /api/v1/sandbox/workspaces/:id/files?path=&list=1 列目录 → [{name,size,dir}]
 *
 * 约定：
 * - 鉴权：token 经 extractToken（Authorization: Bearer 优先，其次 ?token=）交 deps.checker；
 *   所有路由要求 role 'root'|'admin'，否则 403 HARNESS-1007；
 * - manager 未启用（HARNESS-6001 SANDBOX_DISABLED，409）等业务错误由 manager 抛
 *   HarnessError、全局错误处理器按 status 下发——错误形状原样透传，本层不吞不改；
 * - 入参全部 zod 校验；body 非法 JSON 与 zod 失败统一 400 HARNESS-1009。
 */
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { extractToken } from '../kernel/auth/authProxy.js';
import { err, HarnessError } from '../kernel/errors/index.js';
import type { SandboxManager } from '../kernel/sandbox/manager.js';

/** registerSandboxRoutes 依赖集合 */
export interface SandboxRoutesDeps {
  /**
   * 统一认证入口（authProxy.createAuthChecker 的产物）。
   * 校验失败应抛 HarnessError(UNAUTHORIZED) → 401。
   */
  checker: (input: {
    token?: string;
    headers: Record<string, string | string[] | undefined>;
  }) => Promise<{ role: string }>;
  /** 沙箱管理器（全部操作委托于此） */
  manager: SandboxManager;
}

// ---------------------------------------------------------------------------
// zod schema
// ---------------------------------------------------------------------------

/** POST /workspaces 请求体（id 形态与 manager 侧家目录名约束一致） */
const createBodySchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/).optional(),
  image: z.string().min(1).max(512).optional(),
});

/** POST /:id/exec 请求体 */
const execBodySchema = z.object({
  cmd: z.array(z.string()).min(1).max(128),
  timeoutMs: z.coerce.number().int().min(1).max(600_000).optional(),
  workdir: z.string().min(1).max(1024).optional(),
  env: z.record(z.string(), z.string()).optional(),
  /** true → 一次性隔离容器（NetworkMode none）承载本次执行 */
  isolated: z.boolean().optional(),
});

/** PUT /:id/files 请求体（≤ 8MB base64 文本；HTTP body 上限另由 maxBodyBytes 把守） */
const filePutBodySchema = z.object({
  contentBase64: z.string().min(1).max(8 * 1024 * 1024),
});

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

/** fastify JSON body 解析类错误码（仅这两个映射为 VALIDATION_FAILED，其余交回全局兜底） */
const JSON_PARSE_ERROR_CODES = new Set(['FST_ERR_CTP_INVALID_JSON_BODY', 'FST_ERR_CTP_EMPTY_JSON_BODY']);

/**
 * POST/PUT 路由级错误处理：非法 JSON body 映射为 400 VALIDATION_FAILED；
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

/** 提取必填的 query.path（PUT 与 GET 读文件用） */
function requirePathQuery(query: Record<string, unknown>): string {
  const raw = query['path'];
  if (typeof raw !== 'string' || raw === '') {
    throw err('VALIDATION_FAILED', {
      message: 'query parameter "path" is required (relative to /home/dev, ".." rejected)',
      detail: [{ path: 'path', message: 'required' }],
    });
  }
  if (raw.length > 1024) {
    throw err('VALIDATION_FAILED', { message: 'query parameter "path" exceeds 1024 chars', detail: [{ path: 'path' }] });
  }
  return raw;
}

// ---------------------------------------------------------------------------
// 路由注册
// ---------------------------------------------------------------------------

/**
 * 向 Fastify 实例注册沙箱 API 路由（全部 admin/root）。
 * 必须在 app.ready() 之前调用（路由注册期）；重复注册会因路由冲突抛错。
 */
export function registerSandboxRoutes(app: FastifyInstance, deps: SandboxRoutesDeps): void {
  /** 鉴权 + 角色门禁：沙箱是宿主级能力，仅 root/admin 可操作 */
  const requireAdmin = async (request: FastifyRequest): Promise<void> => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    const identity = await deps.checker({
      token: extractToken(request.headers, query),
      headers: request.headers,
    });
    if (identity.role !== 'root' && identity.role !== 'admin') {
      throw err('FORBIDDEN', {
        message: `sandbox API requires role admin or root (got "${identity.role}")`,
        detail: { role: identity.role },
      });
    }
  };

  const routeOptions = { schema: { tags: ['sandbox'] } };

  // GET /api/v1/sandbox/workspaces — 工作区列表
  app.get('/api/v1/sandbox/workspaces', routeOptions, async (request) => {
    await requireAdmin(request);
    return deps.manager.list();
  });

  // POST /api/v1/sandbox/workspaces — 创建工作区（201 + WorkspaceInfo）
  app.post(
    '/api/v1/sandbox/workspaces',
    { ...routeOptions, errorHandler: mapBodyParseError },
    async (request, reply) => {
      await requireAdmin(request);
      const parsed = createBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        throw err('VALIDATION_FAILED', { detail: parsed.error.issues });
      }
      const workspace = await deps.manager.createWorkspace(parsed.data);
      reply.code(201);
      return workspace;
    },
  );

  // DELETE /api/v1/sandbox/workspaces/:id — 删除工作区 → { deleted: true }
  app.delete('/api/v1/sandbox/workspaces/:id', routeOptions, async (request) => {
    await requireAdmin(request);
    const { id } = request.params as { id: string };
    const deleted = await deps.manager.removeWorkspace(id, {});
    if (!deleted) {
      throw err('SANDBOX_NOT_FOUND', { message: `sandbox workspace "${id}" not found`, detail: { id } });
    }
    return { deleted: true };
  });

  // POST /api/v1/sandbox/workspaces/:id/exec — 执行命令 → SandboxExecResult
  app.post(
    '/api/v1/sandbox/workspaces/:id/exec',
    { ...routeOptions, errorHandler: mapBodyParseError },
    async (request) => {
      await requireAdmin(request);
      const { id } = request.params as { id: string };
      const parsed = execBodySchema.safeParse(request.body);
      if (!parsed.success) {
        throw err('VALIDATION_FAILED', { detail: parsed.error.issues });
      }
      return deps.manager.exec(id, parsed.data.cmd, {
        timeoutMs: parsed.data.timeoutMs,
        workdir: parsed.data.workdir,
        env: parsed.data.env,
        isolated: parsed.data.isolated,
      });
    },
  );

  // PUT /api/v1/sandbox/workspaces/:id/files?path= — 写文件（base64）
  app.put(
    '/api/v1/sandbox/workspaces/:id/files',
    { ...routeOptions, errorHandler: mapBodyParseError },
    async (request) => {
      await requireAdmin(request);
      const { id } = request.params as { id: string };
      const query = (request.query ?? {}) as Record<string, unknown>;
      const path = requirePathQuery(query);
      const parsed = filePutBodySchema.safeParse(request.body);
      if (!parsed.success) {
        throw err('VALIDATION_FAILED', { detail: parsed.error.issues });
      }
      await deps.manager.writeFile(id, path, parsed.data.contentBase64);
      return { ok: true, path };
    },
  );

  // GET /api/v1/sandbox/workspaces/:id/files?path= — 读文件；?list=1（或 true）改为列目录
  app.get('/api/v1/sandbox/workspaces/:id/files', routeOptions, async (request) => {
    await requireAdmin(request);
    const { id } = request.params as { id: string };
    const query = (request.query ?? {}) as Record<string, unknown>;
    const isList = query['list'] === '1' || query['list'] === 'true';
    if (isList) {
      const dir = typeof query['path'] === 'string' && query['path'] !== '' ? query['path'] : '.';
      return deps.manager.listFiles(id, dir);
    }
    const path = requirePathQuery(query);
    const contentBase64 = await deps.manager.readFile(id, path);
    return { path, contentBase64 };
  });
}
