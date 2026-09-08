import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { api, getToken } from '@/lib/api';
import { connectSse, type SseStream } from '@/lib/sse';

/**
 * NotificationsProvider — 通知未读数与实时连接的单一来源。
 *
 * - 初始未读数：REST GET /api/v1/notifications?limit=1（响应含 unread 聚合）；
 * - 实时增量：订阅 SSE topics=notifications，notification.created 帧本地 +1；
 * - replay-gap（服务端重启/缓冲挤出导致游标失效）：清空本地口径，重新 REST 对账；
 * - connected：连接状态供顶栏「实时」徽标显示。
 */
export interface NotificationsContextValue {
  unread: number;
  connected: boolean;
  /** 强制与 REST 对账（W3 通知中心页做已读操作后调用） */
  refresh(): Promise<void>;
}

const NotificationsContext = createContext<NotificationsContextValue | null>(null);

export function NotificationsProvider({ children }: { children: ReactNode }): ReactNode {
  const [unread, setUnread] = useState(0);
  const [connected, setConnected] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    if (getToken() === '') return;
    try {
      const res = await api.get<{ items: unknown[]; unread: number }>('/api/v1/notifications?limit=1', {
        silent: true,
      });
      setUnread(res.unread);
    } catch {
      /* 静默：未读数不是关键路径，失败保持现值 */
    }
  }, []);

  useEffect(() => {
    if (getToken() === '') return;
    void refresh();
    let stream: SseStream | null = connectSse({
      topics: ['notifications'],
      onEvent: (e) => {
        if (e.event === 'notification.created') setUnread((prev) => prev + 1);
      },
      onReplayGap: () => {
        // 游标失效（服务端重启/环形缓冲挤出）：丢弃本地增量口径，REST 全量对账
        void refresh();
      },
      onStateChange: setConnected,
    });
    return () => {
      stream?.close();
      stream = null;
    };
  }, [refresh]);

  const value = useMemo<NotificationsContextValue>(
    () => ({ unread, connected, refresh }),
    [unread, connected, refresh],
  );

  return <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>;
}

export function useNotifications(): NotificationsContextValue {
  const ctx = useContext(NotificationsContext);
  if (ctx === null) throw new Error('useNotifications 必须在 <NotificationsProvider> 内使用');
  return ctx;
}
