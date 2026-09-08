/**
 * sandbox — 扩展沙箱的宿主侧装配：受限 require、defineExtension、harness 门面、贡献收集器。
 *
 * - 受限 require(spec)：仅允许扩展目录内的相对 .js 文件（'./x' / '../x'，无扩展名时
 *   补 .js）；绝对路径 / 内置模块名 / 其他扩展名一律拒绝。解析后路径必须落在
 *   extDir 内（防穿越），读文件后在**同一 vm.Context** 内以 CJS 包装编译执行，
 *   递归 require 同规则；模块缓存 per-extId（每个 createRestrictedRequire 实例一份）。
 * - defineExtension(def)：扩展入口标记（__opptrixExtension: true），setup 由
 *   worker 在激活期调用。
 * - createHarnessApi(opts)：扩展可见的全部 API 面。运行类方法经 kernelCall 转发
 *   内核（本地先做与内核同规则的单语句 + 禁词预检，双保险）；注册类方法
 *   （route/webhook/on/hook/expose/page/menu/task/cron.schedule/ui.register）
 *   **不进 kernelCall**——激活期由 ContributionsCollector 捕获（contributions 快照
 *   随 host.load 应答回内核，handler Maps 留在 worker 内存供后续 dispatch）。
 * - db/schema 预检与内核 storage/db.ts forbidDangerousSql 同规则（字面量剥离 →
 *   多语句计数 / ATTACH / DETACH / load_extension 禁词），本地先行拒绝。
 *
 * 注意：本文件经 Node 24 原生 TS 剥离加载（execArgv: []），只能使用可剥离语法。
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import * as path from 'node:path';
import vm from 'node:vm';

import { err } from '../kernel/errors/index.js';

import { realmBridgeFor } from './realm.js';
import type { RealmBridge } from './realm.js';
import { KERNEL_TOPICS } from './protocol.js';
import type { KernelCall, TimerRegistry } from './vm-runtime.js';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** files.save 的二进制大小上限（8MB） */
const MAX_FILE_BYTES = 8 * 1024 * 1024;
/** h.call 经内核 broker 的 topic（protocol.ts v1 的 KERNEL_TOPICS 尚未收录，按契约固定） */
const TOPIC_HOST_CALL = 'host.call';
/** webhook 签名头（与内核 channels signedPost 的签名约定一致） */
const WEBHOOK_SIGNATURE_HEADER = 'x-harness-signature';
const WEBHOOK_TIMESTAMP_HEADER = 'x-harness-timestamp';

/** 受限 require 的统一拒绝理由（面向扩展开发者：说清允许什么） */
const REQUIRE_DENIED =
  'require denied: only relative .js files inside the extension directory (use "./mod" or "../mod", no packages, no node builtins)';

// ---------------------------------------------------------------------------
// 贡献与 handler 类型
// ---------------------------------------------------------------------------

/** h.route 注册的一条 HTTP 路由贡献（path 已归一化） */
export interface RouteContribution {
  method: string;
  path: string;
  /** 'public' | 'authenticated' | ... 由内核 authProxy 裁决；缺省 'public' */
  auth: string;
  scope?: string;
  timeoutMs?: number;
}

/** h.on 注册的一条事件订阅贡献 */
export interface EventContribution {
  pattern: string;
  priority: number;
}

/** h.hook 注册的一条 hook 贡献 */
export interface HookContribution {
  name: string;
  priority: number;
}

/** h.expose 注册的一条服务贡献 */
export interface ServiceContribution {
  name: string;
  methods: string[];
}

/** h.page 注册的一条 UI 页面贡献 */
export interface UiPageContribution {
  path: string;
  title: string;
  entry: string;
}

/** h.menu 注册的一条菜单贡献 */
export interface UiMenuContribution {
  label: string;
  icon?: string;
}

/** UI 贡献片段（h.ui.register 可整段合并） */
export interface UiContributions {
  pages: UiPageContribution[];
  menu: UiMenuContribution[];
}

/** 扩展声明式贡献集合（随 host.load 应答回内核；纯数据、可结构化克隆） */
export interface Contributions {
  routes: RouteContribution[];
  events: EventContribution[];
  hooks: HookContribution[];
  services: ServiceContribution[];
  ui: UiContributions;
}

/** routeRequest 下发给扩展 handler 的请求形状（内核 http 层装配） */
export interface RouteRequest {
  method: string;
  params: Record<string, string>;
  query: Record<string, string>;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  /** 原始请求体文本（仅 webhook 等需要验签的场景由内核提供） */
  rawBody?: string;
  requestId: string;
}

export type RouteHandler = (request: RouteRequest) => unknown | Promise<unknown>;
export type EventHandler = (payload: unknown, meta: { name: string; source: string }) => unknown | Promise<unknown>;
export type HookHandler = (value: unknown, ctx: unknown) => unknown | Promise<unknown>;
export type ServiceHandler = (args: unknown) => unknown | Promise<unknown>;
export type CronHandler = () => unknown | Promise<unknown>;
/**
 * 认证提供方 handler（h.authProvider 登记）：内核 AuthProxy → AuthProviderRegistry →
 * host.authVerify 派发到这里。返回身份对象表示认证通过，返回 null/undefined 表示拒绝。
 */
export type AuthVerifyHandler = (input: {
  token?: string;
  headers: Record<string, string | string[] | undefined>;
}) => unknown | Promise<unknown>;
/** 任务执行上下文：worker 按次装配（携带 taskId，回调转发内核 task.* topic） */
export interface TaskContext {
  progress(pct: number, msg?: string): Promise<void>;
  complete(result?: unknown): Promise<void>;
  fail(error: unknown): Promise<void>;
}
export type TaskHandler = (args: unknown, ctx: TaskContext) => unknown | Promise<unknown>;

