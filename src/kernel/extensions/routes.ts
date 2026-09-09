/**
 * extensions/routes — 扩展路由机制（wildcard 兜底 + 运行时查表）。
 *
 * 设计要点：
 * - 挂载方式：在 Fastify 实例上注册**单条通配兜底路由**（`/ext/:extId/*` 与 `/ext/:extId`，
 *   find-my-way wildcard），运行时查 Registry 匹配 (extId, method, path)。路径匹配自行实现：
 *   精确段匹配 + `:param` 提取 + `*` 尾通配；**大小写敏感**。commit/remove 只换表，
 *   兜底路由与具体路由表无关，注册一次即可（"重新挂载"为幂等 no-op）。
 * - 三态区分：表内无此 extId 任何路由 → 404 ROUTE_NOT_FOUND；有扩展但无此路径 → 404；
 *   扩展被禁用 / 摘表（remove 后的墓碑）/ drain 换表中 → 503 SERVICE_UNAVAILABLE。
 * - 鉴权前置（entry.auth !== 'public' 时才调 checker）：user 恒过（无 public 角色）；
 *   admin 要求 role ∈ ['root','admin']；scope 要求 identity.scopes 含 '*' 或该 scope。
 * - 并发闸：per-ext inflight ≥ maxConcurrentPerExt → TOO_MANY_CONCURRENT。
 * - body：GET/DELETE 不解析；POST/PUT/PATCH 用 fastify 已解析的 request.body；
 *   非 JSON content-type 时另透传 rawBody（见 mountWildcard 内注释的最小侵入实现）。
 * - drain：remove/commit 前对同 extId 旧表的在途请求有界等待（100ms 轮询，上限 5s），
 *   超时继续换表（在途请求按既有 entry 完成，迟到响应对新表不可见）。
 *   等待期间该扩展的新请求 → 503（SERVICE_UNAVAILABLE，"reloading" 语义）。
 *   在途为 0 时走同步快路径，commit/remove 保持同步原子语义。
 * - 计数：counters?.inc('ext.route.requests', {extId, route}) + 响应码计数
 *   （counters 同时充当 drain 超时的日志替代，见 drain 内 'ext.route.drain_timeout'）。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { extractToken } from '../auth/authProxy.js';
import { err, HarnessError } from '../errors/HarnessError.js';

// ---------------------------------------------------------------------------
// 契约类型
// ---------------------------------------------------------------------------

/** 扩展路由的鉴权级别 */
export type ExtRouteAuth = 'public' | 'user' | 'admin';

/** 一条扩展路由声明（来自 manifest routes 段，经 ExtensionManager 递交） */
export interface ExtRouteEntry {
  extId: string;
  method: string;
  path: string;
  auth: ExtRouteAuth;
  /** 需要的权限 scope；identity.scopes 含 '*' 或该值即放行 */
  scope?: string;
  /** 本路由的 dispatch 超时；缺省用 deps.defaultTimeoutMs */
  timeoutMs?: number;
}

/** 透传给扩展 handler 的请求信封 */
export interface ExtDispatchRequest {
  method: string;
  params: Record<string, string>;
  query: Record<string, unknown>;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  rawBody?: string;
  requestId: string;
}

/** 扩展 handler 的响应信封 */
export interface ExtDispatchResult {
  status: number;
  headers?: Record<string, string>;
  body: unknown;
}

/**
 * 扩展路由派发门面 —— bridge.callToWorker(HOST_METHODS.routeRequest) 的包装，
 * 由集成方（ExtensionManager/Bridge）注入；本模块不关心 worker 细节。
 * `extId` 为本次命中的路由归属扩展（查表裁决结果），跨扩展同名路由时以此消歧。
 */
export interface ExtRouteDispatcher {
  dispatch(
    routeKey: string,
    request: ExtDispatchRequest,
    timeoutMs: number,
    extId?: string,
  ): Promise<ExtDispatchResult>;
}

/** 计数器最小接口（对接 kernel metrics） */
export interface ExtRouteCounters {
  inc(name: string, tags?: Record<string, string>): void;
}

/** 日志最小接口（pino Logger 结构兼容，避免本模块直接依赖 pino 类型） */
export interface ExtRouteLogger {
  warn(msg: string, obj?: Record<string, unknown>): void;
}

