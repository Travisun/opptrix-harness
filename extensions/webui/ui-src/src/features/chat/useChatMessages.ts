import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { toast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { connectSse, type SseStream } from '@/lib/sse';

import { describeReason, normalizeContent, type ChatMessage } from './types';

/**
 * useChatMessages — 当前频道消息流（REST 分页 + 单 topic 精确游标 SSE + 乐观发送）。
 *
 * - 初始：GET /api/v1/channels/{id}/messages?limit=50（升序）；「加载更早」用
 *   before=<最旧 createdAt> 游标向前翻页（每页 50，不足一页即到底）；
 * - 实时：SSE topics=chat:{slug}（单 topic → lib/sse 携带 lastEventId 断线补帧）；
 *   chat.message.created 按 id 去重插入（命中乐观消息时以真实消息替换）；
 *   chat.message.updated 原地替换正文；
 * - replay-gap（游标失效）：重新 REST 拉取最新一页对账（按 id 合并去重）；
 * - 发送：POST body 即 content {type:'text',text}；乐观插入（临时 id），POST 返回
 *   blocked:true → 移除乐观消息并 toast 拦截原因；成功以返回消息替换（SSE 稍后
 *   到达时按 id 幂等命中，不会重复）。
 */

const PAGE_SIZE = 50;
/** 同一发送者连续消息合并显示的时间窗（毫秒） */
export const GROUP_WINDOW_MS = 5 * 60 * 1000;

export type SendOutcome = 'sent' | 'blocked' | 'error';

export interface UseChatMessagesResult {
  messages: ChatMessage[];
  loading: boolean;
  loadingMore: boolean;
  /** 还有更早消息可加载 */
  hasMore: boolean;
  /** 当前频道 SSE 连接状态 */
  connected: boolean;
  sending: boolean;
  error: string | null;
  loadMore(): void;
  send(text: string): Promise<SendOutcome>;
  /** 初始加载失败后的重试 */
  reload(): void;
}

interface SendResponse {
  blocked: boolean;
  message: ChatMessage | null;
  reason?: unknown;
}

function randomId(): string {
  return `pending-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function sortMessages(list: ChatMessage[]): ChatMessage[] {
  return [...list].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
}

/** SSE/REST 行 → ChatMessage（形状防御：字段缺失丢弃；供面板多处复用） */
export function toChatMessage(data: unknown): ChatMessage | null {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null;
  const raw = data as Record<string, unknown>;
  if (typeof raw['id'] !== 'string' || typeof raw['channelId'] !== 'string') return null;
  if (typeof raw['createdAt'] !== 'number') return null;
  return {
    id: raw['id'],
    channelId: raw['channelId'],
    senderType: typeof raw['senderType'] === 'string' ? raw['senderType'] : 'user',
    senderId: typeof raw['senderId'] === 'string' ? raw['senderId'] : '',
    content: raw['content'] ?? null,
    attachments: raw['attachments'] ?? null,
    createdAt: raw['createdAt'],
    updatedAt: typeof raw['updatedAt'] === 'number' ? raw['updatedAt'] : undefined,
  };
}

/** 乐观消息与真实消息是否同一条（发送者 + 文本内容一致） */
function sameOptimistic(pending: ChatMessage, real: ChatMessage): boolean {
  if (pending.pending !== true || pending.senderId !== real.senderId) return false;
  const a = normalizeContent(pending.content);
  const b = normalizeContent(real.content);
  return a.type === 'text' && b.type === 'text' && a.text === b.text;
}

/** REST 对账合并：按 id 去重（REST 侧覆盖），被真实消息命中的乐观副本丢弃 */
function mergePage(existing: ChatMessage[], page: ChatMessage[]): ChatMessage[] {
  const kept = existing.filter((m) => m.pending !== true && !page.some((p) => sameOptimistic(m, p)));
  const byId = new Map<string, ChatMessage>();
  for (const m of kept) byId.set(m.id, m);
  for (const m of page) byId.set(m.id, { ...m, pending: false });
  return sortMessages([...byId.values()]);
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : '请求失败';
}

export function useChatMessages(
  channel: { id: string; slug: string } | null,
  myUserId: string | null,
): UseChatMessagesResult {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [connected, setConnected] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const channelId = channel?.id ?? null;
  const slug = channel?.slug ?? null;

  // 镜像最新值给 SSE 回调 / 异步流程（避免 effect 因对象身份反复重建连接）
  const channelRef = useRef(channel);
  channelRef.current = channel;
  const messagesRef = useRef<ChatMessage[]>([]);
  messagesRef.current = messages;
  const loadingMoreRef = useRef(false);
  const reachedOldestRef = useRef(false);

  const fetchPage = useCallback(async (id: string, before?: number): Promise<ChatMessage[]> => {
    const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (before !== undefined) query.set('before', String(before));
    const rows = await api.get<ChatMessage[]>(
      `/api/v1/channels/${encodeURIComponent(id)}/messages?${query.toString()}`,
    );
    if (!Array.isArray(rows)) throw new Error('消息列表响应形状异常');
    return rows
      .map((m) => toChatMessage(m))
      .filter((m): m is ChatMessage => m !== null)
      .map((m) => ({ ...m, pending: false }));
  }, []);

  // -----------------------------------------------------------------------
  // 初始加载（频道切换 / 重试）
  // -----------------------------------------------------------------------

  useEffect(() => {
    if (channelId === null) {
      setMessages([]);
      setError(null);
      setHasMore(false);
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    setError(null);
    setHasMore(true);
    reachedOldestRef.current = false;
    void (async () => {
      try {
        const page = await fetchPage(channelId);
        if (!alive) return;
        setMessages(page);
        reachedOldestRef.current = page.length < PAGE_SIZE;
        setHasMore(page.length >= PAGE_SIZE);
      } catch (e) {
        if (!alive) return;
        setMessages([]);
        setHasMore(false);
        setError(errorMessage(e));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [channelId, reloadKey, fetchPage]);

  // -----------------------------------------------------------------------
  // 实时流（单 topic 精确游标；频道切换重建连接）
  // -----------------------------------------------------------------------

  const applyIncoming = useCallback((msg: ChatMessage): void => {
    setMessages((prev) => {
      if (prev.some((m) => m.id === msg.id)) {
        // 幂等：SSE 重放/重复帧以服务端版本覆盖
        return prev.map((m) => (m.id === msg.id ? { ...msg, pending: false } : m));
      }
      // 乐观副本被真实消息命中 → 移除后插入真实消息
      const twinIndex = prev.findIndex((m) => sameOptimistic(m, msg));
      const base = twinIndex >= 0 ? prev.filter((_, i) => i !== twinIndex) : prev;
      return sortMessages([...base, { ...msg, pending: false }]);
    });
  }, []);

  /** replay-gap：游标失效（服务端重启/缓冲挤出）→ REST 拉最新一页对账 */
  const reconcile = useCallback(async (): Promise<void> => {
    const ch = channelRef.current;
    if (ch === null) return;
    try {
      const page = await fetchPage(ch.id);
      setMessages((prev) => mergePage(prev, page));
    } catch {
      /* 静默：下一帧到达或下次 gap 再对账 */
    }
  }, [fetchPage]);

  useEffect(() => {
    if (slug === null) {
      setConnected(false);
      return;
    }
    let stream: SseStream | null = connectSse({
      topics: [`chat:${slug}`],
      onEvent: (e) => {
        if (e.event === 'chat.message.created') {
          const msg = toChatMessage(e.data);
          if (msg !== null) applyIncoming(msg);
        } else if (e.event === 'chat.message.updated') {
          const msg = toChatMessage(e.data);
          if (msg === null) return;
          setMessages((prev) =>
            prev.some((m) => m.id === msg.id)
              ? prev.map((m) =>
                  m.id === msg.id
                    ? { ...m, content: msg.content, attachments: msg.attachments, updatedAt: msg.updatedAt }
                    : m,
                )
              : prev,
          );
        }
      },
      onReplayGap: () => {
        void reconcile();
      },
      onStateChange: setConnected,
    });
    return () => {
      stream?.close();
      stream = null;
    };
  }, [slug, applyIncoming, reconcile]);

  // -----------------------------------------------------------------------
  // 向前翻页 / 发送 / 重试
  // -----------------------------------------------------------------------

  const loadMore = useCallback((): void => {
    const ch = channelRef.current;
    if (ch === null || loadingMoreRef.current || reachedOldestRef.current) return;
    const oldest = messagesRef.current.find((m) => m.pending !== true) ?? null;
    if (oldest === null) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    void (async () => {
      try {
        const page = await fetchPage(ch.id, oldest.createdAt);
        setMessages((prev) => mergePage(prev, page));
        if (page.length < PAGE_SIZE) {
          reachedOldestRef.current = true;
          setHasMore(false);
        }
      } catch (e) {
        // 翻页失败：保留现状，api 层已 toast；下次点击可重试
        void errorMessage(e);
      } finally {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      }
    })();
  }, [fetchPage]);

  const send = useCallback(
    async (text: string): Promise<SendOutcome> => {
      const ch = channelRef.current;
      const trimmed = text.trim();
      if (ch === null || trimmed === '') return 'error';
      const tmpId = randomId();
      const optimistic: ChatMessage = {
        id: tmpId,
        channelId: ch.id,
        senderType: 'user',
        senderId: myUserId ?? '',
        content: { type: 'text', text: trimmed },
        attachments: null,
        createdAt: Date.now(),
        pending: true,
      };
      setMessages((prev) => sortMessages([...prev, optimistic]));
      setSending(true);
      try {
        const res = await api.post<SendResponse>(
          `/api/v1/channels/${encodeURIComponent(ch.id)}/messages`,
          { type: 'text', text: trimmed },
        );
        if (res.blocked) {
          setMessages((prev) => prev.filter((m) => m.id !== tmpId));
          toast.error('消息被拦截', describeReason(res.reason));
          return 'blocked';
        }
        const real = res.message;
        setMessages((prev) => {
          const base = prev.filter((m) => m.id !== tmpId);
          if (real === null || real === undefined) return base;
          if (base.some((m) => m.id === real.id)) {
            return base.map((m) => (m.id === real.id ? { ...real, pending: false } : m));
          }
          return sortMessages([...base, { ...real, pending: false }]);
        });
        return 'sent';
      } catch {
        // 网络/校验失败：api 层已 toast；移除乐观消息（Composer 保留输入可重发）
        setMessages((prev) => prev.filter((m) => m.id !== tmpId));
        return 'error';
      } finally {
        setSending(false);
      }
    },
    [myUserId],
  );

  const reload = useCallback((): void => {
    setReloadKey((k) => k + 1);
  }, []);

  return useMemo(
    () => ({
      messages,
      loading,
      loadingMore,
      hasMore,
      connected,
      sending,
      error,
      loadMore,
      send,
      reload,
    }),
    [messages, loading, loadingMore, hasMore, connected, sending, error, loadMore, send, reload],
  );
}
