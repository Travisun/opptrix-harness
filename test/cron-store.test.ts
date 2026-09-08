/**
 * CronJobStore 单测：临时文件库 + Migrator 跑内核迁移（cron_jobs/cron_runs
 * 由 006/007 建立）→ 验证 ensureTable 幂等、create/get payload JSON 往返、
 * list 过滤与排序、update 字段级更新、delete/setEnabled、touchRun、
 * recordRun + history 降序与 limit。
 *
 * 另以"未跑迁移的空白库"分支验证 ensureTable 的惰性建表与并发去重。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Knex } from 'knex';

import { CronJobStore, type CronJobRecord } from '../src/kernel/cron/store.js';
import { openSqlite } from '../src/kernel/storage/db.js';
import { KERNEL_MIGRATIONS } from '../src/kernel/storage/kernel-migrations.js';
import { Migrator } from '../src/kernel/storage/migrator.js';

let dir: string;
let db: Knex;
let store: CronJobStore;

let seq = 0;

/** 构造测试记录（缺省字段可被 overrides 覆盖；id 与 createdAt 自动递增保证唯一） */
function makeRecord(overrides: Partial<CronJobRecord> = {}): CronJobRecord {
  seq += 1;
  return {
    id: overrides.id ?? `job-${seq}`,
    extId: null,
    name: 'tick',
    expr: '*/5 * * * *',
    tz: 'UTC',
    payload: null,
    enabled: true,
    overlap: 'skip',
    misfire: 'skip',
    lastRun: null,
    nextRun: null,
    createdAt: 1_000 + seq,
    ...overrides,
  };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'opptrix-cron-store-'));
  db = await openSqlite(join(dir, 'cron-store.sqlite'));
  // 先跑内核迁移：cron_jobs / cron_runs 由迁移建立，store 的 ensureTable 必须幂等共存
  const migrator = new Migrator(db, { migrations: KERNEL_MIGRATIONS });
  await migrator.latest();
  store = new CronJobStore(db);
});

afterAll(async () => {
  await db?.destroy();
  rmSync(dir, { recursive: true, force: true });
});

describe('ensureTable 幂等与惰性建表', () => {
  it('内核迁移已建表时 ensureTable 不炸，且可重复/并发调用', async () => {
    await store.ensureTable();
    await store.ensureTable();
    await Promise.all([store.ensureTable(), store.ensureTable(), store.ensureTable()]);
    // 表存在的前提下可正常读写
    const rec = makeRecord({ id: 'ensure-1', createdAt: 10 });
    await store.create(rec);
    await expect(store.get('ensure-1')).resolves.toEqual(rec);
  });

  it('空白库（未跑迁移）上惰性建两表；并发调用共享同一次建表', async () => {
    const fresh = await openSqlite(join(dir, 'cron-fresh.sqlite'));
    try {
      const freshStore = new CronJobStore(fresh);
      await Promise.all([freshStore.ensureTable(), freshStore.ensureTable()]);
      expect(await fresh.schema.hasTable('cron_jobs')).toBe(true);
      expect(await fresh.schema.hasTable('cron_runs')).toBe(true);
      // 建表结构健全：裸插入走默认值，读取得到规范记录
      await fresh('cron_jobs').insert({
        id: 'raw-1',
        name: 'raw',
        expr: '* * * * *',
        tz: 'UTC',
        created_at: 1,
      });
      await expect(freshStore.get('raw-1')).resolves.toMatchObject({
        id: 'raw-1',
        extId: null,
        enabled: true,
        overlap: 'skip',
        misfire: 'skip',
        payload: null,
        lastRun: null,
        nextRun: null,
      });
    } finally {
      await fresh.destroy();
    }
  });
});

