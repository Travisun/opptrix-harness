/**
 * inbox — 站内信驱动（NotificationDriver 契约实现）。
 *
 * "入库即 inbox"：通知记录本身（notifications 表）就是站内信的存储，
 * NotificationManager 在投递前已负责持久化并发布 'notification.created'
 * SSE 事件，通知中心 UI 消费该事件渲染。因此本驱动无需任何动作，
 * 存在的意义是让路由规则/调用方可以用 `driver: 'inbox'` 显式表达
 * "只入站内信、不外发"，与 webhook/email 等外发驱动在同一抽象下编排。
 */
import type { NotificationDriver } from '../../channels/index.js';

/** inbox 通知驱动：no-op 投递（持久化与 SSE 由 NotificationManager 负责） */
export const inboxDriver: NotificationDriver = {
  name: 'inbox',
  deliver: async () => {},
};