/** ExtRouteRegistry 依赖集合 */
export interface ExtRoutesDeps {
  app: FastifyInstance;
  /**
   * 统一认证入口（authProxy.createAuthChecker 的产物或等价物）。
   * 返回 null 表示拒绝（本模块转为 UNAUTHORIZED）；直接抛 HarnessError(UNAUTHORIZED) 亦可。
   */
  checker: (input: {
    token?: string;
    headers: Record<string, string | string[] | undefined>;
  }) => Promise<{ userId: string; role: 'root' | 'admin' | 'normal'; scopes: string[] } | null>;
  dispatcher: ExtRouteDispatcher;
  defaultTimeoutMs: number;
  maxConcurrentPerExt: number;
  /** ExtensionManager 的启用位：false 表示扩展已被禁用（即使路由表仍在）→ 503 */
  isExtEnabled(extId: string): boolean;
  /** 该扩展是否属于内置池（受信第一方）：决定是否保留 authorization 头 */
  isBuiltinExt?: (extId: string) => boolean;
  counters?: ExtRouteCounters;
  /** 可选 warn 日志（drain 超时等异常路径）；未注入时以 counters 替代 */
  logger?: ExtRouteLogger;
}

// ---------------------------------------------------------------------------
// 常量与 zod schema
// ---------------------------------------------------------------------------

/** drain 轮询间隔（ms） */
const DRAIN_POLL_INTERVAL_MS = 100;
/** drain 有界等待上限（ms）；超时继续换表 */
const DRAIN_MAX_WAIT_MS = 5_000;

/**
 * SEC-7：下发扩展 handler 的请求头白名单（小写）。
 * authorization / cookie 及其余未列名头部一律剔除——扩展路由是第三方代码，
 * 全量透传会把调用方的凭据泄露给扩展（auth mount 的 provider 校验由内核完成）。
 */
const EXT_HEADER_ALLOWLIST: ReadonlySet<string> = new Set([
  'content-type',
  'content-length',
  'user-agent',
  'accept',
  'x-requested-with',
  'authorization',
  'x-harness-signature',
  'x-harness-timestamp',
]);

/**
 * SEC-7：按白名单裁剪请求头（保留原键的大小写形式；仅小写比较）。
 * 内核→扩展方向的所有请求头下发（/ext/* 通配与 builtin auth mount）统一走这里。
 */
export function sanitizeExtHeaders(
  headers: Record<string, string | string[] | undefined>,
  opts?: { keepAuthorization?: boolean },
): Record<string, string | string[] | undefined> {
  // 安全默认：authorization 一律剥离（防调用方令牌被扩展代码收割）；
  // 仅受信第一方（内置池，如 auth 扩展自身）由调用方显式 keepAuthorization 放行
  const keepAuth = opts?.keepAuthorization === true;
  const out: Record<string, string | string[] | undefined> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (lower === 'authorization') {
      if (keepAuth) out[name] = value;
      continue;
    }
    if (EXT_HEADER_ALLOWLIST.has(lower)) out[name] = value;
  }
  return out;
}

/** extId 作为 URL 段与表键：仅允许字母数字与 . _ - */
const EXT_ID_SCHEMA = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);

/** 单条路由声明校验（manifest routes 段的形状契约） */
const ROUTE_ENTRY_SCHEMA = z.object({
  extId: EXT_ID_SCHEMA,
  method: z
    .string()
    .min(2)
    .max(16)
    .regex(/^[A-Z][A-Z0-9]*$/, 'method 必须为全大写 HTTP 方法（如 GET/POST）'),
  path: z
    .string()
    .min(1)
    .max(2048)
    .refine((p) => p.startsWith('/'), 'path 必须以 / 开头')
    .refine((p) => !p.split('/').includes('..'), 'path 禁止包含 ".." 段')
    .refine((p) => !p.includes('\\') && !/[\s\0-\x1f]/.test(p), 'path 禁止包含反斜杠与空白/控制字符'),
  auth: z.enum(['public', 'user', 'admin']),
  scope: z.string().min(1).max(256).optional(),
  timeoutMs: z.number().int().min(1).max(3_600_000).optional(),
});

/** dispatcher 返回信封校验（worker 属外部边界，ENGINEERING 规则：入参须校验） */
const DISPATCH_RESULT_SCHEMA = z.object({
  status: z.number().int().min(100).max(599),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.unknown(),
});

