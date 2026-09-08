/**
 * 内核聊天桥模块出口。
 * 使用方统一 `import { createWebhookBridge, createEmailBridge, ChatBridgeDispatcher } from '../chat/bridges.js'`。
 */
export {
  createWebhookBridge,
  type WebhookBridgeDeps,
  type WebhookBridgeTarget,
} from './bridges/webhook.js';
export {
  createEmailBridge,
  type EmailBridgeDeps,
  type EmailBridgeTarget,
  type EmailTransport,
  type EmailTransportOptions,
} from './bridges/email.js';
export {
  ChatBridgeDispatcher,
  type ChannelBridgeConfig,
  type ChatBridgeDispatcherDeps,
  type DeliveryRecord,
} from './dispatcher.js';