export interface RouteOptions {
  auth?: string;
  scope?: string;
  timeoutMs?: number;
}

export interface WebhookOptions {
  /** HMAC-SHA256 共享密钥；提供时校验 x-harness-signature（hex(hmac_sha256(secret, ts + '.' + rawBody))） */
  secret?: string;
}

/** 同优先级的 handler 列表条目 */
export interface HandlerEntry<H> {
  handler: H;
  priority: number;
}

/** worker 内存中的 handler 注册表（不跨线程、不进快照） */
export interface HandlerMaps {
  /** key: 'METHOD /path'（与内核组装 routeKey 的格式一致） */
  routes: Map<string, { handler: RouteHandler; timeoutMs?: number }>;
  /** pattern -> handler 列表（同 pattern 多次 on() 叠加，priority 降序投递） */
  events: Map<string, HandlerEntry<EventHandler>[]>;
  hooks: Map<string, HandlerEntry<HookHandler>[]>;
  /** key: `${service}.${method}` */
  services: Map<string, ServiceHandler>;
  /** name -> handler（cron.schedule 本地登记 / cron.unschedule 摘除） */
  crons: Map<string, CronHandler>;
  /** name -> handler（h.task(name, handler) 登记） */
  tasks: Map<string, TaskHandler>;
  /** h.authProvider(handler) 登记（每扩展至多一个，后注册覆盖前者；不进 contributions 快照） */
  authProvider: AuthVerifyHandler | undefined;
}

/**
 * 贡献收集器：激活期由 harness 写入（contributions 数组 + handler Maps），
 * worker 读取（snapshot 随 host.load 回内核；handlers 留在内存供 dispatch）。
 */
export interface ContributionsCollector {
  readonly contributions: Contributions;
  readonly handlers: HandlerMaps;
  /** 纯数据快照（结构化克隆安全；不含 handler） */
  snapshot(): Contributions;
}

/** 创建收集器（每个扩展激活期一份） */
export function createContributionsCollector(): ContributionsCollector {
  const contributions: Contributions = {
    routes: [],
    events: [],
    hooks: [],
    services: [],
    ui: { pages: [], menu: [] },
  };
  const handlers: HandlerMaps = {
    routes: new Map(),
    events: new Map(),
    hooks: new Map(),
    services: new Map(),
    crons: new Map(),
    tasks: new Map(),
    authProvider: undefined,
  };
  return {
    contributions,
    handlers,
    snapshot: () => structuredClone(contributions),
  };
}

// ---------------------------------------------------------------------------
// defineExtension
// ---------------------------------------------------------------------------

/** 扩展入口定义（main 模块的 module.exports） */
export interface ExtensionDefinition {
  /** 形状标记：worker 据此识别合法扩展入口 */
  __opptrixExtension: true;
  /**
   * 激活期由 worker 调用（限时 30s）；注册类 API 仅可在此期间调用。
   * 第二参 ctx 为内核注入的引导上下文（与 h.boot 同源；v1 仅 rootToken，可忽略）。
   */
  setup: (h: HarnessApi, ctx?: { rootToken?: string }) => void | Promise<void>;
}

/** 扩展作者唯一需要的入口函数：打形状标记并原样返回（身份函数） */
export function defineExtension(def: {
  setup: (h: HarnessApi, ctx?: { rootToken?: string }) => void | Promise<void>;
}): ExtensionDefinition {
  return { __opptrixExtension: true, setup: def.setup };
}

/** worker 侧形状识别：module.exports 或 module.exports.default 皆可 */
export function isExtensionDefinition(x: unknown): x is ExtensionDefinition {
  if (x === null || typeof x !== 'object') return false;
  const candidate = x as { __opptrixExtension?: unknown; setup?: unknown };
  return candidate.__opptrixExtension === true && typeof candidate.setup === 'function';
}

// ---------------------------------------------------------------------------
// 受限 require
// ---------------------------------------------------------------------------

export interface RestrictedRequireOptions {
  /** 扩展目录（绝对或相对均可，内部 resolve 为根） */
  extDir: string;
  /** 模块编译执行的 vm 上下文（与扩展 VM 同一 context） */
  context: vm.Context;
  /** realm 桥（SEC-1：require 包装成 VM realm 函数所需）；缺省取 context 的共享桥 */
  bridge?: RealmBridge;
}

const CJS_WRAP_PRE = '(function (exports, require, module, __filename, __dirname) {\n';
const CJS_WRAP_POST = '\n});';

/**
 * 在指定 context 内编译 CJS 模块代码，返回包装函数。
 * vm.Script + runInContext：编译产物函数本身就是 VM realm 函数（SEC-1 前提）。
 */
function compileCjsModule(code: string, filename: string, context: vm.Context): (...args: unknown[]) => void {
  // 不提供 importModuleDynamically：模块内 import() 在编译期即失败（fail-closed）
  const script = new vm.Script(`${CJS_WRAP_PRE}${code}${CJS_WRAP_POST}`, { filename });
  const fn = script.runInContext(context);
  if (typeof fn !== 'function') {
    throw new Error(`sandbox: failed to compile module "${filename}"`);
  }
  return fn as (...args: unknown[]) => void;
}

