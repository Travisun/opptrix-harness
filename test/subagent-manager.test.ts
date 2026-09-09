/**
 * SubagentManager 内核测试（临时文件库 + 真实迁移 + 可编程时序 StubRunner）。
 *
 * - 迁移 016_subagents 应用与 store 往返（transcript 损坏容错）；
 * - spawn 树约束：depth=1/2、depth 超限拒绝、父不存在拒绝、每父子代上限、prompt/maxIterations 校验；
 * - runner 透传：prompt/model/toolNames/maxIterations/systemPrompt/signal/depth 全部到位；
 * - 并发排队：maxConcurrent=1 时 FIFO 入队消化；queued 取消后不被消化；
 * - 终态落库：done（result/usage/transcript + info 通知）、failed（error + error 通知）、
 *   通知抛错不影响生命周期、runner 裸 reject 兜底落 failed、progress 不触库；
 * - 超时：短超时 failed('timeout') + runner 收到 abort + 迟到 done 丢弃；
 * - 取消：running（abort + 迟到事件丢弃）/ queued / 终态幂等 false；
 * - 树校验：直接父 ok / main ok / 兄弟 FORBIDDEN / 祖父 FORBIDDEN / 未知 EXT_NOT_FOUND；
 * - list 过滤（parentId/status/depth）、waitFor（终态返回 / 超时 RPC_TIMEOUT / 未知 NOT_FOUND）、
 *   sweepTimeouts 僵尸行清扫 + 队列消化。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Knex } from 'knex';

import { SubagentManager } from '../src/kernel/agents/manager.js';
import { SubagentStore } from '../src/kernel/agents/store.js';
import type { SubagentRecord, SubagentRunnerEvent } from '../src/kernel/agents/types.js';
import { closeDb, openSqlite } from '../src/kernel/storage/db.js';
import { KERNEL_MIGRATIONS } from '../src/kernel/storage/kernel-migrations.js';
import { Migrator } from '../src/kernel/storage/migrator.js';

const logger = pino({ level: 'silent' });
/** 等 fire-and-forget 执行链落地（runner 调用在微任务之后，测试给一拍时间） */
const tick = (ms = 25): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// 测试基建：StubRunner（run 只登记不执行；事件/释放由测试手动驱动）
// ---------------------------------------------------------------------------

/** StubRunner 持有的单次调用 */
interface HeldCall {
  input: {
    agentId: string;
    depth: number;
    systemPrompt?: string;
    prompt: string;
    model?: string;
    toolNames?: string[];
    maxIterations?: number;
    signal?: AbortSignal;
  };
  onEvent: (e: SubagentRunnerEvent) => Promise<void>;
  /** 结束 runner Promise（正常返回；reject 由参数控制） */
  release: (mode: 'resolve' | 'reject') => void;
  aborted: boolean;
}

class StubRunner {
  readonly held: HeldCall[] = [];

  run(
    input: HeldCall['input'],
    onEvent: (e: SubagentRunnerEvent) => Promise<void>,
  ): Promise<void> {
    let release!: (mode: 'resolve' | 'reject') => void;
    const promise = new Promise<void>((resolve, reject) => {
      release = (mode) => (mode === 'resolve' ? resolve() : reject(new Error('runner exploded')));
    });
    const call: HeldCall = { input, onEvent, release, aborted: false };
    input.signal?.addEventListener('abort', () => {
      call.aborted = true;
    });
    this.held.push(call);
    return promise;
  }

  byId(id: string): HeldCall {
    const call = this.held.find((c) => c.input.agentId === id);
    if (call === undefined) throw new Error(`StubRunner: no held call for "${id}"`);
    return call;
  }

  /** 驱动事件（不释放 runner Promise——悬挂由测试决定） */
  async emit(id: string, event: SubagentRunnerEvent): Promise<void> {
    await this.byId(id).onEvent(event);
  }

