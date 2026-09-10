/**
 * protocol — 主线程（Kernel）⇄ 扩展线程（Extension Worker）的 RPC 信封。
 *
 * 这是阶段 9 全部跨线程通信的单一事实来源：
 * - 内核 → 扩展线程：`type: 'call'`，`topic` 一律取 HOST_METHODS.*（host.load / host.unload / …）；
 * - 扩展线程 → 内核：`type: 'call'`，`topic` 一律取 KERNEL_TOPICS.*（storage.get / db.all / …）；
 * - 应答：`type: 'reply'`，同 `id` 关联；成功 `ok: true`（payload 为结果），
 *   失败 `ok: false` + `err: { code, message, detail? }`；
 * - 单向事件/hook 派发：`type: 'dispatch'`，`id` 用 'evt-<uuid>'（无需应答）。
 *
 * 信封结构由 zod 校验（isRpcEnvelope）；两侧收包后必须先过闸再消费，
 * 伪造/损坏的信封在线程边界直接丢弃。
 */
import { z } from 'zod';

/** RPC 信封（跨线程传输的 wire format） */
export interface RpcEnvelope {
  /** 协议版本（当前固定 1，破坏性变更时递增） */
  v: 1;
  /** 关联 id（uuid）；单向通知用 'evt-<uuid>' */
  id: string;
  /** 发起方：内核固定 'kernel'，扩展为 'ext:<扩展id>' */
  from: 'kernel' | `ext:${string}`;
  /** 接收方：同 from 语义 */
  to: 'kernel' | `ext:${string}`;
  /** call=请求（等待 reply）；reply=应答；dispatch=单向事件/hook 派发 */
  type: 'call' | 'reply' | 'dispatch';
  /** call/reply=方法名；dispatch=事件/hook 名 */
  topic: string;
  /** 请求参数 / 应答结果 / 事件负载 */
  payload?: unknown;
  /** reply 专用：true=成功（payload 为结果） */
  ok?: boolean;
  /** reply 失败专用：规整后的错误（code 为 HARNESS-* 或扩展自定义码） */
  err?: { code: string; message: string; detail?: unknown };
}

/** 内核调用扩展线程的方法名（扩展线程侧 host 对象必须实现的入口） */
export const HOST_METHODS = {
  loadExt: 'host.load',
  unloadExt: 'host.unload',
  routeRequest: 'host.route',
  eventDispatch: 'host.event',
  hookApply: 'host.hook',
  cronFire: 'host.cron',
  callService: 'host.call',
  taskRun: 'host.task',
  /** 内核 → 扩展：认证校验（AuthProxy → Registry → 扩展注册的 provider handler）；
   *  payload { token?, headers } → 应答 payload { ok: true, identity } */
  authVerify: 'host.authVerify',
} as const;