// ---------------------------------------------------------------------------
// 路径编译与匹配（大小写敏感）
// ---------------------------------------------------------------------------

interface CompiledRoute {
  entry: ExtRouteEntry;
  /** 编译后的段：字面量或 ':name'；'*' 只允许出现在末段 */
  segments: string[];
  /** 是否以 `*` 尾通配结尾 */
  wildcard: boolean;
}

/** 声明路径 → 编译段（去前导斜杠；'/a/*' → ['a','*']） */
function compilePath(path: string): { segments: string[]; wildcard: boolean } {
  const trimmed = path.replace(/^\/+/, '');
  const raw = trimmed === '' ? [] : trimmed.split('/');
  // 去掉非通配路径的尾空段（'/a/' 与 '/a' 等价）
  while (raw.length > 1 && raw[raw.length - 1] === '') raw.pop();
  const wildcard = raw[raw.length - 1] === '*';
  return { segments: raw, wildcard };
}

/** 请求子路径拆段（保留尾空段：'files/' → ['files','']，供 `*` 通配空尾判定） */
function splitSubPath(subPath: string): string[] {
  const s = subPath.replace(/^\/+/, '');
  return s === '' ? [] : s.split('/');
}

/**
 * 单条编译路由与请求段匹配；命中返回提取的 params（含 ':name' 与 '*' 尾段），未命中返回 null。
 * 通配需要至少保留尾斜杠（'/files/*' 匹配 '/files/' 与 '/files/a'，不匹配 '/files'）。
 */
function matchCompiled(route: CompiledRoute, reqSegments: string[]): Record<string, string> | null {
  // 普通路由要求段数相等；通配路由要求请求段数 ≥ 模式段数
  // （'/files/*' 匹配 'files/' 与 'files/a/b'，不匹配 'files'——尾通配至少保留尾斜杠）
  if (route.wildcard) {
    if (reqSegments.length < route.segments.length) return null;
  } else if (reqSegments.length !== route.segments.length) {
    return null;
  }
  const params: Record<string, string> = {};
  for (let i = 0; i < route.segments.length; i++) {
    const seg = route.segments[i] as string;
    if (seg === '*') {
      params['*'] = reqSegments.slice(i).join('/');
      return params;
    }
    const actual = reqSegments[i];
    if (actual === undefined) return null;
    if (seg.startsWith(':')) {
      params[seg.slice(1)] = actual;
    } else if (seg !== actual) {
      return null; // 字面量段精确比较 → 大小写敏感
    }
  }
  return params;
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

function isJsonContentType(ct: string | string[] | undefined): boolean {
  const value = Array.isArray(ct) ? ct[0] : ct;
  if (value === undefined) return false;
  return /^\s*application\/([\w.+-]+\+)?json\b/i.test(value);
}

/**
 * 取 rawBody：集成方若经 preParsing 钩子挂了 request.rawBody 则优先；
 * 否则利用 body 即原始字符串的解析器产物（octet-stream / text/plain）。
 */
function rawBodyOf(request: FastifyRequest): string | undefined {
  const attached = (request as { rawBody?: unknown }).rawBody;
  if (typeof attached === 'string') return attached;
  if (typeof request.body === 'string') return request.body;
  return undefined;
}

function buildDispatchRequest(
  request: FastifyRequest,
  params: Record<string, string>,
  keepAuthorizationOpt?: boolean,
): ExtDispatchRequest {
  const method = request.method;
  let body: unknown = null;
  let rawBody: string | undefined;
  if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
    body = request.body ?? null;
    if (!isJsonContentType(request.headers['content-type'])) {
      rawBody = rawBodyOf(request) ?? '';
    }
  }
  return {
    method,
    params,
    query: (request.query ?? {}) as Record<string, unknown>,
    // SEC-7：白名单裁剪（authorization/cookie 等凭据头不下发给扩展）
    headers: sanitizeExtHeaders(request.headers as Record<string, string | string[] | undefined>, {
      // 内置池（受信第一方，如 auth）保留 authorization 以支持标准 Bearer；
      // 社区池剥离——防止调用方令牌被第三方扩展代码收割（stripAuthorization 由调用方按池决定）
      keepAuthorization: keepAuthorizationOpt === true,
    }),
    body,
    ...(rawBody !== undefined ? { rawBody } : {}),
    requestId: String(request.id),
  };
}

