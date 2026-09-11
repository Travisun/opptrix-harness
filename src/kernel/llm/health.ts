/**
 * health — provider 健康断路器（网络自适应，进程内纯逻辑、无 IO）。
 *
 * 每 provider 维护 {total/ok/fail 计数, consecutiveFailures, lastFailureAt, cooldownUntil}：
 * - 连续失败 ≥ failureThreshold（缺省 3）→ 进入冷却：时长 = baseCooldownMs（缺省 30s）×
 *   2^(超出阈值次数-1)，指数递增、上限 maxCooldownMs（缺省 5min）；
 * - 冷却期内 `isAvailable` 为 false——路由/HA failover 应跳过该 provider
 *   （**除非全部候选都在冷却**，则照常尝试，避免全冷却时无路可走）；
 * - 任一次成功 → consecutiveFailures 清零、冷却解除；
 * - 时钟经 `now` 注入（缺省 Date.now），单测可拨快/拨慢免真实等待。
 *
 * 实例策略：`sharedProviderHealth` 为进程内共享单例，集成装配时注入 LlmGateway.deps.health
 * 即获得全局断路语义；deps 未注入时 gateway 自建独立实例（测试/多租户隔离场景默认安全）。
 */
export interface ProviderHealthOptions {
  /** 触发冷却的连续失败次数（缺省 3） */
  failureThreshold?: number;
  /** 首次冷却时长基值（毫秒，缺省 30_000） */
  baseCooldownMs?: number;
  /** 冷却时长上限（毫秒，缺省 300_000） */
  maxCooldownMs?: number;
  /** 时钟注入（缺省 Date.now） */
  now?: () => number;
}

/** 单 provider 健康概要（诊断/REST 面透出用；cooldownUntil 为 epoch ms，null = 未冷却） */
export interface ProviderHealthStat {
  name: string;
  total: number;
  ok: number;
  fail: number;
  consecutiveFailures: number;
  lastFailureAt: number | null;
  cooldownUntil: number | null;
}

/** gateway 依赖的最小结构视图（ProviderHealthRegistry 天然满足；测试可注入替身） */
export interface ProviderHealthLike {
  isAvailable(provider: string): boolean;
  recordSuccess(provider: string): void;
  recordFailure(provider: string): void;
  /** 概要快照（可选；ProviderHealthRegistry 实现，诊断/REST 面透出用） */
  snapshot?(): ProviderHealthStat[];
}

interface ProviderEntry {
  total: number;
  ok: number;
  fail: number;
  consecutiveFailures: number;
  lastFailureAt: number | null;
  cooldownUntil: number | null;
}

function freshEntry(): ProviderEntry {
  return { total: 0, ok: 0, fail: 0, consecutiveFailures: 0, lastFailureAt: null, cooldownUntil: null };
}

export class ProviderHealthRegistry implements ProviderHealthLike {
  readonly #entries = new Map<string, ProviderEntry>();
  readonly #threshold: number;
  readonly #baseCooldownMs: number;
  readonly #maxCooldownMs: number;
  readonly #now: () => number;

  constructor(opts: ProviderHealthOptions = {}) {
    this.#threshold = Math.max(1, opts.failureThreshold ?? 3);
    this.#baseCooldownMs = Math.max(0, opts.baseCooldownMs ?? 30_000);
    this.#maxCooldownMs = Math.max(this.#baseCooldownMs, opts.maxCooldownMs ?? 300_000);
    this.#now = opts.now ?? Date.now;
  }

  /** 记一次成功：计数 + 连续失败清零 + 冷却解除 */
  recordSuccess(provider: string): void {
    const e = this.#entries.get(provider) ?? freshEntry();
    e.total += 1;
    e.ok += 1;
    e.consecutiveFailures = 0;
    e.cooldownUntil = null;
    this.#entries.set(provider, e);
  }

  /**
   * 记一次失败：连续失败达到阈值 → 冷却
   * （第 threshold 次失败冷却 baseCooldownMs，其后每次翻倍、封顶 maxCooldownMs）。
   */
  recordFailure(provider: string): void {
    const e = this.#entries.get(provider) ?? freshEntry();
    e.total += 1;
    e.fail += 1;
    e.consecutiveFailures += 1;
    e.lastFailureAt = this.#now();
    if (e.consecutiveFailures >= this.#threshold) {
      const over = e.consecutiveFailures - this.#threshold;
      const ms = Math.min(this.#baseCooldownMs * 2 ** over, this.#maxCooldownMs);
      e.cooldownUntil = this.#now() + ms;
    }
    this.#entries.set(provider, e);
  }

  /** 该 provider 是否处于冷却期（未记录过 → 恒可用） */
  isCoolingDown(provider: string): boolean {
    const e = this.#entries.get(provider);
    if (e === undefined || e.cooldownUntil === null) return false;
    return this.#now() < e.cooldownUntil;
  }

  /** 路由/failover 可用性（= 不在冷却期） */
  isAvailable(provider: string): boolean {
    return !this.isCoolingDown(provider);
  }

  /** 单 provider 概要（未记录过返回全零形状） */
  stat(provider: string): ProviderHealthStat {
    const e = this.#entries.get(provider) ?? freshEntry();
    return { name: provider, ...e };
  }

  /** 全部 provider 概要（按名称排序；诊断/REST 面透出用） */
  snapshot(): ProviderHealthStat[] {
    return [...this.#entries.keys()].sort().map((name) => this.stat(name));
  }

  /** 重置（指定 provider 或全部；测试用） */
  reset(provider?: string): void {
    if (provider === undefined) this.#entries.clear();
    else this.#entries.delete(provider);
  }
}

/** 进程内共享单例（集成装配注入 LlmGateway.deps.health 即全局生效） */
export const sharedProviderHealth = new ProviderHealthRegistry();

/**
 * HA failover 尝试间退避：200ms × 已失败尝试次数，±25% 抖动（避免同步重试风暴）。
 * 纯函数（随机仅作用于抖动分量，界内稳定），gateway 经注入 sleep 消费。
 */
export function jitteredFailoverDelayMs(attempt: number): number {
  const base = 200 * Math.max(1, attempt);
  const jitter = base * 0.25 * Math.random();
  return Math.round(base + jitter);
}
