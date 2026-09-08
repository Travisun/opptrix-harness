/**
 * cron scheduler — 持久化感知的调度器。
 *
 * 职责边界：
 * - 持久化由 `CronJobStoreLike`（CronJobStore 契约）负责，调度器只维护内存堆 + 单 timer；
 * - timer 永远只指向最近的 `nextRun`（单个 setTimeout）；tick 时所有 due 任务依序处理；
 * - fire 流程：`touchRun(lastRun=now, nextRun=下一轮)` → `onFire(ctx)`（store.recordRun 由
 *   onFire 实现方负责）→ 无论成败 nextRun 已推进；onFire 抛错仅 logger.error，不影响其他任务；
 * - overlap='skip'：该 job 在途则跳过本轮（nextRun 照常推进）；'queue'：在途完成后检查 due 补跑；
 * - misfire（start 时 nextRun < now）：'skip'=直接重算并 touchRun；'runOnce'=立即补触发一次；
 * - 时间一律 UTC epoch 存储（ms）。
 *
 * 可测性：`deps.now` 可注入时钟；`scheduleTimer(delayMs)` 为受保护方法，测试可子类覆写为
 * 手动驱动（见 test/cron-scheduler.test.ts 的手动时钟模式），避免分钟级真实等待。
 */
import { randomUUID } from 'node:crypto';

import type { Logger } from 'pino';

import { err } from '../errors/index.js';
import { nextCronRun, validateCron } from './parser.js';

/** cron 任务持久化记录（时间字段均为 UTC epoch ms；无触发时刻时为 null） */
export interface CronJobRecord {
  id: string;
  /** 扩展侧幂等标识（可选；list 可按其过滤） */
  extId: string | null;
  name: string;
  /** cron 表达式（5 字段或 @别名） */
  expr: string;
  /** IANA 时区 */
  tz: string;
  payload: unknown;
  enabled: boolean;
  /** 在途重叠策略：skip=跳过本轮；queue=在途结束后补跑 */
  overlap: 'skip' | 'queue';
  /** 错过触发策略：skip=直接重算；runOnce=立即补触发一次 */
  misfire: 'skip' | 'runOnce';
  lastRun: number | null;
  nextRun: number | null;
  createdAt: number;
}

/** fire 回调上下文（job 为触发时刻的记录快照） */
export interface CronFireContext {
  job: CronJobRecord;
  startedAt: number;
}

/** store 契约（由 CronJobStore 提供实现；时间一律 UTC epoch ms） */
export interface CronJobStoreLike {
  create(rec: CronJobRecord): Promise<void>;
  update(id: string, patch: Partial<CronJobRecord>): Promise<CronJobRecord | null>;
  delete(id: string): Promise<boolean>;
  get(id: string): Promise<CronJobRecord | null>;
  list(opts?: { extId?: string }): Promise<CronJobRecord[]>;
  setEnabled(id: string, enabled: boolean): Promise<CronJobRecord | null>;
  touchRun(id: string, patch: { lastRun: number | null; nextRun: number | null }): Promise<void>;
}

export interface CronSchedulerDeps {
  store: CronJobStoreLike;
  logger: Logger;
  /** 未显式指定 tz 时的默认时区（IANA） */
  defaultTimezone: string;
  /** fire 回调（store.recordRun 等持久化由实现方负责） */
  onFire(ctx: CronFireContext): Promise<void>;
  /** 可选：时钟注入（测试用）。默认 `() => new Date()` */
  now?: () => Date;
}

export interface CronScheduleInput {
  extId?: string | null;
  name: string;
  expr: string;
  tz?: string;
  payload?: unknown;
  enabled?: boolean;
  overlap?: 'skip' | 'queue';
  misfire?: 'skip' | 'runOnce';
}

/** stop 等待在途 fire 的有界时长（ms），超时后放弃等待但不再阻 stop */
const STOP_DRAIN_TIMEOUT_MS = 10_000;

export class CronScheduler {
  protected readonly deps: CronSchedulerDeps;