/**
 * 创建受限 require（每扩展一个实例 = 每扩展一份模块缓存）。
 *
 * 允许：'./x' / '../x'（无扩展名自动补 .js）—— 解析后必须仍在 extDir 内，
 * 读文件后在同一 context 内以 CJS 包装执行，递归 require 同规则，命中缓存直接返回。
 * 拒绝（一律抛 Error(REQUIRE_DENIED)）：绝对路径、内置模块名（'fs' / 'node:fs'）、
 * 非 .js 扩展名、解析后逃逸 extDir 的路径。
 *
 * SEC-2（符号链接防击穿）：containment 不能只查逻辑路径——解析路径与扩展目录都过
 * `fs.realpathSync` 后再比对前缀；realpath 失败（除 ENOENT 按模块缺失处理外）一律拒绝。
 *
 * SEC-1（realm 边界）：
 * - module 对象建在 VM realm（`({ exports: {} })` 于 context 内求值）——模块顶层
 *   `this` / `module` / `exports` 不再是宿主对象，`this.constructor.constructor`
 *   只能到达 VM 自有 intrinsics，无法触达宿主 Function；
 * - require（含递归 require）经 realm 桥包装成 VM realm 函数（恒等返回，
 *   不拷贝 exports——模块身份与缓存语义保持不变）后传入模块包装器。
 */
export function createRestrictedRequire(opts: RestrictedRequireOptions): (spec: string) => unknown {
  const extRoot = path.resolve(opts.extDir);
  const bridge = opts.bridge ?? realmBridgeFor(opts.context);
  const cache = new Map<string, { exports: unknown }>();

  const requireFrom = (spec: string, parentDir: string): unknown => {
    if (typeof spec !== 'string' || spec === '') throw new Error(REQUIRE_DENIED);
    if (!spec.startsWith('./') && !spec.startsWith('../')) throw new Error(REQUIRE_DENIED);

    let resolved = path.resolve(parentDir, spec);
    const ext = path.extname(resolved);
    if (ext === '') resolved += '.js';
    else if (ext !== '.js') throw new Error(REQUIRE_DENIED);
    // 防穿越（逻辑路径）：解析后必须落在扩展目录内（extRoot 本身不算——那是目录不是模块）
    if (resolved !== extRoot && !resolved.startsWith(extRoot + path.sep)) throw new Error(REQUIRE_DENIED);

    const cached = cache.get(resolved);
    if (cached !== undefined) return cached.exports;

    // SEC-2：realpath 双侧比对（symlink 指向目录外文件在此被拒）
    let realResolved: string;
    let realExtRoot: string;
    try {
      realResolved = realpathSync(resolved);
      realExtRoot = realpathSync(extRoot);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
        throw new Error(`cannot find module '${spec}' (looked for ${resolved} inside the extension directory)`);
      }
      throw new Error(REQUIRE_DENIED);
    }
    if (realResolved !== realExtRoot && !realResolved.startsWith(realExtRoot + path.sep)) {
      throw new Error(REQUIRE_DENIED);
    }

    let code: string;
    try {
      code = readFileSync(realResolved, 'utf8');
    } catch {
      throw new Error(`cannot find module '${spec}' (looked for ${resolved} inside the extension directory)`);
    }

    // 先入缓存再执行：循环依赖拿到部分 exports（对齐 Node CJS 语义）
    // SEC-1：module 对象在 VM realm 内构建
    const moduleObj = vm.runInContext('({ exports: {} })', opts.context) as { exports: unknown };
    cache.set(resolved, moduleObj);
    const fn = compileCjsModule(code, realResolved, opts.context);
    const dirname = path.dirname(resolved);
    // SEC-1：递归 require 包成 VM realm 函数（恒等返回，exports 不拷贝）
    const localRequireVm = bridge.toVmPassthroughFn((s: unknown): unknown => requireFrom(String(s), dirname));
    fn.call(moduleObj.exports, moduleObj.exports, localRequireVm, moduleObj, resolved, dirname);
    return moduleObj.exports;
  };

  // 扩展主模块的 require 以 extDir 为基准；同样包装为 VM realm 函数
  return bridge.toVmPassthroughFn((spec: unknown): unknown => requireFrom(String(spec), extRoot));
}

// ---------------------------------------------------------------------------
// 本地 SQL 预检（与内核 storage/db.ts forbidDangerousSql 同规则，双保险）
// ---------------------------------------------------------------------------

/** SQLite 字面量（字符串/双引号标识符/反引号标识符/[方括号标识符]），支持转义 */
const SQL_LITERAL_PATTERN = /'(?:[^']|'')*'|"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]/g;
/** 禁止关键词（大小写不敏感、词边界）：ATTACH / DETACH / load_extension / VACUUM（VACUUM INTO 可跨库逃逸） */
const FORBIDDEN_KEYWORD_PATTERN = /\b(?:attach|detach|load_extension|vacuum)\b/i;

/**
 * 扩展 SQL 单语句防护：先剥离字面量，再做多语句计数与禁词检查。
 * 与内核侧规则一致——此处是扩展线程本地预检（快速失败），内核侧仍会复核。
 */
function assertSingleSafeStatement(sql: string): void {
  const stripped = sql.replace(SQL_LITERAL_PATTERN, ' ');
  const semicolonCount = stripped.split(';').length - 1;
  if (semicolonCount > 1) {
    throw err('DB_STATEMENT_FORBIDDEN', {
      message: 'sql rejected: multiple statements are not allowed. Execute one statement per call.',
      detail: { reason: 'multi-statement', semicolonCount },
    });
  }
  const keyword = FORBIDDEN_KEYWORD_PATTERN.exec(stripped)?.[0];
  if (keyword !== undefined) {
    throw err('DB_STATEMENT_FORBIDDEN', {
      message: `sql rejected: "${keyword}" is not allowed (can escape the per-extension database sandbox).`,
      detail: { reason: 'forbidden-keyword', keyword },
    });
  }
}

// ---------------------------------------------------------------------------
// HarnessApi
// ---------------------------------------------------------------------------

