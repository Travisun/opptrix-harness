/**
 * notifications — 通知中心 REST API（/api/v1/notifications*）。
 *
 * 路由（读操作任意已认证身份；写操作要求 role root|admin，否则 FORBIDDEN；
 * 渠道配置例外——凭据读取同样要求 admin）：
 * - GET  /api/v1/notifications              列表 ?unread=1&level=&limit=1..500 → { items, unread }
 * - POST /api/v1/notifications/:id/read     标记单条已读 → { ok: true }（不存在 → 404 HARNESS-3004）
 * - POST /api/v1/notifications/read-all     全部已读 → { updated: n }
 * - POST /api/v1/notifications/send         管理员直发通知 → 201 记录（deps.send 未注入 → 501 HARNESS-9004）
 * - GET  /api/v1/notifications/routes       读取默认渠道路由规则（settings 持久化，集成方提供）
 * - PUT  /api/v1/notifications/routes       覆写路由规则数组 → { ok: true }
 * - GET  /api/v1/notifications/channels     渠道凭据与目标（admin；settings 两键合并默认；
 *                                           passSecretRef 只回引用名不回值；未接线 → 501）
 * - PUT  /api/v1/notifications/channels     覆写渠道配置（zod 校验 + 未知键剥离 → settings）→ { ok: true }
 * - GET  /api/v1/notifications/drivers      可用驱动清单 { notification: [], chat: [] }
 *
 * 约定：
 * - 鉴权：token 经 extractToken（Authorization: Bearer 优先，其次 ?token=）交
 *   deps.checker 校验；失败抛 UNAUTHORIZED → 401；
 * - 入参全部 zod 校验；body 非法 JSON（解析失败）与 zod 校验失败统一
 *   400 HARNESS-1009 VALIDATION_FAILED（detail = issues）；
 * - 读取走 deps.store（NotificationStore 契约），路由规则走 deps.getRoutes/setRoutes，
 *   渠道配置走可选的 deps.getChannels/setChannels（settings 'notify.channels.*'，
 *   未注入即 501），直发走可选的 deps.send（未注入即 501，保持本模块对投递实现不可知）。
 * - 密钥安全：渠道配置里 SMTP 密码只存 secrets 引用名（passSecretRef），本模块不接
 *   secrets、不解析引用——GET 永远只回引用名；PUT 经 zod strip 丢弃一切未知键
 *  （如 pass/password 明文），落 settings 的形状恒为白名单字段。
 */
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { extractToken } from '../kernel/auth/authProxy.js';
import { err, HarnessError } from '../kernel/errors/index.js';

/** 列表查询缺省 limit（服务端兜底，防全表拉取） */
const DEFAULT_LIST_LIMIT = 50;

// ---------------------------------------------------------------------------
// 依赖契约
// ---------------------------------------------------------------------------

/** deps.send 的规范化入参（REST 层已补齐缺省值） */
export interface NotificationSendInput {
  title: string;
  /** 缺省 '' */
  body: string;
  /** 缺省 'info' */
  level: string;
  /** 缺省 null */
  data: unknown;
  /** 缺省 []（通知中心 UI 始终展示；渠道投递由路由规则决定） */
  channels: string[];
  /**
   * 与 channels 同下标的投递目标（仅当请求以对象形 `[{driver, target}]` 显式给出
   * 渠道时携带；纯字符串形请求保持既有形状不带本字段）。集成方把它映射为
   * manager 投递计划的 target；未携带时各渠道按既有语义以空 target 投递
   * （由各驱动自行校验——渠道配置 UI 的「测试发送」依赖本字段携带表单值）。
   */
  channelTargets?: unknown[];
}

