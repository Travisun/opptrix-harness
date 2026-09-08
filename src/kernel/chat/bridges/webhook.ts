/**
 * Webhook Chat Bridge：把出站聊天消息经共享 signedPost 投递到任意 HTTP 端点。
 *
 * - target 契约（zod 校验，非法即 DELIVERY_FAILED）：
 *   `{ url: string; secret?: string; secretRef?: string }`；
 *   签名密钥取值：`target.secret` 优先，否则按 `target.secretRef` 经 deps.resolveSecret 解析。
 * - 投递经 channels 的 signedPost（HMAC 签名头 x-harness-timestamp / x-harness-signature +
 *   超时 10s + 重试 2 次指数退避）；请求体
 *   `{ text, channel, senderType, senderId, content, createdAt }`（text 为单行摘要）。
 * - 失败一律抛 HarnessError(DELIVERY_FAILED)（signedPost 原生抛出；target/密钥问题由本桥抛出）。
 */
import { z } from 'zod';

import { err } from '../../errors/HarnessError.js';
import { signedPost } from '../../channels/index.js';
import type { ChatBridgeDriver } from '../../channels/types.js';
import type { ChatMessagePayload } from '../../channels/types.js';

/** 单次请求超时（毫秒） */
const WEBHOOK_TIMEOUT_MS = 10_000;
/** 首次失败后的重试次数（总尝试 = retries + 1，指数退避见 signedPost） */
const WEBHOOK_RETRIES = 2;

/** 依赖注入：secretRef 解析器（集成方对接内核 secrets 存储） */
export interface WebhookBridgeDeps {
  /**
   * 按 ref 名解析密钥明文；返回 undefined/空串视为解析失败（DELIVERY_FAILED）。
   * 密钥明文永不入日志。
   */
  resolveSecret?: (ref: string) => string | undefined | Promise<string | undefined>;
}

/** webhook target 契约（channels.meta.bridges[].target 的 webhook 分支） */
export interface WebhookBridgeTarget {
  url: string;
  secret?: string;
  secretRef?: string;
}

const webhookTargetSchema = z.object({
  url: z.url(),
  secret: z.string().min(1).optional(),
  secretRef: z.string().min(1).optional(),
});

/**
 * 创建 webhook 桥驱动（name 'webhook'）。
 *
 * @example
 * registry.registerChatBridgeDriver(createWebhookBridge({ resolveSecret: (ref) => secrets.get(ref) }));
 */
export function createWebhookBridge(deps?: WebhookBridgeDeps): ChatBridgeDriver {
  const resolveSecret = deps?.resolveSecret;

  async function deliverOutbound(message: ChatMessagePayload, target: unknown): Promise<void> {
    const parsed = webhookTargetSchema.safeParse(target);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw err('DELIVERY_FAILED', {
        message: `webhook bridge: invalid target config (${first?.path.join('.') || 'target'}: ${first?.message || 'validation failed'})`,
        detail: parsed.error.issues,
      });
    }
    const cfg = parsed.data as WebhookBridgeTarget;
    const secret = await resolveTargetSecret(cfg, resolveSecret);

    await signedPost({
      url: cfg.url,
      body: {
        text: textSummary(message),
        channel: message.channelSlug,
        senderType: message.senderType,
        senderId: message.senderId,
        content: message.content,
        createdAt: message.createdAt,
      },
      secret,
      timeoutMs: WEBHOOK_TIMEOUT_MS,
      retries: WEBHOOK_RETRIES,
    });
  }

  return { name: 'webhook', deliverOutbound };
}

/** 密钥取值：target.secret 优先 secretRef；secretRef 必须能解析出非空明文 */
async function resolveTargetSecret(
  target: WebhookBridgeTarget,
  resolveSecret: WebhookBridgeDeps['resolveSecret'],
): Promise<string | undefined> {
  if (target.secret !== undefined) return target.secret;
  if (target.secretRef === undefined) return undefined;
  if (!resolveSecret) {
    throw err('DELIVERY_FAILED', {
      message: `webhook bridge: target.secretRef "${target.secretRef}" configured but no resolveSecret dep provided`,
    });
  }
  const resolved = await resolveSecret(target.secretRef);
  if (typeof resolved !== 'string' || resolved.length === 0) {
    throw err('DELIVERY_FAILED', {
      message: `webhook bridge: secret "${target.secretRef}" could not be resolved (missing or empty)`,
    });
  }
  return resolved;
}

/** 单行文本摘要：`[<channel>] <senderType>/<senderId>: <content>` */
function textSummary(message: ChatMessagePayload): string {
  const contentText = typeof message.content === 'string' ? message.content : JSON.stringify(message.content) ?? '';
  return `[${message.channelSlug}] ${message.senderType}/${message.senderId}: ${contentText}`;
}
