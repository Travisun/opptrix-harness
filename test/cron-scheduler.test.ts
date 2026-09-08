/**
 * cron scheduler（src/kernel/cron/scheduler.ts）单测。
 *
 * 可测性设计：croner 最小粒度为分钟，真实等待不可测——
 * 测试用 `deps.now` 注入手动时钟，并子类覆写受保护的 `scheduleTimer` 为"仅记录延迟、不建真实 timer"，
 * 由测试显式 `seekTo/advance` 推进时钟并驱动 tick（全流程微任务级，无真实等待）。
 *
 * 覆盖点：schedule 形状与持久化 / 非法入参 BAD_REQUEST / tick 触发与状态推进 /
 * onFire 抛错隔离 / overlap skip 与 queue / runNow（绕堆不绕 overlap）/
 * stop 有界等待在途 + stop 后可重启 / misfire skip 与 runOnce / reload 拾取 /
 * update 重算 nextRun / setEnabled / list-get 过滤 / unschedule。
 */
import { randomUUID } from 'node:crypto';

import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';

import { HarnessError } from '../src/kernel/errors/index.js';
import {
  CronScheduler,
  type CronFireContext,
  type CronJobRecord,
  type CronJobStoreLike,
  type CronSchedulerDeps,
} from '../src/kernel/cron/scheduler.js';

/** 基准时刻：2026-01-01T00:00:00.500Z（故意带 500ms 偏移，非分钟对齐） */
const BASE = Date.UTC(2026, 0, 1, 0, 0, 0, 500);
/** 每分钟边界：b1=00:01:00Z、b2=00:02:00Z、b3=00:03:00Z、b4=00:04:00Z */
const MIN = 60_000;
const b1 = BASE + 59_500;
const b2 = BASE + 119_500;
const b3 = BASE + 179_500;
const b4 = BASE + 239_500;

/** 推进一个宏任务边界：排空全部挂起的微任务（store/onFire/fire 链全为微任务） */
const settle = (): Promise<void> => new Promise<void>((resolve) => { setTimeout(resolve, 0); });

/** 断言 Promise 抛 BAD_REQUEST（HARNESS-1008）并返回该错误 */
async function expectBadReq(fn: () => Promise<unknown>): Promise<HarnessError> {
  try {
    await fn();
  } catch (e) {
    expect(e).toBeInstanceOf(HarnessError);
    const he = e as HarnessError;
    expect(he.code).toBe('HARNESS-1008');
    expect(he.status).toBe(400);
    return he;
  }
  throw new Error('expected a BAD_REQUEST throw, but nothing was thrown');
}

/** 内存 Map 实现的 store stub（拷贝语义与真实 DB 对齐） */
class MemStore implements CronJobStoreLike {
  #map = new Map<string, CronJobRecord>();

  async create(rec: CronJobRecord): Promise<void> {
    this.#map.set(rec.id, { ...rec });
  }

  async update(id: string, patch: Partial<CronJobRecord>): Promise<CronJobRecord | null> {
    const cur = this.#map.get(id);
    if (!cur) return null;
    const next = { ...cur, ...patch };
    this.#map.set(id, next);
    return { ...next };
  }

  async delete(id: string): Promise<boolean> {
    return this.#map.delete(id);
  }

  async get(id: string): Promise<CronJobRecord | null> {
    const cur = this.#map.get(id);
    return cur ? { ...cur } : null;
  }