// ---------------------------------------------------------------------------
// ExtRouteRegistry
// ---------------------------------------------------------------------------

/** 单条通配兜底路由（挂载在 app 根作用域） */
const WILDCARD_NESTED = '/ext/:extId/*';
const WILDCARD_BARE = '/ext/:extId';

/**
 * 扩展路由注册表：持有各扩展的生效路由表，并提供挂在通配兜底路由上的统一 handler。
 * 生命周期：constructor 注册兜底路由与 content-type parser → commit/remove 原子换表。
 */
export class ExtRouteRegistry {
  private readonly deps: ExtRoutesDeps;
  /** extId → 生效路由表（CompiledRoute） */
  private readonly tables = new Map<string, CompiledRoute[]>();
  /** 当前启用位（commit 置位、remove 摘除）；与 tables 键同步维护 */
  private readonly enabledExtIds = new Set<string>();
  /** 墓碑：remove 后保留，使后续请求回 503（扩展存在但不可用）而非 404（从未存在） */
  private readonly knownExtIds = new Set<string>();
  /** per-ext 在途请求数 */
  private readonly inflight = new Map<string, number>();
  /** drain（换表/摘表等待）中的 extId：期间新请求 → 503 */
  private readonly draining = new Set<string>();
  private mounted = false;

  constructor(deps: ExtRoutesDeps) {
    this.deps = deps;
    this.mountWildcard();
  }

  // ---- 公开 API ------------------------------------------------------------

  /**
   * 原子换表：整体替换某扩展的路由（先 drain 该扩展在途请求，有界 5s，超时继续）。
   * 校验失败（形状非法 EXT_MANIFEST_INVALID / 表内重复路由 EXT_ROUTE_CONFLICT）在 drain 前同步抛出。
   */
  commit(extId: string, routes: ExtRouteEntry[]): void {
    const compiled = this.validateAndCompile(extId, routes);
    this.drainThenSwap(extId, () => {
      this.tables.set(extId, compiled);
      this.enabledExtIds.add(extId);
      this.knownExtIds.add(extId);
    });
  }

  /** 整表摘除（保留墓碑：摘除后该扩展请求 → 503 SERVICE_UNAVAILABLE） */
  remove(extId: string): void {
    this.drainThenSwap(extId, () => {
      this.tables.delete(extId);
      this.enabledExtIds.delete(extId);
    });
  }

  /** 全量只读快照（条目为浅拷贝，调用方改动不影响注册表） */
  getTable(): ExtRouteEntry[] {
    const out: ExtRouteEntry[] = [];
    for (const compiled of this.tables.values()) {
      for (const route of compiled) out.push({ ...route.entry });
    }
    return out;
  }

  /** 在途统计（含墓碑中的扩展，便于运维观察 drain 收敛到 0） */
  stats(): { extId: string; inflight: number }[] {
    const ids = new Set<string>([...this.knownExtIds]);
    for (const extId of this.tables.keys()) ids.add(extId);
    for (const extId of this.inflight.keys()) {
      if ((this.inflight.get(extId) ?? 0) > 0) ids.add(extId);
    }
    return [...ids]
      .map((extId) => ({ extId, inflight: this.inflight.get(extId) ?? 0 }))
      .sort((a, b) => (a.extId < b.extId ? -1 : a.extId > b.extId ? 1 : 0));
  }

  // ---- 兜底路由挂载 ---------------------------------------------------------

  /**
   * 注册单条通配兜底路由 + octet-stream rawBody 解析器（幂等）。
   *
   * rawBody 最小侵入方案：仅补 `application/octet-stream` 的 parseAs:'string' 解析器
   * （fastify 原生只解析 application/json 与 text/plain，octet-stream 否则 415）。
   * 解析产物即原始体字符串，handler 将其透传为 dispatcher 的 rawBody；
   * 不采用 preParsing 流拦截（侵入所有请求流），也不影响 @fastify/multipart 等按
   * content-type 注册的其他解析器。
   */
  private mountWildcard(): void {
    if (this.mounted) return;
    this.mounted = true;

    this.deps.app.addContentTypeParser<string>(
      'application/octet-stream',
      { parseAs: 'string' },
      (_req, body, done) => {
        done(null, body);
      },
    );

    // 通配兜底路由与具体路由表无关，注册一次即可；commit/remove 只换表，无需重挂
    this.deps.app.all(WILDCARD_NESTED, this.handleExtRequest);
    this.deps.app.all(WILDCARD_BARE, this.handleExtRequest);
  }

