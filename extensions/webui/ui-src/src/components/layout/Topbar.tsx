import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  BellIcon,
  Loader2Icon,
  LogOutIcon,
  MenuIcon,
  MessageSquareIcon,
  MonitorIcon,
  MoonIcon,
  SunIcon,
} from 'lucide-react';

import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Separator } from '@/components/ui/separator';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { SidebarNav } from '@/components/layout/Sidebar';
import { useChatPanel } from '@/features/chat/ChatPanelContext';
import { useNotifications } from '@/features/notifications/NotificationsProvider';
import { api, clearToken, getCachedUser, type MeResult } from '@/lib/api';
import { findNavItem } from '@/lib/nav';
import { useTheme, type ThemeMode } from '@/lib/theme';
import { cn } from '@/lib/utils';

/**
 * Topbar — 顶栏（移动/桌面共用）。
 *
 * 左区：移动端汉堡（AppShell 的 Sheet 抽屉经 onMobileNavOpen 打开）+ 当前页面标题；
 * 右区：实时连接徽标｜通知中心（未读 badge）｜主题切换（三态下拉）｜
 *       聊天面板开关（未读 badge；桌面内联第三栏 / 移动全屏 Sheet）｜用户菜单（身份/退出）。
 * 未读约定：通知中心与聊天面板的未读徽标分开显示、互不合并。
 */

const ROLE_LABELS: Record<string, string> = {
  root: '超级管理员',
  owner: '所有者',
  admin: '管理员',
  user: '成员',
};

function roleLabel(role: string | undefined): string {
  if (role === undefined || role === '') return '成员';
  return ROLE_LABELS[role] ?? role;
}

const MODE_OPTIONS: Array<{ value: ThemeMode; label: string; icon: typeof SunIcon }> = [
  { value: 'light', label: '浅色', icon: SunIcon },
  { value: 'dark', label: '深色', icon: MoonIcon },
  { value: 'system', label: '跟随系统', icon: MonitorIcon },
];

function ConnectionBadge(): React.ReactNode {
  const { connected } = useNotifications();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="hidden items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs text-muted-foreground sm:flex"
          aria-label={connected ? '实时连接已建立' : '实时连接已断开'}
        >
          <span className="relative flex size-2">
            {connected && (
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-75" />
            )}
            <span
              className={cn(
                'relative inline-flex size-2 rounded-full',
                connected ? 'bg-emerald-500' : 'bg-muted-foreground/50',
              )}
            />
          </span>
          实时
        </span>
      </TooltipTrigger>
      <TooltipContent>{connected ? '事件流已连接' : '事件流重连中…'}</TooltipContent>
    </Tooltip>
  );
}