  /** 完成路径：done 事件 + 释放 */
  async done(id: string, result: string, usage?: { usageIn: number; usageOut: number }): Promise<void> {
    await this.emit(id, { type: 'done', result, ...usage });
    this.byId(id).release('resolve');
  }

  /** 失败路径：error 事件 + 释放 */
  async fail(id: string, error: string): Promise<void> {
    await this.emit(id, { type: 'error', error });
    this.byId(id).release('resolve');
  }
}

interface NotificationRec {
  title: string;
  body: string;
  level?: 'info' | 'warn' | 'error';
}

function makeManager(
  store: SubagentStore,
  stub: StubRunner,
  opts: {
    maxDepth?: number;
    maxChildrenPerParent?: number;
    maxConcurrent?: number;
    timeoutMs?: number;
    notifyThrows?: boolean;
  } = {},
): { manager: SubagentManager; notifications: NotificationRec[] } {
  const notifications: NotificationRec[] = [];
  const manager = new SubagentManager({
    store,
    runner: (input, onEvent) => stub.run(input, onEvent),
    logger,
    ...(opts.maxDepth !== undefined ? { maxDepth: opts.maxDepth } : {}),
    ...(opts.maxChildrenPerParent !== undefined
      ? { maxChildrenPerParent: opts.maxChildrenPerParent }
      : {}),
    ...(opts.maxConcurrent !== undefined ? { maxConcurrent: opts.maxConcurrent } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    notify: {
      send: async (input) => {
        if (opts.notifyThrows === true) throw new Error('notify channel down');
        notifications.push(input);
        return { id: 'n1' };
      },
    },
  });
  return { manager, notifications };
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

let dir: string;
let db: Knex;
let store: SubagentStore;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'opptrix-subagents-'));
  db = await openSqlite(join(dir, 'subagents.sqlite'));
  const migrator = new Migrator(db, { migrations: KERNEL_MIGRATIONS });
  await migrator.latest();
  store = new SubagentStore(db);
});

afterAll(async () => {
  await closeDb(db);
  rmSync(dir, { recursive: true, force: true });
});

// 每个用例清空 subagents 表：隔离树/并发槽状态（前序用例遗留的 running 会占满并发额度）
beforeEach(async () => {
  await db('subagents').del();
});

describe('迁移 016_subagents 与 store 往返', () => {
  it('迁移已应用且 subagents 表可写（ensureTable 幂等）', async () => {
    const applied = await new Migrator(db, { migrations: KERNEL_MIGRATIONS }).applied();
    expect(applied.some((m) => m.name === '016_subagents')).toBe(true);
    await store.ensureTable(); // 表已存在（迁移先建）：直接跳过，不抛
    await expect(store.ensureTable()).resolves.toBeUndefined();
  });

  it('空白库（未跑迁移）上惰性先到先建；重复 id 抛 DB_ERROR', async () => {
    const blankDir = mkdtempSync(join(tmpdir(), 'opptrix-subagents-blank-'));
    const blankDb = await openSqlite(join(blankDir, 'blank.sqlite'));
    try {
      const blankStore = new SubagentStore(blankDb);
      const base: SubagentRecord = {
        id: 'blank-1',
        parentId: 'main',
        depth: 1,
        model: null,
        systemPrompt: null,
        prompt: 'blank',
        toolNames: null,
        status: 'queued',
        result: null,
        error: null,
        transcript: null,
        usageIn: null,
        usageOut: null,
        createdAt: 1,
        startedAt: null,
        finishedAt: null,
      };
      await blankStore.create(base); // 首次操作惰性建表
      expect(await blankStore.get('blank-1')).toMatchObject({ id: 'blank-1', prompt: 'blank', status: 'queued' });
      await expect(blankStore.create(base)).rejects.toMatchObject({ code: 'HARNESS-4003' }); // 主键冲突
      await expect(blankStore.ensureTable()).resolves.toBeUndefined(); // 建表备忘录：幂等
    } finally {
      await closeDb(blankDb);
      rmSync(blankDir, { recursive: true, force: true });
    }
  });

  it('create/get/list/update 往返；损坏的 transcript JSON 容错置 null', async () => {
    const rec: SubagentRecord = {
      id: 'roundtrip-1',
      parentId: 'main',
      depth: 1,
      model: 'gpt-x',
      systemPrompt: 'sys',
      prompt: 'p',
      toolNames: ['a', 'b'],
      status: 'running',
      result: null,
      error: null,
      transcript: [{ role: 'user', content: 'hi' }],
      usageIn: 11,
      usageOut: 7,
      createdAt: 123,
      startedAt: 124,
      finishedAt: null,
    };
    await store.create(rec);
    const got = await store.get('roundtrip-1');
    expect(got).toMatchObject({
      id: 'roundtrip-1',
      parentId: 'main',
      depth: 1,
      model: 'gpt-x',
      toolNames: ['a', 'b'],
      status: 'running',
      transcript: [{ role: 'user', content: 'hi' }],
      usageIn: 11,
      usageOut: 7,
    });
    await db('subagents').where('id', 'roundtrip-1').update({ transcript: '{not-json' });
    const corrupted = await store.get('roundtrip-1');
    expect(corrupted?.transcript).toBeNull(); // 脏数据容错：单字段损坏不影响整体读取
    await store.update('roundtrip-1', { status: 'done', result: 'ok', transcript: [{ role: 'assistant' }] });
    expect(await store.get('roundtrip-1')).toMatchObject({ status: 'done', result: 'ok' });
  });
});

