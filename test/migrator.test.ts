import knex, { type Knex } from 'knex';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HarnessError } from '../src/kernel/errors/index.js';
import { Migrator, type Migration } from '../src/kernel/storage/migrator.js';

let db: Knex;

beforeEach(async () => {
  // :memory: 必须单连接池，否则事务与外层查询落在不同内存库上
  db = knex({ client: 'better-sqlite3', connection: ':memory:', pool: { min: 1, max: 1 }, useNullAsDefault: true });
  await db.schema.createTable('events', (t) => {
    t.string('name');
  });
});

afterEach(async () => {
  await db.destroy();
});

interface TrackOpts {
  /** false = 迁移不带 down（不可回滚） */
  withDown?: boolean;
  /** true = up 中途抛错 */
  upThrows?: boolean;
}

/** 构造把执行足迹写入 events 表的迁移（up/down 各追加一条 `<name>:<phase>`） */
function tracked(name: string, opts: TrackOpts = {}): Migration {
  return {
    name,
    up: async (trx) => {
      await trx('events').insert({ name: `${name}:up` });
      if (opts.upThrows) throw new Error(`boom in ${name}`);
    },
    ...(opts.withDown === false ? {} : { down: async (trx) => { await trx('events').insert({ name: `${name}:down` }); } }),
  };
}

async function eventNames(): Promise<string[]> {
  const rows = await db<{ name: string }>('events').select('name');
  return rows.map((r) => r.name);
}

describe('Migrator.latest', () => {
  it('按数组顺序应用、记账 batch=1、返回应用数量、重复调用幂等', async () => {
    const m = new Migrator(db, { migrations: [tracked('a'), tracked('b'), tracked('c')] });
    expect(await m.latest()).toBe(3);
    expect(await eventNames()).toEqual(['a:up', 'b:up', 'c:up']);

    const applied = await m.applied();
    expect(applied.map((r) => r.name)).toEqual(['a', 'b', 'c']);
    expect(applied.every((r) => r.batch === 1)).toBe(true);
    expect(applied.every((r) => Number.isInteger(r.appliedAt) && r.appliedAt > 0)).toBe(true);

    // 幂等：已应用的不再执行
    expect(await m.latest()).toBe(0);
    expect(await eventNames()).toEqual(['a:up', 'b:up', 'c:up']);
  });

  it('batch 随调用递增：新追加的迁移落在 max(batch)+1 批', async () => {
    const migrations: Migration[] = [tracked('a')];
    const m = new Migrator(db, { migrations });
    await m.latest();

    migrations.push(tracked('b'), tracked('c'));
    expect(await m.latest()).toBe(2);
    expect(await m.applied()).toEqual([
      { name: 'a', batch: 1, appliedAt: expect.any(Number) },
      { name: 'b', batch: 2, appliedAt: expect.any(Number) },
      { name: 'c', batch: 2, appliedAt: expect.any(Number) },
    ]);
  });

  it('中途失败：抛 DB_MIGRATION_FAILED 且 detail.name 正确、失败迁移事务回滚且不记账', async () => {
    // 第二个迁移：先建表再抛错——事务回滚后表不应存在
    const second: Migration = {
      name: 'second',
      up: async (trx) => {
        await trx.schema.createTable('t_second', (t) => t.string('x'));
        await trx('events').insert({ name: 'second:up' });
        throw new Error('boom in second');
      },
    };
    const first = tracked('first');
    const m = new Migrator(db, { migrations: [first, second] });

    const failure = await m.latest().then(
      () => null,
      (e) => e,
    );
    expect(failure).toBeInstanceOf(HarnessError);
    const he = failure as HarnessError;
    expect(he.code).toBe('HARNESS-4001'); // DB_MIGRATION_FAILED
    expect(he.message).toBe('database migration failed');
    const detail = he.detail as { name: string; cause: unknown };
    expect(detail.name).toBe('second');
    expect((detail.cause as Error).message).toBe('boom in second');
    expect(he.cause).toBe(detail.cause);

    // 第一个迁移已提交（表 + 记账），第二个已回滚且无记账
    expect(await db.schema.hasTable('migrations_log')).toBe(true);
    expect((await m.applied()).map((r) => r.name)).toEqual(['first']);
    expect(await eventNames()).toEqual(['first:up']);
  });

  it('中途失败后再次 latest 只跑剩余（已应用的不再执行）', async () => {
    const failing: Migration[] = [tracked('first'), tracked('second', { upThrows: true }), tracked('third')];
    const m = new Migrator(db, { migrations: failing });
    await expect(m.latest()).rejects.toMatchObject({ name: 'HarnessError', code: 'HARNESS-4001' });
    expect(await eventNames()).toEqual(['first:up']);

    // 修复第二个迁移后重跑：first 不重复执行，second/third 落在新批次
    const fixed: Migration[] = [tracked('first'), tracked('second'), tracked('third')];
    const m2 = new Migrator(db, { migrations: fixed });
    expect(await m2.latest()).toBe(2);
    expect(await eventNames()).toEqual(['first:up', 'second:up', 'third:up']);
    const applied = await m2.applied();
    expect(applied.find((r) => r.name === 'first')?.batch).toBe(1);
    expect(applied.find((r) => r.name === 'second')?.batch).toBe(2);
    expect(applied.find((r) => r.name === 'third')?.batch).toBe(2);
  });
});

