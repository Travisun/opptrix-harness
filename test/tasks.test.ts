/**
 * tasks 内核测试（临时文件库 + 真实迁移）。
 *
 * - TaskStore：create/get 默认值与反序列化、状态机合法/非法转移（条件更新守卫）、
 *   setProgress 钳制、setResult/setError、list 过滤；
 * - TaskManager + 真实 TaskWorkerPool：echo 全链路（progress 50 → done → result 落库 →
 *   task.completed 事件 / task.progress 推送）、未知 name 失败路径、size=1 并发 FIFO 排队；
 * - TaskManager + StubPool（时序可控）：cancel queued / cancel running 且迟到回调丢弃、
 *   sweepTimeouts（注入短超时后手动清扫）、start 前派发 fail-fast、stop 资源清理。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Knex } from 'knex';

import { TaskManager } from '../src/kernel/tasks/manager.js';
import { TaskStore, type TaskRecord } from '../src/kernel/tasks/store.js';
import { TASK_NOT_REGISTERED_MESSAGE, TaskWorkerPool } from '../src/kernel/tasks/worker-pool.js';
import { closeDb, openSqlite } from '../src/kernel/storage/db.js';
import { KERNEL_MIGRATIONS } from '../src/kernel/storage/kernel-migrations.js';
import { Migrator } from '../src/kernel/storage/migrator.js';

const logger = pino({ level: 'silent' });
/** 等待 fire-and-forget 回调链落地（manager 回调异步，测试里给一拍时间） */
const tick = (ms = 30): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

let dir: string;
let db: Knex;
let store: TaskStore;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'opptrix-tasks-'));
  db = await openSqlite(join(dir, 'tasks.sqlite'));
  const migrator = new Migrator(db, { migrations: KERNEL_MIGRATIONS });
  await migrator.latest();
  store = new TaskStore(db);
});

afterAll(async () => {
  await closeDb(db);
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 测试基建：StubPool（时序可控）、事件/推送记录、懒门面接线、轮询工具
// ---------------------------------------------------------------------------

/** 池替身：run() 只登记不执行，任务状态由测试经 manager.onXxx 手动驱动 */
class StubPool {
  started = false;
  stopped = false;
  readonly held: Array<{ taskId: string; name: string; args: unknown; resolve: () => void }> = [];

  async start(): Promise<void> {
    this.started = true;
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }

  run(taskId: string, name: string, args: unknown): Promise<void> {
    return new Promise<void>((resolve) => {
      this.held.push({ taskId, name, args, resolve });
    });
  }
}

interface EventRec {
  name: string;
  payload: unknown;
}

function makeSink() {
  const events: EventRec[] = [];
  const pubs: Array<{ topic: string; event: string; data: unknown }> = [];
  return {
    events,
    pubs,
    emit(name: string, payload: unknown, _opts?: { source?: string }): unknown {
      events.push({ name, payload });
      return { delivered: 1, errors: [] };
    },
    publish(topic: string, event: string, data: unknown): void {
      pubs.push({ topic, event, data });
    },
  };
}

type Sink = ReturnType<typeof makeSink>;

/** StubPool 版组装：manager 直接持有 stub，回调由测试手动触发 */
function wireStubManager(opts: { defaultTimeoutMs?: number } = {}): {
  manager: TaskManager;
  stub: StubPool;
  events: Sink['events'];
  pubs: Sink['pubs'];
} {
  const sink = makeSink();
  const stub = new StubPool();
  const manager = new TaskManager({
    store,
    pool: stub,
    emit: sink.emit,
    publish: sink.publish,
    logger,
    defaultTimeoutMs: opts.defaultTimeoutMs,
  });
  return { manager, stub, events: sink.events, pubs: sink.pubs };
}

/** 真实池版组装：manager 先构造（持懒门面），池回调回接 manager（与内核组装一致） */
function wireRealManager(size: number, opts: { defaultTimeoutMs?: number } = {}): {
  manager: TaskManager;
  pool: TaskWorkerPool;
  events: Sink['events'];
  pubs: Sink['pubs'];
} {
  const sink = makeSink();
  let pool!: TaskWorkerPool;
  const manager = new TaskManager({
    store,
    pool: {
      start: () => pool.start(),
      stop: () => pool.stop(),
      run: (taskId, name, args) => pool.run(taskId, name, args),
    },
    emit: sink.emit,
    publish: sink.publish,
    logger,
    defaultTimeoutMs: opts.defaultTimeoutMs,
  });
  pool = new TaskWorkerPool({
    size,
    logger,
    onProgress: (taskId, pct, msg) => manager.onProgress(taskId, pct, msg),
    onDone: (taskId, result) => manager.onDone(taskId, result),
    onFailed: (taskId, error) => manager.onFailed(taskId, error),
  });
  return { manager, pool, events: sink.events, pubs: sink.pubs };
}

/** 轮询直到条件满足（缺省 ≤5s），超时抛错并附最后快照 */
async function pollUntil(
  load: () => Promise<TaskRecord | null>,
  until: (rec: TaskRecord) => boolean,
  timeoutMs = 5000,
): Promise<TaskRecord> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rec = await load();
    if (rec !== null && until(rec)) return rec;
    if (Date.now() > deadline) {
      throw new Error(`poll timeout: last=${JSON.stringify(rec)}`);
    }
    await tick(20);
  }
}