export interface HarnessApiOptions {
  extId: string;
  kernelCall: KernelCall;
  /** 激活期注册捕获目标（worker 创建并持有） */
  contributions: ContributionsCollector;
  /** 受控定时器登记表（与扩展 VM 共享，卸载时统一清理） */
  timers: TimerRegistry;
  /** 是否处于激活（setup）期：注册类 API 的闸门 */
  activationPhase: () => boolean;
  /**
   * 引导态（h.boot 的数据源；worker load 时按需填充，缺省空对象）。
   * rootToken 仅对 builtin && mount==='auth' 的扩展注入（worker 侧双复核）。
   */
  boot?: { rootToken?: string };
}

/**
 * 扩展可见 API 面（h）。运行类方法经 kernelCall 转发内核；注册类方法仅在
 * setup 期间可用（否则抛 Error('registration API is only available during setup')）。
 */
export interface HarnessApi {
  log: {
    debug(msg: unknown, obj?: unknown): void;
    info(msg: unknown, obj?: unknown): void;
    warn(msg: unknown, obj?: unknown): void;
    error(msg: unknown, obj?: unknown): void;
  };
  config: { get(path: string, fallback?: unknown): Promise<unknown> };
  storage: {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<unknown>;
    delete(key: string): Promise<unknown>;
  };
  db: {
    all(sql: string, params?: unknown[]): Promise<unknown>;
    get(sql: string, params?: unknown[]): Promise<unknown>;
    run(sql: string, params?: unknown[]): Promise<unknown>;
    schema(statements: string[]): Promise<unknown>;
  };
  notify: { send(input: unknown): Promise<unknown> };
  chat: { send(input: unknown): Promise<unknown>; patch(input: unknown): Promise<unknown> };
  files: {
    /** data: 二进制（Uint8Array/Buffer，自动转 base64）或已是 base64 的字符串；上限 8MB */
    save(input: { origName: string; mime: string; data: string | Uint8Array; visibility?: string; extId?: string }): Promise<unknown>;
    /** 返回 base64（由内核返回值决定） */
    read(id: string): Promise<unknown>;
    get(id: string): Promise<unknown>;
  };
  tasks: {
    dispatch(input: { name: string; args?: unknown }): Promise<unknown>;
    progress(taskId: string, pct: number, msg?: string): Promise<unknown>;
    complete(taskId: string, result?: unknown): Promise<unknown>;
    fail(taskId: string, error: unknown): Promise<unknown>;
  };
  cron: {
    /** 注册 cron 任务：input 发内核调度，handler 本地登记（cronFire 时调用） */
    schedule(
      input: { name: string; expr: string; tz?: string; payload?: unknown; overlap?: boolean; misfire?: string },
      handler: CronHandler,
    ): Promise<unknown>;
    unschedule(name: string): Promise<unknown>;
  };
  ui: { register(fragment: { pages?: UiPageContribution[]; menu?: UiMenuContribution[] }): void };
  llm: { chat(input: unknown): Promise<unknown> };
  sandbox: { exec(input: unknown): Promise<unknown> };
  system: { info(): Promise<unknown>; stats(): Promise<unknown> };
  /**
   * 引导态（冻结对象）：内核随 load 注入；缺省为空冻结对象。
   * rootToken 仅 builtin && mount==='auth' 的扩展可见（break-glass 令牌不下发其余扩展）。
   */
  boot: { rootToken?: string };
  /**
   * 内核密码原语（scrypt，经 auth.hashPassword / auth.verifyPassword topic）。
   * 调用方 manifest 必须声明 'auth:provider' 权限（缺 → 内核侧 FORBIDDEN）。
   */
  auth: {
    /** 哈希明文密码 → 自描述 scrypt 串（`scrypt$N$r$p$salt$key`，每次新鲜随机盐） */
    hashPassword(password: string): Promise<string>;
    /** 校验明文密码与 hash；hash 格式非法/参数越界一律 false（不抛） */
    verifyPassword(password: string, hash: string): Promise<boolean>;
  };
  /** 调用其他扩展暴露的服务（内核 broker 中转，topic 'host.call'） */
  call(targetExtId: string, method: string, args?: unknown): Promise<unknown>;
  // ---- 注册类 API（仅激活期；被 collector 捕获，不进 kernelCall）----
  route(method: string, path: string, handler: RouteHandler, opts?: RouteOptions): void;
  webhook(path: string, handler: RouteHandler, opts?: WebhookOptions): void;
  on(pattern: string, handler: EventHandler, opts?: { priority?: number }): void;
  hook(name: string, handler: HookHandler, opts?: { priority?: number }): void;
  expose(service: string, methods: Record<string, ServiceHandler>): void;
  page(path: string, page: { title: string; entry: string }): void;
  menu(label: string, icon?: string): void;
  /** 登记长任务执行器：tasks.dispatch({name}) → kernel taskRun → handler(args, ctx) */
  task(name: string, handler: TaskHandler): void;
  /**
   * 登记本扩展为认证提供方（仅激活期）：内核 AuthProxy 校验非 root 令牌时经
   * host.authVerify 派发到 handler({ token, headers })，返回身份对象（AuthIdentity 形状）
   * 表示通过，返回 null/undefined 表示拒绝。每扩展至多一个，后注册覆盖前者。
   */
  authProvider(handler: AuthVerifyHandler): void;
}

/** 路由路径归一化：合并连续斜杠、去尾斜杠（根 '/' 除外）、'' → '/'、补前导斜杠 */
function normalizeRoutePath(raw: string): string {
  if (raw === '') return '/';
  let p = raw.startsWith('/') ? raw : `/${raw}`;
  p = p.replace(/\/{2,}/g, '/');
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p;
}

/** 事件 pattern 校验：非空、'.' 分段无空段（与内核 EventBus 分段语义一致） */
function assertEventPattern(pattern: string, label: string): void {
  if (pattern === '' || pattern.split('.').some((seg) => seg === '')) {
    throw new TypeError(`${label}: pattern segments must be non-empty ('a.b' / 'a.*' / 'a.**'), got "${pattern}"`);
  }
}