/** registerNotificationRoutes 依赖集合 */
export interface NotificationRoutesDeps {
  /**
   * 统一认证入口（authProxy.createAuthChecker 的产物）。
   * 校验失败应抛 HarnessError(UNAUTHORIZED) → 401；写操作 role 非
   * 'root'|'admin' 时本模块抛 FORBIDDEN → 403。
   */
  checker: (input: {
    token?: string;
    headers: Record<string, string | string[] | undefined>;
  }) => Promise<{ role: string }>;
  /** 通知存储（NotificationStore 契约，通常为 knex 实现的门面） */
  store: {
    list(opts?: { unreadOnly?: boolean; level?: string; limit?: number }): Promise<Record<string, unknown>[]>;
    markRead(id: string): Promise<boolean>;
    markAllRead(): Promise<number>;
    unreadCount(): Promise<number>;
    create(rec: Record<string, unknown>): Promise<void>;
  };
  /** 读取默认渠道路由规则（settings 持久化由集成方实现） */
  getRoutes: () => Promise<unknown>;
  /** 覆写默认渠道路由规则（持久化由集成方实现） */
  setRoutes: (rules: unknown) => Promise<void>;
  /** 可用驱动清单（按用途分组） */
  drivers: () => { notification: string[]; chat: string[] };
  /**
   * 渠道凭据与目标的原始读取（可选；集成方接 settings 两键
   * 'notify.channels.webhook' / 'notify.channels.email'，缺省值合并由本模块做）。
   * 未注入时 GET /channels 返回 501 NOT_IMPLEMENTED。
   */
  getChannels?: () => Promise<{ webhook: unknown; email: unknown }>;
  /**
   * 渠道配置持久化（可选；集成方接 settings.set 同两键）。入参为 zod 校验 +
   * 缺省归一化后的白名单形状（未知键已在 REST 层剥离）。
   * 未注入时 PUT /channels 返回 501 NOT_IMPLEMENTED。
   */
  setChannels?: (next: NotificationChannelsConfig) => Promise<void>;
  /**
   * 直发管道（可选）：校验后的入参 → 创建通知记录 + 按路由规则投递。
   * 未注入时 POST /send 返回 501 NOT_IMPLEMENTED。
   */
  send?: (input: NotificationSendInput) => Promise<unknown>;
}

// ---------------------------------------------------------------------------
// 渠道配置（notify.channels.*：渠道凭据与目标；与通知中心「渠道配置」UI 同一落点）
// ---------------------------------------------------------------------------

/** settings 键：webhook 渠道配置（{ url, secret }） */
export const NOTIFY_WEBHOOK_CHANNEL_KEY = 'notify.channels.webhook';

/** settings 键：email 渠道配置（{ smtp: {…}, from, to }） */
export const NOTIFY_EMAIL_CHANNEL_KEY = 'notify.channels.email';

/** webhook 渠道配置（secret 为共享签名密钥明文；空串 = 未配置） */
export interface WebhookChannelConfig {
  /** 完整 http(s) 地址；'' = 未配置 */
  url: string;
  /** HMAC 共享密钥；'' = 不带签名投递 */
  secret: string;
}

/** SMTP 连接配置（密码只存 secrets 引用名 passSecretRef，明文密码永不落配置） */
export interface SmtpChannelConfig {
  /** SMTP 主机；'' = 未配置 */
  host: string;
  /** 端口（缺省 587 / STARTTLS 惯例） */
  port: number;
  /** true = SMTPS(465 直连 TLS)；false = STARTTLS/明文 */
  secure: boolean;
  /** 认证用户名；'' = 匿名 */
  user: string;
  /** 密码的 kernel secrets 引用名；'' = 不附 auth。只回引用名，永不回明文 */
  passSecretRef: string;
}

/** email 渠道配置 */
export interface EmailChannelConfig {
  smtp: SmtpChannelConfig;
  /** 发件人 */
  from: string;
  /** 收件人（单地址或逗号分隔多地址）；'' = 未配置 */
  to: string;
}

/** GET/PUT /api/v1/notifications/channels 的归一化形状 */
export interface NotificationChannelsConfig {
  webhook: WebhookChannelConfig;
  email: EmailChannelConfig;
}

/** 渠道配置缺省值（settings 无值/形状非法时合并兜底，UI 表单可直接渲染） */
export const DEFAULT_NOTIFICATION_CHANNELS: NotificationChannelsConfig = {
  webhook: { url: '', secret: '' },
  email: {
    smtp: { host: '', port: 587, secure: false, user: '', passSecretRef: '' },
    from: '',
    to: '',
  },
};

/** settings 原始值 → 对象（非对象形状一律视为未配置） */
function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * settings 两键原始值 → 合并缺省的完整形状（浅合并 + smtp 嵌套合并）。
 * settings 属外部入参，形状非法的字段按缺省处理；本函数不做逐字段类型修正
 * （zod 口径在 PUT 入口把关，GET 只做形状兜底）。
 */
export function mergeNotificationChannels(raw: { webhook?: unknown; email?: unknown }): NotificationChannelsConfig {
  const defaults = DEFAULT_NOTIFICATION_CHANNELS;
  const webhook = { ...defaults.webhook, ...asRecord(raw.webhook) } as WebhookChannelConfig;
  const rawEmail = asRecord(raw.email);
  const email = {
    ...defaults.email,
    ...rawEmail,
    smtp: { ...defaults.email.smtp, ...asRecord(rawEmail['smtp']) },
  } as EmailChannelConfig;
  return { webhook, email };
}

// ---------------------------------------------------------------------------
// zod schema
// ---------------------------------------------------------------------------

