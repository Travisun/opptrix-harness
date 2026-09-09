import { useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';

import { Sidebar, isSidebarCollapsed } from '@/components/layout/Sidebar';
import { MobileNavSheet, Topbar } from '@/components/layout/Topbar';
import { ChatPanelDesktop, ChatPanelMobile } from '@/features/chat/ChatPanel';
import { ChatPanelProvider } from '@/features/chat/ChatPanelContext';
import { NotificationsProvider } from '@/features/notifications/NotificationsProvider';
import { findNavItem } from '@/lib/nav';

/**
 * AppShell — 控制台壳层（已认证区域的布局骨架）。
 *
 * 桌面（≥lg）三栏：左侧固定侧栏（可折叠为图标栏，折叠态持久化）｜中间主内容｜
 * 右侧聊天面板（默认隐藏，顶栏聊天按钮开关，宽 ~380px）。
 * 移动（<lg）：侧栏 → 汉堡 + Sheet 抽屉；聊天面板 → 右侧全屏 Sheet；
 * 顶栏含汉堡 / 页面标题 / 主题切换 / 聊天开关（未读徽标）/ 用户菜单。
 */
export function AppShell(): React.ReactNode {
  const location = useLocation();
  const [collapsed, setCollapsed] = useState<boolean>(isSidebarCollapsed);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  // 页面标题随路由（hash 路由下 location.pathname 即路由路径）
  useEffect(() => {
    const item = findNavItem(location.pathname);
    document.title = item !== undefined ? `Opptrix Console — ${item.title}` : 'Opptrix Console';
  }, [location.pathname]);

  const toggleCollapsed = (): void => {
    setCollapsed((prev) => {
      try {
        localStorage.setItem('ui.sidebar.collapsed', prev ? '0' : '1');
      } catch {
        /* 存储不可用时折叠态仅本次会话有效 */
      }
      return !prev;
    });
  };

  return (
    <ChatPanelProvider>
      <NotificationsProvider>
        <div className="flex h-svh overflow-hidden">
          <Sidebar collapsed={collapsed} onToggleCollapsed={toggleCollapsed} />
          <MobileNavSheet open={mobileNavOpen} onOpenChange={setMobileNavOpen} />
          <div className="flex min-w-0 flex-1 flex-col">
            <Topbar onMobileNavOpen={() => setMobileNavOpen(true)} />
            <div className="flex min-h-0 flex-1">
              <main
                data-slot="main-content"
                className="min-w-0 flex-1 overflow-y-auto"
                tabIndex={-1}
              >
                <div className="mx-auto w-full max-w-6xl p-4 sm:p-6">
                  <Outlet />
                </div>
              </main>
              <ChatPanelDesktop />
            </div>
          </div>
          <ChatPanelMobile />
        </div>
      </NotificationsProvider>
    </ChatPanelProvider>
  );
}
