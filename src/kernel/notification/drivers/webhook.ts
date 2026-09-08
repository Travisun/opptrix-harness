/**
 * webhook — 签名 Webhook 通知驱动（NotificationDriver 契约实现）。
 *
 * target（渠道路由里的 target 字段，经 zod 校验）：
 * - url 必填（完整 http(s) 地址）；
 * - secret 明文共享密钥，或 secretRef（kernel secrets 引用，明文永不入配置）——
 *   两者都给时 target.secret 优先；都未给则发不带签名头的 POST；
 *   secretRef 有值但未注入 resolveSecret 时抛 DELIVERY_FAILED（给出两种修复方式）；
 * - timeoutMs / retries 透传给 channels 包 signedPost（缺省 10s / 3 次重试）。
 *
 * 投递：请求体为 NotificationPayload 原样 JSON；secret 存在时由 signedPost 附加
 * x-harness-timestamp / x-harness-signature（hex(hmac_sha256(secret, ts + '.' + rawBody))）。
 *
 * 失败语义：target 非法 → VALIDATION_FAILED；secretRef 解析/POST 任一环节失败 →
 * DELIVERY_FAILED。失败由 NotificationManager 隔离计数，不会中断其他渠道。
 */
import type { NotificationDriver } from '../../channels/index.js';
import { signedPost } from '../../channels/index.js';
import { err } from '../../errors/index.js';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// 依赖契约
// ---------------------------------------------------------------------------

/** createWebhookDriver 依赖集合（全部可选，便于最小装配与测试注入） */
export interface WebhookDriverDeps {
  /** 密钥解析（kernel secrets）：secretRef → 明文密钥；返回 null 视作未配置（不带签名） */
  resolveSecret?: (ref: string) => Promise<string | null>;
}

// ---------------------------------------------------------------------------
// target zod schema
// ---------------------------------------------------------------------------

const webhookTargetSchema = z.object({
  url: z.url(),
  secret: z.string().min(1).optional(),
  secretRef: z.string().min(1).optional(),
  /** 单次尝试超时（毫秒），透传 signedPost */
  timeoutMs: z.number().int().positive().optional(),
  /** 失败重试次数（不含首次），透传 signedPost；测试可置 0 加速失败路径 */
  retries: z.number().int().min(0).max(10).optional(),
});

// ---------------------------------------------------------------------------
// 驱动工厂
// ---------------------------------------------------------------------------

/**
 * 创建 webhook 通知驱动（name: 'webhook'）。
 *
 * deliver(payload, target)：
 * 1. zod 校验 target（缺 url 即抛 VALIDATION_FAILED，detail = issues）；
 * 2. 取签名密钥：target.secret 优先，其次经 deps.resolveSecret(target.secretRef)
 *    解析（null = 未配置，不带签名；解析器抛错 → DELIVERY_FAILED）；
 * 3. signedPost({ url, body: payload, secret?, timeoutMs?, retries? })；
 *    全部尝试失败由 signedPost 抛 DELIVERY_FAILED。
 */
export function createWebhookDriver(deps: WebhookDriverDeps = {}): NotificationDriver {
  return {
    name: 'webhook',

    deliver: async (payload, target) => {
      const parsed = webhookTargetSchema.safeParse(target);
      if (!parsed.success) {
        throw err('VALIDATION_FAILED', {
          message: 'webhook driver target invalid (require url; optional secret / secretRef / timeoutMs / retries)',
          detail: parsed.error.issues,
        });
      }
      const targetValue = parsed.data;

      // 签名密钥：明文 secret 优先；否则解析 secretRef（引用指针可入库，明文永不入配置）
      let secret: string | undefined = targetValue.secret;
      if (secret === undefined && targetValue.secretRef !== undefined) {
        if (deps.resolveSecret === undefined) {
          throw err('DELIVERY_FAILED', {
            message:
              `webhook driver: target.secretRef "${targetValue.secretRef}" set but no resolveSecret provided. ` +
              'Wire createWebhookDriver({ resolveSecret }) at assembly time, or pass target.secret directly.',
            detail: { url: targetValue.url, secretRef: targetValue.secretRef },
          });
        }
        try {
          const resolved = await deps.resolveSecret(targetValue.secretRef);
          // null = secrets 里未配置该引用：按不带签名投递（与 email 驱动 omit-auth 语义一致）
          secret = resolved ?? undefined;
        } catch (e) {
          throw err('DELIVERY_FAILED', {
            message: `webhook driver failed to resolve secret "${targetValue.secretRef}"`,
            detail: { url: targetValue.url, secretRef: targetValue.secretRef },
            cause: e,
          });
        }
      }

      await signedPost({
        url: targetValue.url,
        body: payload,
        secret,
        timeoutMs: targetValue.timeoutMs,
        retries: targetValue.retries,
      });
    },
  } satisfies NotificationDriver;
}