/** GET /api/v1/notifications 查询参数 */
const listQuerySchema = z.object({
  unread: z.enum(['0', '1', 'true', 'false']).optional(),
  level: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

/** PUT /channels 渠道 schema：全部字段可选（部分更新），输出补齐缺省；未知键剥离 */
const webhookChannelSchema = z.object({
  url: z.union([z.url(), z.literal('')]).default(''),
  secret: z.string().max(2048).default(''),
});

const smtpChannelSchema = z.object({
  host: z.string().max(255).default(''),
  port: z.coerce.number().int().min(1).max(65535).default(587),
  secure: z.boolean().default(false),
  user: z.string().max(255).default(''),
  passSecretRef: z.string().max(255).default(''),
});

const emailChannelSchema = z.object({
  smtp: smtpChannelSchema.default({ host: '', port: 587, secure: false, user: '', passSecretRef: '' }),
  from: z.string().max(320).default(''),
  to: z.string().max(1024).default(''),
});

/** PUT /channels 请求体：{ webhook?, email? }（zod strip 保证密钥类未知键不入 settings） */
const channelsBodySchema = z.object({
  webhook: webhookChannelSchema.default({ url: '', secret: '' }),
  email: emailChannelSchema.default({ smtp: { host: '', port: 587, secure: false, user: '', passSecretRef: '' }, from: '', to: '' }),
});

/** POST /api/v1/notifications/send 请求体 */
const sendBodySchema = z.object({
  title: z.string().min(1).max(256),
  body: z.string().max(10_000).optional(),
  level: z.string().min(1).max(32).optional(),
  data: z.unknown().optional(),
  /**
   * 渠道两形：'driver'（既有契约，target 由集成方给空对象）或
   * { driver, target }（渠道配置 UI「测试发送」携带当前表单值）。
   */
  channels: z
    .array(
      z.union([
        z.string().min(1),
        z.object({ driver: z.string().min(1), target: z.unknown() }),
      ]),
    )
    .optional(),
});

/** 单条渠道路由：driver 名 + driver 语义内的 target（形状由各驱动自校验，此处不约束） */
const routeChannelSchema = z.object({
  driver: z.string().min(1),
  target: z.unknown(),
});

/** 单条路由规则：match.level 缺省 = 匹配全部级别 */
const routeRuleSchema = z.object({
  match: z.object({ level: z.string().min(1).optional() }),
  channels: z.array(routeChannelSchema).min(1).max(16),
});

/** PUT /api/v1/notifications/routes 请求体：规则数组 */
const routesBodySchema = z.array(routeRuleSchema).max(100);

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

/** 通知未找到（EXT_NOT_FOUND 语义贴切 → 404 HARNESS-3004，与 cron 模块一致） */
function notificationNotFound(id: string): HarnessError {
  return err('EXT_NOT_FOUND', { message: `notification "${id}" not found`, detail: { id } });
}

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

// ---------------------------------------------------------------------------
// 路由注册
// ---------------------------------------------------------------------------

/**
 * 向 Fastify 实例注册通知中心 API 路由。
 * 必须在 app.ready() 之前调用（路由注册期）；重复注册会因路由冲突抛错。
 */
export function registerNotificationRoutes(app: FastifyInstance, deps: NotificationRoutesDeps): void {
  // 统一鉴权（读操作仅需已认证身份）
  const authenticate = async (request: FastifyRequest): Promise<{ role: string }> => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    return deps.checker({
      token: extractToken(request.headers, query),
      headers: request.headers,
    });
  };

  // 写操作门禁：admin 及以上（root 放行），否则 FORBIDDEN
  const requireAdmin = async (request: FastifyRequest): Promise<void> => {
    const identity = await authenticate(request);
    if (identity.role !== 'root' && identity.role !== 'admin') {
      throw err('FORBIDDEN', {
        message: `notification write requires role admin or root (got "${identity.role}")`,
        detail: { role: identity.role },
      });
    }
  };

  const routeOptions = { schema: { tags: ['notifications'] } };

  // GET /api/v1/notifications — 列表（?unread=1&level=&limit=；{items, unread}）
  app.get('/api/v1/notifications', routeOptions, async (request) => {
    await authenticate(request);
    const query = (request.query ?? {}) as Record<string, unknown>;
    const parsed = listQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw err('VALIDATION_FAILED', { detail: parsed.error.issues });
    }
    const opts: { unreadOnly?: boolean; level?: string; limit?: number } = {};
    if (parsed.data.unread === '1' || parsed.data.unread === 'true') opts.unreadOnly = true;
    if (parsed.data.level !== undefined) opts.level = parsed.data.level;
    opts.limit = parsed.data.limit ?? DEFAULT_LIST_LIMIT;

    const [items, unread] = await Promise.all([deps.store.list(opts), deps.store.unreadCount()]);
    return { items, unread };
  });

  // POST /api/v1/notifications/:id/read — 标记单条已读（写操作）
  app.post(
    '/api/v1/notifications/:id/read',
    { ...routeOptions, errorHandler: mapBodyParseError },
    async (request) => {
      await requireAdmin(request);
      const { id } = request.params as { id: string };
      const ok = await deps.store.markRead(id);
      if (!ok) throw notificationNotFound(id);
      return { ok: true };
    },
  );

  // POST /api/v1/notifications/read-all — 全部已读（写操作）
  app.post(
    '/api/v1/notifications/read-all',
    { ...routeOptions, errorHandler: mapBodyParseError },
    async (request) => {
      await requireAdmin(request);
      const updated = await deps.store.markAllRead();
      return { updated };
    },
  );

  // POST /api/v1/notifications/send — 管理员直发（201 记录；未注入 deps.send → 501）
  app.post(
    '/api/v1/notifications/send',
    { ...routeOptions, errorHandler: mapBodyParseError },
    async (request, reply) => {
      await requireAdmin(request);
      if (deps.send === undefined) {
        throw err('NOT_IMPLEMENTED', {
          message: 'notification send is not wired (no deps.send provider registered)',
        });
      }
      const parsed = sendBodySchema.safeParse(request.body);
      if (!parsed.success) {
        throw err('VALIDATION_FAILED', { detail: parsed.error.issues });
      }
      // 渠道两形归一：字符串形保持既有形状（不带 channelTargets）；对象形把
      // target 按同下标放入 channelTargets，交由集成方映射为投递计划
      const rawChannels = parsed.data.channels ?? [];
      const channels: string[] = [];
      const targets: unknown[] = [];
      let hasTarget = false;
      for (const item of rawChannels) {
        if (typeof item === 'string') {
          channels.push(item);
          targets.push(undefined);
        } else {
          channels.push(item.driver);
          targets.push(item.target);
          hasTarget = true;
        }
      }
      const input: NotificationSendInput = {
        title: parsed.data.title,
        body: parsed.data.body ?? '',
        level: parsed.data.level ?? 'info',
        data: parsed.data.data ?? null,
        channels,
        ...(hasTarget ? { channelTargets: targets } : {}),
      };
      const record = await deps.send(input);
      reply.code(201);
      return record ?? input;
    },
  );

  // GET /api/v1/notifications/routes — 默认渠道路由规则（读操作）
  app.get('/api/v1/notifications/routes', routeOptions, async (request) => {
    await authenticate(request);
    return deps.getRoutes();
  });

  // PUT /api/v1/notifications/routes — 覆写路由规则数组（写操作）
  app.put(
    '/api/v1/notifications/routes',
    { ...routeOptions, errorHandler: mapBodyParseError },
    async (request) => {
      await requireAdmin(request);
      const parsed = routesBodySchema.safeParse(request.body);
      if (!parsed.success) {
        throw err('VALIDATION_FAILED', {
          message: 'routes must be an array of { match: { level? }, channels: [{ driver, target }] }',
          detail: parsed.error.issues,
        });
      }
      await deps.setRoutes(parsed.data);
      return { ok: true };
    },
  );

  // GET /api/v1/notifications/channels — 渠道凭据与目标（admin 门禁：响应含凭据字段；
  // settings 未配置的两键合并缺省返回；passSecretRef 只回引用名，本模块不接 secrets）
  app.get('/api/v1/notifications/channels', routeOptions, async (request) => {
    await requireAdmin(request);
    if (deps.getChannels === undefined) {
      throw err('NOT_IMPLEMENTED', {
        message: 'notification channels config is not wired (no deps.getChannels provider registered)',
      });
    }
    const raw = await deps.getChannels();
    return mergeNotificationChannels(raw ?? {});
  });

  // PUT /api/v1/notifications/channels — 覆写渠道配置（admin；zod 校验 + 未知键剥离
  // 后整体落 settings 两键；'' 端口等缺省由 schema 补齐）
  app.put(
    '/api/v1/notifications/channels',
    { ...routeOptions, errorHandler: mapBodyParseError },
    async (request) => {
      await requireAdmin(request);
      if (deps.setChannels === undefined) {
        throw err('NOT_IMPLEMENTED', {
          message: 'notification channels config is not wired (no deps.setChannels provider registered)',
        });
      }
      const parsed = channelsBodySchema.safeParse(request.body);
      if (!parsed.success) {
        throw err('VALIDATION_FAILED', {
          message:
            'channels must be { webhook?: { url, secret }, email?: { smtp: { host, port, secure, user, passSecretRef }, from, to } }',
          detail: parsed.error.issues,
        });
      }
      await deps.setChannels(parsed.data);
      return { ok: true };
    },
  );

  // GET /api/v1/notifications/drivers — 可用驱动清单（读操作）
  app.get('/api/v1/notifications/drivers', routeOptions, async (request) => {
    await authenticate(request);
    return deps.drivers();
  });
}
