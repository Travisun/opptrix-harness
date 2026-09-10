/**
 * agents — Agent 会话 REST API（/api/v1/agents/sessions*）。
 *
 * 路由（全部要求已认证——会话或 API Key；会话级端点先 assertAccess 再动作）：
 * - POST   /api/v1/agents/sessions                创建会话 {title?, model?, systemPrompt?, parentId?}
 *                                                 （userId 不收请求体——从 checker identity 注入）→ 201
 * - GET    /api/v1/agents/sessions?status=&userId= 会话列表（按最后消息时间降序；
 *                                                 普通用户只见本人会话，root/admin 见全部，?userId= 过滤可选）
 * - GET    /api/v1/agents/sessions/:id            读取单个会话（未找到 → 404 HARNESS-3004，他人 → 403）
 * - PATCH  /api/v1/agents/sessions/:id            部分更新 {title?, status?}（归档/恢复/改名）
 * - DELETE /api/v1/agents/sessions/:id            删除会话（级联删消息）→ { ok, deleted }
 * - GET    /api/v1/agents/sessions/:id/messages   消息列表（?before=<消息id游标>&limit=，升序）
 * - POST   /api/v1/agents/sessions/:id/messages   发送用户消息 {content} → 驱动 LLM 回复
 *          （SSE topic `agent:{id}` 实时推送 message.created）→ 200 最终 assistant 消息
 * - POST   /api/v1/agents/sessions/:id/messages/stream  发送用户消息（流式 SSE）{content}
 *          → reply.hijack 裸写 text/event-stream：逐事件 `data: {ChatProgressEvent JSON}\n\n`
 *          （thinking/reply/tool_start/tool_done/done；异常写 error 后 end）。
 *          客户端断开联动 manager.cancelGeneration 取消生成。鉴权/校验先行（401/403/404/400
 *          仍为 JSON 形状），hijack 后的错误以 error 事件下发。
 * - POST   /api/v1/agents/sessions/:id/cancel     取消进行中的生成 → 202 { ok, cancelled }
 *
 * 会话工作区（每根会话一个目录；子会话经 parent 链继承，全部先 assertAccess）：
 * - GET    /api/v1/agents/sessions/:id/workspace?path=&recursive=   目录列表
 *          （path 为会话内相对路径；目录排前按名排序）
 * - GET    /api/v1/agents/sessions/:id/workspace/file?path=         原始字节
 *          （Content-Type 按扩展名推断；.html/.svg 附 CSP 头；全部带 X-Content-Type-Options:
 *          nosniff——供 UI iframe 预览，token 走 ?token=，extractToken 已支持）
 * - PUT    /api/v1/agents/sessions/:id/workspace/file  {path, content(base64), encoding?: 'base64'}
 *          → 写文件（mkdir -p 语义；解码后 ≤8MB）
 * - DELETE /api/v1/agents/sessions/:id/workspace/file?path=         删文件/空目录
 *
 * 约定：
 * - 鉴权：token 经 extractToken（Authorization: Bearer 优先，其次 ?token=）交 deps.checker
 *   校验；失败抛 HarnessError UNAUTHORIZED → 401 HARNESS-1005；
 * - 所有权：root/admin 全通；本人会话放行；system 会话（userId=null）仅 root/admin；
 *   其余 403 FORBIDDEN（assertAccess 统一裁决，Manager 侧实现）；
 * - 入参全部 zod 校验；body 非法 JSON 与 zod 校验失败统一 400 HARNESS-1008/1009；
 * - POST messages 同步等待 LLM 回复（长耗时）；进行中的重复发送 → 429 TOO_MANY_CONCURRENT，
 *   被 cancel 中断 → 503 SERVICE_UNAVAILABLE，LLM 失败按网关错误码原样下发。
 */
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { extractToken } from '../kernel/auth/authProxy.js';
import type { AgentSessionManager } from '../kernel/agents/session.js';
import type { ChatProgressEvent } from '../kernel/agents/chat-progress.js';
import { AGENT_SESSION_STATUSES } from '../kernel/agents/session-store.js';
import { err, HarnessError } from '../kernel/errors/index.js';
import { MAX_FILE_BYTES, type WorkspaceService } from '../kernel/workspace/index.js';

