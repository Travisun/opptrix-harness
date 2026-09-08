/**
 * notification — 通知中心模块出口。
 * 使用方统一 `import { NotificationStore, NotificationManager, ... } from '.../notification/index.js'`。
 *
 * 说明：`drivers/email.ts` 属 email 驱动工作包，由此处刻意不 re-export
 *（文件所有权隔离），装配方按需直接引 `drivers/email.js`。
 */
export { NotificationStore, type NotificationRecord } from './store.js';
export {
  NotificationManager,
  NOTIFICATION_HOOK_POINTS,
  type NotificationManagerDeps,
  type NotificationSendInput,
  type NotificationChannel,
  type ChannelDeliveryResult,
} from './manager.js';
export { inboxDriver } from './drivers/inbox.js';
export { createWebhookDriver, type WebhookDriverDeps } from './drivers/webhook.js';
export { createConsoleDriver } from './drivers/console.js';