  // ---- 请求处理主流程 -------------------------------------------------------

  private readonly handleExtRequest = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<unknown> => {
    const rawParams = (request.params ?? {}) as Record<string, string>;
    const extId = rawParams['extId'] ?? '';
    const subPath = rawParams['*'] ?? '';
    let routeKey = '-';

    try {
      // ① 查表与可用性三态
      const table = this.tables.get(extId);
      if (table === undefined) {
        if (this.draining.has(extId) || this.knownExtIds.has(extId)) {
          throw err('SERVICE_UNAVAILABLE', { detail: { extId } });
        }
        throw err('ROUTE_NOT_FOUND', { detail: { extId } });
      }
      if (this.draining.has(extId) || !this.enabledExtIds.has(extId) || !this.deps.isExtEnabled(extId)) {
        throw err('SERVICE_UNAVAILABLE', { detail: { extId } });
      }

      const matched = this.matchRoute(table, request.method, subPath);
      if (matched === null) {
        throw err('ROUTE_NOT_FOUND', { detail: { extId, path: `/${subPath}`, method: request.method } });
      }
      const entry = matched.entry;
      routeKey = `${entry.method.toUpperCase()} ${entry.path}`;

      // ② 鉴权前置
      if (entry.auth !== 'public') {
        const token = extractToken(request.headers, request.query as Record<string, unknown>);
        const identity = await this.deps.checker({ token, headers: request.headers });
        if (identity === null) {
          throw err('UNAUTHORIZED', { detail: { extId, route: routeKey } });
        }
        if (entry.auth === 'admin' && identity.role !== 'root' && identity.role !== 'admin') {
          throw err('FORBIDDEN', { detail: { extId, route: routeKey, role: identity.role } });
        }
        if (entry.scope !== undefined) {
          const allowed = identity.scopes.includes('*') || identity.scopes.includes(entry.scope);
          if (!allowed) {
            throw err('FORBIDDEN', { detail: { extId, route: routeKey, scope: entry.scope } });
          }
        }
      }

      // ③ per-ext 并发闸
      if ((this.inflight.get(extId) ?? 0) >= this.deps.maxConcurrentPerExt) {
        throw err('TOO_MANY_CONCURRENT', {
          detail: { extId, limit: this.deps.maxConcurrentPerExt },
        });
      }

      // ④ body/rawBody（见 buildDispatchRequest）
      const dispatchRequest = buildDispatchRequest(request, matched.params, this.deps.isBuiltinExt?.(extId) === true);
      const timeoutMs = entry.timeoutMs ?? this.deps.defaultTimeoutMs;

      // ⑤ dispatch（超时 → HANDLER_TIMEOUT）；extId 随行供集成方消歧跨扩展同名路由
      this.deps.counters?.inc('ext.route.requests', { extId, route: routeKey });
      this.inflight.set(extId, (this.inflight.get(extId) ?? 0) + 1);
      let result: ExtDispatchResult;
      try {
        result = await this.dispatchWithTimeout(routeKey, dispatchRequest, timeoutMs, entry.extId);
      } finally {
        this.inflight.set(extId, Math.max(0, (this.inflight.get(extId) ?? 1) - 1));
      }

      const parsed = DISPATCH_RESULT_SCHEMA.safeParse(result);
      if (!parsed.success) {
        throw err('RPC_HANDLER_ERROR', {
          detail: { routeKey, issues: parsed.error.issues },
        });
      }

      // ⑥ 响应映射 + 计数
      reply.code(parsed.data.status);
      if (parsed.data.headers !== undefined) {
        for (const [name, value] of Object.entries(parsed.data.headers)) {
          reply.header(name, value);
        }
      }
      this.deps.counters?.inc('ext.route.responses', {
        extId,
        route: routeKey,
        status: String(parsed.data.status),
      });
      return parsed.data.body;
    } catch (e) {
      const status = e instanceof HarnessError ? e.status : 500;
      this.deps.counters?.inc('ext.route.responses', { extId, route: routeKey, status: String(status) });
      throw e;
    }
  };