describe('Migrator.rollback', () => {
  it('回滚最大批次：逆序调 down、清记账、pending 恢复', async () => {
    const m = new Migrator(db, { migrations: [tracked('a'), tracked('b'), tracked('c')] });
    await m.latest();
    expect(await m.rollback()).toBe(3);

    // down 逆序：c → b → a
    expect(await eventNames()).toEqual(['a:up', 'b:up', 'c:up', 'c:down', 'b:down', 'a:down']);
    expect(await m.applied()).toEqual([]);
    expect(await m.pending()).toEqual(['a', 'b', 'c']);

    // 账已清空：再回滚返回 0
    expect(await m.rollback()).toBe(0);
  });

  it('只回滚最新批次，旧批次保留', async () => {
    const migrations: Migration[] = [tracked('a')];
    const m = new Migrator(db, { migrations });
    await m.latest();
    migrations.push(tracked('b'));
    await m.latest();

    expect(await m.rollback()).toBe(1);
    expect(await eventNames()).toEqual(['a:up', 'b:up', 'b:down']);
    const applied = await m.applied();
    expect(applied.map((r) => r.name)).toEqual(['a']);
    expect(applied[0]?.batch).toBe(1);
  });

  it('down 缺失的迁移跳过：不执行 down、保留记账、不计入返回值', async () => {
    const m = new Migrator(db, {
      migrations: [tracked('a'), tracked('b', { withDown: false }), tracked('c')],
    });
    await m.latest();
    expect(await m.rollback()).toBe(2);

    // 逆序回滚时 b 被跳过：c 先于 a，b 不产生 down 足迹
    expect(await eventNames()).toEqual(['a:up', 'b:up', 'c:up', 'c:down', 'a:down']);
    const applied = await m.applied();
    expect(applied.map((r) => r.name)).toEqual(['b']);
    expect(applied[0]?.batch).toBe(1);
    expect(await m.pending()).toEqual(['a', 'c']);
  });

  it('空账 / 全部跳过时返回 0', async () => {
    const m = new Migrator(db, { migrations: [tracked('a', { withDown: false })] });
    expect(await m.rollback()).toBe(0);
    await m.latest();
    // 唯一迁移无 down → 全跳过，返回 0 且记账保留
    expect(await m.rollback()).toBe(0);
    expect((await m.applied()).map((r) => r.name)).toEqual(['a']);
  });

  it('down 抛错：事务回滚、记账保留、抛 DB_MIGRATION_FAILED', async () => {
    const badDown: Migration = {
      name: 'a',
      up: async () => {},
      down: async () => {
        throw new Error('boom in down');
      },
    };
    const m = new Migrator(db, { migrations: [badDown] });
    await m.latest();

    const failure = await m.rollback().then(
      () => null,
      (e) => e,
    );
    expect(failure).toBeInstanceOf(HarnessError);
    expect((failure as HarnessError).code).toBe('HARNESS-4001');
    const detail = (failure as HarnessError).detail as { name: string; cause: unknown };
    expect(detail.name).toBe('a');
    expect((detail.cause as Error).message).toBe('boom in down');
    expect(await m.applied()).toEqual([{ name: 'a', batch: 1, appliedAt: expect.any(Number) }]);
  });
});

describe('Migrator.applied / pending / 记账表', () => {
  it('applied/pending 形状与顺序正确', async () => {
    const m = new Migrator(db, { migrations: [tracked('a'), tracked('b')] });
    expect(await m.pending()).toEqual(['a', 'b']);
    expect(await m.applied()).toEqual([]);

    await m.latest();
    expect(await m.applied()).toEqual([
      { name: 'a', batch: 1, appliedAt: expect.any(Number) },
      { name: 'b', batch: 1, appliedAt: expect.any(Number) },
    ]);
    expect(await m.pending()).toEqual([]);
  });

  it('默认创建 migrations_log 记账表，opts.table 可自定义', async () => {
    const def = new Migrator(db, { migrations: [tracked('a')] });
    await def.latest();
    expect(await db.schema.hasTable('migrations_log')).toBe(true);

    const custom = new Migrator(db, { table: 'ext_foo_log', migrations: [tracked('a')] });
    await custom.latest();
    expect(await db.schema.hasTable('ext_foo_log')).toBe(true);
    // 自定义记账表与默认表互不干扰：同一迁移在两本账里各记一行
    expect((await custom.applied()).map((r) => r.name)).toEqual(['a']);
  });

  it('记账表 schema：name TEXT PK / batch INTEGER / applied_at INTEGER epoch ms', async () => {
    // before 必须在首个 migrate 之前采样：断言要求所有 applied_at >= before（含 a）
    const before = Date.now();
    const m = new Migrator(db, { migrations: [tracked('a')] });
    await m.latest();
    const cols = await db('migrations_log').columnInfo();
    expect(cols.name?.type).toBe('text');
    expect(cols.batch?.type).toBe('integer');
    expect(cols.applied_at?.type).toBe('integer');

    const m2 = new Migrator(db, { migrations: [tracked('a'), tracked('b')] });
    expect(await m2.latest()).toBe(1); // m 已应用 a，这里只剩 b
    const rows = await db<{ name: string; batch: number; applied_at: number }>('migrations_log')
      .select('name', 'batch', 'applied_at');
    expect(rows.map((r) => ({ name: r.name, batch: r.batch }))).toEqual([
      { name: 'a', batch: 1 },
      { name: 'b', batch: 2 },
    ]);
    for (const r of rows) {
      expect(r.applied_at).toBeGreaterThanOrEqual(before);
      expect(r.applied_at).toBeLessThanOrEqual(Date.now());
    }
  });
});
