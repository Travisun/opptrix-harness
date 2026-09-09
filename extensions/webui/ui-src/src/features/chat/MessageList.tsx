import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  AlertCircleIcon,
  ArrowDownIcon,
  HistoryIcon,
  Loader2Icon,
  MessageSquareIcon,
  PaperclipIcon,
  RotateCcwIcon,
  WebhookIcon,
} from 'lucide-react';

import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

import { GROUP_WINDOW_MS } from './useChatMessages';
import {
  dayKey,
  describeUnknown,
  formatBytes,
  formatDayLabel,
  formatTime,
  normalizeContent,
  type ChatMessage,
  type ContentView,
} from './types';

/**
 * MessageList — 消息流渲染。
 *
 * - 升序渲染 + 按天分隔线（今天/昨天/日期）；
 * - 同一发送者 5 分钟内的连续消息合并显示（头像与名称只出现一次）；
 * - 新消息自动滚底；用户上翻历史时暂停自动滚动并显示「回到底部」悬浮钮；
 * - 「加载更早」按钮（before 游标），插入历史后保持视口位置不跳动；
 * - 渲染规则：自己右对齐 primary 气泡；他人左侧带头像；ext 带 Bot 徽标；
 *   webhook 灰色系统样式；file/card 渲染为卡片（card 详情 JSON 默认折叠）。
 */

interface MessageListProps {
  channelId: string | null;
  channelName: string | null;
  /** 频道列表仍在首载（区别于「没有频道」） */
  channelLoading: boolean;
  messages: ChatMessage[];
  myUserId: string | null;
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  error: string | null;
  onLoadMore(): void;
  onRetry(): void;
}

type Row =
  | { kind: 'day'; key: string; label: string }
  | { kind: 'message'; key: string; msg: ChatMessage; grouped: boolean };

function buildRows(messages: ChatMessage[]): Row[] {
  const rows: Row[] = [];
  let prev: ChatMessage | null = null;
  for (const msg of messages) {
    const key = dayKey(msg.createdAt);
    if (prev === null || dayKey(prev.createdAt) !== key) {
      rows.push({ kind: 'day', key: `day-${key}-${msg.id}`, label: formatDayLabel(msg.createdAt) });
    }
    const grouped =
      prev !== null &&
      dayKey(prev.createdAt) === key &&
      prev.senderType === msg.senderType &&
      prev.senderId === msg.senderId &&
      msg.createdAt - prev.createdAt < GROUP_WINDOW_MS;
    rows.push({ kind: 'message', key: msg.id, msg, grouped });
    prev = msg;
  }
  return rows;
}

/** 距底部多少像素以内视为「在底部」（自动滚动窗口） */
const AT_BOTTOM_THRESHOLD_PX = 60;

