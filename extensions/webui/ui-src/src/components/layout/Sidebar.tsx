import { NavLink, useLocation } from 'react-router-dom';
import { PanelLeftCloseIcon, PanelLeftOpenIcon, BoxesIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { NAV_GROUPS, NAV_ITEMS } from '@/lib/nav';

/**
 * Sidebar — 左侧固定导航栏。
 *
 * - 可折叠为图标栏（折叠态经 Tooltip 显示标签），折叠态持久化 localStorage('ui.sidebar')；
 * - 移动端复用 SidebarNav 于 Sheet 抽屉（永远展开形态，见 AppShell）。
 */
export const SIDEBAR_COLLAPSED_KEY = 'ui.sidebar.collapsed';

export function isSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

interface SidebarNavProps {
  collapsed?: boolean;
  onNavigate?: () => void;
}

function SidebarNav({ collapsed = false, onNavigate }: SidebarNavProps): React.ReactNode {
  const location = useLocation();
  return (
    <nav aria-label="主导航" className="density-gap flex flex-col gap-4 overflow-y-auto px-2 py-3">
      {NAV_GROUPS.map((group) => (
        <div key={group.label} className="density-gap flex flex-col gap-1">
          {collapsed ? (
            <Separator className="mx-2 my-1 w-auto" />
          ) : (
            <p className="text-muted-foreground px-2 py-1 text-xs font-medium tracking-wide">
              {group.label}
            </p>
          )}
          {group.items.map((item) => {
            const active = location.pathname === item.path;
            const link = (
              <NavLink
                key={item.path}
                to={item.path}
                onClick={onNavigate}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'density-row flex items-center gap-2.5 rounded-md text-sm font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  collapsed && 'justify-center px-0',
                  active
                    ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                    : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground',
                )}
              >
                <item.icon className="size-4 shrink-0" aria-hidden />
                {!collapsed && <span className="truncate">{item.label}</span>}
              </NavLink>
            );
            return collapsed ? (
              <Tooltip key={item.path}>
                <TooltipTrigger asChild>{link}</TooltipTrigger>
                <TooltipContent side="right">{item.label}</TooltipContent>
              </Tooltip>
            ) : (
              link
            );
          })}
        </div>
      ))}
    </nav>
  );
}

export { SidebarNav };

interface SidebarProps {
  collapsed: boolean;
  onToggleCollapsed(): void;
}

export function Sidebar({ collapsed, onToggleCollapsed }: SidebarProps): React.ReactNode {
  return (
    <aside
      data-slot="sidebar"
      data-collapsed={collapsed}
      className="bg-sidebar text-sidebar-foreground sticky top-0 hidden h-svh shrink-0 flex-col border-r transition-[width] duration-200 ease-in-out lg:flex"
      style={{ width: collapsed ? '3.5rem' : '16rem' }}
    >
      {/* 品牌区 */}
      <div
        className={cn(
          'flex h-14 shrink-0 items-center gap-2 border-b px-3',
          collapsed && 'justify-center px-0',
        )}
      >
        <div className="bg-primary text-primary-foreground flex size-8 shrink-0 items-center justify-center rounded-md">
          <BoxesIcon className="size-4.5" aria-hidden />
        </div>
        {!collapsed && (
          <div className="min-w-0 leading-tight">
            <p className="truncate text-sm font-semibold">Opptrix Harness</p>
            <p className="text-muted-foreground truncate text-[11px]">Dashboard（管理台）</p>
          </div>
        )}
      </div>

      {/* 导航分组 */}
      <SidebarNav collapsed={collapsed} />

      {/* 底部：折叠开关 */}
      <div className={cn('shrink-0 border-t p-2', collapsed && 'px-1')}>
        <Button
          variant="ghost"
          size={collapsed ? 'icon-sm' : 'sm'}
          onClick={onToggleCollapsed}
          aria-label={collapsed ? '展开侧栏' : '折叠侧栏'}
          className={cn('text-muted-foreground w-full justify-start hover:text-foreground', collapsed && 'justify-center')}
        >
          {collapsed ? <PanelLeftOpenIcon aria-hidden /> : <PanelLeftCloseIcon aria-hidden />}
          {!collapsed && <span>折叠侧栏</span>}
        </Button>
      </div>
    </aside>
  );
}

/** 路由总数（供测试/文档对账：11 项主导航） */
export const SIDEBAR_ITEM_COUNT = NAV_ITEMS.length;