describe('spawn 树约束与入参校验', () => {
  it('main 派生 → depth=1 running；入参透传 runner（prompt/model/toolNames/maxIterations/systemPrompt/signal）', async () => {
    const stub = new StubRunner();
    const { manager } = makeManager(store, stub, { maxChildrenPerParent: 8 });
    const rec = await manager.spawn({
      parentId: 'main',
      prompt: 'hello world',
      systemPrompt: 'be terse',
      model: 'model-a',
      toolNames: ['search'],
      maxIterations: 5,
    });
    expect(rec.depth).toBe(1);
    expect(rec.parentId).toBe('main');
    expect(rec.status).toBe('running');
    expect(rec.startedAt).not.toBeNull();
    await tick();
    const call = stub.byId(rec.id);
    expect(call.input).toMatchObject({
      depth: 1,
      prompt: 'hello world',
      systemPrompt: 'be terse',
      model: 'model-a',
      toolNames: ['search'],
      maxIterations: 5,
    });
    expect(call.input.signal).toBeInstanceOf(AbortSignal);
    expect(call.aborted).toBe(false);
  });

  it('子代理派生 → depth=父.depth+1', async () => {
    const stub = new StubRunner();
    const { manager } = makeManager(store, stub);
    const parent = await manager.spawn({ parentId: 'main', prompt: 'parent' });
    const child = await manager.spawn({ parentId: parent.id, prompt: 'child' });
    expect(child.depth).toBe(2);
    expect(child.parentId).toBe(parent.id);
  });

  it('depth 超限 → BAD_REQUEST "max subagent depth exceeded"', async () => {
    const stub = new StubRunner();
    const { manager } = makeManager(store, stub, { maxDepth: 2 });
    const parent = await manager.spawn({ parentId: 'main', prompt: 'p1' });
    const child = await manager.spawn({ parentId: parent.id, prompt: 'p2' });
    await expect(manager.spawn({ parentId: child.id, prompt: 'p3' })).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining('max subagent depth exceeded'),
    });
  });

  it('父不存在 → BAD_REQUEST "parent subagent not found"', async () => {
    const stub = new StubRunner();
    const { manager } = makeManager(store, stub);
    await expect(manager.spawn({ parentId: 'no-such-parent', prompt: 'p' })).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining('parent subagent not found'),
    });
  });

  it('每父子代数达到上限 → BAD_REQUEST "max children per parent exceeded"', async () => {
    const stub = new StubRunner();
    const { manager } = makeManager(store, stub, { maxChildrenPerParent: 2 });
    await manager.spawn({ parentId: 'main', prompt: 'c1' });
    await manager.spawn({ parentId: 'main', prompt: 'c2' });
    await expect(manager.spawn({ parentId: 'main', prompt: 'c3' })).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining('max children per parent exceeded'),
    });
  });

  it('空 prompt / 超 64KB prompt / 非法 maxIterations → BAD_REQUEST', async () => {
    const stub = new StubRunner();
    const { manager } = makeManager(store, stub);
    await expect(manager.spawn({ parentId: 'main', prompt: '' })).rejects.toMatchObject({ status: 400 });
    await expect(manager.spawn({ parentId: 'main', prompt: 'x'.repeat(65_537) })).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      manager.spawn({ parentId: 'main', prompt: 'p', maxIterations: 0 }),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe('并发排队（queued）与消化', () => {
  it('并发达上限入队不拒绝；终态释放槽位后 FIFO 消化', async () => {
    const stub = new StubRunner();
    const { manager } = makeManager(store, stub, { maxConcurrent: 1 });
    const a = await manager.spawn({ parentId: 'main', prompt: 'a' });
    const b = await manager.spawn({ parentId: 'main', prompt: 'b' });
    const c = await manager.spawn({ parentId: 'main', prompt: 'c' });
    expect(a.status).toBe('running');
    expect(b.status).toBe('queued');
    expect(c.status).toBe('queued');
    expect(b.startedAt).toBeNull();

    await manager.cancel(a.id); // 释放槽位
    await tick();
    expect((await store.get(b.id))?.status).toBe('running'); // FIFO：b 先消化
    expect((await store.get(c.id))?.status).toBe('queued');

    await stub.done(b.id, 'b-ok');
    await tick();
    expect((await store.get(c.id))?.status).toBe('running'); // c 接续消化
  });

  it('queued 被取消后不再被消化', async () => {
    const stub = new StubRunner();
    const { manager } = makeManager(store, stub, { maxConcurrent: 1 });
    const a = await manager.spawn({ parentId: 'main', prompt: 'a' });
    const b = await manager.spawn({ parentId: 'main', prompt: 'b' });
    expect(await manager.cancel(b.id)).toBe(true);
    expect((await store.get(b.id))?.status).toBe('cancelled');
    await stub.done(a.id, 'a-ok');
    await tick();
    expect((await store.get(b.id))?.status).toBe('cancelled'); // 不被消化
    expect(stub.held).toHaveLength(1); // b 从未启动
  });
});

describe('终态落库与通知', () => {
  it('done → result/finishedAt/usage 落库 + info 通知；transcript 事件落库；progress 不触库', async () => {
    const stub = new StubRunner();
    const { manager, notifications } = makeManager(store, stub);
    const rec = await manager.spawn({ parentId: 'main', prompt: 'work' });
    await tick();
    await stub.emit(rec.id, { type: 'progress', iteration: 3 }); // 无进度列：仅日志，不抛
    await stub.emit(rec.id, { type: 'transcript', messages: [{ role: 'user', content: 'work' }] });
    await stub.done(rec.id, 'the answer', { usageIn: 100, usageOut: 20 });
    await tick();
    const done = await store.get(rec.id);
    expect(done).toMatchObject({
      status: 'done',
      result: 'the answer',
      usageIn: 100,
      usageOut: 20,
      finishedAt: expect.any(Number),
    });
    expect(done?.transcript).toEqual([{ role: 'user', content: 'work' }]);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({ level: 'info', title: expect.stringContaining(rec.id) });
  });

  it('error → failed + error 落库 + error 通知', async () => {
    const stub = new StubRunner();
    const { manager, notifications } = makeManager(store, stub);
    const rec = await manager.spawn({ parentId: 'main', prompt: 'boom' });
    await tick();
    await stub.fail(rec.id, 'llm exploded');
    expect(await store.get(rec.id)).toMatchObject({ status: 'failed', error: 'llm exploded' });
    expect(notifications).toEqual([
      expect.objectContaining({ level: 'error', body: 'llm exploded', title: expect.stringContaining(rec.id) }),
    ]);
  });

  it('notify.send 抛错不影响生命周期（仍落 done）', async () => {
    const stub = new StubRunner();
    const { manager } = makeManager(store, stub, { notifyThrows: true });
    const rec = await manager.spawn({ parentId: 'main', prompt: 'work' });
    await tick();
    await stub.done(rec.id, 'ok');
    expect(await store.get(rec.id)).toMatchObject({ status: 'done', result: 'ok' });
  });

  it('runner 裸 reject（未发事件）→ 兜底落 failed', async () => {
    const stub = new StubRunner();
    const { manager } = makeManager(store, stub);
    const rec = await manager.spawn({ parentId: 'main', prompt: 'bad runner' });
    await tick();
    stub.byId(rec.id).release('reject');
    await tick();
    expect(await store.get(rec.id)).toMatchObject({ status: 'failed', error: 'runner exploded' });
  });
});

describe('超时与取消', () => {
  it('超时 → failed(timeout) + runner 收到 abort + 迟到 done 丢弃', async () => {
    const stub = new StubRunner();
    const { manager } = makeManager(store, stub, { timeoutMs: 80 });
    const rec = await manager.spawn({ parentId: 'main', prompt: 'slow' });
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 150)); // 等定时器到点
    expect(await store.get(rec.id)).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('timeout'),
    });
    expect(stub.byId(rec.id).aborted).toBe(true);
    await stub.done(rec.id, 'too late'); // 迟到事件
    expect(await store.get(rec.id)).toMatchObject({ status: 'failed' }); // 丢弃
  });

  it('cancel running → cancelled + abort + 迟到 done 丢弃', async () => {
    const stub = new StubRunner();
    const { manager } = makeManager(store, stub);
    const rec = await manager.spawn({ parentId: 'main', prompt: 'cancel me' });
    await tick();
    expect(await manager.cancel(rec.id)).toBe(true);
    expect(await store.get(rec.id)).toMatchObject({ status: 'cancelled', finishedAt: expect.any(Number) });
    expect(stub.byId(rec.id).aborted).toBe(true);
    await stub.done(rec.id, 'too late');
    expect(await store.get(rec.id)).toMatchObject({ status: 'cancelled' });
  });

  it('cancel 终态幂等 false；未知 id false', async () => {
    const stub = new StubRunner();
    const { manager } = makeManager(store, stub);
    const rec = await manager.spawn({ parentId: 'main', prompt: 'x' });
    await tick();
    await stub.done(rec.id, 'ok');
    expect(await manager.cancel(rec.id)).toBe(false);
    expect(await manager.cancel('no-such-id')).toBe(false);
  });
});

