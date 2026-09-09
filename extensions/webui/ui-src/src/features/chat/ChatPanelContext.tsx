import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';

/**
 * ChatPanelContext — 右侧聊天面板的全局开关与未读计数。
 *
 * - 桌面（≥lg）：面板在主内容右侧内联展开（默认隐藏），宽度 ~380px；
 * - 移动（<lg）：面板改为右侧全屏 Sheet，由壳层读取 mobileOpen 渲染；
 * - unread：聊天未读计数，供顶栏徽标显示（W2-W4 聊天包经 setUnread 增量维护）。
 *   与通知中心未读数（NotificationsProvider.unread）互不相干，徽标分开显示。
 */
export interface ChatPanelContextValue {
  desktopOpen: boolean;
  mobileOpen: boolean;
  unread: number;
  setDesktopOpen(open: boolean): void;
  setMobileOpen(open: boolean): void;
  toggle(): void;
  setUnread(count: number): void;
}

const ChatPanelContext = createContext<ChatPanelContextValue | null>(null);

export function ChatPanelProvider({ children }: { children: ReactNode }): ReactNode {
  const [desktopOpen, setDesktopOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [unread, setUnread] = useState(0);

  const value = useMemo<ChatPanelContextValue>(
    () => ({
      desktopOpen,
      mobileOpen,
      unread,
      setDesktopOpen,
      setMobileOpen,
      toggle: () => setDesktopOpen((prev) => !prev),
      setUnread,
    }),
    [desktopOpen, mobileOpen, unread],
  );

  return <ChatPanelContext.Provider value={value}>{children}</ChatPanelContext.Provider>;
}

export function useChatPanel(): ChatPanelContextValue {
  const ctx = useContext(ChatPanelContext);
  if (ctx === null) throw new Error('useChatPanel 必须在 <ChatPanelProvider> 内使用');
  return ctx;
}