describe('create / get：payload JSON 往返', () => {
  it('对象 payload 往返一致；全部字段正确映射（camelCase 视图）', async () => {
    const rec = makeRecord({
      id: 'rt-1',
      extId: 'roundtrip-ext',
      name: 'echo tick',
      expr: '0 9 * * 1-5',
      tz: 'Asia/Shanghai',
      payload: { text: 'hi', nested: { arr: [1, 'two', { three: 3 }] } },
      enabled: false,
      overlap: 'queue',
      misfire: 'runOnce',
      lastRun: 111,
      nextRun: 222,
      createdAt: 333,
    });
    await store.create(rec);
    await expect(store.get('rt-1')).resolves.toEqual(rec);
  });

  it('null / 标量 payload 往返一致；缺失 id 返回 null', async () => {
    await store.create(makeRecord({ id: 'rt-2', payload: null }));
    await store.create(makeRecord({ id: 'rt-3', payload: 'plain-string' }));
    await expect(store.get('rt-2')).resolves.toMatchObject({ payload: null });
    await expect(store.get('rt-3')).resolves.toMatchObject({ payload: 'plain-string' });
    await expect(store.get('missing-id')).resolves.toBeNull();
  });

  it('payload 损坏（非法 JSON）容错：记录照常返回，payload 置 null', async () => {
    await store.create(makeRecord({ id: 'broken-1' }));
    await db('cron_jobs').where('id', 'broken-1').update({ payload: '{not-json' });
    await expect(store.get('broken-1')).resolves.toMatchObject({ id: 'broken-1', payload: null });
    // list 同样不因单条损坏而炸
    const all = await store.list();
    expect(all.find((r) => r.id === 'broken-1')).toMatchObject({ payload: null });
  });
});

describe('list：排序与过滤', () => {
  it('按 created_at 升序返回全部；extId 字符串过滤；extId=null 只列内核级', async () => {
    // 三条内核级（乱序 createdAt）+ 两条 echo-bot（其余用例的记录仍在库中，断言前按本组 id 过滤）
    await store.create(makeRecord({ id: 'ls-k2', createdAt: 200 }));
    await store.create(makeRecord({ id: 'ls-k1', createdAt: 100 }));
    await store.create(makeRecord({ id: 'ls-k3', createdAt: 300 }));
    await store.create(makeRecord({ id: 'ls-e1', extId: 'echo-bot', createdAt: 150 }));
    await store.create(makeRecord({ id: 'ls-e2', extId: 'echo-bot', createdAt: 250 }));

    const wanted = ['ls-k1', 'ls-e1', 'ls-k2', 'ls-e2', 'ls-k3'];
    const all = (await store.list()).filter((r) => wanted.includes(r.id));
    expect(all.map((r) => r.id)).toEqual(wanted);

    expect((await store.list({ extId: 'echo-bot' })).map((r) => r.id)).toEqual(['ls-e1', 'ls-e2']);
    await expect(store.list({ extId: 'no-such-ext' })).resolves.toEqual([]);
    const kernelOnly = (await store.list({ extId: null })).filter((r) => wanted.includes(r.id));
    expect(kernelOnly.map((r) => r.id)).toEqual(['ls-k1', 'ls-k2', 'ls-k3']);
    expect(kernelOnly.every((r) => r.extId === null)).toBe(true);
  });
});

describe('update：只改给定字段', () => {
  it('仅写入的键变化，其余字段（含 payload/createdAt/水位）保持原值', async () => {
    const rec = makeRecord({
      id: 'up-1',
      name: 'before',
      expr: '0 0 * * *',
      tz: 'UTC',
      payload: { keep: true },
      enabled: true,
      overlap: 'skip',
      lastRun: 11,
      nextRun: 22,
      createdAt: 42,
    });
    await store.create(rec);

    const updated = await store.update('up-1', { name: 'after', enabled: false });
    expect(updated).toEqual({ ...rec, name: 'after', enabled: false });

    // 空 patch：仅回读，不改任何字段
    await expect(store.update('up-1', {})).resolves.toEqual(updated);
    // patch 中 undefined 值视为"未提供"，不抹掉原值
    await expect(store.update('up-1', { tz: undefined as unknown as string })).resolves.toMatchObject({ tz: 'UTC' });
  });

  it('更新不存在的任务返回 null；可更新水位与 extId', async () => {
    await expect(store.update('no-such-job', { name: 'x' })).resolves.toBeNull();

    await store.create(makeRecord({ id: 'up-2', extId: 'a', lastRun: 1, nextRun: 2 }));
    await expect(store.update('up-2', { extId: null, lastRun: 100, nextRun: 200 })).resolves.toMatchObject({
      id: 'up-2',
      extId: null,
      lastRun: 100,
      nextRun: 200,
    });
  });
});

