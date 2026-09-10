/**
 * api — REST fetch 封装。
 *
 * - 凭据存 localStorage('ui.token')（会话用户缓存 'ui.user'）；
 * - 自动携带 Authorization: Bearer <token>；401 → 清凭据并跳登录页（hash 路由）；
 * - 错误统一形状 { code, message, detail?, status }（内核 HarnessError.toJSON 契约），
 *   失败默认经 toast 呈现（调用方传 silent 自行处理）。
 */
import { toast } from '@/components/ui/toast';

const TOKEN_KEY = 'ui.token';
const USER_KEY = 'ui.user';

/** 统一错误形状（与内核 { code, message, detail? } 对齐的最小视图） */
export interface ApiError {
  code: string;
  message: string;
  detail?: unknown;
  status: number;
}

// ---------------------------------------------------------------------------
// 凭据存取
// ---------------------------------------------------------------------------

export function getToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

export function setToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* 存储不可用时凭据仅本次会话有效 */
  }
}

export function clearToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  } catch {
    /* 同上 */
  }
}

/** 登录用户缓存（Login 写入 / 顶栏读取；以 /auth/me 实时校准） */
export interface SessionUser {
  id?: string;
  userId?: string;
  username?: string | null;
  role?: string;
}

export function getCachedUser(): SessionUser | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw === null ? null : (JSON.parse(raw) as SessionUser);
  } catch {
    return null;
  }
}

export function setCachedUser(user: SessionUser): void {
  try {
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  } catch {
    /* 同上 */
  }
}

// ---------------------------------------------------------------------------
// 请求核心
// ---------------------------------------------------------------------------

function gotoLogin(): void {
  if (location.hash !== '#/login') location.hash = '#/login';
}

async function toApiError(res: Response): Promise<ApiError> {
  let code = `HTTP-${res.status}`;
  let message = res.statusText || '请求失败';
  let detail: unknown;
  try {
    const body = (await res.json()) as { code?: unknown; message?: unknown; detail?: unknown };
    if (typeof body.code === 'string') code = body.code;
    if (typeof body.message === 'string') message = body.message;
    detail = body.detail;
  } catch {
    /* 非 JSON 响应体：保留 HTTP 状态形状 */
  }
  return { code, message, detail, status: res.status };
}

export interface RequestOptions {
  /** true 时不自动 toast（调用方自行渲染错误态，如登录页） */
  silent?: boolean;
  /** true 时 401 不清凭据/跳登录（公开 auth 端点的 401 属业务语义：root 令牌错误、动态码错误等） */
  skipAuthRedirect?: boolean;
  /** 原始 body（对象 → JSON；FormData 原样交由浏览器补 multipart boundary） */
  body?: unknown;
}

async function request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token !== '') headers['authorization'] = `Bearer ${token}`;
  let payload: BodyInit | undefined;
  if (opts.body instanceof FormData) {
    payload = opts.body;
  } else if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(opts.body);
  }
  let res: Response;
  try {
    res = await fetch(path, { method, headers, body: payload });
  } catch (e) {
    const err: ApiError = { code: 'NETWORK', message: e instanceof Error ? e.message : '网络错误', status: 0 };
    if (opts.silent !== true) toast.error(`[${err.code}] ${err.message}`);
    throw err;
  }
  if (res.status === 401 && opts.skipAuthRedirect !== true) {
    clearToken();
    gotoLogin();
  }
  if (!res.ok) {
    const err = await toApiError(res);
    if (opts.silent !== true) toast.error(`[${err.code}] ${err.message}`);
    throw err;
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (text === '') return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T; // 文本/二进制下载兜底
  }
}

export const api = {
  get: <T>(path: string, opts?: RequestOptions) => request<T>('GET', path, opts),
  post: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>('POST', path, { ...opts, body }),
  put: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>('PUT', path, { ...opts, body }),
  patch: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>('PATCH', path, { ...opts, body }),
  delete: <T>(path: string, opts?: RequestOptions) => request<T>('DELETE', path, opts),
};

// ---------------------------------------------------------------------------
// REST 形状（与内核 src/api/*、auth 扩展对齐的最小视图；W2-W4 页面包按需扩展）
// ---------------------------------------------------------------------------

/** POST /api/v1/auth/login 响应（auth 扩展） */
export interface LoginResult {
  token: string;
  expiresAt: number;
  user: { id: string; username: string; role: string };
}

