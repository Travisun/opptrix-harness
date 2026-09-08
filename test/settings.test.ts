import knex, { type Knex } from 'knex';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SettingsService } from '../src/kernel/storage/settings.js';

let db: Knex;
let svc: SettingsService;

beforeEach(() => {
  db = knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    pool: { min: 1, max: 1 },
    useNullAsDefault: true,
  });
  svc = new SettingsService(db);
});

afterEach(async () => {
  await db.destroy();
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function rawUpdatedAt(key: string): Promise<number | undefined> {
  const row = (await db('settings').where('key', key).first('updated_at')) as
    | { updated_at: number | null }
    | undefined;
  return row?.updated_at ?? undefined;
}

describe('SettingsService 基本读写', () => {
  it('set 后 get 返回原值（对象/字符串/数字/布尔/null/数组）', async () => {
    await svc.set('obj', { a: 1, nested: { b: 'x' } });
    await svc.set('str', 'hello');
    await svc.set('num', 42);
    await svc.set('bool', false);
    await svc.set('nil', null);
    await svc.set('arr', [1, 'two', { three: 3 }]);

    await expect(svc.get('obj')).resolves.toEqual({ a: 1, nested: { b: 'x' } });
    await expect(svc.get('str')).resolves.toBe('hello');
    await expect(svc.get('num')).resolves.toBe(42);
    await expect(svc.get('bool')).resolves.toBe(false);
    await expect(svc.get('nil')).resolves.toBeNull();
    await expect(svc.get('arr')).resolves.toEqual([1, 'two', { three: 3 }]);
  });

  it('缺失键 → undefined；带 fallback → fallback', async () => {
    await expect(svc.get('missing')).resolves.toBeUndefined();
    await expect(svc.get('missing', 'fb')).resolves.toBe('fb');
    await expect(svc.get('missing', { d: 1 })).resolves.toEqual({ d: 1 });
  });

  it('覆盖更新：同 key 写两次 → 取最新值，all() 只有 1 条', async () => {
    await svc.set('k', 'v1');
    await svc.set('k', { v: 2 });
    await expect(svc.get('k')).resolves.toEqual({ v: 2 });
    const all = await svc.all();
    expect(Object.keys(all)).toEqual(['k']);
  });

  it('覆盖更新 updated_at 变化（UTC epoch ms，取自 Date.now）', async () => {
    const before = Date.now();
    await svc.set('k', 1);
    const first = await rawUpdatedAt('k');
    await sleep(5); // ms 精度：确保覆盖写入时刻严格更晚
    await svc.set('k', 2);
    const second = await rawUpdatedAt('k');

    expect(typeof first).toBe('number');
    expect(first).toBeGreaterThanOrEqual(before);
    expect(second).toBeGreaterThan(first as number); // 覆盖更新后 updated_at 变化
  });
});

describe('SettingsService delete / all', () => {
  it('delete：存在 → true，再删 → false；删除后 get 回落 fallback', async () => {
    await svc.set('k', 'v');
    await expect(svc.delete('k')).resolves.toBe(true);
    await expect(svc.delete('k')).resolves.toBe(false);
    await expect(svc.get('k', 'fallback')).resolves.toBe('fallback');
  });

  it('all()：返回全部键值（反序列化后）', async () => {
    await svc.set('a', 1);
    await svc.set('b', { x: 'y' });
    await svc.set('c', [true]);
    await expect(svc.all()).resolves.toEqual({ a: 1, b: { x: 'y' }, c: [true] });
  });

  it('all()：空表 → 空对象', async () => {
    await expect(svc.all()).resolves.toEqual({});
  });
});

describe('SettingsService JSON 损坏容错', () => {
  it('value 为非法 JSON → get 返回 fallback，不抛错', async () => {
    await svc.set('seed', 1); // 触发建表
    await db('settings').insert({ key: 'broken', value: '{not-json', updated_at: Date.now() });
    await expect(svc.get('broken', 'safe-fallback')).resolves.toBe('safe-fallback');
    await expect(svc.get('broken')).resolves.toBeUndefined();
  });

  it('all() 跳过损坏行，健康行正常返回', async () => {
    await svc.set('good', { ok: true }); // 触发建表
    await db('settings').insert({ key: 'broken', value: '{{{', updated_at: Date.now() });
    await expect(svc.all()).resolves.toEqual({ good: { ok: true } });
  });
});

describe('SettingsService 惰性建表与入参校验', () => {
  it('表不存在时首次操作自动建表；多个实例共享同一库幂等共存', async () => {
    const svc2 = new SettingsService(db);
    await svc.set('a', 1);
    await svc2.set('b', 2);
    await expect(svc.get('b')).resolves.toBe(2);
    await expect(svc2.get('a')).resolves.toBe(1);
    // 第二个实例建表路径：hasTable=true → 跳过 create
    await expect(svc2.all()).resolves.toEqual({ a: 1, b: 2 });
  });

  it('set 值不可 JSON 序列化（undefined）→ HarnessError(DB_ERROR)', async () => {
    await expect(svc.set('bad', undefined)).rejects.toMatchObject({ code: 'HARNESS-4003' });
  });

  it('set 循环引用 → HarnessError(DB_ERROR)，消息含 key', async () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    await expect(svc.set('circular', circular)).rejects.toMatchObject({
      code: 'HARNESS-4003',
      message: expect.stringContaining('circular'),
    });
  });

  it('空 key / 空 name 校验 → HarnessError(DB_ERROR)', async () => {
    await expect(svc.set('', 1)).rejects.toMatchObject({ code: 'HARNESS-4003' });
    await expect(svc.get('')).rejects.toMatchObject({ code: 'HARNESS-4003' });
    await expect(svc.delete('')).rejects.toMatchObject({ code: 'HARNESS-4003' });
  });
});
