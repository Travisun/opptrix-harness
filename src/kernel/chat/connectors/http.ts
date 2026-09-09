/**
 * 平台连接器共享 HTTP 助手。
 *
 * - `postJson`：JSON POST（content-type: application/json）+ 超时 10s 单次尝试
 *   （不重试：平台消息重试会造成用户可见的重复消息，失败由 DELIVERY_FAILED 承载，
 *   上层 ChatBridgeDispatcher 自行决定可见性/告警）；
 * - 失败语义：网络/超时/非 2xx → HarnessError(DELIVERY_FAILED)；2xx 但平台业务码
 *   失败（telegram ok:false / dingtalk errcode 等）由各连接器自行判定抛出；
 * - 密钥安全：错误 message/detail 中的 URL 一律经 safeUrlOf 脱敏
 *   （telegram botToken 在 path、dingtalk access_token 在 query，均不入错误）。
 */
import { err } from '../../errors/index.js';

/** 单次请求超时（毫秒） */
const DEFAULT_TIMEOUT_MS = 10_000;

/** postJson 结果：HTTP 状态码 + 平台响应 body（JSON 解析失败为 null） */
export interface JsonPostResult {
  status: number;
  body: unknown;
}

/** postJson 选项 */
export interface PostJsonOptions {
  /** fetch 实现（由连接器从 deps 透传） */
  fetchImpl: typeof fetch;
  /** 平台名（错误 message 前缀，如 'telegram'） */
  platform: string;
  /** 目标 URL（可含凭据——错误信息中会被 safeUrlOf 脱敏） */
  url: string;
  /** 请求体（JSON 序列化后发送） */
  body: unknown;
  /** 附加请求头（如 Authorization / Bearer） */
  headers?: Record<string, string>;
  /** 单次尝试超时（毫秒），缺省 10s */
  timeoutMs?: number;
}

/**
 * 发送 JSON POST：2xx → `{ status, body }`（body 为解析后的 JSON，非 JSON 响应为 null）；
 * 网络错误/超时/非 2xx → HarnessError(DELIVERY_FAILED)。
 */
export async function postJson(opts: PostJsonOptions): Promise<JsonPostResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
  let res: Response;
  try {
    res = await opts.fetchImpl(opts.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...opts.headers },
      body: JSON.stringify(opts.body),
      signal: controller.signal,
    });
  } catch (e) {
    const reason = controller.signal.aborted
      ? `timeout after ${timeoutMs}ms`
      : e instanceof Error
        ? e.message
        : String(e);
    throw err('DELIVERY_FAILED', {
      message: `${opts.platform} connector: POST ${safeUrlOf(opts.url)} failed: ${reason}`,
      detail: { platform: opts.platform, url: safeUrlOf(opts.url) },
      cause: e,
    });
  } finally {
    clearTimeout(timer);
  }

  let body: unknown = null;
  try {
    body = (await res.json()) as unknown;
  } catch {
    body = null;
  }

  if (!res.ok) {
    throw err('DELIVERY_FAILED', {
      message: `${opts.platform} connector: POST ${safeUrlOf(opts.url)} responded HTTP ${res.status}`,
      detail: { platform: opts.platform, url: safeUrlOf(opts.url), status: res.status, body },
    });
  }
  return { status: res.status, body };
}

/** URL 脱敏视图：仅保留 origin + pathname（query/path 中的凭据不进错误信息） */
export function safeUrlOf(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname}`;
  } catch {
    return '[unparseable-url]';
  }
}

/** 平台业务码失败的统一抛出（detail 携带脱敏 URL 与平台响应 body） */
export function platformRejected(platform: string, url: string, body: unknown, summary: string): never {
  throw err('DELIVERY_FAILED', {
    message: `${platform} connector: ${summary}`,
    detail: { platform, url: safeUrlOf(url), body },
  });
}

/** 消息内容 → 单行文本：string 直取；含 text 字段的对象取该字段；其余 JSON 序列化 */
export function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content !== null && typeof content === 'object' && !Array.isArray(content)) {
    const text = (content as Record<string, unknown>)['text'];
    if (typeof text === 'string') return text;
  }
  return JSON.stringify(content) ?? '';
}

/** 未知值安全取 record：对象（非数组/null）→ Record；否则 undefined */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** 取请求头第一个值（键须小写；string[] 取首个） */
export function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const value = headers[name];
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value[0];
  return undefined;
}