// ---------------------------------------------------------------------------
// Auth 公开端点（onboarding 向导 / 2FA 绑定 — 与 auth 扩展端点契约逐字对齐；
// 全部相对根 /api/v1/auth，调用走上面的 request 核心，401 不跳登录）
// ---------------------------------------------------------------------------

/** 公开 auth 调用公共选项：401 属业务语义（root 令牌错误/动态码错误），错误由调用方呈现 */
const AUTH_PUBLIC: RequestOptions = { silent: true, skipAuthRedirect: true };

/** GET /api/v1/auth/onboarding/status 响应（公开） */
export interface OnboardingStatusResult {
  needsOnboarding: boolean;
}

/** POST /api/v1/auth/onboarding 成功响应（owner 创建/重置成功 → 进入强制 2FA 绑定） */
export interface OnboardingEnrollRequired {
  enrollmentRequired: true;
  enrollToken: string;
}

/** GET /api/v1/auth/2fa/setup 响应（uri 供二维码渲染，secret 供手输） */
export interface TwoFactorSetupResult {
  uri: string;
  secret: string;
}

/** POST /api/v1/auth/2fa/enroll 成功响应（绑定成功并签发会话） */
export interface TwoFactorEnrollResult {
  token: string;
  user: LoginResult['user'];
}

/** POST /api/v1/auth/login 的三种 200 形状（调用方按 mfaRequired/enrollmentRequired 字段判别） */
export type LoginResponse =
  | LoginResult
  | { mfaRequired: true; mfaToken: string }
  | { enrollmentRequired: true; enrollToken: string };

/** GET /api/v1/auth/onboarding/status（公开）：系统是否尚未初始化 */
export function getOnboardingStatus(): Promise<OnboardingStatusResult> {
  return api.get<OnboardingStatusResult>('/api/v1/auth/onboarding/status', AUTH_PUBLIC);
}

/** POST /api/v1/auth/onboarding（公开）：root 令牌验证 + 创建/重置 owner 账号 */
export function postOnboarding(body: {
  rootToken: string;
  username: string;
  password: string;
}): Promise<OnboardingEnrollRequired> {
  return api.post<OnboardingEnrollRequired>('/api/v1/auth/onboarding', body, AUTH_PUBLIC);
}

/** GET /api/v1/auth/2fa/setup?enrollToken=<t>（公开）：取 otpauth uri 与手输 secret */
export function getTwoFactorSetup(enrollToken: string): Promise<TwoFactorSetupResult> {
  return api.get<TwoFactorSetupResult>(
    `/api/v1/auth/2fa/setup?enrollToken=${encodeURIComponent(enrollToken)}`,
    AUTH_PUBLIC,
  );
}

/** POST /api/v1/auth/2fa/enroll（公开）：绑定认证器，成功即签发会话 */
export function postTwoFactorEnroll(body: {
  enrollToken: string;
  code: string;
}): Promise<TwoFactorEnrollResult> {
  return api.post<TwoFactorEnrollResult>('/api/v1/auth/2fa/enroll', body, AUTH_PUBLIC);
}

/** GET /api/v1/auth/me 响应（auth 扩展） */
export interface MeResult {
  userId: string;
  username: string | null;
  role: string;
  scopes: string[];
  tokenType: string;
}

/** GET /api/v1/notifications 响应的未读数来源 */
export interface NotificationList {
  items: unknown[];
  unread: number;
}

export interface SystemInfo {
  name: string;
  env: string;
  version: string;
  uptimeMs: number;
  node: string;
  timezone: string;
  state: string;
  counters: Record<string, number>;
}

// ---------------------------------------------------------------------------
// 管理页 REST 面（Skills / MCP / Plugins + 系统 MCP 服务端探测 — 管理台三页工作包追加）。
//
// 线形状与内核 src/api/{skills,mcp,plugins}.ts、src/kernel/{skills,mcp,plugins}、
// /mcp 网关逐字段对齐；页面包视图类型见 pages/Skills/shared.tsx、pages/Mcp/shared.tsx、
// pages/Plugins/shared.tsx（结构兼容，可互相赋值）。既有方法不改动。
// ---------------------------------------------------------------------------

/** Skill 来源（内核 SkillSource：builtin=repoRoot/skills，data=<dataDir>/skills，extension=扩展贡献） */
export type SkillSourceWire = 'builtin' | 'data' | 'extension';

