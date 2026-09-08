/**
 * mcp — MCP 客户端子系统 REST API（/api/v1/mcp/*，全部 admin/root）。
 *
 * 路由：
 * - GET    /api/v1/mcp/servers                    全部 server 配置+状态（含 env/headers，凭据不出 admin 面）
 * - POST   /api/v1/mcp/servers                    新增 { id, name, transport, command?/url?, ... } → 201 配置
 * - DELETE /api/v1/mcp/servers/:id                删除（先摘配置再断连）→ { deleted: true }
 * - PATCH  /api/v1/mcp/servers/:id                { enabled?/name?/headers? }（enabled:false 即断连）→ 配置
 * - POST   /api/v1/mcp/servers/:id/connect        手动（重）连接 → status（失败 500 INTERNAL 带原因）
 * - GET    /api/v1/mcp/tools?serverId=            工具目录（合并全部已连接 server；serverId 过滤可选）
 * - POST   /api/v1/mcp/tools/call                 { serverId, toolName, args?, timeoutMs? } → 归一 CallToolResult
 * - GET    /api/v1/mcp/:id/resources              资源目录（连接期缓存）
 * - GET    /api/v1/mcp/:id/prompts                Prompt 目录（连接期缓存）
 *
 * 约定：
 * - 鉴权：token 经 extractToken（Authorization: Bearer 优先，其次 ?token=）交 deps.checker；
 *   MCP server 配置含子进程命令/远端 url/凭据头——宿主级能力，全部路由要求 role root|admin，
 *   否则 403 HARNESS-1007（同 sandbox API 门禁）；
 * - 业务错误（EXT_NOT_FOUND 404 / VALIDATION_FAILED 400 / RPC_TIMEOUT 504 / INTERNAL 500）
 *   由 registry/configStore 抛 HarnessError、全局错误处理器按 status 下发，本层不吞不改；
 * - 入参全部 zod 校验；body 非法 JSON 与 zod 失败统一 400 HARNESS-1009。
 */
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { extractToken } from '../kernel/auth/authProxy.js';
import { err, HarnessError } from '../kernel/errors/index.js';
import type { McpConfigStore } from '../kernel/mcp/config-store.js';
import type { McpRegistry } from '../kernel/mcp/registry.js';
import { MCP_ID_PATTERN } from '../kernel/mcp/types.js';

/** registerMcpRoutes 依赖集合 */
export interface McpRoutesDeps {
  /**
   * 统一认证入口（authProxy.createAuthChecker 的产物）。
   * 校验失败应抛 HarnessError(UNAUTHORIZED) → 401。
   */
  checker: (input: {
    token?: string;
    headers: Record<string, string | string[] | undefined>;
  }) => Promise<{ role: string }>;
  /** MCP 注册中心（连接/工具/资源/Prompt 门面） */
  registry: McpRegistry;
  /** 配置持久化（增删改查） */
  configStore: McpConfigStore;
}

// ---------------------------------------------------------------------------
// zod schema
// ---------------------------------------------------------------------------

/** POST /servers 请求体（跨字段约束见 mcpCreateBodySchema 的 superRefine） */
const mcpCreateBodySchema = z
  .object({
    id: z.string().regex(MCP_ID_PATTERN, 'id must match ^[a-z0-9][a-z0-9_-]*$').min(1).max(64),
    name: z.string().min(1).max(200),
    transport: z.enum(['stdio', 'streamable-http', 'sse']),
    command: z.string().min(1).max(2048).optional(),
    args: z.array(z.string().min(1).max(4096)).max(128).optional(),
    env: z.record(z.string(), z.string()).optional(),
    url: z.url().max(2048).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    enabled: z.boolean().optional(),
    timeoutMs: z.coerce.number().int().min(1_000).max(600_000).optional(),
  })
  .superRefine((body, ctx) => {
    if (body.transport === 'stdio' && (body.command === undefined || body.command === '')) {
      ctx.addIssue({
        code: 'custom',
        path: ['command'],
        message: 'transport "stdio" requires "command" (executable to spawn)',
      });
    }
    if ((body.transport === 'streamable-http' || body.transport === 'sse') &&
      (body.url === undefined || body.url === '')) {
      ctx.addIssue({
        code: 'custom',
        path: ['url'],
        message: `transport "${body.transport}" requires "url" (http/https endpoint)`,
      });
    }
    if (body.url !== undefined && !/^https?:\/\//i.test(body.url)) {
      ctx.addIssue({ code: 'custom', path: ['url'], message: 'url must start with http:// or https://' });
    }
  });

/** PATCH /servers/:id 请求体（enabled=false 立即断连；name/headers 下次连接生效） */
const mcpPatchBodySchema = z
  .object({
    enabled: z.boolean().optional(),
    name: z.string().min(1).max(200).optional(),
    headers: z.record(z.string(), z.string()).optional(),
  })
  .refine((body) => body.enabled !== undefined || body.name !== undefined || body.headers !== undefined, {
    message: 'PATCH requires at least one of: enabled, name, headers',
  });

