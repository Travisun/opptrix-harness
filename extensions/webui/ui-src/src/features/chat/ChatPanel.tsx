import { useEffect, useMemo, useRef } from 'react';
import {
  MessageSquareIcon,
  PanelRightCloseIcon,
  XIcon,
} from 'lucide-react';

import { toast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { getToken, api } from '@/lib/api';
import { connectSse, type SseStream } from '@/lib/sse';
import { useChatPanel } from '@/features/chat/ChatPanelContext';

import { ChannelSidebar, type ChatConnectionStatus } from './ChannelSidebar';
import { Composer } from './Composer';
import { MessageList } from './MessageList';
import { emitChatMessageEvent } from './chatEvents';
import { useIdentity } from './useIdentity';
import { useChatChannels } from './useChatChannels';
import { toChatMessage, useChatMessages } from './useChatMessages';
import type { ChatChannel } from './types';

/**
 * ChatPanel — 右侧聊天面板（第三栏）。
 *
 * - 桌面（≥lg）：ChatPanelSlot 在主内容右侧内联展开（desktopOpen 控制）；
 * - 移动（<lg）：由壳层经 mobileOpen 渲染右侧全屏 Sheet（同槽位内容），
 *   头部关闭按钮即移动端「返回」；槽位契约：只改本目录文件，不动壳层与上下文；
 * - 功能面：频道列表（新建频道仅 admin）、消息流（before 游标分页 + 单 topic
 *   精确游标 SSE 实时 + replay-gap REST 对账）、乐观发送（blocked toast 原因）、
 *   未读联动（面板关闭期间全局未读 +1，打开清零；打开时非当前频道点亮红点）。
 */

/** 聊天面板内容槽位：频道条 + 消息流 + 输入区（壳层仅负责开合与头部） */
export function ChatPanelSlot(): React.ReactNode {
  const identity = useIdentity();
  const channels = useChatChannels();
  const current = useMemo<ChatChannel | null>(() => {
    if (channels.currentSlug === null) return null;
    return channels.channels.find((c) => c.slug === channels.currentSlug) ?? null;
  }, [channels.channels, channels.currentSlug]);
  const messages = useChatMessages(current, identity?.userId ?? null);

  // 连接状态指示：无当前频道时不显示（idle）
  const status: ChatConnectionStatus =
    current === null ? 'idle' : messages.connected ? 'live' : 'reconnecting';

  const handleCreateChannel = async (name: string): Promise<boolean> => {
    const created = await channels.createChannel(name);
    if (created === null) return false;
    toast.success('频道已创建', `#${created.slug}`);
    return true;
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ChannelSidebar
        channels={channels.channels}
        currentSlug={channels.currentSlug}
        unreadBySlug={channels.unreadBySlug}
        isAdmin={identity?.isAdmin === true}
        loading={channels.loading}
        error={channels.error}
        status={status}
        onSelect={channels.select}
        onCreateChannel={handleCreateChannel}
        onRetry={channels.refresh}
      />
      <MessageList
        channelId={current?.id ?? null}
        channelName={current?.name ?? null}
        channelLoading={channels.loading}
        messages={messages.messages}
        myUserId={identity?.userId ?? null}
        loading={messages.loading}
        loadingMore={messages.loadingMore}
        hasMore={messages.hasMore}
        error={messages.error}
        onLoadMore={messages.loadMore}
        onRetry={messages.reload}
      />
      <Composer
        channelName={current?.name ?? null}
        sending={messages.sending}
        onSend={messages.send}
      />
    </div>
  );
}

/** useChatMessages 的频道入参视图（id 用于 REST，slug 用于 SSE topic）；ChatChannel 满足该形状 */

function PanelHeader({ onClose }: { onClose: () => void }): React.ReactNode {
  return (
    <div className="flex h-14 shrink-0 items-center justify-between border-b px-4">
      <div className="flex items-center gap-2">
        <MessageSquareIcon className="size-4 text-muted-foreground" aria-hidden />
        <h2 className="text-sm font-semibold">聊天</h2>
      </div>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="收起聊天面板"
        onClick={onClose}
      >
        <PanelRightCloseIcon className="lg:hidden" aria-hidden />
        <XIcon className="hidden lg:block" aria-hidden />
      </Button>
    </div>
  );
}

/** 桌面内联面板（≥lg 显示；由 ChatPanelContext.desktopOpen 控制） */
export function ChatPanelDesktop(): React.ReactNode {
  const { desktopOpen, setDesktopOpen } = useChatPanel();
  if (!desktopOpen) return null;
  return (
    <aside
      data-slot="chat-panel"
      className="hidden w-[380px] shrink-0 flex-col border-l bg-background lg:flex"
      aria-label="聊天面板"
    >
      <PanelHeader onClose={() => setDesktopOpen(false)} />
      <ChatPanelSlot />
    </aside>
  );
}

/** 移动全屏面板（<lg 显示；Sheet 侧滑，宽度全屏） */
export function ChatPanelMobile(): React.ReactNode {
  const { mobileOpen, setMobileOpen } = useChatPanel();
  return (
    <>
      <ChatUnreadWatcher />
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent
          side="right"
          className="inset-y-0 right-0 flex h-full w-full flex-col gap-0 p-0 sm:max-w-[380px]"
          showCloseButton={false}
          aria-label="聊天面板"
        >
          <SheetHeader className="sr-only">
            <SheetTitle>聊天面板</SheetTitle>
            <SheetDescription>与团队成员的会话界面</SheetDescription>
          </SheetHeader>
          <PanelHeader onClose={() => setMobileOpen(false)} />
          <ChatPanelSlot />
        </SheetContent>
      </Sheet>
    </>
  );
}

// ---------------------------------------------------------------------------
// ChatUnreadWatcher — 面板关闭期间的全局未读计数（始终挂载，随 ChatPanelMobile）
// ---------------------------------------------------------------------------

/** 全频道轮询兜底周期（他人新建频道后 topics 漂移的下一次生效上限） */
const CHANNELS_POLL_MS = 60_000;

/** 单例守卫：热路径上防止双连接（StrictMode 双挂载由 effect cleanup 兜底） */
let watcherActive = false;

/**
 * 始终挂载的轻量组件（不渲染 UI）：
 * - 订阅 topics=全部频道 slug 的 SSE（多 topic，lib/sse 断线不携带游标）；
 * - 面板关闭（desktopOpen 与 mobileOpen 均为 false）期间收到任意频道消息 →
 *   ChatPanelContext.unread +1；面板打开 → 清零（消息可见性由面板自身负责）；
 * - 面板打开期间经 chatEvents 总线广播消息 → 频道条为非当前频道点亮红点；
 * - replay-gap / 未知频道消息 → 静默刷新频道列表（topics 重建）。
 */
function ChatUnreadWatcher(): null {
  const { desktopOpen, mobileOpen, setUnread } = useChatPanel();
  const panelOpenRef = useRef(desktopOpen || mobileOpen);
  panelOpenRef.current = desktopOpen || mobileOpen;
  // context.setUnread 只接受数值（非 React updater）：本组件是聊天未读的唯一写入口，
  // 用本地镜像支持增量；打开面板归零即回写 0
  const unreadMirrorRef = useRef(0);

  // 打开面板 → 全局未读清零
  useEffect(() => {
    if (desktopOpen || mobileOpen) {
      unreadMirrorRef.current = 0;
      setUnread(0);
    }
  }, [desktopOpen, mobileOpen, setUnread]);

  useEffect(() => {
    if (getToken() === '' || watcherActive) return;
    watcherActive = true;
    let alive = true;
    let stream: SseStream | null = null;
    let channels: Array<{ id: string; slug: string }> = [];
    let refreshing = false;

    const connect = (): void => {
      stream?.close();
      stream = null;
      if (channels.length === 0) return;
      stream = connectSse({
        topics: channels.map((c) => `chat:${c.slug}`),
        onEvent: (e) => {
          if (e.event !== 'chat.message.created' && e.event !== 'chat.message.updated') return;
          const msg = toChatMessage(e.data);
          if (msg === null) return;
          const slug = channels.find((c) => c.id === msg.channelId)?.slug ?? null;
          emitChatMessageEvent({ kind: e.event === 'chat.message.updated' ? 'updated' : 'created', slug, message: msg });
          if (e.event === 'chat.message.created') {
            if (slug === null) void refresh();
            if (!panelOpenRef.current) {
              unreadMirrorRef.current += 1;
              setUnread(unreadMirrorRef.current);
            }
          }
        },
        onReplayGap: () => {
          // 游标失效（多 topic 断线本就不携带游标，出现即服务端缓冲溢出/重启）：
          // 未读为本地口径无法精确对账（无服务端聚合），仅刷新频道表保持 topics 新鲜
          void refresh();
        },
      });
    };

    const refresh = async (): Promise<void> => {
      if (refreshing || !alive) return;
      refreshing = true;
      try {
        const rows = await api.get<Array<{ id: string; slug: string; name: string }>>('/api/v1/channels', {
          silent: true,
        });
        if (!alive || !Array.isArray(rows)) return;
        channels = rows.map((c) => ({ id: c.id, slug: c.slug }));
        connect();
      } catch {
        /* 静默：保留旧订阅；失败场景（401）由 api 层统一登出 */
      } finally {
        refreshing = false;
      }
    };

    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, CHANNELS_POLL_MS);

    return () => {
      alive = false;
      watcherActive = false;
      clearInterval(timer);
      stream?.close();
      stream = null;
    };
  }, [setUnread]);

  return null;
}
