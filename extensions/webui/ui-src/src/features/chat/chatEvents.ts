import type { ChatMessage } from './types';

/**
 * chatEvents — 面板内共享的「全频道消息事件」模块级总线。
 *
 * 背景面板（ChatUnreadWatcher，始终挂载）持有一条 topics=全部频道的 SSE 连接，
 * 收到 chat.message.* 后经此广播；消费者：
 * - useChatChannels：面板打开时给非当前频道点亮未读点 / 发现未知频道时刷新列表；
 * - 面板未挂载时全局未读由 Watcher 直接写 ChatPanelContext.unread。
 *
 * 当前频道的消息流由 useChatMessages 的单 topic 精确游标连接负责（去重/对账），
 * 不经过本总线，避免双连接竞争。
 */

export interface ChatMessageEvent {
  /** 事件种类 */
  kind: 'created' | 'updated';
  /** 消息所属频道 slug（本地频道表查不到 → null，消费者应刷新频道列表） */
  slug: string | null;
  message: ChatMessage;
}

type Listener = (event: ChatMessageEvent) => void;

const listeners = new Set<Listener>();

/** 仅供 ChatUnreadWatcher 发布（模块内约定，不导出到包外语义） */
export function emitChatMessageEvent(event: ChatMessageEvent): void {
  for (const listener of listeners) listener(event);
}

/** 订阅全频道消息事件；返回取消订阅函数（ effect cleanup 用） */
export function subscribeChatMessages(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