  async list(opts?: { extId?: string }): Promise<CronJobRecord[]> {
    let all = [...this.#map.values()].map((rec) => ({ ...rec }));
    if (opts?.extId !== undefined) all = all.filter((rec) => rec.extId === opts.extId);
    return all;
  }

  async setEnabled(id: string, enabled: boolean): Promise<CronJobRecord | null> {
    const cur = this.#map.get(id);
    if (!cur) return null;
    cur.enabled = enabled;
    this.#map.set(id, { ...cur });
    return { ...cur };
  }

  async touchRun(id: string, patch: { lastRun: number | null; nextRun: number | null }): Promise<void> {
    const cur = this.#map.get(id);
    if (cur) this.#map.set(id, { ...cur, ...patch });
  }

  rows(): CronJobRecord[] {
    return [...this.#map.values()].map((rec) => ({ ...rec }));
  }

  row(id: string): CronJobRecord | null {
    const cur = this.#map.get(id);
    return cur ? { ...cur } : null;
  }
}

/** 静音且可断言的 logger stub */
function makeLogger(): Logger {
  return {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
  } as unknown as Logger;
}

/**
 * 测试调度器：覆写 scheduleTimer 为"记录延迟、不建真实 timer"（手动驱动模式），
 * 并暴露 seekTo/advance 推进注入时钟后同步驱动 tick。
 */
class TestScheduler extends CronScheduler {
  /** 每次建 timer 的延迟记录（断言 #rearm 的"指向最近 nextRun"语义） */
  timerDelays: number[] = [];
  #clock: { ms: number };

  constructor(deps: CronSchedulerDeps, clock: { ms: number }) {
    super(deps);
    this.#clock = clock;
  }

  protected override scheduleTimer(delayMs: number): void {
    this.timerDelays.push(delayMs);
  }

  nowMs(): number {
    return this.#clock.ms;
  }

  /** 绝对跳时刻并驱动一轮 tick + 微任务排空 */
  async seekTo(ms: number): Promise<void> {
    this.#clock.ms = ms;
    await this.tick();
    await settle();
  }

  /** 相对推进 */
  async advance(ms: number): Promise<void> {
    return this.seekTo(this.#clock.ms + ms);
  }
}

/** 组装被测调度器（内存 store + 注入手动时钟 + 可替换 onFire） */
function makeScheduler(opts: {
  onFire?: (ctx: CronFireContext) => Promise<void>;
  store?: MemStore;
  defaultTimezone?: string;
} = {}) {
  const clock = { ms: BASE };
  const store = opts.store ?? new MemStore();
  const logger = makeLogger();
  const onFire = opts.onFire ?? (async () => {});
  const sched = new TestScheduler(
    { store, logger, defaultTimezone: opts.defaultTimezone ?? 'UTC', onFire, now: () => new Date(clock.ms) },
    clock,
  );
  return { sched, store, logger, onFire };
}

/** 记录调用并返回手动门闩的 onFire（每轮 fire 挂起，测试显式放行） */
function gatedOnFire() {
  const calls: CronFireContext[] = [];
  const gates: Array<{ promise: Promise<void>; resolve: () => void }> = [];
  const onFire = vi.fn((ctx: CronFireContext): Promise<void> => {
    calls.push(ctx);
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    gates.push({ promise, resolve });
    return promise;
  });
  return { onFire, calls, gates };
}

/** 直接构造持久化记录（预置 store 场景用） */
function makeRecord(over: Partial<CronJobRecord> = {}): CronJobRecord {
  return {
    id: randomUUID(),
    extId: null,
    name: 'pre-seeded',
    expr: '* * * * *',
    tz: 'UTC',
    payload: null,
    enabled: true,
    overlap: 'skip',
    misfire: 'skip',
    lastRun: null,
    nextRun: null,
    createdAt: BASE,
    ...over,
  };
}

describe('CronScheduler', () => {
  it('schedule：默认值正确、nextRun 指向下一分钟边界、持久化并入内存、timer 指向最近 nextRun', async () => {
    const { sched, store } = makeScheduler();
    const rec = await sched.schedule({ name: 'job-1', expr: '* * * * *' });
    expect(rec.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(rec.name).toBe('job-1');
    expect(rec.expr).toBe('* * * * *');
    expect(rec.tz).toBe('UTC'); // 默认时区
    expect(rec.enabled).toBe(true);
    expect(rec.overlap).toBe('skip');
    expect(rec.misfire).toBe('skip');
    expect(rec.lastRun).toBeNull();
    expect(rec.nextRun).toBe(b1);
    expect(rec.createdAt).toBe(BASE);
    // 持久化 + 内存一致
    expect(store.rows()).toHaveLength(1);
    expect(sched.get(rec.id)).toEqual(rec);
    // start 后 timer 指向最近 nextRun：b1 - BASE = 59.5s
    await sched.start();
    expect(sched.timerDelays).toEqual([59_500]);
  });

  it('schedule：非法表达式抛 BAD_REQUEST 且不落库', async () => {
    const { sched, store } = makeScheduler();
    const he = await expectBadReq(() => sched.schedule({ name: 'bad', expr: 'not a cron' }));
    expect((he.detail as { expr: string }).expr).toBe('not a cron');
    expect(store.rows()).toHaveLength(0);
    expect(sched.list()).toHaveLength(0);
  });

  it('schedule：非法时区抛 BAD_REQUEST 且不落库；空 name 同样拒绝', async () => {
    const { sched, store } = makeScheduler();
    await expectBadReq(() => sched.schedule({ name: 'bad-tz', expr: '* * * * *', tz: 'No/Such/Zone' }));
    await expectBadReq(() => sched.schedule({ name: '   ', expr: '* * * * *' }));
    expect(store.rows()).toHaveLength(0);
  });

  it('tick：边界触发 onFire、touchRun 推进 lastRun/nextRun（内存+store）、running 清空、timer 重排', async () => {
    const fired: CronFireContext[] = [];
    const { sched, store } = makeScheduler({ onFire: async (ctx) => { fired.push(ctx); } });
    const rec = await sched.schedule({ name: 'job-1', expr: '* * * * *' });
    await sched.start();
    await sched.seekTo(b1);
    expect(fired).toHaveLength(1);
    expect(fired[0]!.job.id).toBe(rec.id);
    expect(fired[0]!.startedAt).toBe(b1);
    expect(fired[0]!.job.nextRun).toBe(b2); // ctx 快照里已推进
    expect(sched.running()).toEqual([]);
    // 内存与 store 都推进
    expect(sched.get(rec.id)!.lastRun).toBe(b1);
    expect(sched.get(rec.id)!.nextRun).toBe(b2);
    expect(store.row(rec.id)).toMatchObject({ lastRun: b1, nextRun: b2 });
    // timer 重排到 b2
    expect(sched.timerDelays.at(-1)).toBe(60_000);
  });

  it('多个 due 任务依序处理；onFire 抛错仅 logger.error，不影响其他任务', async () => {
    const onFire = vi.fn(async (ctx: CronFireContext) => {
      if (ctx.job.name === 'bad-job') throw new Error('boom-a');
    });
    const { sched, logger } = makeScheduler({ onFire });
    const a = await sched.schedule({ name: 'bad-job', expr: '* * * * *' });
    const c = await sched.schedule({ name: 'good-job', expr: '* * * * *' });
    await sched.start();
    await sched.seekTo(b1);
    expect(onFire).toHaveBeenCalledTimes(2);
    expect(sched.get(a.id)!.lastRun).toBe(b1);
    expect(sched.get(c.id)!.lastRun).toBe(b1);
    expect(logger.error).toHaveBeenCalledTimes(1);
    const logArg = (logger.error as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as { jobId: string };
    expect(logArg.jobId).toBe(a.id);
  });

  it("overlap='skip'：在途跳过本轮、nextRun 照常推进、结束后不补跑", async () => {
    const { onFire, calls, gates } = gatedOnFire();
    const { sched, store } = makeScheduler({ onFire });
    const rec = await sched.schedule({ name: 'skip-job', expr: '* * * * *', overlap: 'skip' });
    await sched.start();
    await sched.seekTo(b1); // 第 1 轮 fire（挂起）
    expect(sched.running()).toEqual([rec.id]);
    await sched.seekTo(b2); // 第 2 轮 due 但在途 → 跳过，nextRun 推进到 b3
    expect(calls).toHaveLength(1);
    expect(sched.get(rec.id)!.nextRun).toBe(b3);
    expect(store.row(rec.id)).toMatchObject({ lastRun: b1, nextRun: b3 }); // lastRun 不变
    gates[0]!.resolve();
    await settle();
    expect(calls).toHaveLength(1); // 不补跑
    await sched.seekTo(b3); // b3 边界正常触发下一轮
    expect(calls).toHaveLength(2);
    gates[1]!.resolve();
  });

  it("overlap='queue'：在途完成后检查 due 并立即补跑，链收敛不死循环", async () => {
    const { onFire, calls, gates } = gatedOnFire();
    const { sched } = makeScheduler({ onFire });
    const rec = await sched.schedule({ name: 'queue-job', expr: '* * * * *', overlap: 'queue' });
    await sched.start();
    await sched.seekTo(b1); // 第 1 轮 fire（挂起），nextRun=b2
    await sched.seekTo(b2); // due 但在途 → 等
    await sched.seekTo(b3); // 仍 due（nextRun=b2 未被推进）→ 等
    expect(calls).toHaveLength(1);
    gates[0]!.resolve();
    await settle();
    // 上一轮结束后立即补跑一轮
    expect(calls).toHaveLength(2);
    expect(sched.get(rec.id)!.lastRun).toBe(b3);
    expect(sched.get(rec.id)!.nextRun).toBe(b4); // 补跑推进到未来，链收敛
    gates[1]!.resolve();
    await settle();
    expect(calls).toHaveLength(2); // 不再继续
  });

  it('runNow：立即走 fire 流程（不等 tick），lastRun/nextRun 照常推进', async () => {
    const fired: CronFireContext[] = [];
    const { sched, store } = makeScheduler({ onFire: async (ctx) => { fired.push(ctx); } });
    const rec = await sched.schedule({ name: 'manual', expr: '* * * * *' });
    await sched.runNow(rec.id); // 时钟仍在 BASE，未到任何边界
    expect(fired).toHaveLength(1);
    expect(fired[0]!.startedAt).toBe(BASE);
    expect(sched.get(rec.id)).toMatchObject({ lastRun: BASE, nextRun: b1 });
    expect(store.row(rec.id)).toMatchObject({ lastRun: BASE, nextRun: b1 });
    expect(sched.running()).toEqual([]);
  });

  it('runNow：不绕过 overlap（skip 在途直接跳过 / queue 在途排队补跑）；未知 id 抛 BAD_REQUEST', async () => {
    // skip：在途时不执行
    {
      const { onFire, calls, gates } = gatedOnFire();
      const { sched } = makeScheduler({ onFire });
      const rec = await sched.schedule({ name: 'rn-skip', expr: '* * * * *', overlap: 'skip' });
      await sched.start();
      await sched.seekTo(b1);
      await sched.runNow(rec.id);
      expect(calls).toHaveLength(1);
      gates[0]!.resolve();
      await settle();
    }
    // queue：在途时排队，上一轮结束后补跑
    {
      const { onFire, calls, gates } = gatedOnFire();
      const { sched } = makeScheduler({ onFire });
      const rec = await sched.schedule({ name: 'rn-queue', expr: '* * * * *', overlap: 'queue' });
      await sched.start();
      await sched.seekTo(b1);
      await sched.runNow(rec.id); // 排队
      expect(calls).toHaveLength(1);
      gates[0]!.resolve();
      await settle();
      expect(calls).toHaveLength(2); // 补跑一次
      gates[1]!.resolve();
      await settle();
    }
    // 未知 id
    const { sched } = makeScheduler();
    await expectBadReq(() => sched.runNow('missing-id'));
  });

  it('stop：有界等待在途 fire 排空；stop 后 tick 不再触发', async () => {
    const { onFire, calls, gates } = gatedOnFire();
    const { sched } = makeScheduler({ onFire });
    const rec = await sched.schedule({ name: 'drain', expr: '* * * * *' });
    await sched.start();
    await sched.seekTo(b1);
    expect(sched.running()).toEqual([rec.id]);

    let stopped = false;
    const stopPromise = sched.stop().then(() => { stopped = true; });
    await settle();
    expect(stopped).toBe(false); // 在途未完成，stop 仍在等待（未到 10s 上限）

    gates[0]!.resolve();
    await stopPromise;
    expect(stopped).toBe(true);
    expect(sched.running()).toEqual([]);

    await sched.seekTo(b2);
    expect(calls).toHaveLength(1); // stop 后不再触发
  });

  it('stop 后 start 可重复：重新载入 store 状态并恢复触发', async () => {
    const fired: CronFireContext[] = [];
    const { sched, store } = makeScheduler({ onFire: async (ctx) => { fired.push(ctx); } });
    const rec = await sched.schedule({ name: 'restart', expr: '* * * * *' });
    await sched.start();
    await sched.seekTo(b1);
    expect(fired).toHaveLength(1);
    await sched.stop();
    await sched.seekTo(b2);
    expect(fired).toHaveLength(1);

    await sched.start(); // 重启：从 store 载入（lastRun=b1, nextRun=b2）
    expect(sched.get(rec.id)).toMatchObject({ lastRun: b1, nextRun: b2 });
    expect(sched.timerDelays.at(-1)).toBe(0); // nextRun 恰为当前时刻 → 立即 tick
    await sched.seekTo(b2);
    expect(fired).toHaveLength(2);
    expect(fired[1]!.job.id).toBe(rec.id);
    expect(store.row(rec.id)).toMatchObject({ lastRun: b2, nextRun: b3 });
  });

  it("misfire='skip'：start 时过期 nextRun 直接重算，不补触发", async () => {
    const fired: CronFireContext[] = [];
    const store = new MemStore();
    await store.create(makeRecord({ id: 'm-skip', nextRun: BASE - 90_000, misfire: 'skip' }));
    const { sched } = makeScheduler({ store, onFire: async (ctx) => { fired.push(ctx); } });
    await sched.start();
    expect(fired).toHaveLength(0); // 不补触发
    expect(store.row('m-skip')).toMatchObject({ lastRun: null, nextRun: b1 }); // 仅重算
    await sched.seekTo(b1);
    expect(fired).toHaveLength(1); // 未来边界正常触发
  });

  it("misfire='runOnce'：start 时立即补触发一次并重算 nextRun", async () => {
    const { onFire, calls, gates } = gatedOnFire();
    const store = new MemStore();
    await store.create(makeRecord({ id: 'm-runonce', nextRun: BASE - 90_000, misfire: 'runOnce' }));
    const { sched } = makeScheduler({ store, onFire });
    await sched.start();
    await settle();
    expect(calls).toHaveLength(1); // 立即补触发一次
    expect(store.row('m-runonce')).toMatchObject({ lastRun: BASE, nextRun: b1 });
    expect(sched.running()).toEqual(['m-runonce']);
    gates[0]!.resolve();
    await settle();
    expect(calls).toHaveLength(1); // 仅一次
    await sched.seekTo(b1);
    expect(calls).toHaveLength(2); // 之后恢复正常节律
    gates[1]!.resolve();
  });

  it('reload：拾取 store 中绕过调度器新增的任务', async () => {
    const fired: CronFireContext[] = [];
    const { sched, store } = makeScheduler({ onFire: async (ctx) => { fired.push(ctx); } });
    await sched.schedule({ name: 'existing', expr: '* * * * *' });
    await sched.start();
    // 绕过调度器直接写 store
    await store.create(makeRecord({ id: 'extra', name: 'extra', nextRun: b1 }));
    expect(sched.get('extra')).toBeNull();
    await sched.reload();
    expect(sched.get('extra')).toMatchObject({ name: 'extra', nextRun: b1 });
    await sched.seekTo(b1);
    expect(fired.map((c) => c.job.name).sort()).toEqual(['existing', 'extra']);
  });

  it('update：expr 变更重算 nextRun 并重排触发', async () => {
    const fired: CronFireContext[] = [];
    const { sched, store } = makeScheduler({ onFire: async (ctx) => { fired.push(ctx); } });
    const rec = await sched.schedule({ name: 'up-expr', expr: '* * * * *' });
    await sched.start();
    expect(rec.nextRun).toBe(b1);
    const updated = await sched.update(rec.id, { expr: '30 12 * * *' });
    expect(updated!.nextRun).toBe(Date.UTC(2026, 0, 1, 12, 30, 0)); // 当天 12:30Z
    expect(store.row(rec.id)!.nextRun).toBe(Date.UTC(2026, 0, 1, 12, 30, 0));
    await sched.seekTo(b1);
    expect(fired).toHaveLength(0); // 原边界不再触发
    await sched.seekTo(Date.UTC(2026, 0, 1, 12, 30, 0));
    expect(fired).toHaveLength(1);
  });

  it('update：tz 变更重算 nextRun（UTC → Asia/Shanghai）', async () => {
    const { sched, store } = makeScheduler({ defaultTimezone: 'UTC' });
    const rec = await sched.schedule({ name: 'up-tz', expr: '0 12 * * *' });
    expect(rec.nextRun).toBe(Date.UTC(2026, 0, 1, 12, 0, 0));
    const updated = await sched.update(rec.id, { tz: 'Asia/Shanghai' });
    expect(updated!.nextRun).toBe(Date.UTC(2026, 0, 1, 4, 0, 0)); // 本地钟面 12:00+08
    expect(store.row(rec.id)).toMatchObject({ tz: 'Asia/Shanghai', nextRun: Date.UTC(2026, 0, 1, 4, 0, 0) });
  });

  it('update：非法 expr 抛 BAD_REQUEST 且不改库；未知 id 返回 null', async () => {
    const { sched, store } = makeScheduler();
    const rec = await sched.schedule({ name: 'up-bad', expr: '* * * * *' });
    const before = store.row(rec.id);
    await expectBadReq(() => sched.update(rec.id, { expr: 'garbage expr' }));
    expect(store.row(rec.id)).toEqual(before);
    expect(await sched.update('missing-id', { name: 'x' })).toBeNull();
  });

  it('setEnabled：disable 后不再触发，enable 恢复；未知 id 返回 null', async () => {
    const fired: CronFireContext[] = [];
    const { sched, store } = makeScheduler({ onFire: async (ctx) => { fired.push(ctx); } });
    const rec = await sched.schedule({ name: 'toggle', expr: '* * * * *' });
    await sched.start();
    expect((await sched.setEnabled(rec.id, false))!.enabled).toBe(false);
    expect(store.row(rec.id)!.enabled).toBe(false);
    await sched.seekTo(b1);
    expect(fired).toHaveLength(0); // 禁用不触发
    expect((await sched.setEnabled(rec.id, true))!.enabled).toBe(true);
    await sched.seekTo(b2);
    expect(fired).toHaveLength(1); // 重新启用后恢复
    expect(await sched.setEnabled('missing-id', true)).toBeNull();
  });

  it('list/get：按 extId 过滤，返回内存快照拷贝', async () => {
    const { sched } = makeScheduler();
    const a = await sched.schedule({ name: 'a', expr: '* * * * *', extId: 'ext-a' });
    await sched.schedule({ name: 'b', expr: '* * * * *', extId: 'ext-b' });
    await sched.schedule({ name: 'c', expr: '* * * * *' });
    expect(sched.list()).toHaveLength(3);
    expect(sched.list({ extId: 'ext-a' }).map((r) => r.id)).toEqual([a.id]);
    expect(sched.list({ extId: 'ext-none' })).toEqual([]);
    expect(sched.get(a.id)!.extId).toBe('ext-a');
    expect(sched.get('missing-id')).toBeNull();
    // 快照拷贝：改动返回值不影响内部状态
    const snap = sched.get(a.id)!;
    snap.name = 'mutated';
    expect(sched.get(a.id)!.name).toBe('a');
    const listed = sched.list()[0]!;
    listed.name = 'mutated-too';
    expect(sched.list()[0]!.name).not.toBe('mutated-too');
  });

  it('unschedule：出堆并删库；重复删除返回 false', async () => {
    const fired: CronFireContext[] = [];
    const { sched, store } = makeScheduler({ onFire: async (ctx) => { fired.push(ctx); } });
    const rec = await sched.schedule({ name: 'gone', expr: '* * * * *' });
    expect(await sched.unschedule(rec.id)).toBe(true);
    expect(store.rows()).toHaveLength(0);
    expect(sched.get(rec.id)).toBeNull();
    await sched.seekTo(b1);
    expect(fired).toHaveLength(0);
    expect(await sched.unschedule(rec.id)).toBe(false);
    expect(await sched.unschedule('never-existed')).toBe(false);
  });
});