// ---------------------------------------------------------------------------
// 依赖契约
// ---------------------------------------------------------------------------

/** registerAgentRoutes 依赖集合 */
export interface AgentRoutesDeps {
  /**
   * 统一认证入口（authProxy.createAuthChecker 的产物）。
   * 校验失败应抛 HarnessError(UNAUTHORIZED) → 401；userId 用于会话属主注入与所有权过滤
   * （注入式调用兼容：identity 缺 userId 时视为 system 语义，userId=null）。
   */
  checker: (input: {
    token?: string;
    headers: Record<string, string | string[] | undefined>;
  }) => Promise<{ userId?: string; role: string }>;
  /** Agent 会话管理器（全部业务语义委托于此） */
  sessionManager: AgentSessionManager;
  /** 会话工作区内核（/workspace* 目录操作；解析链/路径安全由服务收口） */
  workspace: WorkspaceService;
  /** 系统工具运行时（保留依赖位：工具目录只读投影；当前路由面未消费） */
  systemRuntime?: unknown;
}

// ---------------------------------------------------------------------------
// zod schema
// ---------------------------------------------------------------------------

/** 消息/系统提示的字节上限（64KB，与子代理 prompt 上限一致；zod 按字符计，管理器面不重复校验） */
const TEXT_MAX_CHARS = 65_536;

/** 工作区文件解码后的字节上限（8MB，与 files 桥一致；service.write 内按字节终审） */
const WORKSPACE_FILE_MAX_BYTES = MAX_FILE_BYTES;

/** PUT workspace/file 请求体（content 为 base64 文本；8MB 解码 ≈ 11.18MB base64，再放宽容头） */
const WORKSPACE_FILE_B64_MAX_CHARS = Math.ceil(WORKSPACE_FILE_MAX_BYTES * 1.6);

const putWorkspaceFileBodySchema = z.object({
  path: z.string().min(1).max(2048),
  content: z
    .string()
    .max(WORKSPACE_FILE_B64_MAX_CHARS)
    .regex(/^[A-Za-z0-9+/]*={0,2}$/, 'content must be base64 text'),
  encoding: z.literal('base64').optional(),
});

/** POST /api/v1/agents/sessions 请求体 */
const createSessionBodySchema = z.object({
  title: z.string().min(1).max(200).optional(),
  model: z.string().min(1).max(256).optional(),
  systemPrompt: z.string().min(1).max(TEXT_MAX_CHARS).optional(),
  /** 父会话 id（存在性由 manager 软校验：不存在 → 404 形状） */
  parentId: z.string().min(1).max(128).optional(),
});