describe('delete / setEnabled', () => {
  it('delete 存在 → true，再删 → false；get 回落 null', async () => {
    await store.create(makeRecord({ id: 'del-1' }));
    await expect(store.delete('del-1')).resolves.toBe(true);
    await expect(store.delete('del-1')).resolves.toBe(false);
    await expect(store.get('del-1')).resolves.toBeNull();
  });

  it('setEnabled 切换布尔；不存在的任务返回 null', async () => {
    await store.create(makeRecord({ id: 'en-1', enabled: true }));
    await expect(store.setEnabled('en-1', false)).resolves.toMatchObject({ enabled: false });
    await expect(store.setEnabled('en-1', true)).resolves.toMatchObject({ enabled: true });
    await expect(store.setEnabled('no-such-job', true)).resolves.toBeNull();
  });
});

describe('touchRun / recordRun / history', () => {
  it('touchRun 写入 last_run/next_run；传 null 清除', async () => {
    await store.create(makeRecord({ id: 'tr-1', lastRun: null, nextRun: null }));
    await store.touchRun('tr-1', { lastRun: 500, nextRun: 600 });
    await expect(store.get('tr-1')).resolves.toMatchObject({ lastRun: 500, nextRun: 600 });
    await store.touchRun('tr-1', { lastRun: null, nextRun: null });
    await expect(store.get('tr-1')).resolves.toMatchObject({ lastRun: null, nextRun: null });
    // 任务不存在：静默无操作不炸
    await expect(store.touchRun('no-such-job', { lastRun: 1, nextRun: 2 })).resolves.toBeUndefined();
  });

  it('recordRun + history：按 started_at 降序，字段类型正确映射', async () => {
    await store.recordRun({ jobId: 'run-1', startedAt: 300, finishedAt: 350, ok: true, durationMs: 50 });
    await store.recordRun({ jobId: 'run-1', startedAt: 100, ok: false, error: 'boom' });
    await store.recordRun({ jobId: 'run-1', startedAt: 200, finishedAt: 210, ok: true, durationMs: 10 });

    await expect(store.history('run-1')).resolves.toEqual([
      { startedAt: 300, finishedAt: 350, ok: true, durationMs: 50, error: null },
      { startedAt: 200, finishedAt: 210, ok: true, durationMs: 10, error: null },
      { startedAt: 100, finishedAt: null, ok: false, durationMs: null, error: 'boom' },
    ]);
  });

  it('history limit 生效（取最新 N 条）；无记录返回 []', async () => {
    for (let i = 1; i <= 5; i += 1) {
      await store.recordRun({ jobId: 'run-2', startedAt: i * 10, ok: true });
    }
    await expect(store.history('run-2', 2)).resolves.toEqual([
      { startedAt: 50, finishedAt: null, ok: true, durationMs: null, error: null },
      { startedAt: 40, finishedAt: null, ok: true, durationMs: null, error: null },
    ]);
    await expect(store.history('run-2')).resolves.toHaveLength(5);
    await expect(store.history('no-runs-job')).resolves.toEqual([]);
  });

  it('history 默认 50 条：写入 55 条只取最新 50 条', async () => {
    for (let i = 1; i <= 55; i += 1) {
      await store.recordRun({ jobId: 'run-3', startedAt: i, ok: true });
    }
    const rows = await store.history('run-3');
    expect(rows).toHaveLength(50);
    expect(rows[0]?.startedAt).toBe(55); // 最新在前
    expect(rows[49]?.startedAt).toBe(6);
  });
});

describe('错误与边界', () => {
  it('create/update 传入不可序列化 payload → HarnessError(DB_ERROR HARNESS-4003)', async () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    await expect(store.create(makeRecord({ id: 'bad-1', payload: circular }))).rejects.toMatchObject({
      code: 'HARNESS-4003',
    });
    await store.create(makeRecord({ id: 'bad-2' }));
    await expect(store.update('bad-2', { payload: circular })).rejects.toMatchObject({ code: 'HARNESS-4003' });
    // 失败的 update 不改库
    await expect(store.get('bad-2')).resolves.toMatchObject({ payload: null });
  });
});
