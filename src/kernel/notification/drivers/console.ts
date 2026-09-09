/**
 * console — 控制台通知驱动（NotificationDriver 契约实现）。
 *
 * 把通知标题/级别经 kernel logger（pino，info 级）输出，用于本地开发与
 * 无外发渠道场景下的可观测性。日志只含 id/级别/标题等非敏感字段。
 *
 * 失败重试：投递与其他驱动同样纳入 NotificationManager 的统一重试封装
 *（retry.ts withDeliveryRetry）；logger.info 几乎不会失败，缺省口径为不重试。
 */
import type { NotificationDriver } from '../../channels/index.js';
import type { Logger } from 'pino';

/**
 * 创建 console 通知驱动（name: 'console'）。
 * deliver(payload)：logger.info 输出标题与级别（结构化字段 + 单行摘要）。
 */
export function createConsoleDriver(logger: Logger): NotificationDriver {
  return {
    name: 'console',

    deliver: async (payload) => {
      logger.info(
        { notificationId: payload.id, level: payload.level },
        `[notification:console] [${payload.level}] ${payload.title}`,
      );
    },
  } satisfies NotificationDriver;
}