/** GET /api/v1/agents/sessions 查询参数（空串视同未提供） */
const listSessionsQuerySchema = z.object({
  status: z.enum(AGENT_SESSION_STATUSES).optional(),
  /** 按属主过滤（仅 root/admin 生效；普通用户恒定只看本人） */
  userId: z.string().min(1).max(128).optional(),
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

/** GET /api/v1/agents/sessions/:id/workspace 查询参数 */
const listWorkspaceQuerySchema = z.object({
  path: z.string().max(2048).optional(),
  recursive: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

/** GET/DELETE /api/v1/agents/sessions/:id/workspace/file 查询参数 */
const workspaceFileQuerySchema = z.object({
  path: z.string().min(1).max(2048),
});

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

/** 会话未找到（EXT_NOT_FOUND 语义贴切 → 404 HARNESS-3004） */
function sessionNotFound(id: string): HarnessError {
  return err('EXT_NOT_FOUND', { message: `agent session "${id}" not found`, detail: { id } });
}

/** iframe 预览安全头：.html/.svg 响应必须携带（default-src 'none' 收口脚本/导航面） */
const PREVIEW_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:";

/** 扩展名 → 预览响应 Content-Type（.html/.svg 附 CSP；其余 octet-stream 收口） */
function previewContentTypeOf(path: string): { contentType: string; csp: boolean } {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  switch (ext) {
    case 'html':
    case 'htm':
      return { contentType: 'text/html; charset=utf-8', csp: true };
    case 'svg':
      return { contentType: 'image/svg+xml', csp: true };
    case 'png':
      return { contentType: 'image/png', csp: false };
    case 'jpg':
    case 'jpeg':
      return { contentType: 'image/jpeg', csp: false };
    case 'webp':
      return { contentType: 'image/webp', csp: false };
    case 'json':
      return { contentType: 'application/json', csp: false };
    default:
      return { contentType: 'application/octet-stream', csp: false };
  }
}

/** fastify JSON body 解析类错误码（仅这两个映射为 VALIDATION_FAILED，其余交回全局兜底） */
const JSON_PARSE_ERROR_CODES = new Set(['FST_ERR_CTP_INVALID_JSON_BODY', 'FST_ERR_CTP_EMPTY_JSON_BODY']);

/**
 * POST/PATCH/PUT 路由级错误处理：非法 JSON body 映射为 400 VALIDATION_FAILED；
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
  // 统一鉴权（任意已认证角色；会话面是 LLM 驱动核心面）。identity.userId 参与所有权语义。
  const requireAuth = async (request: FastifyRequest): Promise<{ userId?: string; role: string }> => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    return deps.checker({
      token: extractToken(request.headers, query),
      headers: request.headers,
    });
  };

  const routeOptions = { schema: { tags: ['agents'] } };
  const bodyRouteOptions = { ...routeOptions, errorHandler: mapBodyParseError };

  // POST /api/v1/agents/sessions — 创建会话（201 + SessionRecord；userId 从 identity 注入）
  app.post('/api/v1/agents/sessions', bodyRouteOptions, async (request, reply) => {
    const identity = await requireAuth(request);
    const parsed = createSessionBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw err('VALIDATION_FAILED', { detail: parsed.error.issues });
    }
    const record = await deps.sessionManager.createSession({
      ...(parsed.data.title !== undefined ? { title: parsed.data.title } : {}),
      ...(parsed.data.model !== undefined ? { model: parsed.data.model } : {}),
      ...(parsed.data.systemPrompt !== undefined ? { systemPrompt: parsed.data.systemPrompt } : {}),
      ...(parsed.data.parentId !== undefined ? { parentId: parsed.data.parentId } : {}),
      // 注入式调用兼容：identity 无 userId（undefined）→ null（system 会话）
      userId: identity.userId ?? null,
    });
    reply.code(201);
    return record;
  });

  // GET /api/v1/agents/sessions?status=&userId= — 会话列表（普通用户恒定只看本人）
  app.get('/api/v1/agents/sessions', routeOptions, async (request) => {
    const identity = await requireAuth(request);
    const query = (request.query ?? {}) as Record<string, unknown>;
    const parsed = listSessionsQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw err('VALIDATION_FAILED', { detail: parsed.error.issues });
    }
    const privileged = identity.role === 'root' || identity.role === 'admin';
    const filter = {
      ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {}),
      // 普通用户强制本人视角（忽略 ?userId=）；root/admin 可显式按 ?userId= 过滤
      ...(privileged
        ? parsed.data.userId !== undefined
          ? { userId: parsed.data.userId }
          : {}
        : { userId: identity.userId ?? '__no_identity__' }),
    };
    return deps.sessionManager.listSessions(filter);
  });

  // GET /api/v1/agents/sessions/:id — 读取单个会话（他人 → 403）
  app.get('/api/v1/agents/sessions/:id', routeOptions, async (request) => {
    const identity = await requireAuth(request);
    const { id } = request.params as { id: string };
    return deps.sessionManager.assertAccess(id, identity); // 命中即返回记录（断言内已加载）
  });

  // PATCH /api/v1/agents/sessions/:id — 部分更新（改名 / 归档恢复；他人 → 403）
  app.patch('/api/v1/agents/sessions/:id', bodyRouteOptions, async (request) => {
    const identity = await requireAuth(request);
    const { id } = request.params as { id: string };
    await deps.sessionManager.assertAccess(id, identity);
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

  // DELETE /api/v1/agents/sessions/:id — 删除会话（级联删消息；他人 → 403）
  app.delete('/api/v1/agents/sessions/:id', routeOptions, async (request) => {
    const identity = await requireAuth(request);
    const { id } = request.params as { id: string };
    await deps.sessionManager.assertAccess(id, identity);
    const deleted = await deps.sessionManager.deleteSession(id);
    if (!deleted) throw sessionNotFound(id);
    return { ok: true, deleted: true };
  });

  // GET /api/v1/agents/sessions/:id/messages — 消息列表（升序；before 游标分页；他人 → 403）
  app.get('/api/v1/agents/sessions/:id/messages', routeOptions, async (request) => {
    const identity = await requireAuth(request);
    const { id } = request.params as { id: string };
    await deps.sessionManager.assertAccess(id, identity);
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

  // POST /api/v1/agents/sessions/:id/messages — 发送用户消息（同步等待 LLM 回复；他人 → 403）
  app.post('/api/v1/agents/sessions/:id/messages', bodyRouteOptions, async (request) => {
    const identity = await requireAuth(request);
    const { id } = request.params as { id: string };
    await deps.sessionManager.assertAccess(id, identity);
    const parsed = sendMessageBodySchema.safeParse(request.body);
    if (!parsed.success) {
      throw err('VALIDATION_FAILED', { detail: parsed.error.issues });
    }
    return deps.sessionManager.sendMessage(id, parsed.data.content);
  });

  // POST /api/v1/agents/sessions/:id/messages/stream — 流式发送（SSE 逐事件下发 Chat 进度）。
  // 鉴权/校验先行（仍走 JSON 错误形状）；此后 reply.hijack 接管，进度逐帧
  // `data: {JSON}\n\n` 写出，异常（取消/网关失败等）写 error 事件后收尾。
  // 断开联动：响应流 close → cancelGeneration（AbortController.abort 的既有语义）；
  // 正常结束时 close 亦触发，但生成已完成、cancel 为幂等 no-op。
  app.post('/api/v1/agents/sessions/:id/messages/stream', bodyRouteOptions, async (request, reply) => {
    const identity = await requireAuth(request);
    const { id } = request.params as { id: string };
    await deps.sessionManager.assertAccess(id, identity);
    const parsed = sendMessageBodySchema.safeParse(request.body);
    if (!parsed.success) {
      throw err('VALIDATION_FAILED', { detail: parsed.error.issues });
    }

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
    });
    const writeFrame = (event: ChatProgressEvent): void => {
      if (raw.writable && !raw.destroyed) raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    // 客户端断开联动：挂在 reply.raw（ServerResponse）'close' 上——request.raw 的 'close'
    // 在现代 Node 于请求体接收完成时即触发（会误杀刚起步的生成），响应流的 close 才对齐
    // 「连接终止/响应收尾」。正常结束时 close 亦触发，但生成已完成，cancel 为幂等 no-op
    // （复用 manager.cancelGeneration → AbortController.abort 的既有语义）。
    const onClose = (): void => {
      deps.sessionManager.cancelGeneration(id);
    };
    raw.on('close', onClose);

    const finish = (): void => {
      raw.off('close', onClose);
      if (raw.writableEnded) return;
      if (raw.writable && !raw.destroyed) {
        raw.end();
        return;
      }
      // 响应已不可写（客户端先一步断开）：显式销毁底层连接，避免半开连接
      // 令 server.close()/优雅关停无限等待
      raw.socket?.destroy();
    };
    try {
      await deps.sessionManager.sendMessage(id, parsed.data.content, writeFrame);
      finish();
    } catch (e) {
      // 已 hijack：无法改状态码 → error 事件收尾（客户端已断开时写入为 no-op）
      writeFrame({
        type: 'error',
        message:
          e instanceof HarnessError
            ? e.message
            : e instanceof Error && e.name === 'AbortError'
              ? 'generation was cancelled'
              : 'internal error',
      });
      finish();
    }
  });

  // POST /api/v1/agents/sessions/:id/cancel — 取消进行中的生成（幂等；202 Accepted；他人 → 403）
  app.post('/api/v1/agents/sessions/:id/cancel', routeOptions, async (request, reply) => {
    const identity = await requireAuth(request);
    const { id } = request.params as { id: string };
    await deps.sessionManager.assertAccess(id, identity);
    const cancelled = deps.sessionManager.cancelGeneration(id);
    reply.code(202);
    return { ok: true, cancelled };
  });

  // -------------------------------------------------------------------------
  // 会话工作区（全部先 assertAccess；目录/路径语义由 WorkspaceService 收口）
  // -------------------------------------------------------------------------

  // GET /api/v1/agents/sessions/:id/workspace?path=&recursive= — 目录列表
  app.get('/api/v1/agents/sessions/:id/workspace', routeOptions, async (request) => {
    const identity = await requireAuth(request);
    const { id } = request.params as { id: string };
    await deps.sessionManager.assertAccess(id, identity);
    const query = (request.query ?? {}) as Record<string, unknown>;
    const parsed = listWorkspaceQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw err('VALIDATION_FAILED', { detail: parsed.error.issues });
    }
    return deps.workspace.list(id, parsed.data.path, parsed.data.recursive);
  });

  // GET /api/v1/agents/sessions/:id/workspace/file?path= — 原始字节（UI iframe 预览用）
  app.get('/api/v1/agents/sessions/:id/workspace/file', routeOptions, async (request, reply: FastifyReply) => {
    const identity = await requireAuth(request);
    const { id } = request.params as { id: string };
    await deps.sessionManager.assertAccess(id, identity);
    const query = (request.query ?? {}) as Record<string, unknown>;
    const parsed = workspaceFileQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw err('VALIDATION_FAILED', { detail: parsed.error.issues });
    }
    const data = await deps.workspace.read(id, parsed.data.path);
    const { contentType, csp } = previewContentTypeOf(parsed.data.path);
    reply.header('content-type', contentType);
    reply.header('x-content-type-options', 'nosniff');
    if (csp) reply.header('content-security-policy', PREVIEW_CSP);
    return reply.send(data);
  });

  // PUT /api/v1/agents/sessions/:id/workspace/file — 写文件（base64；≤8MB；mkdir -p 语义）
  app.put(
    '/api/v1/agents/sessions/:id/workspace/file',
    { ...bodyRouteOptions, bodyLimit: Math.ceil(WORKSPACE_FILE_MAX_BYTES * 1.5) },
    async (request) => {
      const identity = await requireAuth(request);
      const { id } = request.params as { id: string };
      await deps.sessionManager.assertAccess(id, identity);
      const parsed = putWorkspaceFileBodySchema.safeParse(request.body);
      if (!parsed.success) {
        throw err('VALIDATION_FAILED', { detail: parsed.error.issues });
      }
      const data = Buffer.from(parsed.data.content, 'base64');
      if (data.byteLength > WORKSPACE_FILE_MAX_BYTES) {
        throw err('PAYLOAD_TOO_LARGE', {
          message: `workspace file content is ${data.byteLength} bytes, which exceeds the 8MB (${WORKSPACE_FILE_MAX_BYTES} bytes) limit`,
          detail: { bytes: data.byteLength, maxBytes: WORKSPACE_FILE_MAX_BYTES },
        });
      }
      return deps.workspace.write(id, parsed.data.path, data);
    },
  );

  // DELETE /api/v1/agents/sessions/:id/workspace/file?path= — 删文件/空目录
  app.delete('/api/v1/agents/sessions/:id/workspace/file', routeOptions, async (request) => {
    const identity = await requireAuth(request);
    const { id } = request.params as { id: string };
    await deps.sessionManager.assertAccess(id, identity);
    const query = (request.query ?? {}) as Record<string, unknown>;
    const parsed = workspaceFileQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw err('VALIDATION_FAILED', { detail: parsed.error.issues });
    }
    await deps.workspace.delete(id, parsed.data.path);
    return { ok: true, path: parsed.data.path };
  });
}