describe('树校验（assertDirectParent / assertParent）', () => {
  it('直接父 ok；main ok；兄弟 FORBIDDEN；祖父 FORBIDDEN；未知子代理 EXT_NOT_FOUND', async () => {
    const stub = new StubRunner();
    const { manager } = makeManager(store, stub, { maxDepth: 3 }); // 深树：允许孙辈存在
    const a = await manager.spawn({ parentId: 'main', prompt: 'a' }); // depth1
    const a1 = await manager.spawn({ parentId: a.id, prompt: 'a1' }); // depth2
    const a1a = await manager.spawn({ parentId: a1.id, prompt: 'a1a' }); // depth3
    const b = await manager.spawn({ parentId: 'main', prompt: 'b' }); // depth1（a 的兄弟）

    await expect(manager.assertDirectParent(a1.id, a.id)).resolves.toBeUndefined(); // 直接父
    await expect(manager.assertDirectParent(a.id, 'main')).resolves.toBeUndefined(); // main 全知
    await expect(manager.assertDirectParent(a1a.id, 'main')).resolves.toBeUndefined();
    await expect(manager.assertDirectParent(b.id, a.id)).rejects.toMatchObject({
      status: 403,
      message: 'cross-generation or sibling access is not allowed (strict parent-child tree)',
    });
    await expect(manager.assertDirectParent(a1a.id, a.id)).rejects.toMatchObject({ status: 403 }); // 祖父（跨代）
    await expect(manager.assertDirectParent('no-such-child', 'main')).rejects.toMatchObject({ status: 404 });
    // 别名同语义
    await expect(manager.assertParent(a1.id, a.id)).resolves.toBeUndefined();
    await expect(manager.assertParent(a1.id, b.id)).rejects.toMatchObject({ status: 403 });
  });
});

