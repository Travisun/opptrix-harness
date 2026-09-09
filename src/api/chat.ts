/**
 * chat — 聊天 REST API（/api/v1/channels*、/api/v1/messages*）+ 入站 webhook（/hooks/chat/:token）。
 *
 * 频道与成员管理（读取需认证；变更需 admin 及以上，root 放行）：
 * - GET    /api/v1/channels                      列出频道
 * - POST   /api/v1/channels                      创建频道（admin）→ 201 + record
 * - GET    /api/v1/channels/:idOrSlug            读取频道（未找到 → 404 HARNESS-3004）
 * - PATCH  /api/v1/channels/:idOrSlug            部分更新（admin）
 * - DELETE /api/v1/channels/:idOrSlug            删除（admin，级联成员/消息）→ { deleted: true }
 * - GET    /api/v1/channels/:idOrSlug/members    成员列表
 * - POST   /api/v1/channels/:idOrSlug/members    添加成员（admin；body {memberType,memberId}）→ 201
 * - DELETE /api/v1/channels/:idOrSlug/members    移除成员（admin；body {memberType,memberId}）
 *
 * 消息（全部需认证）：
 * - GET    /api/v1/channels/:idOrSlug/messages   列表（?before=<epoch ms>&limit=1..200，升序）
 * - POST   /api/v1/channels/:idOrSlug/messages   发送（body 即 content：{type:'text'|'file'|'card',...}，
 *                                                type==='text' 时 text 必填；senderType='user'、
 *                                                senderId=identity.userId）→ 201 {blocked,message}
 * - PATCH  /api/v1/messages/:id                  更新正文（v1 仅 admin；作者校验留待 v2）→ 200 + message
 *
 * 入站 webhook（公开免鉴权，令牌即凭据）：
 * - POST   /hooks/chat/:token                    body {text, sender?} → 202；
 *                                                无效 token → 404 HARNESS-3004（不回显令牌）
 * - POST   /hooks/connector/:platform/:token     平台连接器统一入站回调（deps.connectors 提供
 *                                                createPlatformConnectors() 时启用）：
 *                                                verifyInbound → parseInbound → sendMessage
 *                                                → 202；无效 token / 校验失败 → 401（不回显令牌）；
 *                                                未内置平台 → 404；feishu url_verification
 *                                                challenge 直回（见 docs/chat-platforms.mdx）
 *
 * 约定：
 * - 鉴权：token 经 extractToken（Authorization: Bearer 优先，其次 ?token=）交
 *   deps.checker 校验；管理类路由要求 role 'root'|'admin'，否则 403 HARNESS-1007；
 * - 入参全部 zod 校验；body 非法 JSON 与校验失败统一 400 HARNESS-1009 VALIDATION_FAILED；
 * - senderType='webhook' 的消息由本模块 webhook 路由产生，senderId 缺省 'webhook'。
 */
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { extractToken } from '../kernel/auth/authProxy.js';
import { err, HarnessError } from '../kernel/errors/index.js';
import type { ChatService } from '../kernel/chat/index.js';
import type { PlatformConnector } from '../kernel/chat/connectors/index.js';
import { parseFeishuChallenge, platformTargetFromMeta } from '../kernel/chat/connectors/index.js';

// ---------------------------------------------------------------------------
// 依赖契约
// ---------------------------------------------------------------------------

/** 鉴权后的最小身份视图（与 authProxy.createAuthChecker 的产物结构兼容） */
export interface ChatRouteIdentity {
  userId: string;
  role: string;
}

/** registerChatRoutes 依赖集合 */
export interface ChatRoutesDeps {
  /**
   * 统一认证入口（authProxy.createAuthChecker 的产物）。
   * 校验失败应抛 HarnessError(UNAUTHORIZED) → 401。
   */
  checker: (input: {
    token?: string;
    headers: Record<string, string | string[] | undefined>;
  }) => Promise<ChatRouteIdentity>;
  /** 聊天领域服务（频道/成员/消息全部委托于此） */
  service: ChatService;
  /**
   * 平台连接器注册中心（可选；缺省时 /hooks/connector/* 一律 404）。
   * 由内核装配层注入 createPlatformConnectors() 产物（get 按平台名取连接器：
   * 入站回调解析 + 出站平台 API 投递，见 src/kernel/chat/connectors/）。
   */
  connectors?: {
    get(platform: string): PlatformConnector | undefined;
  };
}

// ---------------------------------------------------------------------------
// zod schema
// ---------------------------------------------------------------------------

