import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api } from '@/lib/api';

import { subscribeChatMessages } from './chatEvents';
import type { ChatChannel } from './types';

/**
 * useChatChannels — 频道列表 + 当前频道选择 + 频道级未读点（面板打开期间）。
 *
 * - 列表：GET /api/v1/channels（未读为本地口径计数，服务端无聊天未读聚合）；
 * - 选中态跨挂卸持久化（desktopOpen/mobileOpen 切换会导致面板重挂载，
 *   用模块级变量记住上次选中的 slug，重挂载后恢复）；
 * - 未读点来源：ChatUnreadWatcher 的全频道 SSE 广播（chatEvents 总线）——
 *   非当前频道消息 +1；切到该频道即清零；当前频道消息不计数（消息流自己渲染）；
 * - 未知频道（他人在别处新建）消息到达 → 静默刷新频道列表；
 * - 新建频道：POST /api/v1/channels（admin，入口显隐由 ChannelSidebar 控制）。
 */

/** 上次选中频道（模块级；面板重挂载后恢复选择） */
let lastSelectedSlug: string | null = null;

export interface UseChatChannelsResult {
  channels: ChatChannel[];
  loading: boolean;
  /** 初始加载失败信息（非空时显示重试入口；api 层已 toast） */
  error: string | null;
  currentSlug: string | null;
  unreadBySlug: Record<string, number>;
  /** 切换当前频道（同时清该频道未读点） */
  select(slug: string): void;
  /** 拉取频道列表；silent 用于后台刷新（不重复 toast） */
  refresh(opts?: { silent?: boolean }): Promise<void>;
  /** 新建频道（admin）；成功后刷新列表并选中新频道 */
  createChannel(name: string): Promise<ChatChannel | null>;
}

export function useChatChannels(): UseChatChannelsResult {
  const [channels, setChannels] = useState<ChatChannel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentSlug, setCurrentSlug] = useState<string | null>(lastSelectedSlug);
  const [unreadBySlug, setUnreadBySlug] = useState<Record<string, number>>({});

  const currentRef = useRef<string | null>(lastSelectedSlug);
  currentRef.current = currentSlug;

  const applySelection = useCallback((slug: string | null): void => {
    lastSelectedSlug = slug;
    currentRef.current = slug;
    setCurrentSlug(slug);
    if (slug !== null) {
      setUnreadBySlug((prev) => (prev[slug] !== undefined ? { ...prev, [slug]: 0 } : prev));
    }
  }, []);

  const refresh = useCallback(async (opts?: { silent?: boolean }): Promise<void> => {
    const silent = opts?.silent === true;
    if (!silent) setLoading(true);
    try {
      const rows = await api.get<ChatChannel[]>('/api/v1/channels', { silent });
      if (!Array.isArray(rows)) throw new Error('频道列表响应形状异常');
      setChannels(rows);
      setError(null);
      // 恢复上次选中；不在列表（被删/首次）→ 选第一个
      setCurrentSlug((prev) => {
        if (prev !== null && rows.some((c) => c.slug === prev)) return prev;
        const next = rows.length > 0 ? rows[0].slug : null;
        lastSelectedSlug = next;
        currentRef.current = next;
        return next;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : '频道列表加载失败');
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 全频道消息广播 → 非当前频道未读点；未知频道 → 后台刷新列表
  useEffect(() => {
    return subscribeChatMessages((event) => {
      if (event.kind !== 'created') return;
      if (event.slug === null) {
        void refresh({ silent: true });
        return;
      }
      if (event.slug === currentRef.current) return;
      const slug = event.slug;
      setUnreadBySlug((prev) => ({ ...prev, [slug]: (prev[slug] ?? 0) + 1 }));
    });
  }, [refresh]);

  const createChannel = useCallback(
    async (name: string): Promise<ChatChannel | null> => {
      const trimmed = name.trim();
      if (trimmed === '') return null;
      try {
        const created = await api.post<ChatChannel>('/api/v1/channels', { name: trimmed });
        await refresh({ silent: true });
        applySelection(created.slug);
        return created;
      } catch {
        // api 层已 toast 错误详情
        return null;
      }
    },
    [applySelection, refresh],
  );

  return useMemo(
    () => ({
      channels,
      loading,
      error,
      currentSlug,
      unreadBySlug,
      select: applySelection,
      refresh,
      createChannel,
    }),
    [channels, loading, error, currentSlug, unreadBySlug, applySelection, refresh, createChannel],
  );
}