describe('list 过滤 / waitFor / sweepTimeouts', () => {
  it('list 按 parentId/status/depth 过滤', async () => {
    const stub = new StubRunner();
    const { manager } = makeManager(store, stub);
    const p = await manager.spawn({ parentId: 'main', prompt: 'p' });
    const c = await manager.spawn({ parentId: p.id, prompt: 'c' });
    await stub.done(c.id, 'ok');
    await tick();
    const byParent = await manager.list({ parentId: p.id });
    expect(byParent).toHaveLength(1);
    expect(byParent[0]?.id).toBe(c.id);
    const running = await manager.list({ status: 'running' });
    expect(running.map((r) => r.id)).toContain(p.id);
    expect(running.map((r) => r.id)).not.toContain(c.id);
    const depthOne = await manager.list({ depth: 1 });
    expect(depthOne.map((r) => r.id)).toContain(p.id);
    expect(depthOne.map((r) => r.id)).not.toContain(c.id);
    expect((await manager.get(c.id))?.status).toBe('done');
  });

  it('waitFor：终态返回记录；超时抛 RPC_TIMEOUT；未知抛 NOT_FOUND', async () => {
    const stub = new StubRunner();
    const { manager } = makeManager(store, stub);
    const rec = await manager.spawn({ parentId: 'main', prompt: 'wait for me' });
    await tick();
    void stub.done(rec.id, 'finished');
    const done = await manager.waitFor(rec.id, 5000);
    expect(done).toMatchObject({ status: 'done', result: 'finished' });

    const hung = await manager.spawn({ parentId: 'main', prompt: 'hung' });
    await expect(manager.waitFor(hung.id, 120)).rejects.toMatchObject({ status: 504 });
    await expect(manager.waitFor('no-such-id', 100)).rejects.toMatchObject({ status: 404 });
    await manager.cancel(hung.id); // 清场
  });

  it('sweepTimeouts：清扫僵尸 running 行（重启遗留）并消化 queued', async () => {
    const stub = new StubRunner();
    const { manager } = makeManager(store, stub, { maxConcurrent: 1, timeoutMs: 1000 });
    // 直接落库僵尸行（模拟进程重启：无内存 controller/定时器）+ 一个排队行
    const zombie: SubagentRecord = {
      id: 'zombie-1',
      parentId: 'main',
      depth: 1,
      model: null,
      systemPrompt: null,
      prompt: 'z',
      toolNames: null,
      status: 'running',
      result: null,
      error: null,
      transcript: null,
      usageIn: null,
      usageOut: null,
      createdAt: Date.now() - 60_000,
      startedAt: Date.now() - 60_000,
      finishedAt: null,
    };
    await store.create(zombie);
    const queuedRec: SubagentRecord = { ...zombie, id: 'queued-1', status: 'queued', startedAt: null };
    await store.create(queuedRec);

    const swept = await manager.sweepTimeouts();
    expect(swept).toBe(1);
    await tick();
    expect(await store.get('zombie-1')).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('timeout'),
    });
    expect(await store.get('queued-1')).toMatchObject({ status: 'running' }); // 槽位释放后消化
    expect(await manager.sweepTimeouts()).toBe(0); // 幂等
  });
});