/** GET /api/v1/skills 条目（内核 SkillEntry 只读投影；不含正文） */
export interface SkillEntryWire {
  id: string;
  name: string;
  description: string;
  version?: string;
  author?: string;
  tags: string[];
  /** frontmatter enabled（缺省 true；注册表只记录事实，REST 无启停写面） */
  enabled: boolean;
  source: SkillSourceWire;
  sourceRef: string;
  bodyBytes: number;
  files: string[];
}

/** GET /api/v1/skills/:id 响应 = 条目 + 正文（≤128KB） */
export type SkillDetailWire = SkillEntryWire & { body: string };

/** POST /api/v1/skills 请求体（id ^[a-z0-9-]{1,64}$，写后内核自动 refresh） */
export interface SkillCreateInput {
  id: string;
  name: string;
  description: string;
  body: string;
  tags?: string[];
  author?: string;
}

/** POST /api/v1/skills/refresh 响应（bySource 三键恒在） */
export interface SkillsRefreshReportWire {
  total: number;
  bySource: Record<SkillSourceWire, number>;
}

/** Skills 管理页 REST 方法（写面 admin/root 门禁在内核） */
export const skillsApi = {
  /** GET /api/v1/skills — 全量列表（数据量小，前端过滤/分页） */
  list: (): Promise<SkillEntryWire[]> => api.get<SkillEntryWire[]>('/api/v1/skills'),
  /** GET /api/v1/skills/:id — 详情（含正文） */
  get: (id: string): Promise<SkillDetailWire> =>
    api.get<SkillDetailWire>(`/api/v1/skills/${encodeURIComponent(id)}`),
  /** POST /api/v1/skills — 创建（写入数据卷，201 { id, path }） */
  create: (input: SkillCreateInput): Promise<{ id: string; path: string }> =>
    api.post<{ id: string; path: string }>('/api/v1/skills', input),
  /** DELETE /api/v1/skills/:id — 删除（仅 data 源可删） */
  remove: (id: string): Promise<{ ok: boolean; id: string }> =>
    api.delete<{ ok: boolean; id: string }>(`/api/v1/skills/${encodeURIComponent(id)}`),
  /** POST /api/v1/skills/refresh — 重扫技能库 */
  refresh: (): Promise<SkillsRefreshReportWire> =>
    api.post<SkillsRefreshReportWire>('/api/v1/skills/refresh'),
};

/** MCP 传输形态（内核 McpTransportKind） */
export type McpTransportWire = 'stdio' | 'streamable-http' | 'sse';

/** MCP server 运行态（内核 McpServerState：never → connect → connected | error；disabled 恒由 enabled=false） */
export type McpStateWire = 'connected' | 'error' | 'disabled' | 'never';

/** GET /api/v1/mcp/servers 条目（内核 McpServerSummary = 配置 + 运行态） */
export interface McpServerSummaryWire {
  id: string;
  name: string;
  transport: McpTransportWire;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled: boolean;
  timeoutMs?: number;
  state: McpStateWire;
  error?: string;
  /** 连接期缓存的工具数（未连接为 0） */
  toolCount: number;
}

/** POST /api/v1/mcp/servers 请求体（stdio 必 command；streamable-http/sse 必 http(s) url） */
export interface McpServerCreateInput {
  id: string;
  name: string;
  transport: McpTransportWire;
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  enabled?: boolean;
  timeoutMs?: number;
}

/** PATCH /api/v1/mcp/servers/:id 请求体（enabled=false 立即断连） */
export interface McpServerPatchInput {
  enabled?: boolean;
  name?: string;
  headers?: Record<string, string>;
}

/** GET /api/v1/mcp/tools 条目（连接期缓存目录，附 serverId） */
export interface McpToolWire {
  serverId: string;
  name: string;
  description?: string;
  inputSchema?: unknown;
}

