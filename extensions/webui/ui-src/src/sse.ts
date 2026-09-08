import { getToken } from './api';

/**
 * sse — EventSource 封装（GET /api/v1/stream?topics=&token=）。
 *
 * - token 走 query（SSE 端点由 zod 契约要求 topics/token 为纯字符串 query）；
 * - 断线自动重连（指数退避，上限 30s）；调用方通过 onEvent(topic, event, data) 分发；
 * - 返回 close()：组件卸载时必须调用，防泄漏连接。
 */

export interface SseHandle {
  close(): void;
  /** 连接是否存活（供页面显示实时徽标） */
  readonly connected: boolean;
}

export type SseDispatcher = (payload: { topic: string; event: string; data: unknown }) => void;

const MAX_BACKOFF_MS = 30_000;

/**
 * 订阅 SSE。同一页面可多次调用（每调用一条连接；本控制台最多同时 2 条：
 * Dashboard 的 notifications + Chat 的 chat:{slug}）。
 */
export function connectSse(topics: string[], onEvent: SseDispatcher, onState?: (up: boolean) => void): SseHandle {
  let es: EventSource | null = null;
  let closed = false;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let up = false;

  const setState = (next: boolean): void => {
    if (up !== next) {
      up = next;
      onState?.(next);
    }
  };

  const open = (): void => {
    if (closed) return;
    const query = new URLSearchParams({ topics: topics.join(','), token: getToken() });
    es = new EventSource(`/api/v1/stream?${query.toString()}`);
    es.onopen = () => {
      attempt = 0;
      setState(true);
    };
    es.onerror = () => {
      setState(false);
      es?.close();
      es = null;
      if (closed) return;
      const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempt);
      attempt += 1;
      timer = setTimeout(open, delay);
    };
    // 内核帧形：event 名自定义、data 为 JSON；未指定 event 的帧走 message
    es.onmessage = (ev: MessageEvent<string>) => {
      dispatch('', ev.data);
    };
    for (const name of ['notification.created', 'notification.delivered', 'chat.message.created', 'chat.message.updated', 'task.progress']) {
      es.addEventListener(name, (ev) => {
        dispatch(name, (ev as MessageEvent<string>).data);
      });
    }
  };

  const dispatch = (event: string, raw: string): void => {
    let data: unknown = raw;
    try {
      data = JSON.parse(raw) as unknown;
    } catch {
      /* 非 JSON 帧：原样字符串透传 */
    }
    onEvent({ topic: topics.join(','), event, data });
  };

  open();

  return {
    get connected(): boolean {
      return up;
    },
    close(): void {
      closed = true;
      if (timer !== undefined) clearTimeout(timer);
      es?.close();
      es = null;
      setState(false);
    },
  };
}
