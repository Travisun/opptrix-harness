/**
 * src/kernel/storage/db.ts 单元测试。
 * 覆盖：openSqlite + PRAGMA 生效、路径约定、extId 校验、SQL 防护、closeDb 生命周期、dbFileSize。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Knex } from 'knex';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { HarnessError } from '../src/kernel/errors/index.js';
import {
  closeDb,
  dbFileSize,
  extDbPath,
  forbidDangerousSql,
  kernelDbPath,
  openSqlite,
} from '../src/kernel/storage/db.js';

/** 取 knex raw 结果第一行第一个单元格的值（PRAGMA 回读） */
function firstVal(rows: unknown): unknown {
  const arr = rows as Array<Record<string, unknown>>;
  return Object.values(arr[0] ?? {})[0];
}

/** 同步捕获 HarnessError，未抛错则失败 */
function errOf(fn: () => void): HarnessError {
  try {
    fn();
  } catch (e) {
    if (e instanceof HarnessError) return e;
    throw e;
  }
  throw new Error('expected the call to throw HarnessError');
}

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'opptrix-db-'));
}

// ---------------------------------------------------------------------------
// openSqlite + PRAGMA
// ---------------------------------------------------------------------------

describe('openSqlite：PRAGMA 逐一生效', () => {
  let dir: string;
  let db: Knex;
  let file: string;

  beforeAll(async () => {
    dir = tmpRoot();
    // 故意用尚不存在的两层子目录，验证 openSqlite 自动递归建目录
    file = join(dir, 'db', 'kernel.sqlite');
    db = await openSqlite(file);
  });

  afterAll(async () => {
    await closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  });

  it('journal_mode 回读为 wal', async () => {
    const rows = await db.raw('PRAGMA journal_mode');
    expect(String(firstVal(rows)).toLowerCase()).toBe('wal');
  });

  it('foreign_keys 已开启（回读 = 1）', async () => {
    expect(Number(firstVal(await db.raw('PRAGMA foreign_keys')))).toBe(1);
  });

  it('busy_timeout = 5000', async () => {
    expect(Number(firstVal(await db.raw('PRAGMA busy_timeout')))).toBe(5000);
  });

  it('synchronous = 1（NORMAL）', async () => {
    expect(Number(firstVal(await db.raw('PRAGMA synchronous')))).toBe(1);
  });

  it('连接可用且能建表读写', async () => {
    await db.schema.createTable('t_probe', (t) => {
      t.increments('id');
      t.text('v');
    });
    await db('t_probe').insert({ v: 'hello' });
    const rows = await db('t_probe').select('v');
    expect(rows).toEqual([{ v: 'hello' }]);
    expect(existsSync(file)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 路径约定
// ---------------------------------------------------------------------------

describe('kernelDbPath / extDbPath 路径约定', () => {
  let dir: string;

  beforeAll(() => {
    dir = tmpRoot();
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('kernelDbPath → <dataDir>/db/kernel.sqlite', () => {
    expect(kernelDbPath({ dataDir: '/srv/harness' })).toBe('/srv/harness/db/kernel.sqlite');
  });

  it('extDbPath → <dataDir>/db/ext/<extId>.sqlite，并递归创建目录', () => {
    const p = extDbPath({ dataDir: dir }, 'hello.world-1');
    expect(p).toBe(join(dir, 'db', 'ext', 'hello.world-1.sqlite'));
    expect(existsSync(join(dir, 'db', 'ext'))).toBe(true);
  });

  it.each(['../evil', 'ABC', '.hidden', 'a/b', 'has space', ''])(
    'extDbPath 非法 extId（%j）抛 EXT_MANIFEST_INVALID（HARNESS-3001）',
    (badId) => {
      const e = errOf(() => extDbPath({ dataDir: dir }, badId));
      expect(e.code).toBe('HARNESS-3001');
      expect(e.detail).toMatchObject({ extId: badId });
    },
  );
});

// ---------------------------------------------------------------------------
// forbidDangerousSql
// ---------------------------------------------------------------------------

describe('forbidDangerousSql：单语句与危险关键词防护', () => {
  it.each([
    "ATTACH DATABASE 'foo.sqlite' AS extra",
    "attach database 'foo.sqlite' as extra",
    'DeTaCh DATABASE extra',
    "SELECT load_extension('/lib/evil.so')",
    'SELECT 1; SELECT 2; DROP TABLE t;',
    // SEC-5：VACUUM INTO 可把整库写到任意路径（跨库逃逸）
    "VACUUM INTO '/tmp/steal.db'",
    "vacuum main into 'out.db'",
  ])('拒绝：%j（HARNESS-4002）', (sql) => {
    const e = errOf(() => forbidDangerousSql(sql));
    expect(e.code).toBe('HARNESS-4002');
    expect(e.detail).toMatchObject({ reason: expect.stringMatching(/^multi-statement|forbidden-keyword$/) });
  });

  it.each([
    'SELECT id, name FROM users WHERE age > 18',
    'select * from t',
    'SELECT 1;', // 单个结尾分号允许
    '', // 空语句放行（执行层自有错误）
    "SELECT 'a;b' AS v", // 字符串里的分号不误判
    "INSERT INTO t (v) VALUES ('x;y;z');", // 字面量分号 + 单个结尾分号
    "SELECT * FROM notes WHERE body LIKE '%attach%'", // 字面量里的关键词不误判
    'SELECT "weird;name" FROM t', // 双引号标识符里的分号不误判
  ])('放行：%j', (sql) => {
    expect(() => forbidDangerousSql(sql)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// closeDb
// ---------------------------------------------------------------------------

describe('closeDb：关闭生命周期', () => {
  it('closeDb 后再查询，连接已销毁（查询拒绝）', async () => {
    const dir = tmpRoot();
    try {
      const db = await openSqlite(join(dir, 'a.sqlite'));
      await closeDb(db);
      await expect(db.raw('SELECT 1 AS one')).rejects.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('destroy 抛 EBUSY：记警告且不抛出', async () => {
    const busy = new Error('EBUSY: resource busy or locked') as NodeJS.ErrnoException;
    busy.code = 'EBUSY';
    const fakeBusy = { destroy: async () => { throw busy; } } as unknown as Knex;
    const warnSpy = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    try {
      await expect(closeDb(fakeBusy)).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('destroy 抛其他错误：包装为 HarnessError（DB_ERROR / HARNESS-4003）', async () => {
    const fakeFail = { destroy: async () => { throw new Error('boom'); } } as unknown as Knex;
    const caught: unknown = await closeDb(fakeFail).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(caught).toBeInstanceOf(HarnessError);
    expect((caught as HarnessError).code).toBe('HARNESS-4003');
    expect((caught as HarnessError).message).toBe('boom');
  });
});

// ---------------------------------------------------------------------------
// dbFileSize
// ---------------------------------------------------------------------------

describe('dbFileSize：主文件字节大小', () => {
  let dir: string;

  beforeAll(() => {
    dir = tmpRoot();
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('文件不存在返回 0', async () => {
    await expect(dbFileSize(join(dir, 'missing.sqlite'))).resolves.toBe(0);
  });

  it('只计主文件，-wal / -shm 不计入', async () => {
    const file = join(dir, 'main.sqlite');
    writeFileSync(file, 'AAAABBBB'); // 主文件 8 字节
    writeFileSync(`${file}-wal`, 'ZZZZZZZZZZZZ'); // 附属文件 12 字节
    await expect(dbFileSize(file)).resolves.toBe(8);
    await expect(dbFileSize(`${file}-wal`)).resolves.toBe(12); // 按路径直查附属文件也会如实返回
  });

  it('真实库写入后：等于主文件 statSync 大小且 > 0', async () => {
    const file = join(dir, 'real.sqlite');
    const db = await openSqlite(file);
    try {
      await db.schema.createTable('t_size', (t) => {
        t.increments('id');
        t.text('v');
      });
      await db('t_size').insert({ v: 'x'.repeat(1000) });
      const size = await dbFileSize(file);
      expect(size).toBe(statSync(file).size);
      expect(size).toBeGreaterThan(0);
    } finally {
      await closeDb(db);
    }
  });
});