/** MCP 客户端管理 REST 方法（全部 admin/root 门禁在内核） */
export const mcpApi = {
  /** GET /api/v1/mcp/servers — 全部 server 配置+状态 */
  listServers: (): Promise<McpServerSummaryWire[]> => api.get<McpServerSummaryWire[]>('/api/v1/mcp/servers'),
  /** POST /api/v1/mcp/servers — 新增配置（201；只落盘不自动连接） */
  createServer: (input: McpServerCreateInput): Promise<McpServerSummaryWire> =>
    api.post<McpServerSummaryWire>('/api/v1/mcp/servers', input),
  /** PATCH /api/v1/mcp/servers/:id — enabled/name/headers */
  patchServer: (id: string, input: McpServerPatchInput): Promise<McpServerSummaryWire> =>
    api.patch<McpServerSummaryWire>(`/api/v1/mcp/servers/${encodeURIComponent(id)}`, input),
  /** DELETE /api/v1/mcp/servers/:id — 删除配置并断连 */
  removeServer: (id: string): Promise<{ deleted: boolean; id: string }> =>
    api.delete<{ deleted: boolean; id: string }>(`/api/v1/mcp/servers/${encodeURIComponent(id)}`),
  /** POST /api/v1/mcp/servers/:id/connect — 手动（重）连接 / 连通性测试 → status */
  connectServer: (id: string): Promise<{ state: string; toolCount: number }> =>
    api.post<{ state: string; toolCount: number }>(
      `/api/v1/mcp/servers/${encodeURIComponent(id)}/connect`,
    ),
  /** GET /api/v1/mcp/tools?serverId= — 工具目录（可选按 server 过滤） */
  listTools: (serverId?: string): Promise<McpToolWire[]> =>
    api.get<McpToolWire[]>(
      serverId === undefined ? '/api/v1/mcp/tools' : `/api/v1/mcp/tools?serverId=${encodeURIComponent(serverId)}`,
    ),
};

