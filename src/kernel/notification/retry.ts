/**
 * notification — 渠道投递重试统一封装（指数退避）。
 *
 * 语义速览：
 * - `withDeliveryRetry(fn, { retries, baseMs })`：总尝试 = retries + 1（retries 不含
 *   首次）；第 n 次重试前等待 `baseMs * 2^(n-1)`（baseMs=500 → 500ms/1s/2s；
 *   baseMs=2000 → 2s/4s）；重试耗尽抛最后一次的原始错误；
 * - 每驱动缺省口径见 {@link NOTIFICATION_RETRY_DEFAULTS}：webhook 保持 channels 包
 *   signedPost 的历史口径（3 次 500ms/1s/2s，本驱动已改为单次尝试、重试上移至此），
 *   email 为 2 次 / 2s/4s（SMTP 慢失败退避拉长），inbox/console 不重试；
 * - 重试次数/退避可由 settings 键 `notify.retry`（形状 {retries, baseMs}）整体覆盖：
 *   经 `normalizeRetryOverride` 归一化，读不到/形状非法返回 null（用默认）；
 * - `resolveChannelRetry` 为单渠道解析最终口径：覆盖值优先；webhook 逐目标
 *   `target.retries` 次之（历史契约：按 target 微调尝试次数）；再回落驱动缺省表。
 *
 * 本模块为纯函数集合：sleep 可注入，测试无需 fake timers / 真实等待。
 */
import { z } from 'zod';

/** 重试口径：retries 不含首次尝试；baseMs 为首次重试前的等待基准（指数翻倍） */
export interface DeliveryRetryConfig {
  /** 首次失败后的重试次数（总尝试 = retries + 1） */
  retries: number;
  /** 指数退避基准（毫秒）：第 n 次重试前等待 baseMs * 2^(n-1) */
  baseMs: number;
}

/** 可注入的等待函数（测试注入记录器以免真实 sleep） */
export type SleepFn = (ms: number) => Promise<void>;

/** 每驱动缺省重试口径（键 = registry 注册的驱动名；未listed驱动回落 FALLBACK） */
export const NOTIFICATION_RETRY_DEFAULTS: Record<string, DeliveryRetryConfig> = {
  /** 与 channels 包 signedPost 历史口径一致：3 次重试，退避 500ms/1s/2s */
  webhook: { retries: 3, baseMs: 500 },
  /** SMTP 慢失败：2 次重试，退避 2s/4s */
  email: { retries: 2, baseMs: 2000 },
  /** 入库即投递 / 本地日志：无重试意义，单次尝试 */
  inbox: { retries: 0, baseMs: 500 },
  console: { retries: 0, baseMs: 500 },
};

/** 未知驱动的兜底口径：不重试（单渠道失败由 manager 计数隔离，不拖慢整批投递） */
export const FALLBACK_DELIVERY_RETRY: DeliveryRetryConfig = { retries: 0, baseMs: 500 };

/** settings 'notify.retry' 覆盖值的 zod 口径（retries 上限 10，baseMs 上限 1 分钟） */
const retryOverrideSchema = z.object({
  retries: z.number().int().min(0).max(10),
  baseMs: z.number().int().min(0).max(60_000),
});

/**
 * settings 'notify.retry' 原始值 → 重试口径；缺失/形状非法返回 null（用默认）。
 * settings 属外部入参，读取结果必须经校验才可使用。
 */
export function normalizeRetryOverride(raw: unknown): DeliveryRetryConfig | null {
  if (raw === null || raw === undefined) return null;
  const parsed = retryOverrideSchema.safeParse(raw);
  return parsed.success ? { retries: parsed.data.retries, baseMs: parsed.data.baseMs } : null;
}

/** 缺省等待实现（setTimeout；测试注入替换） */
export function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** withDeliveryRetry 选项：重试口径 + 可注入 sleep + 可选的重试判定 */
export interface WithDeliveryRetryOptions extends DeliveryRetryConfig {
  /** 等待实现（缺省 setTimeout） */
  sleep?: SleepFn;
  /**
   * 返回 false 的错误立即抛出不重试（缺省全部重试）。manager 注入的判定：
   * HarnessError 按自身 retryable 标志（如 VALIDATION_FAILED 属配置错误不重试）。
   */
  retryOn?: (error: unknown) => boolean;
}

/**
 * 统一投递重试封装：执行 fn，失败按指数退避重试（见模块头），耗尽后抛最后一次错误。
 * 纯函数：无模块态、sleep/retryOn 可注入；成功返回 fn 的原值。
 */
export async function withDeliveryRetry<T>(fn: () => Promise<T>, opts: WithDeliveryRetryOptions): Promise<T> {
  const retries = Math.max(0, Math.trunc(opts.retries));
  const baseMs = Math.max(0, Math.trunc(opts.baseMs));
  const sleep = opts.sleep ?? defaultSleep;
  const retryOn = opts.retryOn;
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= retries || (retryOn !== undefined && !retryOn(e))) throw e;
      await sleep(baseMs * 2 ** attempt);
      attempt += 1;
    }
  }
}

/**
 * 单渠道重试口径解析（优先级：settings 覆盖 > webhook target.retries > 驱动缺省表）。
 *
 * - override 非空：整体生效（含 webhook——运维显式要求时不再叠加逐目标口径）；
 * - webhook 的 target.retries（整数 0..10）逐目标覆盖重试次数（baseMs 沿用 500 历史口径）；
 * - 其余按驱动名查 {@link NOTIFICATION_RETRY_DEFAULTS}，未listed驱动回落 FALLBACK。
 */
export function resolveChannelRetry(
  driver: string,
  target: unknown,
  override: DeliveryRetryConfig | null,
): DeliveryRetryConfig {
  if (override !== null) return override;
  if (driver === 'webhook' && target !== null && typeof target === 'object') {
    const retries = (target as Record<string, unknown>)['retries'];
    if (typeof retries === 'number' && Number.isInteger(retries) && retries >= 0) {
      return { retries: Math.min(retries, 10), baseMs: 500 };
    }
  }
  return NOTIFICATION_RETRY_DEFAULTS[driver] ?? FALLBACK_DELIVERY_RETRY;
}