/** POST /tools/call 请求体 */
const mcpCallBodySchema = z.object({
  serverId: z.string().min(1).max(64),
  toolName: z.string().min(1).max(256),
  args: z.record(z.string(), z.unknown()).optional(),
  timeoutMs: z.coerce.number().int().min(1).max(600_000).optional(),
});

/** GET /tools?serverId= 的 query */
const toolsQuerySchema = z.object({
  serverId: z.string().min(1).max(64).optional(),
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

// ---------------------------------------------------------------------------
// 路由注册
// ---------------------------------------------------------------------------

/**
 * 向 Fastify 实例注册 MCP 客户端 API 路由（全部 admin/root）。
 * 必须在 app.ready() 之前调用（路由注册期）；重复注册会因路由冲突抛错。
 */
export function registerMcpRoutes(app: FastifyInstance, deps: McpRoutesDeps): void {
  /** 鉴权 + 角色门禁：MCP server 配置含命令/凭据，仅 root/admin 可操作 */
  const requireAdmin = async (request: FastifyRequest): Promise<void> => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    const identity = await deps.checker({
      token: extractToken(request.headers, query),
      headers: request.headers,
    });
    if (identity.role !== 'root' && identity.role !== 'admin') {
      throw err('FORBIDDEN', {
        message: `mcp API requires role admin or root (got "${identity.role}")`,
        detail: { role: identity.role },
      });
    }
  };

  const routeOptions = { schema: { tags: ['mcp'] } };

  // GET /api/v1/mcp/servers — 全部 server 配置+状态
  app.get('/api/v1/mcp/servers', routeOptions, async (request) => {
    await requireAdmin(request);
    return deps.registry.list();
  });

  // POST /api/v1/mcp/servers — 新增配置（201；只落盘不自动连接，连接显式走 /connect 或 refreshAll）
  app.post(
    '/api/v1/mcp/servers',
    { ...routeOptions, errorHandler: mapBodyParseError },
    async (request, reply) => {
      await requireAdmin(request);
      const parsed = mcpCreateBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        throw err('VALIDATION_FAILED', { detail: parsed.error.issues });
      }
      const added = await deps.configStore.add({
        ...parsed.data,
        enabled: parsed.data.enabled ?? true,
      });
      reply.code(201);
      return added;
    },
  );

  // DELETE /api/v1/mcp/servers/:id — 删除配置并断开既有连接
  app.delete('/api/v1/mcp/servers/:id', routeOptions, async (request) => {
    await requireAdmin(request);
    const { id } = request.params as { id: string };
    const removed = await deps.configStore.remove(id);
    if (!removed) {
      throw err('EXT_NOT_FOUND', { message: `mcp server "${id}" is not configured`, detail: { id } });
    }
    await deps.registry.disconnect(id);
    return { deleted: true, id };
  });

  // PATCH /api/v1/mcp/servers/:id — enabled/name/headers（enabled:false 立即断连）
  app.patch(
    '/api/v1/mcp/servers/:id',
    { ...routeOptions, errorHandler: mapBodyParseError },
    async (request) => {
      await requireAdmin(request);
      const { id } = request.params as { id: string };
      const parsed = mcpPatchBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        throw err('VALIDATION_FAILED', { detail: parsed.error.issues });
      }
      const updated = await deps.configStore.update(id, parsed.data);
      if (parsed.data.enabled === false) {
        await deps.registry.disconnect(id);
      }
      return updated;
    },
  );

  // POST /api/v1/mcp/servers/:id/connect — 手动（重）连接 → status
  app.post('/api/v1/mcp/servers/:id/connect', routeOptions, async (request) => {
    await requireAdmin(request);
    const { id } = request.params as { id: string };
    return deps.registry.connect(id);
  });

  // GET /api/v1/mcp/tools?serverId= — 工具目录（合并全部已连接 server；可选过滤）
  app.get('/api/v1/mcp/tools', routeOptions, async (request) => {
    await requireAdmin(request);
    const parsed = toolsQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      throw err('VALIDATION_FAILED', { detail: parsed.error.issues });
    }
    return deps.registry.listTools(
      parsed.data.serverId !== undefined ? { serverId: parsed.data.serverId } : undefined,
    );
  });

  // POST /api/v1/mcp/tools/call — 调用远程工具（归一 CallToolResult）
  app.post(
    '/api/v1/mcp/tools/call',
    { ...routeOptions, errorHandler: mapBodyParseError },
    async (request) => {
      await requireAdmin(request);
      const parsed = mcpCallBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        throw err('VALIDATION_FAILED', { detail: parsed.error.issues });
      }
      return deps.registry.callTool(
        parsed.data.serverId,
        parsed.data.toolName,
        parsed.data.args,
        parsed.data.timeoutMs,
      );
    },
  );

  // GET /api/v1/mcp/:id/resources — 资源目录
  app.get('/api/v1/mcp/:id/resources', routeOptions, async (request) => {
    await requireAdmin(request);
    const { id } = request.params as { id: string };
    return deps.registry.listResources(id);
  });

  // GET /api/v1/mcp/:id/prompts — Prompt 目录
  app.get('/api/v1/mcp/:id/prompts', routeOptions, async (request) => {
    await requireAdmin(request);
    const { id } = request.params as { id: string };
    return deps.registry.listPrompts(id);
  });
}