// ---------------------------------------------------------------------------
// TaskStore
// ---------------------------------------------------------------------------

describe('TaskStore — create/get 与序列化', () => {
  it('create → queued 默认值（progress 0、时间戳齐备）；get 回读一致且 args 反序列化', async () => {
    const rec = await store.create({ id: 's1', extId: 'ext-a', name: 'echo', args: { n: 1 } });
    expect(rec.id).toBe('s1');
    expect(rec.extId).toBe('ext-a');
    expect(rec.name).toBe('echo');
    expect(rec.status).toBe('queued');
    expect(rec.progress).toBe(0);
    expect(rec.progressMsg).toBeNull();
    expect(rec.result).toBeNull();
    expect(rec.error).toBeNull();
    expect(rec.createdAt).toBeGreaterThan(0);
    expect(rec.startedAt).toBeNull();
    expect(rec.finishedAt).toBeNull();
    expect(rec.args).toEqual({ n: 1 });

    const back = await store.get('s1');
    expect(back).toEqual(rec);
  });

  it('get 未知 id → null；extId 缺省落 ""（内核级）', async () => {
    expect(await store.get('nope')).toBeNull();
    const rec = await store.create({ id: 's2', name: 'echo' });
    expect(rec.extId).toBe('');
    expect((await store.get('s2'))?.extId).toBe('');
  });

  it('setResult / setError 落库并可回读（对象结果反序列化）', async () => {
    await store.create({ id: 's3', name: 'echo', args: null });
    expect(await store.setResult('s3', { rows: [1, 2] })).toBe(true);
    expect(await store.setError('s3', 'boom')).toBe(true);
    const rec = await store.get('s3');
    expect(rec?.result).toEqual({ rows: [1, 2] });
    expect(rec?.error).toBe('boom');
    expect(await store.setResult('ghost', 1)).toBe(false);
    expect(await store.setError('ghost', 'x')).toBe(false);
  });

  it('list：extId / status / limit 过滤，created_at 升序', async () => {
    await store.create({ id: 'l1', extId: 'ext-l', name: 'echo' });
    await store.create({ id: 'l2', extId: 'ext-l', name: 'echo' });
    await store.create({ id: 'l3', extId: 'ext-m', name: 'echo' });
    await store.transition('l3', ['queued'], 'running', { startedAt: 1 });

    const byExt = await store.list({ extId: 'ext-l' });
    expect(byExt.map((r) => r.id)).toEqual(['l1', 'l2']);

    const byStatus = await store.list({ status: 'running' });
    expect(byStatus.map((r) => r.id)).toEqual(['l3']);
    await store.transition('l3', ['running'], 'failed', { finishedAt: 2 }); // 收尾置终态，不留 running 污染后续 sweep 用例

    const limited = await store.list({ extId: 'ext-l', limit: 1 });
    expect(limited.map((r) => r.id)).toEqual(['l1']);

    const all = await store.list();
    expect(all.length).toBeGreaterThanOrEqual(3);
  });
});

