/**
 * info — 内核运行时信息收集工具。
 *
 * Counters：进程内轻量计数器（Prometheus 文本协议风格的 key）。
 * key 规则：name + 排序后的 tags，形如 `name{code=200,route=/health}`；
 * 相同 name + 相同 tags 累加到同一 key，tags 顺序不影响 key（先排序再拼接）。
 *
 * 上限保护：唯一 key 数上限 10000（防高基数标签把内存打爆——如用动态值当 tag）。
 * 超限后新 key 的 inc 被忽略（已有 key 照常累加），且只发一次 process.emitWarning。
 * 阶段 6 前为轻量占位：若需要完整指标体系应评估 prom-client（见 docs/dependencies.md）。
 */
const MAX_UNIQUE_KEYS = 10_000;

export class Counters {
  /** key -> 计数值 */
  #counts = new Map<string, number>();
  /** 超限警告只发一次 */
  #limitWarned = false;

  /**
   * 计数 +1。
   * @param name 计数名（如 'http.requests'）
   * @param tags 维度标签（可选；key 生成前会按标签名排序）。
   *             禁止使用无界动态值（请求 id、时间戳等）作为 tag——会触发 key 上限被忽略。
   */
  inc(name: string, tags?: Record<string, string>): void {
    const key = counterKey(name, tags);
    if (!this.#counts.has(key)) {
      if (this.#counts.size >= MAX_UNIQUE_KEYS) {
        if (!this.#limitWarned) {
          this.#limitWarned = true;
          process.emitWarning(
            `[info] Counters reached the unique key limit (${MAX_UNIQUE_KEYS}); ` +
              'new keys are ignored. Check for unbounded tag values (ids, timestamps, urls).',
            'CounterKeyLimitWarning',
          );
        }
        return;
      }
      this.#counts.set(key, 0);
    }
    this.#counts.set(key, (this.#counts.get(key) ?? 0) + 1);
  }

  /**
   * 当前全部计数快照（拷贝；后续 inc 不影响已返回的对象）。
   */
  snapshot(): Record<string, number> {
    return Object.fromEntries(this.#counts);
  }
}

/**
 * 计数 key：name + 排序后的 tags（无 tags 或空 tags 时就是 name 本身）。
 * 例：counterKey('http.requests', { route: '/health', code: '200' })
 *   → 'http.requests{code=200,route=/health}'
 */
function counterKey(name: string, tags?: Record<string, string>): string {
  if (tags === undefined) return name;
  const parts = Object.keys(tags)
    .sort()
    .map((k) => `${k}=${String(tags[k])}`);
  return parts.length > 0 ? `${name}{${parts.join(',')}}` : name;
}
