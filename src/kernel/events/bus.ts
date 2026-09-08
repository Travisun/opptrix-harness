/**
 * EventBus — 内核事件总线（发布订阅 / 错误隔离 / 通配 / 优先级）。
 *
 * 语义速览：
 * - 模式与事件名都按 '.' 分段：`*` 匹配任意单个分段；`**` 仅在末段生效，
 *   吞掉剩余全部分段（含 0 段，对齐 glob / MQTT 习惯）；`**` 出现在中间位置
 *   按字面量分段处理；其余情况模式段数必须与事件名段数一致。
 * - 同一事件命中多个模式时，每个模式各投递一次；同一 handler 经多模式命中会被
 *   调用多次（delivered 按 模式×监听器 次数计）。
 * - 投递顺序全局排序：priority 降序（默认 0），同 priority 按全局订阅先后
 *   （订阅时分配的自增序号）；async 监听器顺序 await。
 * - 单个监听器异常被捕获并继续投递后续监听器：异常收集进 EmitResult.errors，
 *   若构造时提供 logger 则经 logger.error 记录；emit 不因监听器异常 reject。
 * - once 监听器在投递前先从注册表摘除（本轮仍会被投递，handler 内再触发同名
 *   事件不会重入自身；抛错同样视为已触发并移除）。
 * - 单模式监听数超过 maxListenersPerPattern（默认 500）时 process.emitWarning
 *   每 pattern 仅一次，且该次及后续新订阅被忽略（on()/once() 返回 no-op 退订函数）。
 * - 投递列表在收集时定格：投递过程中 off()/clear()/新订阅不影响本轮已入列的投递。
 *
 * 约定：编程性误用（空 pattern、空事件分段、非函数 handler、非数字 priority、
 * 空 source）按 fail-fast 抛 HarnessError(INTERNAL)，message 以 [events] 前缀定位；
 * 监听器业务异常一律隔离收集，绝不向外抛。
 */
import { err } from '../errors/index.js';

/** 事件元信息：随每次投递传给监听器（冻结，勿改） */
export interface EventMeta {
  /** 事件名（emit 的 name） */
  name: string;
  /** 事件来源标识，默认 'kernel'，扩展可传 'ext:<name>' 等 */
  source: string;
}

/** 事件监听器：payload 为发布方原样数据，meta 为事件元信息 */
export type EventHandler = (payload: unknown, meta: EventMeta) => Promise<void> | void;

/** 订阅选项 */
export interface SubscribeOptions {
  /** 投递优先级，降序生效，默认 0；同优先级按订阅先后 */
  priority?: number;
  /** true 时触发一次后自动移除（等价于 once()） */
  once?: boolean;
}

/** emit 的返回：投递统计与被隔离的监听器异常 */
export interface EmitResult {
  /** 本次投递的监听器调用次数（按 模式×监听器 计，含抛错者） */
  delivered: number;
  /** 被隔离的监听器异常；handler 为 handler.name 或 'anonymous#<订阅序号>' */
  errors: { handler: string; error: unknown }[];
}

/** EventBus 构造选项 */
export interface EventBusOptions {
  /** 内核 pino logger；提供时监听器异常经 logger.error 记录（含 event/pattern/handler/err） */
  logger?: import('pino').Logger;
  /** 单模式监听数上限，超过则 process.emitWarning 一次并忽略新订阅；默认 500 */
  maxListenersPerPattern?: number;
}

/** 一条订阅记录 */
interface Subscription {
  handler: EventHandler;
  priority: number;
  once: boolean;
  /** 全局订阅序号：同优先级按此升序投递；匿名 handler 的错误报告序号 */
  seq: number;
}

/** 单个模式下的注册表条目：分段结果缓存 + 该模式的订阅列表（订阅序） */
interface PatternEntry {
  segs: string[];
  subs: Subscription[];
}

/** 单模式监听数默认上限 */
const DEFAULT_MAX_LISTENERS_PER_PATTERN = 500;

/** 事件来源默认值 */
const DEFAULT_SOURCE = 'kernel';

/** 拆 '.' 分段并校验：不允许空串与空分段（'' / 'a..b'） */
function splitSegments(value: string): string[] {
  const segments = value.split('.');
  if (value === '' || segments.some((s) => s === '')) {
    throw err('INTERNAL', {
      message: `[events] 事件名/模式的 '.' 分段不能为空（收到 "${value}"），请检查事件命名`,
    });
  }
  return segments;
}

