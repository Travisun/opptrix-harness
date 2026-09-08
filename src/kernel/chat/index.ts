/**
 * 内核 chat 模块出口。
 * 使用方统一 `import { ChatStore, ChatService } from '../chat/index.js'`。
 */
export { ChatStore, DEFAULT_MESSAGE_LIMIT, MAX_MESSAGE_LIMIT } from './store.js';
export type {
  ChannelCreateInput,
  ChannelMemberRow,
  ChannelPatch,
  ChannelRow,
  ChatMessage,
} from './store.js';
export { ChatService } from './service.js';
export type {
  ChatChannelCreateInput,
  ChatHookPort,
  ChatMessagePayload,
  ChatSendResult,
  ChatSendMessageInput,
  ChatServiceDeps,
} from './service.js';