export function MessageList(props: MessageListProps): React.ReactNode {
  const {
    channelId,
    channelName,
    channelLoading,
    messages,
    myUserId,
    loading,
    loadingMore,
    hasMore,
    error,
    onLoadMore,
    onRetry,
  } = props;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const atBottomRef = useRef(true);
  /** 「加载更早」点击时的 视口底距（scrollHeight - scrollTop）；渲染后按此回卷 */
  const prependAnchorRef = useRef<number | null>(null);
  const [showJump, setShowJump] = useState(false);

  const scrollToBottom = (smooth = false): void => {
    const el = containerRef.current;
    if (el === null) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  };

  // 频道切换：恢复自动滚底
  useEffect(() => {
    atBottomRef.current = true;
    setShowJump(false);
  }, [channelId]);

  // 新消息自动滚底（用户上翻时暂停）
  const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;
  useEffect(() => {
    if (lastMessage === null) return;
    if (atBottomRef.current) scrollToBottom();
  }, [lastMessage?.id, lastMessage?.pending]);

  // 「加载更早」插入历史后保持视口位置
  useLayoutEffect(() => {
    if (loadingMore) return;
    const anchor = prependAnchorRef.current;
    if (anchor === null) return;
    prependAnchorRef.current = null;
    const el = containerRef.current;
    if (el === null) return;
    el.scrollTop = el.scrollHeight - anchor;
  }, [messages.length, loadingMore]);

  const handleScroll = (): void => {
    const el = containerRef.current;
    if (el === null) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atBottom = distance < AT_BOTTOM_THRESHOLD_PX;
    atBottomRef.current = atBottom;
    setShowJump(!atBottom);
  };

  const handleLoadMore = (): void => {
    const el = containerRef.current;
    prependAnchorRef.current = el !== null ? el.scrollHeight - el.scrollTop : null;
    onLoadMore();
  };

  const rows = buildRows(messages);

  // ---------------------------------------------------------------------
  // 非消息态：无频道 / 首载 / 失败 / 空频道欢迎
  // ---------------------------------------------------------------------

  if (channelLoading && channelId === null) {
    return <AreaCentered text="正在加载频道…" />;
  }
  if (channelId === null) {
    return (
      <AreaCentered
        icon={<MessageSquareIcon className="size-6" aria-hidden />}
        title="还没有频道"
        text="选择或创建一个频道开始会话。"
      />
    );
  }
  if (loading) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-3 p-4" aria-busy="true" aria-label="消息加载中">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className={cn('flex gap-2', i % 2 === 1 && 'flex-row-reverse')}>
            <div className="bg-muted size-7 shrink-0 animate-pulse rounded-full" />
            <div className="bg-muted h-10 w-40 animate-pulse rounded-2xl" />
          </div>
        ))}
      </div>
    );
  }
  if (error !== null && messages.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <AlertCircleIcon className="text-destructive size-6" aria-hidden />
        <p className="text-sm font-medium">消息加载失败</p>
        <p className="text-muted-foreground max-w-[260px] text-xs leading-relaxed break-all">{error}</p>
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RotateCcwIcon aria-hidden />
          重试
        </Button>
      </div>
    );
  }

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={containerRef}
        data-slot="chat-message-list"
        className="h-full overflow-y-auto px-3 py-3"
        onScroll={handleScroll}
      >
        {messages.length === 0 ? (
          <AreaCentered
            icon={<MessageSquareIcon className="size-6" aria-hidden />}
            title={`欢迎来到 #${channelName ?? 'channel'}`}
            text="这里还是一片空白，发送第一条消息吧。"
          />
        ) : (
          <>
            {hasMore && (
              <div className="flex justify-center pb-3">
                <Button variant="ghost" size="sm" disabled={loadingMore} onClick={handleLoadMore}>
                  {loadingMore ? (
                    <Loader2Icon className="animate-spin" aria-hidden />
                  ) : (
                    <HistoryIcon aria-hidden />
                  )}
                  加载更早的消息
                </Button>
              </div>
            )}
            {rows.map((row) =>
              row.kind === 'day' ? (
                <DaySeparator key={row.key} label={row.label} />
              ) : (
                <MessageRow
                  key={row.key}
                  msg={row.msg}
                  grouped={row.grouped}
                  myUserId={myUserId}
                />
              ),
            )}
          </>
        )}
      </div>
      {showJump && (
        <Button
          size="icon-sm"
          aria-label="回到底部"
          className="absolute bottom-3 right-3 rounded-full shadow-md"
          onClick={() => {
            atBottomRef.current = true;
            setShowJump(false);
            scrollToBottom(true);
          }}
        >
          <ArrowDownIcon aria-hidden />
        </Button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 行渲染
// ---------------------------------------------------------------------------

function DaySeparator({ label }: { label: string }): React.ReactNode {
  return (
    <div className="flex items-center gap-3 py-2" role="separator" aria-label={label}>
      <span className="bg-border h-px flex-1" />
      <span className="text-muted-foreground text-xs">{label}</span>
      <span className="bg-border h-px flex-1" />
    </div>
  );
}

function MessageRow({ msg, grouped, myUserId }: { msg: ChatMessage; grouped: boolean; myUserId: string | null }): React.ReactNode {
  const isWebhook = msg.senderType === 'webhook';
  const isOwn = !isWebhook && msg.senderType === 'user' && myUserId !== null && msg.senderId === myUserId;
  const isBot = msg.senderType === 'ext';

  if (isWebhook) {
    return (
      <div
        className={cn('my-1 rounded-lg border border-dashed bg-muted/40 px-3 py-2', msg.pending === true && 'opacity-60')}
        title={new Date(msg.createdAt).toLocaleString()}
      >
        <p className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium">
          <WebhookIcon className="size-3" aria-hidden />
          <span className="truncate">{msg.senderId || 'webhook'}</span>
        </p>
        <ContentBlock content={normalizeContent(msg.content)} tone="muted" />
      </div>
    );
  }

  if (isOwn) {
    return (
      <div className={cn('flex flex-row-reverse gap-2', grouped ? 'mt-0.5' : 'mt-3')} title={new Date(msg.createdAt).toLocaleString()}>
        <div
          className={cn(
            'bg-primary text-primary-foreground max-w-[85%] rounded-2xl rounded-br-sm px-3 py-2',
            msg.pending === true && 'opacity-70',
          )}
        >
          <ContentBlock content={normalizeContent(msg.content)} tone="primary" />
          {!grouped && (
            <p className="text-primary-foreground/70 mt-0.5 text-right text-[10px] tabular-nums">
              {msg.pending ? '发送中…' : formatTime(msg.createdAt)}
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={cn('flex gap-2', grouped ? 'mt-0.5' : 'mt-3')} title={new Date(msg.createdAt).toLocaleString()}>
      {grouped ? (
        <span className="size-7 shrink-0" aria-hidden />
      ) : (
        <Avatar className="size-7">
          <AvatarFallback className="text-xs font-medium">{initialOf(msg.senderId)}</AvatarFallback>
        </Avatar>
      )}
      <div className="min-w-0 max-w-[85%]">
        {!grouped && (
          <p className="text-muted-foreground mb-1 flex items-center gap-1.5 text-xs">
            <span className="truncate font-medium">{displayName(msg.senderId)}</span>
            {isBot && (
              <Badge variant="secondary" className="h-4 px-1 text-[10px]">
                Bot
              </Badge>
            )}
            <span className="shrink-0 tabular-nums">{formatTime(msg.createdAt)}</span>
          </p>
        )}
        <div className={cn('bg-muted inline-block rounded-2xl rounded-bl-sm px-3 py-2', msg.pending === true && 'opacity-70')}>
          <ContentBlock content={normalizeContent(msg.content)} tone="muted" />
        </div>
      </div>
    </div>
  );
}

function initialOf(senderId: string): string {
  const trimmed = senderId.trim();
  return (trimmed === '' ? '?' : trimmed).slice(0, 1).toUpperCase();
}

function displayName(senderId: string): string {
  return senderId === '' ? '未知用户' : senderId;
}

// ---------------------------------------------------------------------------
// 内容块（text / file / card / unknown）
// ---------------------------------------------------------------------------

function ContentBlock({ content, tone }: { content: ContentView; tone: 'primary' | 'muted' }): React.ReactNode {
  if (content.type === 'text') {
    if (content.text === '') {
      return <p className="text-muted-foreground text-sm italic">（空消息）</p>;
    }
    return <p className="text-sm leading-relaxed break-words whitespace-pre-wrap">{content.text}</p>;
  }
  if (content.type === 'file') {
    return (
      <span
        className={cn(
          'flex max-w-[240px] items-center gap-2 rounded-md border px-2.5 py-1.5',
          tone === 'primary' ? 'border-primary-foreground/25 bg-primary-foreground/10' : 'border-border bg-background/60',
        )}
      >
        <PaperclipIcon className="size-4 shrink-0" aria-hidden />
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium">{content.name}</span>
          {content.size !== null && (
            <span className={cn('block text-[11px] tabular-nums', tone === 'primary' ? 'text-primary-foreground/70' : 'text-muted-foreground')}>
              {formatBytes(content.size)}
            </span>
          )}
        </span>
      </span>
    );
  }
  if (content.type === 'card') {
    return (
      <span className="block max-w-[260px] rounded-md border border-border bg-background/60 px-2.5 py-2">
        <span className="block text-sm font-medium break-words">{content.kind}</span>
        <details className="mt-1">
          <summary className="text-muted-foreground cursor-pointer text-xs select-none">查看详情</summary>
          <pre className="text-muted-foreground mt-1 max-h-40 overflow-auto rounded bg-black/5 p-2 font-mono text-[11px] leading-relaxed break-all whitespace-pre-wrap dark:bg-white/5">
            {describeUnknown(content.payload)}
          </pre>
        </details>
      </span>
    );
  }
  return (
    <pre className="text-muted-foreground max-w-[260px] overflow-auto rounded bg-black/5 p-2 font-mono text-[11px] leading-relaxed break-all whitespace-pre-wrap dark:bg-white/5">
      {describeUnknown(content.payload)}
    </pre>
  );
}

function AreaCentered({
  icon,
  title,
  text,
  children,
}: {
  icon?: React.ReactNode;
  title?: string;
  text?: string;
  children?: React.ReactNode;
}): React.ReactNode {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
      {icon !== undefined && (
        <div className="bg-muted text-muted-foreground flex size-11 items-center justify-center rounded-full">{icon}</div>
      )}
      {title !== undefined && <p className="text-sm font-medium">{title}</p>}
      {text !== undefined && (
        <p className="text-muted-foreground max-w-[240px] text-xs leading-relaxed">{text}</p>
      )}
      {children}
    </div>
  );
}