/**
 * 模式分段与事件分段匹配：
 * - 末段 `**` 直接命中（前面的段已逐一匹配，剩余段数不限，含 0 段）；
 * - `*` 匹配任意单段；其余段必须字面相等；
 * - 循环走完仍需段数相等（无 `**` 兜底时段数不符即不命中）。
 */
function matchSegments(patternSegs: string[], eventSegs: string[]): boolean {
  for (let i = 0; i < patternSegs.length; i++) {
    const seg = patternSegs[i];
    if (seg === '**' && i === patternSegs.length - 1) return true;
    if (i >= eventSegs.length) return false;
    if (seg === '*') continue;
    if (seg !== eventSegs[i]) return false;
  }
  return patternSegs.length === eventSegs.length;
}

/** 内核事件总线：发布订阅、错误隔离、通配、优先级。 */
export class EventBus {
  /** pattern -> 注册表条目 */
  #patterns = new Map<string, PatternEntry>();

  /** 已就"监听数超上限"告警过的 pattern（每 pattern 仅告警一次） */
  #warnedPatterns = new Set<string>();

  #logger: import('pino').Logger | undefined;
  #maxListeners: number;

  /** 全局订阅序号发生器（同优先级投递顺序依据） */
  #seq = 0;

  constructor(opts: EventBusOptions = {}) {
    this.#logger = opts.logger;
    this.#maxListeners = opts.maxListenersPerPattern ?? DEFAULT_MAX_LISTENERS_PER_PATTERN;
  }

  /**
   * 订阅事件模式。
   * @returns 退订函数（幂等，可重复调用）；若该 pattern 监听数已达上限，
   *          本次订阅被忽略并返回 no-op 退订函数（调用方无需特判）。
   */
  on(pattern: string, handler: EventHandler, opts: SubscribeOptions = {}): () => void {
    return this.#subscribe(pattern, handler, opts, false);
  }

  /** 订阅一次性事件：触发一次（含抛错）后自动移除。返回值语义同 on()。 */
  once(pattern: string, handler: EventHandler, opts: SubscribeOptions = {}): () => void {
    return this.#subscribe(pattern, handler, opts, true);
  }