/** 扩展线程调用内核服务的 topic（内核侧 RPC 网关按此分发到核心服务） */
export const KERNEL_TOPICS = {
  log: 'log',
  storageGet: 'storage.get',
  storageSet: 'storage.set',
  storageDelete: 'storage.delete',
  configGet: 'config.get',
  dbAll: 'db.all',
  dbGet: 'db.get',
  dbRun: 'db.run',
  dbSchema: 'db.schema',
  notifySend: 'notify.send',
  chatSend: 'chat.send',
  chatPatch: 'chat.patch',
  filesSave: 'files.save',
  filesRead: 'files.read',
  filesGet: 'files.get',
  tasksDispatch: 'tasks.dispatch',
  taskProgress: 'task.progress',
  taskComplete: 'task.complete',
  taskFail: 'task.fail',
  cronSchedule: 'cron.schedule',
  cronUnschedule: 'cron.unschedule',
  uiRegister: 'ui.register',
  llmChat: 'llm.chat',
  sandboxExec: 'sandbox.exec',
  systemInfo: 'system.info',
  systemStats: 'system.stats',
  /** 出站 HTTP（内核 fetch 代理 + SSRF 防护）：需 manifest 声明 net:out / net:out:<host> */
  httpFetch: 'http.fetch',
  // ---- Skills / MCP / 插件（OS 能力目录）----
  skillsList: 'skills.list',
  skillsGet: 'skills.get',
  skillsRefresh: 'skills.refresh',
  skillsRegister: 'skills.register',
  mcpServersList: 'mcp.servers.list',
  mcpServerAdd: 'mcp.servers.add',
  mcpServerRemove: 'mcp.servers.remove',
  mcpToolsList: 'mcp.tools.list',
  mcpToolsCall: 'mcp.tools.call',
  mcpResourcesList: 'mcp.resources.list',
  mcpResourcesRead: 'mcp.resources.read',
  mcpPromptsList: 'mcp.prompts.list',
  mcpPromptsGet: 'mcp.prompts.get',
  pluginsList: 'plugins.list',
  extractFile: 'extract.file',
  extractStatus: 'extract.status',
  memorySearch: 'memory.search',
  memoryAdd: 'memory.add',
  memoryExtract: 'memory.extract',
  memoryList: 'memory.list',
  memoryForget: 'memory.forget',
  asrStatus: 'asr.status',
  asrTranscribe: 'asr.transcribe',
  // ---- 浏览器自动化（内核引擎，Playwright 跑在内核主线程；扩展壳 h.browser.* 转发）----
  /** 运行态快照 {} → { installed, running, installing, lastError }（需 'browser' 权限） */
  browserStatus: 'browser.status',
  /** 触发后台安装 chromium（幂等，不等完成）（需 'browser' 权限） */
  browserInstall: 'browser.install',
  /** 读取截图文件 { file } → { file, mime, base64 }（uuid 形状校验防穿越；需 'browser' 权限） */
  browserScreenshot: 'browser.screenshot',
  // ---- Coding（沙箱化代码执行会话；引擎 src/kernel/coding，需 'sandbox' 权限）----
  codingExec: 'coding.exec',
  codingRunCode: 'coding.runCode',
  codingFsWrite: 'coding.fs.write',
  codingFsRead: 'coding.fs.read',
  codingFsList: 'coding.fs.list',
  codingSessions: 'coding.sessions',
  codingSessionReset: 'coding.session.reset',
  codingSessionDelete: 'coding.session.delete',
  /** SHA-256 摘要（令牌脱敏存储等）：{ value } → { hash }（需 'auth:provider' 权限） */
  authHashToken: 'auth.hashToken',
  authTotpGenerate: 'auth.totpGenerate',
  authTotpVerify: 'auth.totpVerify',
  authVerifyRootToken: 'auth.verifyRootToken',
  /** 密码哈希（内核 scrypt）：{ password } → { hash }（需 'auth:provider' 权限） */
  authHashPassword: 'auth.hashPassword',
  /** 密码校验（内核 scrypt）：{ password, hash } → { ok }（需 'auth:provider' 权限） */
  authVerifyPassword: 'auth.verifyPassword',
  /** 注册本扩展为 AuthProvider（provider 名 = 扩展 id；需 'auth:provider' 权限） */
  authRegisterProvider: 'auth.registerProvider',
  /** 注销本扩展的 AuthProvider（需 'auth:provider' 权限） */
  authUnregisterProvider: 'auth.unregisterProvider',
} as const;

/** 信封端点：'kernel' 或 'ext:<扩展id>' */
const envelopeEndpointSchema = z.union([z.literal('kernel'), z.templateLiteral(['ext:', z.string()])]);

/** reply.err 的形状 */
const envelopeErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string(),
  detail: z.unknown().optional(),
});

/** RpcEnvelope 的 zod schema（未知键剥离，向前兼容新字段） */
export const rpcEnvelopeSchema = z.object({
  v: z.literal(1),
  id: z.string().min(1),
  from: envelopeEndpointSchema,
  to: envelopeEndpointSchema,
  type: z.enum(['call', 'reply', 'dispatch']),
  topic: z.string().min(1),
  payload: z.unknown().optional(),
  ok: z.boolean().optional(),
  err: envelopeErrorSchema.optional(),
});

// 编译期闸门：zod 推断的输出类型必须与手写 RpcEnvelope 接口完全一致，
// 两侧漂移时此处 tsc 直接报错（协议单一事实来源的守护）。
const _envelopeTypeCheck: z.ZodType<RpcEnvelope> = rpcEnvelopeSchema;
void _envelopeTypeCheck;

/**
 * 判断任意值是否为合法 RPC 信封（线程边界收包闸）。
 * 只做结构校验，不校验方向语义（from/to 一致性由收包方按会话裁决）。
 */
export function isRpcEnvelope(x: unknown): x is RpcEnvelope {
  return rpcEnvelopeSchema.safeParse(x).success;
}