  private matchRoute(
    table: CompiledRoute[],
    method: string,
    subPath: string,
  ): { entry: ExtRouteEntry; params: Record<string, string> } | null {
    const reqSegments = splitSubPath(subPath);
    for (const route of table) {
      if (route.entry.method.toUpperCase() !== method.toUpperCase()) continue;
      const params = matchCompiled(route, reqSegments);
      if (params !== null) return { entry: route.entry, params };
    }
    return null;
  }

  /** dispatch + 超时竞速；dispatcher 迟到的 reject 不产生 unhandledRejection */
  private async dispatchWithTimeout(
    routeKey: string,
    dispatchRequest: ExtDispatchRequest,
    timeoutMs: number,
    extId?: string,
  ): Promise<ExtDispatchResult> {
    const dispatchPromise = this.deps.dispatcher.dispatch(routeKey, dispatchRequest, timeoutMs, extId);
    void dispatchPromise.catch(() => {}); // race 已判定后到达的失败与调用方无关
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            err('HANDLER_TIMEOUT', {
              detail: { routeKey, timeoutMs, requestId: dispatchRequest.requestId },
            }),
          ),
        timeoutMs,
      );
    });
    try {
      return await Promise.race([dispatchPromise, timeoutPromise]);
    } finally {
      clearTimeout(timer);
    }
  }

  // ---- commit/remove 前置 drain ---------------------------------------------

  /**
   * 在途为 0 → 立即同步执行 swap（commit/remove 的同步原子语义）；
   * 在途 > 0 → 置 draining（期间该扩展新请求 503），100ms 轮询至归零或 5s 上限后 swap。
   * 超时继续：以 counters 'ext.route.drain_timeout' + 可选 logger.warn 替代日志。
   */
  private drainThenSwap(extId: string, swap: () => void): void {
    if ((this.inflight.get(extId) ?? 0) === 0) {
      swap();
      return;
    }
    this.draining.add(extId);
    const deadline = Date.now() + DRAIN_MAX_WAIT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = (): void => {
      timer = undefined;
      if ((this.inflight.get(extId) ?? 0) !== 0 && Date.now() < deadline) {
        timer = setTimeout(poll, DRAIN_POLL_INTERVAL_MS);
        return;
      }
      if ((this.inflight.get(extId) ?? 0) !== 0) {
        this.deps.counters?.inc('ext.route.drain_timeout', { extId });
        this.deps.logger?.warn('ext route drain wait exceeded 5s; swapping table with inflight requests', {
          extId,
        });
      }
      this.draining.delete(extId);
      swap();
    };
    timer = setTimeout(poll, DRAIN_POLL_INTERVAL_MS);
    // drain 只在测试/进程退出时可能悬挂；有界 5s，允许事件循环不被其拖住
    timer.unref?.();
  }

  // ---- 校验与编译 ------------------------------------------------------------

  /** commit 入参校验（zod 形状 + extId 一致性 + 表内去重），失败在 drain 前同步抛出 */
  private validateAndCompile(extId: string, routes: ExtRouteEntry[]): CompiledRoute[] {
    if (!EXT_ID_SCHEMA.safeParse(extId).success) {
      throw err('EXT_MANIFEST_INVALID', { detail: { extId, reason: 'invalid extId' } });
    }
    const compiled: CompiledRoute[] = [];
    const seen = new Set<string>();
    for (const route of routes) {
      const parsed = ROUTE_ENTRY_SCHEMA.safeParse(route);
      if (!parsed.success) {
        throw err('EXT_MANIFEST_INVALID', { detail: { extId, issues: parsed.error.issues } });
      }
      if (parsed.data.extId !== extId) {
        throw err('EXT_MANIFEST_INVALID', {
          detail: { extId, reason: `route extId mismatch: ${parsed.data.extId}` },
        });
      }
      const { segments, wildcard } = compilePath(parsed.data.path);
      const key = `${parsed.data.method.toUpperCase()} ${segments.join('/')}${wildcard ? '/*' : ''}`;
      if (seen.has(key)) {
        throw err('EXT_ROUTE_CONFLICT', { detail: { extId, route: key } });
      }
      seen.add(key);
      compiled.push({ entry: { ...parsed.data }, segments, wildcard });
    }
    return compiled;
  }
}