/** 从 headers 取单值（string[] 取首个；undefined 安全） */
function pickHeader(headers: RouteRequest['headers'], name: string): string | undefined {
  const value = headers?.[name];
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

/** 常数时间十六进制串比较（长度不等直接 false，不泄露前缀匹配信息） */
function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * webhook 验签 + 调用底层 handler：
 * secret 提供且 payload 带 rawBody 时强制校验——签名取 x-harness-signature，
 * 被签内容为 `x-harness-timestamp + '.' + rawBody`（无时间戳头时退化为 rawBody），
 * 与内核 channels/signedPost 的签名约定一致。失败抛 HARNESS-1006（HTTP 401）。
 */
function verifyWebhookAndCall(
  secret: string | undefined,
  handler: RouteHandler,
  request: RouteRequest,
): unknown {
  if (secret !== undefined && typeof request.rawBody === 'string') {
    const provided = pickHeader(request.headers, WEBHOOK_SIGNATURE_HEADER);
    const ts = pickHeader(request.headers, WEBHOOK_TIMESTAMP_HEADER);
    const signedPayload = ts !== undefined ? `${ts}.${request.rawBody}` : request.rawBody;
    const expected = createHmac('sha256', secret).update(signedPayload).digest('hex');
    if (provided === undefined || !safeEqualHex(expected, provided)) {
      throw err('UNAUTHORIZED', {
        message: 'webhook signature verification failed (x-harness-signature mismatch); check the shared secret',
        detail: { header: WEBHOOK_SIGNATURE_HEADER },
      });
    }
  }
  return handler(request);
}

/**
 * 创建扩展 harness 门面。返回对象及其全部子对象均已冻结——扩展无法篡改
 * 宿主侧实现；所有运行类方法经 kernelCall(KERNEL_TOPICS.*, payload) 转发。
 */
export function createHarnessApi(opts: HarnessApiOptions): HarnessApi {
  const { extId, kernelCall, contributions, activationPhase } = opts;
  const handlers = contributions.handlers;

  const assertActive = (): void => {
    if (!activationPhase()) throw new Error('registration API is only available during setup');
  };

  const callKernel = (topic: string, payload: unknown): Promise<unknown> => kernelCall(topic, payload);

  const forwardLog = (level: string) => (msg: unknown, obj?: unknown): void => {
    kernelCall(KERNEL_TOPICS.log, {
      level,
      msg: typeof msg === 'string' ? msg : String(msg),
      args: obj === undefined ? [] : [obj],
    }).catch(() => {
      // log 属 fire-and-forget：内核不可达时静默丢弃（不得打断扩展执行）
    });
  };

  const assertFunction = (value: unknown, label: string): void => {
    if (typeof value !== 'function') throw new TypeError(`${label} must be a function`);
  };

  const log = Object.freeze({
    debug: forwardLog('debug'),
    info: forwardLog('info'),
    warn: forwardLog('warn'),
    error: forwardLog('error'),
  });

  const config = Object.freeze({
    get: (p: string, fallback?: unknown): Promise<unknown> =>
      callKernel(KERNEL_TOPICS.configGet, { path: p, fallback }),
  });

  const storage = Object.freeze({
    get: (key: string): Promise<unknown> => callKernel(KERNEL_TOPICS.storageGet, { key }),
    set: (key: string, value: unknown): Promise<unknown> => callKernel(KERNEL_TOPICS.storageSet, { key, value }),
    delete: (key: string): Promise<unknown> => callKernel(KERNEL_TOPICS.storageDelete, { key }),
  });

  const db = Object.freeze({
    all: (sql: string, params?: unknown[]): Promise<unknown> => {
      assertSingleSafeStatement(sql);
      return callKernel(KERNEL_TOPICS.dbAll, { sql, params: params ?? [] });
    },
    get: (sql: string, params?: unknown[]): Promise<unknown> => {
      assertSingleSafeStatement(sql);
      return callKernel(KERNEL_TOPICS.dbGet, { sql, params: params ?? [] });
    },
    run: (sql: string, params?: unknown[]): Promise<unknown> => {
      assertSingleSafeStatement(sql);
      return callKernel(KERNEL_TOPICS.dbRun, { sql, params: params ?? [] });
    },
    schema: (statements: string[]): Promise<unknown> => {
      if (!Array.isArray(statements) || statements.some((s) => typeof s !== 'string')) {
        throw new TypeError('db.schema: statements must be a string[]');
      }
      for (const statement of statements) assertSingleSafeStatement(statement);
      return callKernel(KERNEL_TOPICS.dbSchema, { statements });
    },
  });

  const notify = Object.freeze({
    send: (input: unknown): Promise<unknown> => callKernel(KERNEL_TOPICS.notifySend, input),
  });

  const chat = Object.freeze({
    send: (input: unknown): Promise<unknown> => callKernel(KERNEL_TOPICS.chatSend, input),
    patch: (input: unknown): Promise<unknown> => callKernel(KERNEL_TOPICS.chatPatch, input),
  });

  const files = Object.freeze({
    save: (input: {
      origName: string;
      mime: string;
      data: string | Uint8Array;
      visibility?: string;
      extId?: string;
    }): Promise<unknown> => {
      if (input === null || typeof input !== 'object') {
        throw new TypeError('files.save: input object { origName, mime, data } is required');
      }
      const data = input.data;
      let base64: string;
      let bytes: number;
      if (typeof data === 'string') {
        base64 = data;
        bytes = Math.floor((data.length * 3) / 4); // 已是 base64：按解码后大小计
      } else if (data instanceof Uint8Array) {
        bytes = data.byteLength;
        base64 = Buffer.from(data).toString('base64');
      } else {
        throw new TypeError('files.save: data must be a base64 string or Uint8Array/Buffer');
      }
      if (bytes > MAX_FILE_BYTES) {
        throw err('PAYLOAD_TOO_LARGE', {
          message: `files.save: "${input.origName}" is ${bytes} bytes, which exceeds the 8MB (8388608 bytes) limit`,
          detail: { origName: input.origName, bytes, limit: MAX_FILE_BYTES },
        });
      }
      const payload: Record<string, unknown> = {
        origName: input.origName,
        mime: input.mime,
        data: base64,
      };
      if (input.visibility !== undefined) payload['visibility'] = input.visibility;
      if (input.extId !== undefined) payload['extId'] = input.extId;
      return callKernel(KERNEL_TOPICS.filesSave, payload);
    },
    read: (id: string): Promise<unknown> => callKernel(KERNEL_TOPICS.filesRead, { id }),
    get: (id: string): Promise<unknown> => callKernel(KERNEL_TOPICS.filesGet, { id }),
  });

  const tasks = Object.freeze({
    dispatch: (input: { name: string; args?: unknown }): Promise<unknown> => {
      if (input === null || typeof input !== 'object' || typeof input.name !== 'string' || input.name === '') {
        throw new TypeError('tasks.dispatch: input.name must be a non-empty string');
      }
      return callKernel(KERNEL_TOPICS.tasksDispatch, { name: input.name, args: input.args });
    },
    progress: (taskId: string, pct: number, msg?: string): Promise<unknown> =>
      callKernel(KERNEL_TOPICS.taskProgress, { taskId, pct, msg }),
    complete: (taskId: string, result?: unknown): Promise<unknown> =>
      callKernel(KERNEL_TOPICS.taskComplete, { taskId, result }),
    fail: (taskId: string, error: unknown): Promise<unknown> =>
      callKernel(KERNEL_TOPICS.taskFail, { taskId, error }),
  });

  const cron = Object.freeze({
    schedule: (
      input: { name: string; expr: string; tz?: string; payload?: unknown; overlap?: boolean; misfire?: string },
      handler: CronHandler,
    ): Promise<unknown> => {
      assertActive();
      if (input === null || typeof input !== 'object' || typeof input.name !== 'string' || input.name === '' ||
          typeof input.expr !== 'string' || input.expr === '') {
        throw new TypeError('cron.schedule: input.name and input.expr must be non-empty strings');
      }
      assertFunction(handler, 'cron.schedule: handler');
      // 本地登记 name→handler（worker 收到 cronFire 时调用）；input 原样发内核调度
      handlers.crons.set(input.name, handler);
      return callKernel(KERNEL_TOPICS.cronSchedule, input);
    },
    unschedule: (name: string): Promise<unknown> => {
      handlers.crons.delete(name);
      return callKernel(KERNEL_TOPICS.cronUnschedule, { name });
    },
  });

  const ui = Object.freeze({
    register: (fragment: { pages?: UiPageContribution[]; menu?: UiMenuContribution[] }): void => {
      assertActive();
      if (fragment === null || typeof fragment !== 'object') {
        throw new TypeError('ui.register: fragment object is required');
      }
      if (fragment.pages !== undefined) {
        if (!Array.isArray(fragment.pages)) throw new TypeError('ui.register: pages must be an array');
        for (const page of fragment.pages) {
          if (typeof page?.title !== 'string' || typeof page?.entry !== 'string') {
            throw new TypeError('ui.register: each page requires string title and entry');
          }
          contributions.contributions.ui.pages.push({
            path: normalizeRoutePath(String(page.path ?? '/')),
            title: page.title,
            entry: page.entry,
          });
        }
      }
      if (fragment.menu !== undefined) {
        if (!Array.isArray(fragment.menu)) throw new TypeError('ui.register: menu must be an array');
        for (const item of fragment.menu) {
          if (typeof item?.label !== 'string') throw new TypeError('ui.register: each menu item requires a label');
          contributions.contributions.ui.menu.push(item.icon === undefined ? { label: item.label } : { label: item.label, icon: item.icon });
        }
      }
    },
  });

  const llm = Object.freeze({
    chat: (input: unknown): Promise<unknown> => callKernel(KERNEL_TOPICS.llmChat, input),
  });

  const sandboxExec = Object.freeze({
    exec: (input: unknown): Promise<unknown> => callKernel(KERNEL_TOPICS.sandboxExec, input),
  });

  const system = Object.freeze({
    info: (): Promise<unknown> => callKernel(KERNEL_TOPICS.systemInfo, {}),
    stats: (): Promise<unknown> => callKernel(KERNEL_TOPICS.systemStats, {}),
  });

  /** 引导态（冻结）：缺省空冻结对象；rootToken 由 worker 仅对 builtin auth 注入 */
  const boot = Object.freeze(
    opts.boot?.rootToken !== undefined ? { rootToken: opts.boot.rootToken } : {},
  ) as { rootToken?: string };

  /**
   * 内核密码原语：auth.* topic 应答为 { hash } / { ok } 信封形状，
   * 此处解包为扩展契约的 string / boolean（extensions/auth 的 h.auth 契约）。
   */
  const auth = Object.freeze({
    hashPassword: async (password: string): Promise<string> => {
      const reply = (await callKernel(KERNEL_TOPICS.authHashPassword, { password })) as {
        hash?: unknown;
      } | null;
      if (reply === null || typeof reply !== 'object' || typeof reply['hash'] !== 'string') {
        throw new TypeError('auth.hashPassword: kernel reply is missing the "hash" string');
      }
      return reply['hash'];
    },
    verifyPassword: async (password: string, hash: string): Promise<boolean> => {
      const reply = (await callKernel(KERNEL_TOPICS.authVerifyPassword, { password, hash })) as {
        ok?: unknown;
      } | null;
      if (reply === null || typeof reply !== 'object' || typeof reply['ok'] !== 'boolean') {
        throw new TypeError('auth.verifyPassword: kernel reply is missing the "ok" boolean');
      }
      return reply['ok'];
    },
  });

  const api: HarnessApi = {
    log,
    config,
    storage,
    db,
    notify,
    chat,
    files,
    tasks,
    cron,
    ui,
    llm,
    sandbox: sandboxExec,
    system,
    boot,
    auth,
    call: (targetExtId: string, method: string, args?: unknown): Promise<unknown> => {
      if (typeof targetExtId !== 'string' || targetExtId === '' || typeof method !== 'string' || method === '') {
        throw new TypeError('call: targetExtId and method must be non-empty strings');
      }
      return callKernel(TOPIC_HOST_CALL, { targetExtId, method, args });
    },

    // ---- 注册类 API（激活期闸门；捕获进 collector）----
    route: (method, routePath, handler, routeOpts) => {
      assertActive();
      const m = String(method).trim().toUpperCase();
      if (m === '') throw new TypeError('route: method must be a non-empty string');
      assertFunction(handler, 'route: handler');
      const normalized = normalizeRoutePath(String(routePath));
      const key = `${m} ${normalized}`;
      if (handlers.routes.has(key)) throw new Error(`duplicate route: ${key}`);
      handlers.routes.set(key, { handler, timeoutMs: routeOpts?.timeoutMs });
      contributions.contributions.routes.push({
        method: m,
        path: normalized,
        auth: routeOpts?.auth ?? 'public',
        scope: routeOpts?.scope,
        timeoutMs: routeOpts?.timeoutMs,
      });
    },
    webhook: (webhookPath, handler, webhookOpts) => {
      assertActive();
      assertFunction(handler, 'webhook: handler');
      const secret = webhookOpts?.secret;
      api.route('POST', webhookPath, (request: RouteRequest) => verifyWebhookAndCall(secret, handler, request));
    },
    on: (pattern, handler, onOpts) => {
      assertActive();
      if (typeof pattern !== 'string') throw new TypeError('on: pattern must be a string');
      assertEventPattern(pattern, 'on');
      assertFunction(handler, 'on: handler');
      const priority = onOpts?.priority ?? 0;
      contributions.contributions.events.push({ pattern, priority });
      const list = handlers.events.get(pattern) ?? [];
      list.push({ handler, priority });
      handlers.events.set(pattern, list);
    },
    hook: (name, handler, hookOpts) => {
      assertActive();
      if (typeof name !== 'string' || name === '') throw new TypeError('hook: name must be a non-empty string');
      assertFunction(handler, 'hook: handler');
      const priority = hookOpts?.priority ?? 0;
      contributions.contributions.hooks.push({ name, priority });
      const list = handlers.hooks.get(name) ?? [];
      list.push({ handler, priority });
      handlers.hooks.set(name, list);
    },
    expose: (service, methods) => {
      assertActive();
      if (typeof service !== 'string' || service === '') throw new TypeError('expose: service must be a non-empty string');
      if (methods === null || typeof methods !== 'object') throw new TypeError('expose: methods must be an object of functions');
      const names = Object.keys(methods);
      for (const name of names) {
        assertFunction(methods[name], `expose: methods.${name}`);
        handlers.services.set(`${service}.${name}`, methods[name] as ServiceHandler);
      }
      contributions.contributions.services.push({ name: service, methods: names });
    },
    page: (pagePath, page) => {
      assertActive();
      if (page === null || typeof page !== 'object' || typeof page.title !== 'string' || typeof page.entry !== 'string') {
        throw new TypeError('page: { title, entry } with string values is required');
      }
      contributions.contributions.ui.pages.push({
        path: normalizeRoutePath(String(pagePath)),
        title: page.title,
        entry: page.entry,
      });
    },
    menu: (label, icon) => {
      assertActive();
      if (typeof label !== 'string' || label === '') throw new TypeError('menu: label must be a non-empty string');
      contributions.contributions.ui.menu.push(icon === undefined ? { label } : { label, icon });
    },
    task: (name, handler) => {
      assertActive();
      if (typeof name !== 'string' || name === '') throw new TypeError('task: name must be a non-empty string');
      assertFunction(handler, 'task: handler');
      handlers.tasks.set(name, handler);
    },
    authProvider: (handler) => {
      assertActive();
      assertFunction(handler, 'authProvider: handler');
      // 每扩展一个 provider 槽位：后注册覆盖前者（AuthProviderRegistry 同名替换语义对齐）
      handlers.authProvider = handler;
    },
  };

  // 冻结整棵 API 树：扩展无法改写宿主实现
  return Object.freeze(api);
}

/**
 * 把宿主侧 {@link HarnessApi} 暴露为 **VM realm 对象树**（SEC-1：h 门面逃逸链根除）。
 *
 * - 每个 h.* 方法都经 realm 桥包装成 VM realm 函数：运行类（kernelCall 转发）用
 *   async 包装（返回 VM realm Promise，结果深拷贝入 VM realm）；注册类/同步方法用
 *   同步包装；宿主抛出的 Error 转为 VM realm Error。
 * - 各子对象（log/config/…/boot）在 VM 内构建并冻结——扩展拿到的是 VM realm
 *   冻结对象，`h.constructor.constructor` 只能到达 VM 自有 intrinsics。
 * - handler 形参（route/on/hook/expose/task/cron.schedule/authProvider 注册时传入的
 *   扩展函数）原样透传给宿主侧 api —— collector 捕获的仍是 VM 函数本身。
 *
 * @param api 宿主侧实现（createHarnessApi 的返回值）
 * @param bridge 目标 context 的 realm 桥（createExtVm 产物）
 */
export function exposeHarnessApiInVm(api: HarnessApi, bridge: RealmBridge): unknown {
  // never[] 形参技巧：具体签名 (p: string) => ... 可赋给 (...args: never[]) => unknown，
  // 包装时再放宽为 unknown[] 形参（运行期参数由 VM 侧原样透传给宿主实现）
  const syncFn = (fn: (...args: never[]) => unknown): unknown =>
    bridge.toVmFn(fn as unknown as (...args: unknown[]) => unknown);
  const asyncFn = (fn: (...args: never[]) => unknown): unknown =>
    bridge.toVmAsyncFn(fn as unknown as (...args: unknown[]) => unknown);

  return bridge.makeVmObject({
    log: bridge.makeVmObject({
      debug: syncFn((msg: unknown, obj?: unknown) => api.log.debug(msg, obj)),
      info: syncFn((msg: unknown, obj?: unknown) => api.log.info(msg, obj)),
      warn: syncFn((msg: unknown, obj?: unknown) => api.log.warn(msg, obj)),
      error: syncFn((msg: unknown, obj?: unknown) => api.log.error(msg, obj)),
    }),
    config: bridge.makeVmObject({
      get: asyncFn((p: string, fallback?: unknown) => api.config.get(p, fallback)),
    }),
    storage: bridge.makeVmObject({
      get: asyncFn((key: string) => api.storage.get(key)),
      set: asyncFn((key: string, value: unknown) => api.storage.set(key, value)),
      delete: asyncFn((key: string) => api.storage.delete(key)),
    }),
    db: bridge.makeVmObject({
      all: asyncFn((sql: string, params?: unknown[]) => api.db.all(sql, params)),
      get: asyncFn((sql: string, params?: unknown[]) => api.db.get(sql, params)),
      run: asyncFn((sql: string, params?: unknown[]) => api.db.run(sql, params)),
      schema: asyncFn((statements: string[]) => api.db.schema(statements)),
    }),
    notify: bridge.makeVmObject({
      send: asyncFn((input: unknown) => api.notify.send(input)),
    }),
    chat: bridge.makeVmObject({
      send: asyncFn((input: unknown) => api.chat.send(input)),
      patch: asyncFn((input: unknown) => api.chat.patch(input)),
    }),
    files: bridge.makeVmObject({
      save: asyncFn((input: unknown) =>
        api.files.save(input as { origName: string; mime: string; data: string | Uint8Array; visibility?: string; extId?: string }),
      ),
      read: asyncFn((id: string) => api.files.read(id)),
      get: asyncFn((id: string) => api.files.get(id)),
    }),
    tasks: bridge.makeVmObject({
      dispatch: asyncFn((input: unknown) => api.tasks.dispatch(input as { name: string; args?: unknown })),
      progress: asyncFn((taskId: string, pct: number, msg?: string) => api.tasks.progress(taskId, pct, msg)),
      complete: asyncFn((taskId: string, result?: unknown) => api.tasks.complete(taskId, result)),
      fail: asyncFn((taskId: string, error: unknown) => api.tasks.fail(taskId, error)),
    }),
    cron: bridge.makeVmObject({
      schedule: asyncFn(
        (input: unknown, handler: unknown) =>
          api.cron.schedule(input as Parameters<HarnessApi['cron']['schedule']>[0], handler as CronHandler),
      ),
      unschedule: asyncFn((name: string) => api.cron.unschedule(name)),
    }),
    ui: bridge.makeVmObject({
      register: syncFn((fragment: unknown) => api.ui.register(fragment as Parameters<HarnessApi['ui']['register']>[0])),
    }),
    llm: bridge.makeVmObject({
      chat: asyncFn((input: unknown) => api.llm.chat(input)),
    }),
    sandbox: bridge.makeVmObject({
      exec: asyncFn((input: unknown) => api.sandbox.exec(input)),
    }),
    system: bridge.makeVmObject({
      info: asyncFn(() => api.system.info()),
      stats: asyncFn(() => api.system.stats()),
    }),
    // 引导态：纯数据对象在 VM 内重建（rootToken 为字符串原语）
    boot: bridge.makeVmObject(api.boot.rootToken !== undefined ? { rootToken: api.boot.rootToken } : {}),
    auth: bridge.makeVmObject({
      hashPassword: asyncFn((password: string) => api.auth.hashPassword(password)),
      verifyPassword: asyncFn((password: string, hash: string) => api.auth.verifyPassword(password, hash)),
    }),
    call: asyncFn((targetExtId: string, method: string, args?: unknown) => api.call(targetExtId, method, args)),
    // ---- 注册类 API（宿主侧捕获 VM 函数进 collector）----
    route: syncFn(
      (method: string, path: string, handler: unknown, opts?: RouteOptions) =>
        api.route(method, path, handler as RouteHandler, opts),
    ),
    webhook: syncFn(
      (path: string, handler: unknown, opts?: WebhookOptions) =>
        api.webhook(path, handler as RouteHandler, opts),
    ),
    on: syncFn(
      (pattern: string, handler: unknown, opts?: { priority?: number }) =>
        api.on(pattern, handler as EventHandler, opts),
    ),
    hook: syncFn(
      (name: string, handler: unknown, opts?: { priority?: number }) =>
        api.hook(name, handler as HookHandler, opts),
    ),
    expose: syncFn(
      (service: string, methods: unknown) =>
        api.expose(service, methods as Record<string, ServiceHandler>),
    ),
    page: syncFn(
      (path: string, page: unknown) => api.page(path, page as { title: string; entry: string }),
    ),
    menu: syncFn((label: string, icon?: string) => api.menu(label, icon)),
    task: syncFn(
      (name: string, handler: unknown) => api.task(name, handler as TaskHandler),
    ),
    authProvider: syncFn(
      (handler: unknown) => api.authProvider(handler as AuthVerifyHandler),
    ),
  });
}
