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
  if (res.status === 401) {
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