  /** 内存态任务表（含 disabled；list/get 的数据源） */
  #jobs = new Map<string, CronJobRecord>();
  /** 在途 fire：jobId -> 完成门闩（stop 用它等待排空） */
  #running = new Map<string, Promise<void>>();
  /** runNow 对在途 queue-overlap 任务的排队标记（在途完成后补跑一次） */
  #queued = new Set<string>();
  /** 唯一 timer（指向最近 nextRun） */
  #timer: NodeJS.Timeout | null = null;
  #started = false;
  /** tick 串行化：防重入 + 尾随补一轮 */
  #ticking = false;
  #tickQueued = false;

  constructor(deps: CronSchedulerDeps) {
    this.deps = deps;
  }

  /** 当前时钟（可注入） */
  #now(): number {
    return (this.deps.now?.() ?? new Date()).getTime();
  }

  /**
   * 启动：从 store 载入全部任务，对 enabled 且 nextRun 已过期者按 misfire 策略处理
   * （skip=重算 nextRun；runOnce=立即补触发一次），然后建堆起 timer。
   * stop 后可重复调用。
   */
  async start(): Promise<void> {
    const all = await this.deps.store.list();
    this.#jobs = new Map(all.map((rec) => [rec.id, { ...rec }]));
    const nowMs = this.#now();
    for (const job of this.#jobs.values()) {
      if (!job.enabled) continue;
      if (job.nextRun !== null && job.nextRun < nowMs) {
        if (job.misfire === 'skip') {
          // 错过的不再补：直接把 nextRun 重算到未来
          await this.#advanceNextRun(job, nowMs);
        } else {
          // runOnce：立即补触发一次（fire 流程自身会重算并 touchRun）
          this.#launchFire(job);
        }
      }
    }
    this.#started = true;
    this.#rearm();
  }

  /**
   * 停止：清除 timer；等待在途 fire 排空（有界 10s，超时放弃等待但不阻 stop）。
   * stop 后 start 可重复。
   */
  async stop(): Promise<void> {
    this.#started = false;
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    const inflight = [...this.#running.values()];
    if (inflight.length === 0) return;
    await Promise.race([
      Promise.allSettled(inflight),
      new Promise<void>((resolve) => {
        const t = setTimeout(resolve, STOP_DRAIN_TIMEOUT_MS);
        // 超时兜底 timer 不应阻止进程退出
        t.unref?.();
      }),
    ]);
  }

  /** 重读 store 重建内存堆（保留在途 fire）；未启动时只刷新内存不建 timer */
  async reload(): Promise<void> {
    const all = await this.deps.store.list();
    this.#jobs = new Map(all.map((rec) => [rec.id, { ...rec }]));
    this.#queued.clear();
    if (this.#started) this.#rearm();
  }

  /** 创建并注册 cron 任务：校验表达式/时区 → 持久化 → 入堆 */
  async schedule(input: CronScheduleInput): Promise<CronJobRecord> {
    if (typeof input.name !== 'string' || input.name.trim() === '') {
      throw err('BAD_REQUEST', { detail: { field: 'name', cause: 'name must be a non-empty string' } });
    }
    const tz = input.tz ?? this.deps.defaultTimezone;
    validateCron(input.expr, tz);
    const nowMs = this.#now();
    const next = nextCronRun(input.expr, tz, new Date(nowMs));
    const rec: CronJobRecord = {
      id: randomUUID(),
      extId: input.extId ?? null,
      name: input.name,
      expr: input.expr,
      tz,
      payload: input.payload,
      enabled: input.enabled ?? true,
      overlap: input.overlap ?? 'skip',
      misfire: input.misfire ?? 'skip',
      lastRun: null,
      nextRun: next ? next.getTime() : null,
      createdAt: nowMs,
    };
    await this.deps.store.create(rec);
    this.#jobs.set(rec.id, { ...rec });
    this.#rearm();
    return { ...rec };
  }

  /** 移除任务：出堆 + 删库。返回是否确有删除 */
  async unschedule(id: string): Promise<boolean> {
    const deleted = await this.deps.store.delete(id);
    if (!deleted) return false;
    this.#jobs.delete(id);
    this.#queued.delete(id);
    this.#rearm();
    return true;
  }

  /** 启用/禁用任务。重新启用时若 nextRun 已过期，按 misfire 策略处理 */
  async setEnabled(id: string, enabled: boolean): Promise<CronJobRecord | null> {
    const rec = await this.deps.store.setEnabled(id, enabled);
    if (!rec) return null;
    this.#jobs.set(rec.id, { ...rec });
    if (enabled && rec.enabled && this.#started && !this.#running.has(id)) {
      const nowMs = this.#now();
      if (rec.nextRun !== null && rec.nextRun < nowMs) {
        if (rec.misfire === 'skip') {
          await this.#advanceNextRun(rec, nowMs);
        } else {
          this.#launchFire(rec);
        }
      }
    }
    this.#rearm();
    return { ...rec };
  }

  /**
   * 更新任务（name/expr/tz/payload/overlap/misfire）。
   * expr 或 tz 变更时：先整体校验，再重算 nextRun 并重排堆。
   */
  async update(
    id: string,
    patch: { name?: string; expr?: string; tz?: string; payload?: unknown; overlap?: 'skip' | 'queue'; misfire?: 'skip' | 'runOnce' },
  ): Promise<CronJobRecord | null> {
    const current = this.#jobs.get(id) ?? (await this.deps.store.get(id));
    if (!current) return null;

    const effective: Partial<CronJobRecord> = { ...patch };
    if (patch.expr !== undefined || patch.tz !== undefined) {
      const expr = patch.expr ?? current.expr;
      const tz = patch.tz ?? current.tz;
      validateCron(expr, tz);
      const next = nextCronRun(expr, tz, new Date(this.#now()));
      effective.nextRun = next ? next.getTime() : null;
    }
    const rec = await this.deps.store.update(id, effective);
    if (!rec) return null;
    this.#jobs.set(rec.id, { ...rec });
    this.#rearm();
    return { ...rec };
  }

  /** 内存态快照（拷贝），可按 extId 过滤 */
  list(opts?: { extId?: string }): CronJobRecord[] {
    const all = [...this.#jobs.values()].map((rec) => ({ ...rec }));
    if (opts?.extId === undefined) return all;
    return all.filter((rec) => rec.extId === opts.extId);
  }

  /** 内存态单条快照（拷贝） */
  get(id: string): CronJobRecord | null {
    const rec = this.#jobs.get(id);
    return rec ? { ...rec } : null;
  }

  /**
   * 立即触发：走与 timer 相同的 fire 流程（绕过堆的 due 判断，但不绕过 overlap）。
   * - overlap='skip' 且在途：不执行；
   * - overlap='queue' 且在途：排队，在途结束后补跑一次。
   */
  async runNow(id: string): Promise<void> {
    const job = this.#jobs.get(id);
    if (!job) {
      throw err('BAD_REQUEST', { detail: { id, cause: 'cron job not found' } });
    }
    if (this.#running.has(id)) {
      if (job.overlap === 'queue') this.#queued.add(id);
      return;
    }
    await this.#executeFire(job);
  }

  /** 在途 jobId 列表 */
  running(): string[] {
    return [...this.#running.keys()];
  }

  // ---------------------------------------------------------------- 内部实现

  /**
   * 建唯一 timer：指向所有 enabled 任务中最近的 nextRun。
   * 测试可覆写本方法以手动驱动 tick（croner 最小粒度为分钟，真实等待不可测）。
   */
  protected scheduleTimer(delayMs: number): void {
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.tick();
    }, delayMs);
    // 库组件不应阻止进程退出
    this.#timer.unref?.();
  }

  /** 清除并重算 timer（未启动时不建） */
  #rearm(): void {
    if (!this.#started) return;
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    const nowMs = this.#now();
    let nearest: number | null = null;
    for (const job of this.#jobs.values()) {
      if (!job.enabled || job.nextRun === null) continue;
      if (nearest === null || job.nextRun < nearest) nearest = job.nextRun;
    }
    if (nearest === null) return;
    this.scheduleTimer(Math.max(0, nearest - nowMs));
  }

  /** 推进某任务的 nextRun（重算并持久化；lastRun 不变） */
  async #advanceNextRun(job: CronJobRecord, fromMs: number): Promise<void> {
    const next = nextCronRun(job.expr, job.tz, new Date(fromMs));
    const nextRun = next ? next.getTime() : null;
    try {
      await this.deps.store.touchRun(job.id, { lastRun: job.lastRun, nextRun });
    } catch (e) {
      this.#logError(e, job.id, 'touchRun(misfire/overlap advance) failed');
    }
    job.nextRun = nextRun;
    const mem = this.#jobs.get(job.id);
    if (mem) mem.nextRun = nextRun;
  }

  /**
   * tick：处理当前所有 due（nextRun <= now）的 enabled 任务，依序处理。
   * - overlap='skip' 且在途：跳过本轮，nextRun 照常推进；
   * - overlap='queue' 且在途：什么都不做——在途 fire 完成后的 #afterFire 会检查 due 补跑；
   * - 其余：启动 fire 流程（不等待其完成，避免慢 onFire 阻塞其他任务）。
   */
  protected async tick(): Promise<void> {
    if (!this.#started) return;
    if (this.#ticking) {
      this.#tickQueued = true;
      return;
    }
    this.#ticking = true;
    try {
      do {
        this.#tickQueued = false;
        const nowMs = this.#now();
        const due = [...this.#jobs.values()]
          .filter((job) => job.enabled && job.nextRun !== null && job.nextRun <= nowMs)
          .sort((a, b) => (a.nextRun ?? 0) - (b.nextRun ?? 0));
        for (const job of due) {
          if (this.#running.has(job.id)) {
            if (job.overlap === 'skip') {
              await this.#advanceNextRun(job, nowMs); // 跳过本轮，nextRun 照常推进
            }
            continue; // queue：交给 #afterFire 的 due 检查补跑
          }
          this.#launchFire(job);
        }
      } while (this.#tickQueued);
    } finally {
      this.#ticking = false;
    }
  }

  /** 启动 fire 流程（异步，不等待；生命周期由 #running 跟踪） */
  #launchFire(job: CronJobRecord): void {
    void this.#executeFire(job);
  }

  /**
   * fire 流程：touchRun(lastRun=now, nextRun=下一轮) → onFire(ctx)。
   * nextRun 在 onFire 之前推进并持久化——无论 onFire 成败都不会重复触发同一轮。
   * onFire 抛错仅 logger.error。完成后 #afterFire 处理 queue 补跑与重排 timer。
   */
  async #executeFire(snapshot: CronJobRecord): Promise<void> {
    const startedAt = this.#now();
    // 同步占位 running 集：tick / runNow / setEnabled 的重入判断即时生效
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#running.set(snapshot.id, gate);
    try {
      const next = nextCronRun(snapshot.expr, snapshot.tz, new Date(startedAt));
      const nextRun = next ? next.getTime() : null;
      try {
        await this.deps.store.touchRun(snapshot.id, { lastRun: startedAt, nextRun });
      } catch (e) {
        this.#logError(e, snapshot.id, 'touchRun(fire) failed');
      }
      const mem = this.#jobs.get(snapshot.id);
      if (mem) {
        mem.lastRun = startedAt;
        mem.nextRun = nextRun;
      }
      try {
        await this.deps.onFire({ job: { ...(mem ?? snapshot) }, startedAt });
      } catch (e) {
        this.#logError(e, snapshot.id, 'onFire handler failed');
      }
    } catch (e) {
      // nextCronRun 等前置步骤失败：不致命，不影响其他任务
      this.#logError(e, snapshot.id, 'fire flow failed');
    } finally {
      this.#running.delete(snapshot.id);
      release();
      this.#afterFire(snapshot.id);
    }
  }

  /** fire 完成后：queue 补跑检查（排队标记或 due）+ 重排 timer */
  #afterFire(id: string): void {
    const job = this.#jobs.get(id);
    const wasQueued = this.#queued.has(id);
    const due = job !== undefined && job.enabled && job.nextRun !== null && job.nextRun <= this.#now();
    if (job !== undefined && job.enabled && job.overlap === 'queue' && (wasQueued || due)) {
      this.#queued.delete(id);
      // 补跑一轮；其 touchRun 会把 nextRun 推进到 now 之后，链必然收敛
      this.#launchFire(job);
      return;
    }
    if (wasQueued) this.#queued.delete(id); // 任务已删/禁用/非 queue：排队标记作废
    this.#rearm();
  }

  #logError(e: unknown, jobId: string, msg: string): void {
    this.deps.logger.error(
      { err: e instanceof Error ? { message: e.message, stack: e.stack } : e, jobId },
      `cron: ${msg}`,
    );
  }
}