function ThemeToggle(): React.ReactNode {
  const { mode, setMode } = useTheme();
  const current = MODE_OPTIONS.find((o) => o.value === mode) ?? MODE_OPTIONS[2];
  const CurrentIcon = current.icon;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={`切换主题（当前：${current.label}）`}>
          <CurrentIcon aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-32">
        <DropdownMenuRadioGroup
          value={mode}
          onValueChange={(value) => {
            if (value === 'light' || value === 'dark' || value === 'system') setMode(value);
          }}
        >
          {MODE_OPTIONS.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value}>
              <option.icon className="mr-1.5 size-3.5 text-muted-foreground" aria-hidden />
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ChatToggle(): React.ReactNode {
  const chat = useChatPanel();
  const handleToggle = (): void => {
    // ≥lg：内联第三栏开关（默认隐藏）；<lg：右侧全屏 Sheet
    if (window.matchMedia('(min-width: 1024px)').matches) {
      chat.toggle();
    } else {
      chat.setMobileOpen(true);
    }
  };
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="聊天面板"
          aria-pressed={chat.desktopOpen}
          className={cn('relative', chat.desktopOpen && 'bg-accent')}
          onClick={handleToggle}
        >
          <MessageSquareIcon aria-hidden />
          {chat.unread > 0 && (
            <Badge
              variant="default"
              className="absolute -top-1 -right-1 h-4 min-w-4 rounded-full px-1 text-[10px] tabular-nums"
            >
              {chat.unread > 99 ? '99+' : chat.unread}
            </Badge>
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent>聊天面板</TooltipContent>
    </Tooltip>
  );
}

function NotificationBell(): React.ReactNode {
  const { unread } = useNotifications();
  const navigate = useNavigate();
  const location = useLocation();
  const onNotificationsPage = location.pathname === '/notifications';
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="通知中心"
          className={cn('relative', onNotificationsPage && 'bg-accent')}
          onClick={() => {
            if (!onNotificationsPage) navigate('/notifications');
          }}
        >
          <BellIcon aria-hidden />
          {unread > 0 && (
            <Badge
              variant={onNotificationsPage ? 'secondary' : 'destructive'}
              className="absolute -top-1 -right-1 h-4 min-w-4 rounded-full px-1 text-[10px] tabular-nums"
            >
              {unread > 99 ? '99+' : unread}
            </Badge>
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent>通知中心{unread > 0 ? `（${unread} 条未读）` : ''}</TooltipContent>
    </Tooltip>
  );
}

interface SessionInfo {
  username: string;
  role: string;
}

function UserMenu(): React.ReactNode {
  const navigate = useNavigate();
  const [session, setSession] = useState<SessionInfo | null>(() => {
    const cached = getCachedUser();
    if (cached === null) return null;
    return { username: cached.username ?? 'root', role: cached.role ?? '' };
  });
  const [loggingOut, setLoggingOut] = useState(false);

  // 以 /auth/me 实时校准身份显示（登录时缓存兜底）
  useEffect(() => {
    let alive = true;
    api
      .get<MeResult>('/api/v1/auth/me', { silent: true })
      .then((me) => {
        if (!alive) return;
        setSession({ username: me.username ?? 'root', role: me.role });
      })
      .catch(() => {
        /* 保持缓存兜底值 */
      });
    return () => {
      alive = false;
    };
  }, []);

  const handleLogout = async (): Promise<void> => {
    setLoggingOut(true);
    try {
      await api.post('/api/v1/auth/logout', undefined, { silent: true });
    } catch {
      /* 会话可能已过期：本地清理后照常回登录页 */
    }
    clearToken();
    navigate('/login', { replace: true });
  };

  const initial = (session?.username ?? '?').slice(0, 1).toUpperCase();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="用户菜单" className="rounded-full">
          <Avatar className="size-7">
            <AvatarFallback className="text-xs font-medium">{initial}</AvatarFallback>
          </Avatar>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        <DropdownMenuLabel className="flex flex-col gap-0.5">
          <span className="truncate text-sm">{session?.username ?? '未登录'}</span>
          <span className="text-muted-foreground text-xs font-normal">{roleLabel(session?.role)}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => {
            void handleLogout();
          }}
          disabled={loggingOut}
        >
          {loggingOut ? <Loader2Icon className="animate-spin" aria-hidden /> : <LogOutIcon aria-hidden />}
          退出登录
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function Topbar({ onMobileNavOpen }: { onMobileNavOpen: () => void }): React.ReactNode {
  const location = useLocation();
  const current = findNavItem(location.pathname);

  return (
    <header className="bg-background/80 supports-[backdrop-filter]:bg-background/60 sticky top-0 z-40 flex h-14 shrink-0 items-center gap-2 border-b px-4 backdrop-blur">
      <Button
        variant="ghost"
        size="icon-sm"
        className="lg:hidden"
        aria-label="打开导航"
        onClick={onMobileNavOpen}
      >
        <MenuIcon aria-hidden />
      </Button>
      <h1 className="min-w-0 truncate text-sm font-semibold sm:text-base">
        {current?.title ?? '控制台'}
      </h1>

      <div className="ml-auto flex items-center gap-1">
        <ConnectionBadge />
        <Separator orientation="vertical" className="mx-1 hidden h-5 sm:block" />
        <NotificationBell />
        <ThemeToggle />
        <ChatToggle />
        <Separator orientation="vertical" className="mx-1 h-5" />
        <UserMenu />
      </div>
    </header>
  );
}

/** 移动端导航抽屉（AppShell 渲染；与 Topbar 的汉堡按钮经 onMobileNavOpen 联动） */
export function MobileNavSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.ReactNode {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="left" className="w-64 gap-0 p-0" showCloseButton={false}>
        <SheetHeader className="border-b">
          <SheetTitle className="text-left text-sm">Opptrix 控制台</SheetTitle>
          <SheetDescription className="text-left text-xs">Harness OS 管理台</SheetDescription>
        </SheetHeader>
        <SidebarNav onNavigate={() => onOpenChange(false)} />
      </SheetContent>
    </Sheet>
  );
}