/** 系统操作 MCP 服务端（/mcp 网关）工具目录条目（tools/list 投影） */
export interface SystemMcpToolWire {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

/**
 * getSystemMcpTools — 系统操作 MCP 服务端工具目录（JSON-RPC tools/list 直连 /mcp）。
 *
 * /mcp 是无状态 Streamable HTTP 端点（每请求独立协议实例，enableJsonResponse）：
 * - 请求头必须同时 Accept application/json 与 text/event-stream（SDK transport 406 闸）；
 * - 凭据走 Authorization Bearer（extractToken 契约，与 api 核心一致）；
 * - 无状态实例不强制 initialize 先行，裸 tools/list 由已注册的 ListTools 处理器应答；
 * - 服务端在位 = 正常返回目录；401/403/404/网络失败 → ApiError 形状抛出（调用方内联展示）。
 */
export async function getSystemMcpTools(): Promise<SystemMcpToolWire[]> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  const token = getToken();
  if (token !== '') headers['authorization'] = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch('/mcp', {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
  } catch (e) {
    const err: ApiError = { code: 'NETWORK', message: e instanceof Error ? e.message : '网络错误', status: 0 };
    throw err;
  }
  if (!res.ok) {
    throw await toApiError(res);
  }
  let frame: { result?: { tools?: SystemMcpToolWire[] }; error?: { code?: number; message?: string } };
  try {
    frame = (await res.json()) as typeof frame;
  } catch {
    const err: ApiError = { code: 'MCP-PROTOCOL', message: '/mcp 响应不是合法 JSON', status: res.status };
    throw err;
  }
  if (frame.error !== undefined) {
    const err: ApiError = {
      code: 'MCP-PROTOCOL',
      message: frame.error.message ?? 'tools/list 调用失败（JSON-RPC error）',
      detail: frame.error,
      status: res.status,
    };
    throw err;
  }
  return Array.isArray(frame.result?.tools) ? frame.result.tools : [];
}

/** GET /api/v1/plugins 条目（内核 InstalledPlugin 摘要；:id 详情同形） */
export interface InstalledPluginWire {
  id: string;
  name: string;
  version: string;
  description: string;
  /** 贡献的 skill 数 */
  skills: number;
  /** 贡献的 prompt 数 */
  prompts: number;
  /** 声明的 MCP server 数 */
  mcpServers: number;
  /** 声明的可执行脚本数 */
  scripts: number;
  /** 安装时间（UTC ISO8601） */
  installedAt: string;
}

/** Plugins 管理页 REST 方法（全部 admin/root 门禁在内核） */
export const pluginsApi = {
  /** GET /api/v1/plugins — 已安装插件列表 */
  list: (): Promise<InstalledPluginWire[]> => api.get<InstalledPluginWire[]>('/api/v1/plugins'),
  /** GET /api/v1/plugins/:id — 单个插件摘要 */
  get: (id: string): Promise<InstalledPluginWire> =>
    api.get<InstalledPluginWire>(`/api/v1/plugins/${encodeURIComponent(id)}`),
  /** POST /api/v1/plugins/install — zip 安装（multipart field 'file'，≤64MB；?overwrite=1 覆盖） */
  install: (zip: File, overwrite: boolean): Promise<InstalledPluginWire> => {
    const form = new FormData();
    form.append('file', zip);
    return api.post<InstalledPluginWire>(`/api/v1/plugins/install${overwrite ? '?overwrite=1' : ''}`, form);
  },
  /** DELETE /api/v1/plugins/:id — 卸载（?force=1 摘贡献后删目录） */
  remove: (id: string, force: boolean): Promise<{ deleted: boolean }> =>
    api.delete<{ deleted: boolean }>(`/api/v1/plugins/${encodeURIComponent(id)}${force ? '?force=1' : ''}`),
  /** POST /api/v1/plugins/refresh — 重新扫描聚合 → { plugins } */
  refresh: (): Promise<{ plugins: InstalledPluginWire[] }> =>
    api.post<{ plugins: InstalledPluginWire[] }>('/api/v1/plugins/refresh'),
};

// ---------------------------------------------------------------------------
// Agent 会话工作区（/chat 工作区文件面板消费；路径相对当前会话解析到根会话工作区，
// 子会话天然继承根会话工作区）。端点均走 Bearer 头认证；iframe/img/a[download] 直链
// 场景（fileUrl）token 走 ?token= 查询通道（内核 extractToken 契约）。
// ---------------------------------------------------------------------------

/** GET /api/v1/agents/sessions/:id/workspace 条目 */
export interface WorkspaceEntry {
  name: string;
  /** 相对工作区根的路径（目录懒加载/文件操作的 path 主键） */
  path: string;
  type: 'file' | 'dir';
  size: number;
  /** 修改时间（epoch ms） */
  mtime: number;
}

/** GET /api/v1/agents/sessions/:id/workspace 响应 */
export interface WorkspaceListResult {
  entries: WorkspaceEntry[];
}

/** 会话工作区端点基路径（目录列表与 file 读写都在其下） */
function workspaceBase(sessionId: string): string {
  return `/api/v1/agents/sessions/${encodeURIComponent(sessionId)}/workspace`;
}

/**
 * workspaceApi — 会话工作区文件面：
 *
 * - list：目录列表（recursive=false 逐层懒加载；path 为目录相对路径，根目录传空串）；
 * - fileUrl：原始字节直链（img src / iframe src / a[download] 用；自动追加 ?token=）；
 * - read：原始文本读取（文本预览用；Bearer 头认证，二进制请用 fileUrl 直链）；
 * - write：写入/覆盖文件（content 为 base64；前端上传入口 ≤8MB 校验在页面侧）；
 * - remove：删除文件（?path= 定位）。
 */
export const workspaceApi = {
  /** GET {base}?path=&recursive= — 目录列表（{ entries }） */
  list: (sessionId: string, path = '', recursive = false): Promise<WorkspaceListResult> =>
    api.get<WorkspaceListResult>(
      `${workspaceBase(sessionId)}?path=${encodeURIComponent(path)}&recursive=${recursive ? 'true' : 'false'}`,
    ),
  /** GET {base}/file?path= — 原始字节直链（token 不足时省略 &token= 段） */
  fileUrl: (sessionId: string, path: string): string => {
    const token = getToken();
    const query = `path=${encodeURIComponent(path)}`;
    return token === ''
      ? `${workspaceBase(sessionId)}/file?${query}`
      : `${workspaceBase(sessionId)}/file?${query}&token=${encodeURIComponent(token)}`;
  },
  /** GET {base}/file?path= — 原始文本（!ok 抛 ApiError 形状） */
  read: async (sessionId: string, path: string): Promise<string> => {
    const headers: Record<string, string> = {};
    const token = getToken();
    if (token !== '') headers['authorization'] = `Bearer ${token}`;
    const res = await fetch(`${workspaceBase(sessionId)}/file?path=${encodeURIComponent(path)}`, { headers });
    if (!res.ok) throw await toApiError(res);
    return res.text();
  },
  /** PUT {base}/file — 写入/覆盖（body { path, content(base64) }） */
  write: (sessionId: string, path: string, content: string): Promise<unknown> =>
    api.put<unknown>(`${workspaceBase(sessionId)}/file`, { path, content }),
  /** DELETE {base}/file?path= — 删除文件 */
  remove: (sessionId: string, path: string): Promise<unknown> =>
    api.delete<unknown>(`${workspaceBase(sessionId)}/file?path=${encodeURIComponent(path)}`),
};
