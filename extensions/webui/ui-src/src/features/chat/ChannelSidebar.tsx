import { useState } from 'react';
import { HashIcon, Loader2Icon, PlusIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

import type { ChatChannel } from './types';

/**
 * ChannelSidebar — 面板顶部频道区（380px 窄栏采用横向频道条）。
 *
 * - 频道 chip：#名称，点击切换当前频道；当前高亮；有未读显示红点；
 * - 「新建频道」：仅 admin/root 显示（身份由 useIdentity 提供），name 必填；
 * - 连接状态指示：实时（绿点）/ 重连中（灰点）——取自当前频道消息流 SSE；
 * - 未知 slug 的频道经后台刷新自动出现，无需手动操作。
 */

export type ChatConnectionStatus = 'idle' | 'live' | 'reconnecting';

interface ChannelSidebarProps {
  channels: ChatChannel[];
  currentSlug: string | null;
  unreadBySlug: Record<string, number>;
  /** 仅 admin/root 显示新建入口 */
  isAdmin: boolean;
  loading: boolean;
  error: string | null;
  status: ChatConnectionStatus;
  onSelect(slug: string): void;
  /** 返回是否创建成功（成功后父级已刷新列表并选中新频道） */
  onCreateChannel(name: string): Promise<boolean>;
  onRetry(): void;
}

export function ChannelSidebar(props: ChannelSidebarProps): React.ReactNode {
  const {
    channels,
    currentSlug,
    unreadBySlug,
    isAdmin,
    loading,
    error,
    status,
    onSelect,
    onCreateChannel,
    onRetry,
  } = props;

  const [dialogOpen, setDialogOpen] = useState(false);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);

  const submit = async (): Promise<void> => {
    if (creating) return;
    setCreating(true);
    const ok = await onCreateChannel(name);
    setCreating(false);
    if (ok) {
      setDialogOpen(false);
      setName('');
    }
  };

  return (
    <div className="shrink-0 border-b">
      <div className="flex h-11 items-center gap-1 px-2">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto" role="tablist" aria-label="频道列表">
          {loading && channels.length === 0 ? (
            <span className="text-muted-foreground px-1 text-xs">正在加载频道…</span>
          ) : error !== null && channels.length === 0 ? (
            <button
              type="button"
              className="text-destructive px-1 text-xs hover:underline"
              onClick={onRetry}
            >
              频道加载失败，点击重试
            </button>
          ) : channels.length === 0 ? (
            <span className="text-muted-foreground px-1 text-xs">暂无频道</span>
          ) : (
            channels.map((channel) => {
              const active = channel.slug === currentSlug;
              const unread = unreadBySlug[channel.slug] ?? 0;
              return (
                <button
                  key={channel.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  title={`#${channel.slug}`}
                  onClick={() => onSelect(channel.slug)}
                  className={cn(
                    'relative inline-flex h-7 shrink-0 items-center gap-1 rounded-full px-2.5 text-xs whitespace-nowrap transition-colors',
                    active
                      ? 'bg-primary text-primary-foreground font-medium'
                      : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                  )}
                >
                  <HashIcon className="size-3 opacity-70" aria-hidden />
                  <span className="max-w-32 truncate">{channel.name}</span>
                  {unread > 0 && (
                    <span
                      className={cn(
                        'absolute top-0.5 right-0.5 size-2 rounded-full',
                        active ? 'bg-primary-foreground' : 'bg-destructive',
                      )}
                      aria-label={`${unread} 条未读`}
                    />
                  )}
                </button>
              );
            })
          )}
        </div>

        {isAdmin && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="新建频道"
            className="shrink-0"
            onClick={() => setDialogOpen(true)}
          >
            <PlusIcon aria-hidden />
          </Button>
        )}
        <ConnectionPill status={status} />
      </div>

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) setName('');
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>新建频道</DialogTitle>
            <DialogDescription>创建一个团队会话频道（slug 由名称自动生成）。</DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
            className="flex flex-col gap-2"
          >
            <Label htmlFor="chat-new-channel-name">频道名称</Label>
            <Input
              id="chat-new-channel-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：值班告警"
              maxLength={128}
              autoFocus
              required
            />
            <DialogFooter className="mt-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setDialogOpen(false)}
                disabled={creating}
              >
                取消
              </Button>
              <Button type="submit" disabled={name.trim() === '' || creating}>
                {creating && <Loader2Icon className="animate-spin" aria-hidden />}
                创建
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ConnectionPill({ status }: { status: ChatConnectionStatus }): React.ReactNode {
  if (status === 'idle') return null;
  const live = status === 'live';
  return (
    <span
      className="text-muted-foreground hidden shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] sm:flex"
      aria-label={live ? '实时连接已建立' : '实时连接重连中'}
    >
      <span className="relative flex size-2">
        {live && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-75" />}
        <span className={cn('relative inline-flex size-2 rounded-full', live ? 'bg-emerald-500' : 'bg-muted-foreground/50')} />
      </span>
      {live ? '实时' : '重连中'}
    </span>
  );
}
