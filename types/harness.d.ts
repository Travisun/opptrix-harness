/**
 * Opptrix Harness OS — 扩展作者 TypeScript 类型声明（v1 契约）。
 *
 * 用法（扩展侧任意一种即可）：
 * - 扩展目录内放置引用：`/// <reference path="../types/harness.d.ts" />`
 * - 或在扩展 tsconfig / jsconfig 的 `include` 中加入本文件，JS 文件加 `// @ts-check`。
 *
 * ⚠️ 对齐基准：本文件与 `src/extension-host/sandbox.ts` 注入沙箱的 HarnessApi 实现
 * 逐项对齐（该文件是单一事实来源，形状漂移以实现为准回改这里）；运行类方法的
 * 线格式与内核对应服务对齐：events/bus（on）、notification/manager（notify.send）、
 * files/service（files.*）、tasks/manager（tasks.*）、storage/db（db.*）、
 * hooks/points（hook 埋点）、extensions/registry（h.expose / h.call）。
 */

declare global {
  // ---------------------------------------------------------------------------
  // 扩展入口
  // ---------------------------------------------------------------------------

  /**
   * 扩展入口：由沙箱注入的全局函数（也可作 `module.exports = defineExtension({ setup })`
   * 使用——两种写法等价，worker 侧均识别）。setup 仅在激活期调用一次（限时 30s）；
   * 注册类 API（route/webhook/on/hook/expose/page/menu/task/authProvider/ui.register/
   * cron.schedule）只在 setup 期间可用，激活后调用抛
   * `Error('registration API is only available during setup')`。
   * 返回 Promise 时内核会等待其完成后再宣告激活成功。
   * 第二参 ctx 为内核随激活注入的引导上下文（与 `h.boot` 同源；可忽略）。
   */
  function defineExtension(setup: (h: HarnessApi, ctx?: SetupContext) => void | Promise<void>): void;

  /** setup 第二参引导上下文（与 h.boot 同源；v1 仅 rootToken，仅 builtin auth 有值） */
  interface SetupContext {
    rootToken?: string;
  }

  /** 引导态（h.boot，冻结对象）：rootToken 仅 builtin && mount==='auth' 扩展可见，其余扩展为空对象 */
  interface BootState {
    rootToken?: string;
  }

  /** 内核密码/摘要/TOTP 原语（经内核 auth.* topic；调用方 manifest 需声明 'auth:provider' 权限） */
  interface AuthApi {
    /** 哈希明文密码 → 自描述 scrypt 串（`scrypt$N$r$p$salt_hex$key_hex`，每次新鲜随机盐） */
    hashPassword(password: string): Promise<string>;
    /** 校验明文密码与 hash；hash 格式非法/参数越界一律 false（不抛） */
    verifyPassword(password: string, hash: string): Promise<boolean>;
    /** 计算任意字符串的 SHA-256 十六进制摘要（令牌脱敏存储等用途）→ { hash: 64 位小写 hex } */
    hashToken(value: string): Promise<{ hash: string }>;
    /** 生成 TOTP 密钥：account 进 otpauth URI label（`otpauth://totp/Opptrix%20Harness:<account>`） */
    totpGenerate(account: string): Promise<{ secret: string; uri: string }>;
    /** 校验 TOTP 令牌（window ±1）；格式非法一律 ok:false（不抛） */
    totpVerify(input: { secret: string; token: string }): Promise<{ ok: boolean; delta: number | null }>;
    /** 常数时间校验内核 root 令牌（break-glass；令牌本身从不落库） */
    verifyRootToken(token: string): Promise<{ ok: boolean }>;
  }

  /**
   * 认证提供方 handler（h.authProvider 登记）：内核 AuthProxy 校验非 root 令牌时经
   * host.authVerify 派发到这里。返回身份对象表示认证通过，返回 null/undefined 表示
   * "本 provider 不认识该凭据"（继续尝试下一个 provider）。每扩展至多一个，后注册覆盖前者。
   */
  type AuthVerifyHandler = (input: {
    token?: string;
    headers: Record<string, string | string[] | undefined>;
  }) => unknown | Promise<unknown>;

  /** 扩展可见 API 面（沙箱注入的唯一宿主对象 `h`；整树冻结，不可篡改） */
  interface HarnessApi {
    /** 结构化日志（内核 pino，自动带 ext:<id> 作用域；密钥永不入日志） */
    log: LogApi;
    /** 只读读取内核配置（点分路径；token/secret/password/apiKey 命中即 FORBIDDEN） */
    config: ConfigApi;
    /** 扩展私有 KV 存储（内核 ext_kv 表；非 SQL，适合少量配置态） */
    storage: StorageApi;
    /** 扩展专属 SQLite（物理隔离的 `<dataDir>/db/ext/{id}.sqlite`；单语句 + 参数绑定） */
    db: DbApi;
    /** 发送通知（入库 + SSE 必然发生；channels 决定外发渠道） */
    notify: NotifyApi;
    /** 聊天：发消息 / 改消息正文（senderType 恒为 'ext'，扩展消息不触发订阅自身的回声） */
    chat: ChatApi;
    /** 文件存储（上限 8MB/文件；沙箱无 Buffer，data 用 Uint8Array 或 base64 字符串） */
    files: FilesApi;
    /** CPU 密集长任务：派发 / 上报进度 / 完成 / 失败（独立任务线程执行） */
    tasks: TasksApi;
    /** 注册定时任务（标准 5 段 cron 表达式；存储一律 UTC，tz 为 IANA 展示时区） */
    cron: CronApi;
    /** 运行期 UI 贡献注册（与 h.page / h.menu 等价的可整段合并入口） */
    ui: UiApi;
    /** LLM 网关（OpenAI / Anthropic 双协议，按 model 路由 provider；流式仅 REST SSE） */
    llm: LlmApi;
    /** 沙箱 Workspace 容器（dockerode；未启用/无权限时抛 HARNESS-6xxx） */
    sandbox: SandboxApi;
    /** 沙箱化代码执行会话（受控子进程；需 manifest 权限 'sandbox'） */
    coding: CodingApi;
    /** 系统信息与资源水位（只读策划面） */
    system: SystemApi;
    /** 引导态（冻结；缺省空对象）：rootToken 仅 builtin auth 扩展可见 */
    boot: BootState;
    /** 内核密码原语（scrypt；需 manifest 权限 'auth:provider'） */
    auth: AuthApi;
    /** 调用其他扩展（或本扩展）经 h.expose 暴露的服务（manifest 需声明 'rpc:call' 或 'rpc:call:<targetExtId>'；自调用豁免） */
    call(targetExtId: string, method: string, args?: unknown): Promise<unknown>;
    /** 浏览器自动化内核引擎（Playwright 跑在内核主线程；manifest 需声明 'browser' 权限） */
    browser: BrowserApi;

    // ---- 注册类 API（仅激活期可用；被贡献收集器捕获，随 host.load 回报内核）----
    /** 注册 HTTP 路由，最终挂载于 `/ext/{id}` 前缀下 */
    route(method: string, path: string, handler: RouteHandler, opts?: RouteOptions): void;
    /** webhook 语法糖：HMAC 签名校验（x-harness-signature）+ 原始 body 的便捷路由 */
    webhook(path: string, handler: RouteHandler, opts?: WebhookOptions): void;
    /** 订阅内核事件（'.' 分段，支持 `*` / 末段 `**` 通配） */
    on(pattern: string, handler: EventHandler, opts?: { priority?: number }): void;
    /** 注册 hook 埋点处理器（埋点名见内核 HOOK_POINTS，禁止手写未登记埋点） */
    hook(name: string, handler: HookHandler, opts?: { priority?: number }): void;
    /** 向 Registry 注册 RPC 服务（方法名 → handler 映射；供 h.call 跨扩展调用） */
    expose(service: string, methods: Record<string, ServiceHandler>): void;
    /** 注册扩展 UI 页面（与 manifest `ui.pages` 等价，二选一即可） */
    page(path: string, page: { title: string; entry: string }): void;
    /** 注册扩展菜单项（与 manifest `ui.menu` 等价；单值语义，最后一次提供为准） */
    menu(label: string, icon?: string): void;
    /** 登记长任务执行器：tasks.dispatch({name}) → host.task → handler(args, ctx) */
    task(name: string, handler: TaskHandler): void;
    /** 登记本扩展为认证提供方（仅激活期；需 manifest 权限 'auth:provider'；每扩展至多一个） */
    authProvider(handler: AuthVerifyHandler): void;
  }

  // ---------------------------------------------------------------------------
  // HTTP（route / webhook）
  // ---------------------------------------------------------------------------

  /** 路由处理上下文：内核已解析 body；auth 非 public 的路由派发前已完成鉴权 */
  interface RouteContext {
    /** HTTP 方法（大写） */
    method: string;
    /** 路径参数（`:param` 提取） */
    params: Record<string, string>;
    /** 查询参数（单值视图） */
    query: Record<string, unknown>;
    /** 请求头（原样键；安全裁剪后透传） */
    headers: Record<string, string | string[] | undefined>;
    /** 请求体（仅 POST/PUT/PATCH 解析；其余方法为 null） */
    body?: unknown;
    /** 原始请求体文本（仅 webhook 验签场景由内核提供） */
    rawBody?: string;
    /** 内核贯穿日志的请求 ID */
    requestId: string;
  }

  /**
   * 处理器返回值：普通值 → 200 JSON（undefined → null）；
   * 或显式 `{ status, headers?, body }` 全量响应。
   */
  type RouteHandlerResult = unknown | { status: number; headers?: Record<string, string>; body: unknown };

  type RouteHandler = (request: RouteContext) => RouteHandlerResult | Promise<RouteHandlerResult>;

  interface RouteOptions {
    /** 鉴权档位，默认 'public'；user/admin 由内核 AuthProxy 在派发前校验 */
    auth?: string;
    /** 需要的 API Key scope（auth:'user' 时可叠加） */
    scope?: string;
    /** 处理器超时（毫秒），默认取内核 routeTimeoutMs；超时返回 `HARNESS-1002` */
    timeoutMs?: number;
  }

  interface WebhookOptions {
    /** HMAC-SHA256 共享密钥；提供时校验 x-harness-signature（hex(hmac_sha256(secret, ts + '.' + rawBody))），失败 401 */
    secret?: string;
  }

  // ---------------------------------------------------------------------------
  // Events / Hooks
  // ---------------------------------------------------------------------------

  /** 事件元信息（与内核 EventBus 投递 meta 一致） */
  interface EventMeta {
    /** 事件名 */
    name: string;
    /** 来源标识：'kernel' 或 'ext:<id>' */
    source: string;
  }

  type EventHandler = (payload: unknown, meta: EventMeta) => unknown | Promise<unknown>;

  /** hook 处理器：接收上一个处理器的输出，返回改写后的值（undefined 视为"不改写"）；抛 HookAbort 形状对象可短路 */
  type HookHandler = (value: unknown, ctx: unknown) => unknown | Promise<unknown>;

  // ---------------------------------------------------------------------------
  // Registry RPC（expose / call）
  // ---------------------------------------------------------------------------

  type ServiceHandler = (args: unknown) => unknown | Promise<unknown>;

  // ---------------------------------------------------------------------------
  // Cron（h.cron.schedule：input 发内核调度，handler 本地登记，cronFire 时调用）
  // ---------------------------------------------------------------------------

  type CronHandler = () => unknown | Promise<unknown>;

  interface CronScheduleInput {
    /** 任务名（扩展内唯一；内核按 `extId:name` 内部命名） */
    name: string;
    /** 标准 5 段 cron 表达式 */
    expr: string;
    /** IANA 时区，缺省用内核 timezone；调度存储一律 UTC */
    tz?: string;
    /** 触发时随事件回传的负载 */
    payload?: unknown;
    /** 上次未结束时再触发：true 视为 'queue'（排队续跑），缺省 skip */
    overlap?: boolean;
    /** 错过触发点：'skip' | 'runOnce' */
    misfire?: string;
  }

  interface CronApi {
    schedule(input: CronScheduleInput, handler: CronHandler): Promise<unknown>;
    unschedule(name: string): Promise<unknown>;
  }

  // ---------------------------------------------------------------------------
  // Notification（h.notify.send：payload 透传内核 NotificationManager.send）
  // ---------------------------------------------------------------------------

  type NotifyLevel = 'info' | 'success' | 'warn' | 'error';

  interface NotifyInput {
    /** 标题（单行摘要，必填） */
    title: string;
    /** 正文（纯文本，缺省 ''） */
    body?: string;
    /** 级别（缺省 'info'） */
    level?: NotifyLevel;
    /** 结构化附加数据（任意可 JSON 序列化值） */
    data?: unknown;
  }

  interface NotifyApi {
    send(input: NotifyInput): Promise<unknown>;
  }

  // ---------------------------------------------------------------------------
  // Chat
  // ---------------------------------------------------------------------------

  interface ChatSendInput {
    /** 目标频道 ID 或 slug（二选一，channelId 优先） */
    channelId?: string;
    slug?: string;
    /** 消息正文（如 { type: 'text', text } / { type: 'card', card }） */
    content: unknown;
    /** 附件（可省） */
    attachments?: unknown;
  }

  interface ChatApi {
    /** 向频道发送一条消息（senderType 恒 'ext'，senderId 为本扩展 id） */
    send(input: ChatSendInput): Promise<unknown>;
    /** 更新消息正文：{ id, content } */
    patch(input: { id: string; content: unknown }): Promise<unknown>;
  }

  // ---------------------------------------------------------------------------
  // Files（与内核 FileService / 沙箱 8MB 上限对齐）
  // ---------------------------------------------------------------------------

  interface FileSaveInput {
    /** 原始文件名（内核自动净化） */
    origName: string;
    /** MIME 类型（缺省按二进制处理） */
    mime: string;
    /** 内容：二进制（Uint8Array/Buffer，自动转 base64）或已是 base64 的字符串；上限 8MB */
    data: string | Uint8Array;
    /** 'private'（默认）| 'public' */
    visibility?: string;
    /** 归属扩展 id（缺省本扩展） */
    extId?: string;
  }

  interface FilesApi {
    /** 存储文件（返回 FileRecord 形状：{ id, origName, mime, size, visibility, ... }） */
    save(input: FileSaveInput): Promise<unknown>;
    /** 元信息；不存在返回 null */
    get(id: string): Promise<unknown>;
    /** 读取内容 → base64 字符串（沙箱无 Buffer，扩展侧自行解码） */
    read(id: string): Promise<string>;
  }

  // ---------------------------------------------------------------------------
  // Tasks（与内核 TaskManager / 沙箱 TaskContext 对齐）
  // ---------------------------------------------------------------------------

  /** 任务执行上下文（worker 按次装配，回调转发内核 task.* topic） */
  interface TaskContext {
    progress(pct: number, msg?: string): Promise<void>;
    complete(result?: unknown): Promise<void>;
    fail(error: unknown): Promise<void>;
  }

  type TaskHandler = (args: unknown, ctx: TaskContext) => unknown | Promise<unknown>;

  interface TasksApi {
    /** 派发长任务（异步执行，立即返回 queued 记录；handler 需已用 h.task 登记） */
    dispatch(input: { name: string; args?: unknown }): Promise<unknown>;
    progress(taskId: string, pct: number, msg?: string): Promise<unknown>;
    complete(taskId: string, result?: unknown): Promise<unknown>;
    fail(taskId: string, error: unknown): Promise<unknown>;
  }

  // ---------------------------------------------------------------------------
  // DB（per-extension SQLite：单语句 + 参数绑定，禁多语句/ATTACH/DETACH/load_extension）
  // ---------------------------------------------------------------------------

  interface DbApi {
    /** 查询多行（数组；无行为空数组） */
    all(sql: string, params?: unknown[]): Promise<unknown>;
    /** 查询单行；无行返回 null */
    get(sql: string, params?: unknown[]): Promise<unknown>;
    /** 执行写语句，返回 { changes, lastInsertRowid? } */
    run(sql: string, params?: unknown[]): Promise<unknown>;
    /** 建表/迁移批次（语句数组，逐条执行；单条失败即抛） */
    schema(statements: string[]): Promise<unknown>;
  }

  // ---------------------------------------------------------------------------
  // LLM / Sandbox / System
  // ---------------------------------------------------------------------------

  interface LlmApi {
    /** 一次性对话补全（payload 与 REST /api/v1/llm/chat 非流式 body 同形状；流式走 REST SSE） */
    chat(input: unknown): Promise<unknown>;
  }

  interface SandboxApi {
    /**
     * 在持久 Workspace 容器内执行命令（workspaceId 缺省 'ext-<extId>' 扩展家目录；
     * payload 形状：{ cmd: string[], workspaceId?, timeoutMs?, isolated?, workdir?, env? }；
     * 需 manifest 权限 'sandbox'）。
     */
    exec(input: unknown): Promise<unknown>;
  }

  /** 沙箱化代码执行会话（kernel CodingEngine；需 manifest 权限 'sandbox'）。
   * 会话目录 `<dataDir>/coding-workspaces/<sessionId>/`（sessionId 缺省 "default"）；
   * 命令白名单 + shell:false argv 直传 + 超时 kill + 输出 256KB 截断 + 每会话 1 进程
   * （忙时抛 HARNESS SANDBOX_BUSY）；路径参数一律会话目录内相对（绝对路径与 ".." 拒绝）。 */
  interface CodingApi {
    /** 执行白名单命令：{ sessionId?, cmd, args?, cwd?, timeoutMs?, env? } → { exitCode, stdout, stderr, durationMs, truncated, timedOut } */
    exec(input: unknown): Promise<unknown>;
    /** 执行源码：{ sessionId?, language: 'node'|'python', code, timeoutMs? } → 同 exec（临时文件自动清理） */
    runCode(input: unknown): Promise<unknown>;
    /** 写会话文件：{ sessionId?, path, content } → { path, size } */
    fsWrite(input: unknown): Promise<unknown>;
    /** 读会话文件：{ sessionId?, path } → { path, size, content, truncated } */
    fsRead(input: unknown): Promise<unknown>;
    /** 列会话目录（一级）：{ sessionId?, path? } → [{ name, size, dir }] */
    fsList(input: unknown): Promise<unknown>;
    /** 列出全部会话：{} → [{ id, dir, createdAt }] */
    sessions(): Promise<unknown>;
    /** 重置会话（清空目录）：{ sessionId? } → { id, dir, createdAt } */
    resetSession(input: unknown): Promise<unknown>;
    /** 删除会话：{ sessionId } → { deleted: boolean } */
    deleteSession(input: unknown): Promise<unknown>;
  }

  interface SystemApi {
    /** 系统信息（版本/env/uptime/counters） */
    info(): Promise<unknown>;
    /** 进程资源水位（pid/platform/memory/loadavg） */
    stats(): Promise<unknown>;
  }

  /** 浏览器自动化内核引擎（kernel BrowserEngine，Playwright 跑在内核主线程；需 manifest 权限 'browser'）。
   * 浏览器二进制默认不下载：未安装时 status().installed=false，install() 触发后台下载（幂等）。 */
  interface BrowserApi {
    /** 运行态快照：installed=chromium 已装 / running=浏览器实例存活 / installing=后台安装中 */
    status(): Promise<{ installed: boolean; running: boolean; installing: boolean; lastError: string | null }>;
    /** 触发后台安装 chromium（幂等；立即返回 { started }，完成态经 status 观察） */
    install(): Promise<{ started: boolean; installed?: boolean; installing?: boolean }>;
    /** 读取引擎截图文件（file 必须是 browser_screenshot 工具产出的 <uuid>.png，防穿越） */
    readScreenshot(file: string): Promise<{ file: string; mime: string; base64: string }>;
  }

  /** 扩展私有 KV 存储（内核 ext_kv 表；值 JSON 序列化落库，损坏读回 null） */
  interface StorageApi {
    get(key: string): Promise<unknown>;    set(key: string, value: unknown): Promise<unknown>;
    delete(key: string): Promise<unknown>;
  }

  interface ConfigApi {
    /** 按点分路径读取内核配置；敏感键（token/secret/password/apiKey）命中即 FORBIDDEN */
    get<T = unknown>(path: string, fallback?: T): Promise<T | undefined>;
  }

  // ---------------------------------------------------------------------------
  // UI（page / menu / ui.register，与 manifest `ui.*` 声明等价，二选一即可）
  // ---------------------------------------------------------------------------

  interface PageDefinition {
    /** 扩展内页面路径（如 '/'） */
    path: string;
    /** 页面标题 */
    title: string;
    /** 入口 HTML（相对扩展目录） */
    entry: string;
  }

  interface MenuDefinition {
    /** 菜单显示名 */
    label: string;
    /** 图标名（可选） */
    icon?: string;
  }

  interface UiApi {
    /** 整段合并一个 UI 片段：{ pages?: [...], menu?: [...] }（激活期） */
    register(fragment: { pages?: PageDefinition[]; menu?: MenuDefinition[] }): void;
  }

  // ---------------------------------------------------------------------------
  // Log
  // ---------------------------------------------------------------------------

  type LogLevel = 'debug' | 'info' | 'warn' | 'error';

  interface LogApi {
    debug(message: unknown, data?: unknown): void;
    info(message: unknown, data?: unknown): void;
    warn(message: unknown, data?: unknown): void;
    error(message: unknown, data?: unknown): void;
  }
}

export {};