  /**
   * 按 pattern + handler 退订：移除该 handler 在该模式下的全部订阅（含重复订阅）。
   * pattern 或 handler 不存在时为安全 no-op。
   */
  off(pattern: string, handler: EventHandler): void {
    splitSegments(this.#assertString(pattern, 'pattern'));
    if (typeof handler !== 'function') {
      throw err('INTERNAL', { message: '[events] off(): handler 必须是函数' });
    }
    const entry = this.#patterns.get(pattern);
    if (entry === undefined) return;
    const kept = entry.subs.filter((sub) => sub.handler !== handler);
    if (kept.length === entry.subs.length) return;
    if (kept.length === 0) this.#patterns.delete(pattern);
    else entry.subs = kept;
  }

  /**
   * 发布事件：收集全部命中模式下的订阅，按 priority 降序、同优先级按订阅序
   * 顺序 await 投递；单个监听器异常被隔离收集（并提供 logger 时记录），
   * emit 不因监听器异常 reject。
   *
   * @throws HarnessError(INTERNAL) 仅当 name 非法（空串/空分段）或 source 非法
   *   （提供时必须是非空字符串）——属于调用方编程错误，fail-fast。
   */
  async emit(name: string, payload: unknown, opts: { source?: string } = {}): Promise<EmitResult> {
    const eventSegs = splitSegments(this.#assertString(name, '事件名'));
    const source = opts.source ?? DEFAULT_SOURCE;
    if (typeof source !== 'string' || source === '') {
      throw err('INTERNAL', { message: '[events] emit(): opts.source 必须是非空字符串' });
    }

    // 1. 跨模式收集本轮投递列表并排序（之后定格，不受投递过程中增删影响）
    const delivery: Array<{ sub: Subscription; pattern: string }> = [];
    for (const [pattern, entry] of this.#patterns) {
      if (!matchSegments(entry.segs, eventSegs)) continue;
      for (const sub of entry.subs) delivery.push({ sub, pattern });
    }
    delivery.sort((a, b) => b.sub.priority - a.sub.priority || a.sub.seq - b.sub.seq);

    // 2. once 先摘除再投递（对齐 Node EventEmitter：本轮已入列仍会被调用，
    //    但 handler 内再触发同名事件不会重入自身）
    for (const { sub, pattern } of delivery) {
      if (!sub.once) continue;
      const entry = this.#patterns.get(pattern);
      if (entry === undefined) continue;
      const idx = entry.subs.indexOf(sub);
      if (idx !== -1) {
        entry.subs.splice(idx, 1);
        if (entry.subs.length === 0) this.#patterns.delete(pattern);
      }
    }

    // 3. 顺序投递；单点异常隔离，不中断后续监听器
    const meta: EventMeta = Object.freeze({ name, source });
    const errors: EmitResult['errors'] = [];
    let delivered = 0;
    for (const { sub, pattern } of delivery) {
      delivered++;
      const handlerName = sub.handler.name || `anonymous#${sub.seq}`;
      try {
        await sub.handler(payload, meta);
      } catch (e) {
        errors.push({ handler: handlerName, error: e });
        this.#logger?.error(
          { event: name, pattern, handler: handlerName, err: e },
          `[events] event handler failed: ${name} (pattern "${pattern}", handler ${handlerName})`,
        );
      }
    }
    return { delivered, errors };
  }

  /**
   * 统计监听器数量：
   * - 不带参：全部模式订阅总数；
   * - 带参：该 pattern（精确字符串，不做通配匹配）下的订阅数，无则 0。
   */
  listenerCount(pattern?: string): number {
    if (pattern === undefined) {
      let total = 0;
      for (const entry of this.#patterns.values()) total += entry.subs.length;
      return total;
    }
    splitSegments(this.#assertString(pattern, 'pattern'));
    return this.#patterns.get(pattern)?.subs.length ?? 0;
  }

  /** 清空全部订阅（并重置超限告警状态，pattern 重新从零计数）。 */
  clear(): void {
    this.#patterns.clear();
    this.#warnedPatterns.clear();
  }

  // ---- 内部 ----

  /** on()/once() 共用订阅入口：校验 → 超限检查 → 登记 → 返回退订函数 */
  #subscribe(pattern: string, handler: EventHandler, opts: SubscribeOptions, forceOnce: boolean): () => void {
    const segs = splitSegments(this.#assertString(pattern, 'pattern'));
    if (typeof handler !== 'function') {
      throw err('INTERNAL', { message: '[events] on(): handler 必须是函数' });
    }
    const priority = opts.priority ?? 0;
    if (typeof priority !== 'number' || !Number.isFinite(priority)) {
      throw err('INTERNAL', { message: '[events] on(): opts.priority 必须是有限数字' });
    }

    // 超限：每 pattern 仅 process.emitWarning 一次，新订阅一律忽略
    const existing = this.#patterns.get(pattern);
    if (existing !== undefined && existing.subs.length >= this.#maxListeners) {
      if (!this.#warnedPatterns.has(pattern)) {
        this.#warnedPatterns.add(pattern);
        process.emitWarning(
          `[events] pattern "${pattern}" 的监听数已达上限 ${this.#maxListeners}，新订阅被忽略（请用 off()/clear() 释放后再订阅）`,
          'MaxListenersExceededWarning',
        );
      }
      return () => {}; // no-op 退订函数：被忽略的订阅无需退订
    }

    const sub: Subscription = {
      handler,
      priority,
      once: forceOnce || opts.once === true,
      seq: this.#seq++,
    };
    if (existing === undefined) {
      this.#patterns.set(pattern, { segs, subs: [sub] });
    } else {
      existing.subs.push(sub);
    }
    return () => this.#removeSub(pattern, sub);
  }

  /** 按订阅记录身份精确移除一条订阅；列表空则清掉 pattern 条目 */
  #removeSub(pattern: string, sub: Subscription): void {
    const entry = this.#patterns.get(pattern);
    if (entry === undefined) return;
    const idx = entry.subs.indexOf(sub);
    if (idx === -1) return;
    entry.subs.splice(idx, 1);
    if (entry.subs.length === 0) this.#patterns.delete(pattern);
  }

  #assertString(value: string, label: string): string {
    if (typeof value !== 'string') {
      throw err('INTERNAL', { message: `[events] ${label} 必须是字符串（收到 ${typeof value}）` });
    }
    return value;
  }
}