/** POST /api/v1/channels 请求体 */
const createChannelBodySchema = z.object({
  name: z.string().min(1).max(128),
  slug: z
    .string()
    .min(1)
    .max(96)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'slug must be lowercase alnum / hyphen (leading alnum)')
    .optional(),
  type: z.string().min(1).max(32).optional(),
  meta: z.unknown().optional(),
});

/** PATCH /api/v1/channels/:idOrSlug 请求体（全字段可选） */
const patchChannelBodySchema = z.object({
  name: z.string().min(1).max(128).optional(),
  meta: z.unknown().optional(),
});

/** 成员增删请求体（member_type 为 open 枚举：user | bot | ext 等） */
const memberBodySchema = z.object({
  memberType: z.string().min(1).max(64),
  memberId: z.string().min(1).max(128),
});

/** 消息正文：text 型必填 text；file/card 型允许携带任意附加字段 */
const messageContentSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string().min(1).max(20_000) }),
  z.looseObject({ type: z.literal('file') }),
  z.looseObject({ type: z.literal('card') }),
]);

/** GET messages 查询参数（字符串 → 数字） */
const listMessagesQuerySchema = z.object({
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

/** 入站 webhook 请求体 */
const webhookBodySchema = z.object({
  text: z.string().min(1).max(20_000),
  sender: z.string().min(1).max(128).optional(),
});

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

/** 资源未找到（EXT_NOT_FOUND → 404 HARNESS-3004）。 */
function notFound(message: string, detail: Record<string, unknown>): HarnessError {
  return err('EXT_NOT_FOUND', { message, detail });
}

/** fastify JSON body 解析类错误码（仅这两个映射为 VALIDATION_FAILED，其余交回全局兜底） */
const JSON_PARSE_ERROR_CODES = new Set(['FST_ERR_CTP_INVALID_JSON_BODY', 'FST_ERR_CTP_EMPTY_JSON_BODY']);

/**
 * POST/PATCH/DELETE 路由级错误处理：非法 JSON body 映射为 400 VALIDATION_FAILED；
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
 * 向 Fastify 实例注册聊天 API 路由与入站 webhook。
 * 必须在 app.ready() 之前调用（路由注册期）；重复注册会因路由冲突抛错。
 */
export function registerChatRoutes(app: FastifyInstance, deps: ChatRoutesDeps): void {
  /** 认证：checker 失败直接抛（全局错误处理器 → 401） */
  const authenticate = async (request: FastifyRequest): Promise<ChatRouteIdentity> => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    return deps.checker({
      token: extractToken(request.headers, query),
      headers: request.headers,
    });
  };

  /** 认证 + admin 门禁（root 放行）：返回身份供路由使用 */
  const requireAdmin = async (request: FastifyRequest): Promise<ChatRouteIdentity> => {
    const identity = await authenticate(request);
    if (identity.role !== 'root' && identity.role !== 'admin') {
      throw err('FORBIDDEN', {
        message: `chat management requires role admin or root (got "${identity.role}")`,
        detail: { role: identity.role },
      });
    }
    return identity;
  };

  /** 解析 :idOrSlug → 频道；未找到统一 404 HARNESS-3004 */
  const requireChannel = async (idOrSlug: string) => {
    const channel = await deps.service.getChannel(idOrSlug);
    if (channel === null) throw notFound(`chat channel "${idOrSlug}" not found`, { ref: idOrSlug });
    return channel;
  };

  const routeOptions = { schema: { tags: ['chat'] } };

  // -------------------------------------------------------------------------
  // 入站 webhook（公开免鉴权；令牌即凭据）——先注册，避免与受保护路由混淆
  // -------------------------------------------------------------------------

  app.post(
    '/hooks/chat/:token',
    { ...routeOptions, errorHandler: mapBodyParseError },
    async (request, reply) => {
      const { token } = request.params as { token: string };
      const parsed = webhookBodySchema.safeParse(request.body);
      if (!parsed.success) {
        throw err('VALIDATION_FAILED', { detail: parsed.error.issues });
      }
      const channel = await deps.service.getChannelByToken(token);
      if (channel === null) {
        // 不回显令牌（密钥不入日志/响应）
        throw notFound('chat webhook not found (invalid token)', {});
      }
      const result = await deps.service.sendMessage({
        channelId: channel.id,
        senderType: 'webhook',
        senderId: parsed.data.sender ?? 'webhook',
        content: { type: 'text', text: parsed.data.text },
      });
      // 202 = 已受理（异步语义）；被 hook 拦截同样视为已受理，仅回执 blocked 标记
      reply.code(202);
      return result.blocked
        ? { accepted: true, blocked: true, reason: result.reason }
        : { accepted: true, blocked: false, messageId: result.message.id };
    },
  );

  // -------------------------------------------------------------------------
  // 平台连接器统一入站回调（公开免鉴权；令牌即凭据；deps.connectors 提供时启用）
  // -------------------------------------------------------------------------

  app.post(
    '/hooks/connector/:platform/:token',
    { ...routeOptions, errorHandler: mapBodyParseError },
    async (request, reply) => {
      const { platform, token } = request.params as { platform: string; token: string };
      const connector = deps.connectors?.get(platform);
      if (connector === undefined) {
        throw notFound(`chat connector platform "${platform}" is not supported`, { platform });
      }
      const channel = await deps.service.getChannelByToken(token);
      if (channel === null) {
        // 不回显令牌（密钥不入日志/响应）
        throw err('UNAUTHORIZED', { message: 'chat connector callback rejected (invalid token)' });
      }
      // 飞书 url_verification 握手：challenge 直回（在 parseInbound 之前处理）
      if (connector.platform === 'feishu') {
        const challenge = parseFeishuChallenge(request.body);
        if (challenge !== null) return { challenge };
      }
      // 入站校验（如 Telegram secret_token 头；期望值随该频道 meta.bridges 的平台 target 配置）
      if (connector.verifyInbound !== undefined) {
        const verified = await connector.verifyInbound(
          { headers: request.headers, body: request.body },
          platformTargetFromMeta(channel.meta, connector.platform),
        );
        if (!verified) {
          throw err('UNAUTHORIZED', {
            message: `chat connector inbound verification failed (platform "${connector.platform}")`,
            detail: { platform: connector.platform },
          });
        }
      }
      const parsed = connector.parseInbound({ headers: request.headers, body: request.body });
      if (parsed === null || parsed.text.trim() === '') {
        // 非消息载荷（心跳/已跳过事件等）：受理但不入库，避免平台侧重试风暴
        reply.code(202);
        return { accepted: true, ignored: true };
      }
      const result = await deps.service.sendMessage({
        channelId: channel.id,
        senderType: 'webhook',
        senderId: parsed.senderName ?? connector.platform,
        content: { type: 'text', text: parsed.text.slice(0, 20_000) },
      });
      reply.code(202);
      return result.blocked
        ? { accepted: true, blocked: true, reason: result.reason }
        : { accepted: true, blocked: false, messageId: result.message.id };
    },
  );

  // -------------------------------------------------------------------------
  // 频道管理
  // -------------------------------------------------------------------------

  // GET /api/v1/channels — 列出频道（任意已认证身份）
  app.get('/api/v1/channels', routeOptions, async (request) => {
    await authenticate(request);
    return deps.service.listChannels();
  });

  // POST /api/v1/channels — 创建频道（admin）
  app.post(
    '/api/v1/channels',
    { ...routeOptions, errorHandler: mapBodyParseError },
    async (request, reply) => {
      await requireAdmin(request);
      const parsed = createChannelBodySchema.safeParse(request.body);
      if (!parsed.success) {
        throw err('VALIDATION_FAILED', { detail: parsed.error.issues });
      }
      const channel = await deps.service.createChannel(parsed.data);
      reply.code(201);
      return channel;
    },
  );

  // GET /api/v1/channels/:idOrSlug — 读取频道
  app.get('/api/v1/channels/:idOrSlug', routeOptions, async (request) => {
    await authenticate(request);
    const { idOrSlug } = request.params as { idOrSlug: string };
    return requireChannel(idOrSlug);
  });

  // PATCH /api/v1/channels/:idOrSlug — 部分更新（admin）
  app.patch(
    '/api/v1/channels/:idOrSlug',
    { ...routeOptions, errorHandler: mapBodyParseError },
    async (request) => {
      await requireAdmin(request);
      const { idOrSlug } = request.params as { idOrSlug: string };
      const parsed = patchChannelBodySchema.safeParse(request.body);
      if (!parsed.success) {
        throw err('VALIDATION_FAILED', { detail: parsed.error.issues });
      }
      const channel = await deps.service.updateChannel(idOrSlug, parsed.data);
      if (channel === null) throw notFound(`chat channel "${idOrSlug}" not found`, { ref: idOrSlug });
      return channel;
    },
  );

  // DELETE /api/v1/channels/:idOrSlug — 删除（admin，级联成员/消息）
  app.delete('/api/v1/channels/:idOrSlug', routeOptions, async (request) => {
    await requireAdmin(request);
    const { idOrSlug } = request.params as { idOrSlug: string };
    const deleted = await deps.service.deleteChannel(idOrSlug);
    if (!deleted) throw notFound(`chat channel "${idOrSlug}" not found`, { ref: idOrSlug });
    return { deleted: true };
  });

  // -------------------------------------------------------------------------
  // 成员管理
  // -------------------------------------------------------------------------

  // GET members — 成员列表（任意已认证身份）
  app.get('/api/v1/channels/:idOrSlug/members', routeOptions, async (request) => {
    await authenticate(request);
    const { idOrSlug } = request.params as { idOrSlug: string };
    await requireChannel(idOrSlug);
    return deps.service.listMembers(idOrSlug);
  });

  // POST members — 添加成员（admin；幂等）
  app.post(
    '/api/v1/channels/:idOrSlug/members',
    { ...routeOptions, errorHandler: mapBodyParseError },
    async (request, reply) => {
      await requireAdmin(request);
      const { idOrSlug } = request.params as { idOrSlug: string };
      const parsed = memberBodySchema.safeParse(request.body);
      if (!parsed.success) {
        throw err('VALIDATION_FAILED', { detail: parsed.error.issues });
      }
      await requireChannel(idOrSlug);
      const member = await deps.service.addMember(idOrSlug, parsed.data.memberType, parsed.data.memberId);
      reply.code(201);
      return member;
    },
  );

  // DELETE members — 移除成员（admin）
  app.delete(
    '/api/v1/channels/:idOrSlug/members',
    { ...routeOptions, errorHandler: mapBodyParseError },
    async (request) => {
      await requireAdmin(request);
      const { idOrSlug } = request.params as { idOrSlug: string };
      const parsed = memberBodySchema.safeParse(request.body);
      if (!parsed.success) {
        throw err('VALIDATION_FAILED', { detail: parsed.error.issues });
      }
      await requireChannel(idOrSlug);
      const removed = await deps.service.removeMember(idOrSlug, parsed.data.memberType, parsed.data.memberId);
      if (!removed) {
        throw notFound(`member "${parsed.data.memberType}:${parsed.data.memberId}" not in channel "${idOrSlug}"`, {
          ref: idOrSlug,
          memberType: parsed.data.memberType,
          memberId: parsed.data.memberId,
        });
      }
      return { removed: true };
    },
  );

  // -------------------------------------------------------------------------
  // 消息
  // -------------------------------------------------------------------------

  // GET messages — 列表（?before=&limit=；升序返回）
  app.get('/api/v1/channels/:idOrSlug/messages', routeOptions, async (request) => {
    await authenticate(request);
    const { idOrSlug } = request.params as { idOrSlug: string };
    const query = (request.query ?? {}) as Record<string, unknown>;
    const parsed = listMessagesQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw err('VALIDATION_FAILED', { detail: parsed.error.issues });
    }
    await requireChannel(idOrSlug);
    return deps.service.listMessages(idOrSlug, parsed.data);
  });

  // POST messages — 发送消息（任意已认证身份；senderId 锚定为调用者身份，客户端不可伪造）
  app.post(
    '/api/v1/channels/:idOrSlug/messages',
    { ...routeOptions, errorHandler: mapBodyParseError },
    async (request, reply) => {
      const identity = await authenticate(request);
      const { idOrSlug } = request.params as { idOrSlug: string };
      const parsed = messageContentSchema.safeParse(request.body);
      if (!parsed.success) {
        throw err('VALIDATION_FAILED', { detail: parsed.error.issues });
      }
      await requireChannel(idOrSlug);
      const result = await deps.service.sendMessage({
        channelId: undefined,
        slug: idOrSlug,
        senderType: 'user',
        senderId: identity.userId,
        content: parsed.data,
      });
      reply.code(201);
      return result.blocked
        ? { blocked: true, message: null, reason: result.reason }
        : { blocked: false, message: result.message };
    },
  );

  // PATCH /api/v1/messages/:id — 更新正文（v1 仅 admin；作者校验留待 v2）
  app.patch(
    '/api/v1/messages/:id',
    { ...routeOptions, errorHandler: mapBodyParseError },
    async (request) => {
      await requireAdmin(request);
      const { id } = request.params as { id: string };
      const parsed = messageContentSchema.safeParse(request.body);
      if (!parsed.success) {
        throw err('VALIDATION_FAILED', { detail: parsed.error.issues });
      }
      const message = await deps.service.patchMessage(id, parsed.data);
      if (message === null) throw notFound(`chat message "${id}" not found`, { id });
      return message;
    },
  );
}
