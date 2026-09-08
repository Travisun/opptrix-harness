/**
 * api — REST fetch 封装。
 *
 * - 自动携带 Authorization: Bearer <token>（localStorage 持久化）；
 * - 统一错误形状 { code, message }（内核 HarnessError.toJSON 契约），失败经 toast 呈现；
 * - 401 → 清除本地凭据并跳转登录页（hash 路由）。
 */

const TOKEN_KEY = 'opptrix.token';
const USER_KEY = 'opptrix.user';

/** 统一错误形状（与内核 { code, message, detail?, retryable? } 对齐的最小视图） */
export interface ApiError {
  code: string;
  message: string;
  detail?: unknown;
  status: number;
}

// ---------------------------------------------------------------------------
// toast（轻量全局事件：App.vue 订阅渲染；无第三方 UI 库）
// ---------------------------------------------------------------------------

export interface Toast {
  id: number;
  kind: 'info' | 'success' | 'error';
  text: string;
}

type ToastListener = (toasts: Toast[]) => void;

let toastSeq = 0;
let toasts: Toast[] = [];
const toastListeners = new Set<ToastListener>();

function emitToasts(): void {
  for (const fn of toastListeners) fn([...toasts]);
}

export function onToasts(fn: ToastListener): () => void {
  toastListeners.add(fn);
  fn([...toasts]);
  return () => toastListeners.delete(fn);
}

export function pushToast(kind: Toast['kind'], text: string, ttlMs = 4000): void {
  const item: Toast = { id: ++toastSeq, kind, text };
  toasts = [...toasts.slice(-4), item];
  emitToasts();
  setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== item.id);
    emitToasts();
  }, ttlMs);
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
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

/** 登录用户缓存（Login 写入 / 顶栏读取；以 /auth/me 实时校准） */
export interface SessionUser {
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
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

// ---------------------------------------------------------------------------
// 请求核心
// ---------------------------------------------------------------------------

function gotoLogin(): void {
  if (location.hash !== '#/login') location.hash = '#/login';
}

/** 统一错误 → toast；可选吞掉（调用方自己处理失败分支时传 opt.silent） */
function reportError(e: ApiError, silent?: boolean): void {
  if (silent !== true) pushToast('error', `[${e.code}] ${e.message}`);
}

async function toApiError(res: Response): Promise<ApiError> {
  let code = `HTTP-${res.status}`;
  let message = res.statusText || 'request failed';
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
  /** true 时不自动 toast（页面自行渲染错误态） */
  silent?: boolean;
  /** 原始 body（对象 → JSON；FormData 原样） */
  body?: unknown;
}

async function request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token !== '') headers['authorization'] = `Bearer ${token}`;
  let payload: BodyInit | undefined;
  if (opts.body instanceof FormData) {
    payload = opts.body; // 浏览器自动补 multipart boundary
  } else if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(opts.body);
  }
  let res: Response;
  try {
    res = await fetch(path, { method, headers, body: payload });
  } catch (e) {
    const err: ApiError = { code: 'NETWORK', message: e instanceof Error ? e.message : 'network error', status: 0 };
    reportError(err, opts.silent);
    throw err;
  }
  if (res.status === 401) {
    clearToken();
    gotoLogin();
  }
  if (!res.ok) {
    const err = await toApiError(res);
    reportError(err, opts.silent);
    throw err;
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (text === '') return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T; // 二进制/文本下载（如文件下载由 <a> 完成，一般不走这里）
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
// REST 形状（与 src/api/* 对齐的最小视图）
// ---------------------------------------------------------------------------

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

export interface DoctorResult {
  ok: boolean;
  checks: { id: string; ok: boolean; detail: string }[];
}

export interface ExtSummary {
  id: string;
  version: string;
  enabled: boolean;
  builtin: boolean;
  mount: string | null;
  contributions?: { routes: number; crons: number; events: number; hooks: number; services: number };
  lastError: string | null;
  manifest?: { displayName?: string; ui?: { menu?: { label?: string }; pages?: { path: string; title: string; entry: string }[] } };
}

export interface ExtRouteEntry {
  extId: string;
  method: string;
  path: string;
  auth: string;
  scope?: string;
}

export interface UiContributionEntry {
  extId: string;
  menu?: { label: string; icon?: string };
  pages: { path: string; title: string; entry: string }[];
  widgets: { id: string; title: string; entry: string }[];
  renderers: string[];
}

export interface CronJob {
  id: string;
  extId: string | null;
  name: string;
  expr: string;
  tz: string;
  enabled: boolean;
  payload: unknown;
  createdAt: number;
  lastRunAt?: number | null;
  nextRunAt?: number | null;
}

export interface CronRunEntry {
  jobId: string;
  startedAt: number;
  finishedAt: number;
  ok: boolean;
  durationMs: number;
  error?: string | null;
}

export interface NotificationItem {
  id: string;
  title: string;
  body: string;
  level: string;
  data: unknown;
  readAt: number | null;
  createdAt: number;
}

export interface NotificationList {
  items: NotificationItem[];
  unread: number;
}

export interface Channel {
  id: string;
  slug: string;
  name: string;
  type: string;
  createdAt: number;
}

export interface ChatMessage {
  id: string;
  channelId: string;
  senderType: string;
  senderId: string;
  content: { type?: string; text?: string } & Record<string, unknown>;
  createdAt: number;
}

export interface FileRecord {
  id: string;
  extId: string | null;
  origName: string;
  mime: string;
  size: number;
  visibility: string;
  createdAt: number;
}

export interface TaskRecord {
  id: string;
  extId: string;
  name: string;
  args: unknown;
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  progress: number;
  progressMsg: string | null;
  result: unknown;
  error: string | null;
  createdAt: number;
}

export interface LlmProvider {
  name: string;
  protocol: string;
  baseUrl: string;
  apiKey?: string;
  apiKeySecretRef?: string;
  models: string[];
  paramAllowlist?: string[];
  timeoutMs?: number;
}

export interface UpdateCheckResult {
  currentVersion: string | null;
  available: { version: string; url?: string; sha256?: string } | null;
  feedOk: boolean;
  error?: string;
}

export interface UpdateHistoryEntry {
  version: string;
  appliedAt: number;
  ok: boolean;
}

export interface WorkspaceInfo {
  id: string;
  containerId: string | null;
  image: string;
  state: string;
  createdAt?: number;
}

export interface SandboxExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface SandboxFileEntry {
  name: string;
  type?: string;
  size?: number;
}

/** 登录（auth 扩展 POST /api/v1/auth/login 的响应形状） */
export interface LoginResult {
  token: string;
  expiresAt: number;
  user: { id: string; username: string; role: string };
}

/** 当前身份（auth 扩展 GET /api/v1/auth/me 的响应形状） */
export interface MeResult {
  userId: string;
  username: string | null;
  role: string;
  scopes: string[];
  tokenType: string;
}
