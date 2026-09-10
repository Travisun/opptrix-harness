import { getToken } from '@/lib/api';

/**
 * sse — EventSource 封装（GET /api/v1/stream?topics=&token=）。
 *
 * 契约对齐内核 src/kernel/http/sse/hub.ts（含 Last-Event-ID 断线重放）：
 * - token 走 query（端点 zod 契约要求 topics/token 为纯字符串）；
 * - 服务端帧形 `id: <topic自增seq>\nevent: <event>\ndata: <JSON>\n\n`；
 * - 断线重连：主动关闭后由本模块带 `lastEventId=<topic>:<seq>` 游标重连（指数退避，
 *   上限 30s），服务端按游标重放缓冲事件；多 topic 订阅时帧 id 无法归属 topic，
 *   不携带游标（内核亦忽略裸数字游标）。
 * - `: replay` 注释帧：EventSource 天然静默（不触发任何 handler），无需处理；
 * - `replay-gap` 事件帧（data: {topic, latestSeq}）：游标超前/事件已被挤出缓冲时服务端
 *   先回此帧——触发 onReplayGap 回调，由调用方清空本地缓存并经 REST 对账。
 * - 返回 close()：组件卸载时必须调用，防泄漏连接。
 */

/** 已知事件名（W2-W4 页面包可按需在此扩展或直接 addEventListener） */
export const SSE_EVENT_NAMES = [
  'notification.created',
  'notification.delivered',
  'chat.message.created',
  'chat.message.updated',
  'task.progress',
  // Agent 会话子系统（/chat 全屏对话页；topic `agent:{sessionId}`）
  'message.created',
  'generation.cancelled',
  'replay-gap',
] as const;

export interface SseEventData {
  /** 帧 id（topic 内自增 seq；客户端用它维护重放游标） */
  id: string | null;
  event: string;
  data: unknown;
}

export interface SseStreamOptions {
  topics: string[];
  /** 事件分发（含已知事件名与默认 message 帧；`: replay` 注释帧不会到达这里） */
  onEvent: (e: SseEventData) => void;
  /** replay-gap：游标失效（服务端重启/缓冲溢出），调用方应清空本地缓存并 REST 对账 */
  onReplayGap?: (info: { topic: string; latestSeq: number }) => void;
  /** 连接状态回调（供页面显示实时徽标） */
  onStateChange?: (connected: boolean) => void;
}

export interface SseStream {
  close(): void;
  readonly connected: boolean;
}

const MAX_BACKOFF_MS = 30_000;

export function connectSse(options: SseStreamOptions): SseStream {
  const { topics, onEvent, onReplayGap, onStateChange } = options;
  let es: EventSource | null = null;
  let closed = false;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let up = false;
  /** 最近一帧 id（裸 seq 字符串；重连游标原料） */
  let lastEventId: string | null = null;

  const setState = (next: boolean): void => {
    if (up !== next) {
      up = next;
      onStateChange?.(next);
    }
  };

  const parseData = (raw: string): unknown => {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return raw; // 非 JSON 帧：原样字符串透传
    }
  };

  const open = (): void => {
    if (closed) return;
    const query = new URLSearchParams({ topics: topics.join(','), token: getToken() });
    // 断线重连游标：单 topic 订阅可精确归属（topic:seq）；多 topic 无法归属则不携带
    if (lastEventId !== null && topics.length === 1) {
      query.set('lastEventId', `${topics[0]}:${lastEventId}`);
    }
    es = new EventSource(`/api/v1/stream?${query.toString()}`);
    es.onopen = () => {
      attempt = 0;
      setState(true);
    };
    es.onerror = () => {
      // 主动断开重建（而不是让 EventSource 原生重连）：原生重连只带 Last-Event-ID 头
      // （裸数字，多 topic 无法归属），带 query 游标的重建由本模块全权控制
      setState(false);
      es?.close();
      es = null;
      if (closed) return;
      const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempt);
      attempt += 1;
      timer = setTimeout(open, delay);
    };
    es.onmessage = (ev: MessageEvent<string>) => {
      if (ev.lastEventId !== '') lastEventId = ev.lastEventId;
      onEvent({ id: ev.lastEventId === '' ? null : ev.lastEventId, event: 'message', data: parseData(ev.data) });
    };
    for (const name of SSE_EVENT_NAMES) {
      es.addEventListener(name, (ev) => {
        const me = ev as MessageEvent<string>;
        if (me.lastEventId !== '') lastEventId = me.lastEventId;
        if (name === 'replay-gap') {
          const data = parseData(me.data) as { topic?: unknown; latestSeq?: unknown };
          onReplayGap?.({
            topic: typeof data.topic === 'string' ? data.topic : (topics[0] ?? ''),
            latestSeq: typeof data.latestSeq === 'number' ? data.latestSeq : -1,
          });
          return;
        }
        onEvent({ id: me.lastEventId === '' ? null : me.lastEventId, event: name, data: parseData(me.data) });
      });
    }
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