describe('TaskStore — 状态机转移（条件更新守卫）', () => {
  it('合法：queued→running（startedAt 落库）→done（finishedAt 落库），返回 true', async () => {
    await store.create({ id: 't1', name: 'echo' });
    expect(await store.transition('t1', ['queued'], 'running', { startedAt: 111 })).toBe(true);
    let rec = await store.get('t1');
    expect(rec?.status).toBe('running');
    expect(rec?.startedAt).toBe(111);
    expect(await store.transition('t1', ['running'], 'done', { finishedAt: 222 })).toBe(true);
    rec = await store.get('t1');
    expect(rec?.status).toBe('done');
    expect(rec?.finishedAt).toBe(222);
  });

  it('合法：queued→cancelled、running→failed 均放行', async () => {
    await store.create({ id: 't2', name: 'echo' });
    expect(await store.transition('t2', ['queued'], 'cancelled', { finishedAt: 1 })).toBe(true);
    expect((await store.get('t2'))?.status).toBe('cancelled');

    await store.create({ id: 't3', name: 'echo' });
    await store.transition('t3', ['queued'], 'running', { startedAt: 1 });
    expect(await store.transition('t3', ['running'], 'failed', { finishedAt: 2 })).toBe(true);
    expect((await store.get('t3'))?.status).toBe('failed');
  });

  it('当前状态不在 from 内 → false 且行保持原状（如 queued 行拒绝 running→done）', async () => {
    await store.create({ id: 't4', name: 'echo' }); // 行为 queued
    expect(await store.transition('t4', ['running'], 'done')).toBe(false);
    const rec = await store.get('t4');
    expect(rec?.status).toBe('queued');
    expect(rec?.finishedAt).toBeNull();
  });

  it('终态无出边：done/failed/cancelled 再转移被守卫（含 done 的 from 组合抛错；from 不含当前态 → false）', async () => {
    // 构造三种终态（全部走合法路径）
    await store.create({ id: 't5d', name: 'echo' });
    await store.transition('t5d', ['queued'], 'running', { startedAt: 1 });
    await store.transition('t5d', ['running'], 'done', { finishedAt: 2 });
    await store.create({ id: 't5f', name: 'echo' });
    await store.transition('t5f', ['queued'], 'running', { startedAt: 1 });
    await store.transition('t5f', ['running'], 'failed', { finishedAt: 2 });
    await store.create({ id: 't5c', name: 'echo' });
    await store.transition('t5c', ['queued'], 'cancelled', { finishedAt: 3 });

    // from 含终态的任何出边都违反状态机 → fail-fast 抛错
    await expect(store.transition('t5d', ['done'], 'running')).rejects.toThrow(/终态/);
    await expect(store.transition('t5f', ['failed'], 'running')).rejects.toThrow(/终态/);
    await expect(store.transition('t5c', ['cancelled'], 'running')).rejects.toThrow(/终态/);

    // from 不含当前终态 → 条件更新不命中，行保持原状
    expect(await store.transition('t5d', ['running'], 'cancelled')).toBe(false);
    expect((await store.get('t5d'))?.status).toBe('done');
  });

  it('非法 from→to 组合 → 抛 INTERNAL（fail-fast 暴露调用方 bug）', async () => {
    await store.create({ id: 't6', name: 'echo' });
    await expect(store.transition('t6', ['queued'], 'done')).rejects.toThrow(/queued → done/);
    await expect(store.transition('t6', ['done'], 'running')).rejects.toThrow(/终态/);
    await expect(store.transition('t6', [], 'running')).rejects.toThrow(/from 不能为空/);
  });

  it('setProgress：钳制 [0,100]、msg 写入；未知 id → false', async () => {
    await store.create({ id: 'p1', name: 'echo' });
    expect(await store.setProgress('p1', 42, 'half')).toBe(true);
    let rec = await store.get('p1');
    expect(rec?.progress).toBe(42);
    expect(rec?.progressMsg).toBe('half');
    await store.setProgress('p1', 250);
    expect((await store.get('p1'))?.progress).toBe(100);
    await store.setProgress('p1', -7);
    expect((await store.get('p1'))?.progress).toBe(0);
    expect(await store.setProgress('ghost', 1)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TaskManager + 真实 TaskWorkerPool（echo 管道）
// ---------------------------------------------------------------------------

describe('TaskManager + TaskWorkerPool — echo 全链路与并发', () => {
  it('dispatch→progress(50)→done：result 落库、task.completed 事件、task.progress 推送', async () => {
    const { manager, events, pubs } = wireRealManager(2);
    await manager.start();
    try {
      const rec = await manager.dispatch({ extId: 'ext-echo', name: 'echo', args: { hello: 'world' } });
      expect(rec.status).toBe('queued');

      const done = await pollUntil(
        () => manager.get(rec.id),
        (r) => r.status === 'done',
      );
      expect(done.result).toEqual({ hello: 'world' });
      expect(done.progress).toBe(50); // worker 先回 progress 再回 done（回调链保证按序落库）
      expect(done.progressMsg).toContain('echo');
      expect(done.startedAt).not.toBeNull();
      expect(done.finishedAt).not.toBeNull();

      const progressPush = pubs.find(
        (p) => p.topic === 'tasks' && p.event === 'task.progress' && (p.data as { id: string }).id === rec.id,
      );
      expect(progressPush).toBeDefined();
      expect((progressPush?.data as { pct: number }).pct).toBe(50);

      const completed = events.find((e) => e.name === 'task.completed');
      expect(completed).toBeDefined();
      expect((completed?.payload as { id: string; name: string; result: unknown }).id).toBe(rec.id);
      expect((completed?.payload as { name: string }).name).toBe('echo');
      expect((completed?.payload as { result: unknown }).result).toEqual({ hello: 'world' });
    } finally {
      await manager.stop();
    }
  });

  it('未知 name → failed + error 落库（未注册文案）+ task.failed 事件', async () => {
    const { manager, events } = wireRealManager(1);
    await manager.start();
    try {
      const rec = await manager.dispatch({ name: 'nope', args: 1 });
      const failed = await pollUntil(
        () => manager.get(rec.id),
        (r) => r.status === 'failed',
      );
      expect(failed.error).toBe(TASK_NOT_REGISTERED_MESSAGE);
      expect(failed.finishedAt).not.toBeNull();
      const event = events.find((e) => e.name === 'task.failed');
      expect(event).toBeDefined();
      expect((event?.payload as { id: string; error: string }).id).toBe(rec.id);
      expect((event?.payload as { error: string }).error).toBe(TASK_NOT_REGISTERED_MESSAGE);
    } finally {
      await manager.stop();
    }
  });

  it('并发排队：size=1 两个任务 FIFO 完成（完成序 == 派发序）', async () => {
    const { manager, events } = wireRealManager(1);
    await manager.start();
    try {
      const a = await manager.dispatch({ name: 'echo', args: 'first' });
      const b = await manager.dispatch({ name: 'echo', args: 'second' }); // 池满 → 排队
      await pollUntil(
        () => manager.get(b.id),
        (r) => r.status === 'done',
      );
      expect((await manager.get(a.id))?.status).toBe('done');
      const order = events
        .filter((e) => e.name === 'task.completed')
        .map((e) => (e.payload as { id: string }).id);
      expect(order).toEqual([a.id, b.id]);
    } finally {
      await manager.stop();
    }
  });

  it('多 worker（size=2）互不阻塞：两个任务都到 done', async () => {
    const { manager } = wireRealManager(2);
    await manager.start();
    try {
      const a = await manager.dispatch({ name: 'echo', args: 1 });
      const b = await manager.dispatch({ name: 'echo', args: 2 });
      await pollUntil(
        () => manager.get(a.id),
        (r) => r.status === 'done',
      );
      await pollUntil(
        () => manager.get(b.id),
        (r) => r.status === 'done',
      );
      expect((await manager.get(a.id))?.result).toBe(1);
      expect((await manager.get(b.id))?.result).toBe(2);
    } finally {
      await manager.stop();
    }
  });

  it('start 之前 dispatch → KERNEL_NOT_READY；stop 后 dispatch 同样 fail-fast', async () => {
    const { manager } = wireRealManager(1);
    await expect(manager.dispatch({ name: 'echo' })).rejects.toThrow(/start/);
    await manager.start();
    await manager.stop();
    await expect(manager.dispatch({ name: 'echo' })).rejects.toThrow(/start/);
  });
});

// ---------------------------------------------------------------------------
// TaskManager + StubPool（取消 / 超时 / 生命周期）
// ---------------------------------------------------------------------------

describe('TaskManager — cancel 与迟到回调丢弃', () => {
  it('cancel queued：queued→cancelled 直接取消；迟到的 onProgress/onDone 全部丢弃', async () => {
    const { manager, events, pubs } = wireStubManager();
    await manager.start();
    const rec = await manager.dispatch({ name: 'echo', args: 1 }); // stub 持有不执行 → 仍 queued
    expect((await manager.get(rec.id))?.status).toBe('queued');

    const cancelled = await manager.cancel(rec.id);
    expect(cancelled?.status).toBe('cancelled');
    expect(cancelled?.finishedAt).not.toBeNull();

    // 池稍后才取到任务并回调 → 一律丢弃（不写进度/结果、不发事件）
    manager.onProgress(rec.id, 50, 'late progress');
    manager.onDone(rec.id, 'late result');
    await tick();
    const after = await manager.get(rec.id);
    expect(after?.status).toBe('cancelled');
    expect(after?.progress).toBe(0);
    expect(after?.result).toBeNull();
    expect(events).toEqual([]);
    expect(pubs).toEqual([]);
  });

  it('cancel running：标记 cancelled；迟到的 onDone 丢弃（不写 result、不发 task.completed）', async () => {
    const { manager, events } = wireStubManager();
    await manager.start();
    const rec = await manager.dispatch({ name: 'echo', args: 1 });
    manager.onProgress(rec.id, 10, 'starting'); // 推入 running
    await tick();
    expect((await manager.get(rec.id))?.status).toBe('running');

    const cancelled = await manager.cancel(rec.id);
    expect(cancelled?.status).toBe('cancelled');

    manager.onDone(rec.id, 'late'); // 池无中断通道：结果迟到必须被丢弃
    await tick();
    const after = await manager.get(rec.id);
    expect(after?.status).toBe('cancelled');
    expect(after?.result).toBeNull();
    expect(events.filter((e) => e.name === 'task.completed')).toEqual([]);
  });

  it('cancel 终态任务幂等（返回原状态）；cancel 未知 id → null', async () => {
    const { manager } = wireStubManager();
    await manager.start();
    const rec = await manager.dispatch({ name: 'echo', args: 1 });
    await manager.cancel(rec.id);
    const again = await manager.cancel(rec.id);
    expect(again?.status).toBe('cancelled');
    expect(await manager.cancel('ghost')).toBeNull();
  });
});

describe('TaskManager — sweepTimeouts', () => {
  it('超时 running → failed("timeout")；迟到的 onDone 丢弃；重复 sweep 计数为 0', async () => {
    const { manager, events } = wireStubManager({ defaultTimeoutMs: 40 });
    await manager.start();
    const rec = await manager.dispatch({ name: 'echo', args: 1 });
    manager.onProgress(rec.id, 10); // 推入 running 并落 startedAt
    await tick();
    expect((await manager.get(rec.id))?.status).toBe('running');

    await tick(70); // 越过 40ms 超时
    // 前置校验：库里 running 的只有本用例的任务（用例间不互相污染）
    const running = await store.list({ status: 'running' });
    expect(running.map((r) => r.id), JSON.stringify(running)).toEqual([rec.id]);
    expect(await manager.sweepTimeouts()).toBe(1);

    const swept = await manager.get(rec.id);
    expect(swept?.status).toBe('failed');
    expect(swept?.error).toContain('timeout');
    expect(swept?.finishedAt).not.toBeNull();

    const failedEvent = events.find((e) => e.name === 'task.failed');
    expect(failedEvent).toBeDefined();
    expect((failedEvent?.payload as { reason: string }).reason).toBe('timeout');

    manager.onDone(rec.id, 'late'); // 真实结果迟到 → 丢弃
    await tick();
    expect((await manager.get(rec.id))?.result).toBeNull();
    expect(await manager.sweepTimeouts()).toBe(0);
  });

  it('未超时/queued 任务不受 sweep 影响', async () => {
    const { manager } = wireStubManager({ defaultTimeoutMs: 60_000 });
    await manager.start();
    const running = await manager.dispatch({ name: 'echo', args: 1 });
    manager.onProgress(running.id, 5);
    const queued = await manager.dispatch({ name: 'echo', args: 2 }); // stub 持有 → 保持 queued
    await tick();
    expect(await manager.sweepTimeouts()).toBe(0);
    expect((await manager.get(running.id))?.status).toBe('running');
    expect((await manager.get(queued.id))?.status).toBe('queued');
  });
});

describe('TaskManager — stop 资源清理', () => {
  it('stop：pool 停止、幂等可重复调用；stop 后再 start 可继续服务', async () => {
    const { manager, stub } = wireStubManager();
    await manager.start();
    expect(stub.started).toBe(true);
    await manager.stop();
    expect(stub.stopped).toBe(true);
    await expect(manager.stop()).resolves.toBeUndefined(); // 幂等
    await expect(manager.start()).resolves.toBeUndefined(); // 可重启
    await manager.stop();
  });

  it('真实池 stop：在途任务经 onFailed 判失败，run() Promise 不悬空', async () => {
    const { manager } = wireRealManager(1);
    await manager.start();
    const rec = await manager.dispatch({ name: 'echo', args: 1 });
    // 不等 done，立即 stop：池会终止线程并把任务判 failed（排队/在途都有终局）
    await manager.stop();
    const after = await manager.get(rec.id);
    expect(['done', 'failed']).toContain(after?.status);
  });
});
