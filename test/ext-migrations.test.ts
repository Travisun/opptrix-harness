/**
 * 扩展迁移机制（worker host.load 内嵌迁移步骤）契约测试 — 真 worker 线程 + 最小内核桩。
 *
 * 链路：vitest 主线程 spawn src/extension-host/worker.ts（dev 模式，tsx loader）→
 * 测试侧充当"内核桩"：应答 worker→kernel 的 db.run/db.all/db.get（better-sqlite3
 * 每扩展一个文件库 + 内核同款 forbidDangerousSql 复核）与 log（静默），并发起
 * host.load / host.unload。不启动完整 Kernel——迁移机制全部发生在扩展线程内，
 * 内核侧只需要 db RPC 通路（与生产 kernel-handlers 的 db.* 同语义）。
 *
 * 覆盖：目录缺失/为空降级（applied=0）/ 文件名序执行 + setup 在迁移后执行 /
 * migrations_log 记账形状与批次 / unload 后重载幂等 / 新增迁移续跑 batch=max+1 /
 * up 抛错 → HARNESS-4001 且 setup 未执行 / 失败留部分记账 + 修复后重 load 续跑 /
 * up 缺失 fail-fast / module.exports.default 归一 / 违禁 SQL 双保险 / 非 .js 与
 * 子目录忽略 / down v1 不被调用。另有 listMigrationFiles / loadMigrations 纯函数单测。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';

import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { HOST_METHODS, KERNEL_TOPICS } from '../src/extension-host/protocol.js';
import type { RpcEnvelope } from '../src/extension-host/protocol.js';
import { listMigrationFiles, loadMigrations } from '../src/extension-host/worker.js';
import { err } from '../src/kernel/errors/index.js';
import { forbidDangerousSql } from '../src/kernel/storage/db.js';

// ---------------------------------------------------------------------------
// 装配：真 worker 线程 + 内核桩
// ---------------------------------------------------------------------------

/** worker 入口（src，dev 模式：tsx loader 剥离 TS，不受 dist 新鲜度影响） */
const WORKER_ENTRY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'extension-host', 'worker.ts');

/** DB_MIGRATION_FAILED 的线上码（codes.ts：DB 域 seq1） */
const DB_MIGRATION_FAILED_CODE = err('DB_MIGRATION_FAILED').code;

let tmpRoot = '';
let worker: Worker;

/** host.load/host.unload 的挂起 Promise（id → 结算器） */
const hostPending = new Map<string, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();

/** 每扩展一个 better-sqlite3 文件库（内核桩的 db.* 存储面） */
const dbs = new Map<string, Database.Database>();

/** 内核桩收到的 log 信封（level/msg 供调试；正常断言不依赖） */
const kernelLogs: Array<{ level: unknown; msg: unknown }> = [];

function extDbOf(extId: string): Database.Database {
  const cached = dbs.get(extId);
  if (cached !== undefined) return cached;
  const file = path.join(tmpRoot, 'db', 'ext', `${extId}.sqlite`);
  mkdirSync(path.dirname(file), { recursive: true }); // 与内核 extDbPath 同语义：目录不存在则递归创建
  const opened = new Database(file);
  dbs.set(extId, opened);
  return opened;
}

/** 内核桩：应答 worker→kernel call（db.run / db.all / db.get / log；其余 topic 一律 NOT_FOUND） */
async function serveKernelCall(env: RpcEnvelope): Promise<void> {
  const replyOk = (payload: unknown): void => {
    worker.postMessage({ v: 1, id: env.id, from: 'kernel', to: env.from, type: 'reply', topic: env.topic, ok: true, payload });
  };
  const replyErr = (code: string, message: string): void => {
    worker.postMessage({ v: 1, id: env.id, from: 'kernel', to: env.from, type: 'reply', topic: env.topic, ok: false, err: { code, message } });
  };
  const payload = (env.payload ?? {}) as { sql?: unknown; params?: unknown; level?: unknown; msg?: unknown };
  if (env.topic === KERNEL_TOPICS.log) {
    kernelLogs.push({ level: payload.level, msg: payload.msg });
    replyOk({ ok: true });
    return;
  }
  const extId = env.from.startsWith('ext:') ? env.from.slice('ext:'.length) : '';
  if (extId === '') {
    replyErr(err('RPC_PERMISSION_DENIED').code, `stub kernel: caller "${env.from}" is not an extension endpoint`);
    return;
  }
  if (env.topic !== KERNEL_TOPICS.dbRun && env.topic !== KERNEL_TOPICS.dbAll && env.topic !== KERNEL_TOPICS.dbGet) {
    replyErr(err('RPC_TARGET_NOT_FOUND').code, `stub kernel has no handler for "${env.topic}"`);
    return;
  }
  try {
    const sql = typeof payload.sql === 'string' ? payload.sql : '';
    if (sql === '') throw err('BAD_REQUEST', { message: `${env.topic} requires a non-empty "sql"` });
    forbidDangerousSql(sql); // 与内核 kernel-handlers 同款复核（双保险的内核侧）
    const params = Array.isArray(payload.params) ? (payload.params as unknown[]) : [];
    const db = extDbOf(extId);
    if (env.topic === KERNEL_TOPICS.dbRun) {
      const info = db.prepare(sql).run(...params);
      replyOk({ changes: Number(info.changes) });
      return;
    }
    const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
    replyOk(env.topic === KERNEL_TOPICS.dbAll ? rows : (rows[0] ?? null));
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    replyErr(typeof code === 'string' ? code : err('DB_ERROR').code, e instanceof Error ? e.message : String(e));
  }
}

function rejectAllPending(cause: Error): void {
  for (const [id, entry] of hostPending) {
    entry.reject(cause);
    hostPending.delete(id);
  }
}

beforeAll(async () => {
  tmpRoot = await mkdtemp(path.join(tmpdir(), 'opptrix-ext-migrations-'));
  worker = new Worker(WORKER_ENTRY, { execArgv: ['--import', 'tsx'] });
  worker.on('message', (env: RpcEnvelope) => {
    if (env === null || typeof env !== 'object') return;
    if (env.type === 'reply') {
      const entry = hostPending.get(env.id);
      if (entry === undefined) return; // 迟到回执安全丢弃
      hostPending.delete(env.id);
      if (env.ok === true) {
        entry.resolve(env.payload);
        return;
      }
      const failure = new Error(env.err?.message ?? 'host call failed') as Error & { code?: string; detail?: unknown };
      failure.code = env.err?.code;
      failure.detail = env.err?.detail;
      entry.reject(failure);
      return;
    }
    if (env.type === 'call' || env.type === 'dispatch') {
      void serveKernelCall(env).catch((e: unknown) => {
        worker.postMessage({
          v: 1, id: env.id, from: 'kernel', to: env.from, type: 'reply', topic: env.topic, ok: false,
          err: { code: 'RPC_HANDLER_ERROR', message: e instanceof Error ? e.message : String(e) },
        });
      });
    }
  });
  worker.on('error', (cause: Error) => rejectAllPending(cause));
  worker.on('exit', () => rejectAllPending(new Error('extension worker exited before all host calls settled')));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('extension worker did not become ready in time')), 60_000);
    worker.on('online', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}, 90_000);

afterAll(async () => {
  await worker?.terminate();
  for (const db of dbs.values()) void db.close();
  if (tmpRoot !== '') await rm(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 测试侧助手：扩展目录落盘 + host.load / host.unload
// ---------------------------------------------------------------------------

/** 落盘一个扩展目录：files 的 key 相对 extDir（自动建父目录） */
async function writeExt(extId: string, files: Record<string, string>): Promise<string> {
  const extDir = path.join(tmpRoot, 'extensions', extId);
  for (const [rel, code] of Object.entries(files)) {
    const file = path.join(extDir, rel);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, code, 'utf8');
  }
  return extDir;
}

const SETUP_INDEX = `'use strict';
defineExtension(async (h) => {
  await h.db.run('INSERT INTO t (a) VALUES (?)', ['setup-ran']);
});
`;

/** 发起 host.load 并等回执（成功 → payload；失败 → 带 code 的 Error 拒绝） */
function hostLoad(extId: string, extDir: string): Promise<{ ok?: unknown; migrationsApplied?: unknown; contributions?: unknown }> {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const timer = setTimeout(() => {
      hostPending.delete(id);
      reject(new Error(`host.load of "${extId}" timed out on the stub kernel`));
    }, 60_000);
    const settle = (fn: () => void): void => {
      clearTimeout(timer);
      fn();
    };
    hostPending.set(id, {
      resolve: (v) => settle(() => resolve(v as { ok?: unknown; migrationsApplied?: unknown; contributions?: unknown })),
      reject: (e) => settle(() => reject(e)),
    });
    worker.postMessage({
      v: 1,
      id,
      from: 'kernel',
      to: `ext:${extId}`,
      type: 'call',
      topic: HOST_METHODS.loadExt,
      payload: { extId, extDir, manifest: { id: extId, main: 'index.js' }, dataDir: tmpRoot },
    });
  });
}

/** 发起 host.unload（生产 re-enable 路径：unload → load） */
function hostUnload(extId: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const timer = setTimeout(() => {
      hostPending.delete(id);
      reject(new Error(`host.unload of "${extId}" timed out on the stub kernel`));
    }, 30_000);
    hostPending.set(id, {
      resolve: (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });
    worker.postMessage({
      v: 1,
      id,
      from: 'kernel',
      to: `ext:${extId}`,
      type: 'call',
      topic: HOST_METHODS.unloadExt,
      payload: { extId },
    });
  });
}

/** 断言 load 失败回执的 err 形状（HARNESS-4001 DB_MIGRATION_FAILED） */
function expectMigrationFailure(err0: unknown): { code: string; message: string; detail: unknown } {
  const failure = err0 as { code?: string; message?: string; detail?: unknown };
  expect(failure?.code).toBe(DB_MIGRATION_FAILED_CODE);
  expect(typeof failure?.message).toBe('string');
  return { code: failure.code ?? '', message: failure.message ?? '', detail: failure.detail };
}

// ---------------------------------------------------------------------------
// 纯函数单测（主线程导入 worker.ts：parentPort 为 null，无副作用）
// ---------------------------------------------------------------------------

describe('listMigrationFiles / loadMigrations（纯函数）', () => {
  it('listMigrationFiles：目录不存在返回 []（降级），仅取普通 .js 文件且文件名排序', async () => {
    expect(listMigrationFiles(path.join(tmpRoot, 'no-such-ext-dir'))).toEqual([]);

    const extDir = path.join(tmpRoot, 'unit-scan');
    await mkdir(path.join(extDir, 'migrations', 'nested'), { recursive: true });
    await writeFile(path.join(extDir, 'migrations', '020_b.js'), 'x', 'utf8');
    await writeFile(path.join(extDir, 'migrations', '010_a.js'), 'x', 'utf8');
    await writeFile(path.join(extDir, 'migrations', 'README.md'), 'x', 'utf8');
    await writeFile(path.join(extDir, 'migrations', 'nested', '990_nested.js'), 'x', 'utf8');
    await writeFile(path.join(extDir, 'migrations', '030.txt'), 'x', 'utf8');
    expect(listMigrationFiles(extDir)).toEqual(['010_a.js', '020_b.js']);
  });

  it('loadMigrations：归一 module.exports / .default，保留 down；up 缺失抛 DB_MIGRATION_FAILED 且 detail 带文件名', () => {
    const up = (): void => {};
    const down = (): void => {};
    const loaded = loadMigrations(
      (spec) => (spec === './migrations/a.js' ? { up, down } : { default: { up } }),
      ['a.js', 'b.js'],
    );
    expect(loaded).toEqual([
      { name: 'a.js', up, down },
      { name: 'b.js', up, down: undefined },
    ]);

    try {
      loadMigrations(() => ({}), ['010_bad.js']);
      expect.unreachable('missing up must fail fast');
    } catch (e) {
      expect((e as { code?: string }).code).toBe(DB_MIGRATION_FAILED_CODE);
      expect((e as { message?: string }).message).toContain('010_bad.js');
      expect((e as { detail?: { file?: string } }).detail?.file).toBe('migrations/010_bad.js');
    }
  });
});

// ---------------------------------------------------------------------------
// 真 worker：host.load 内嵌迁移步骤
// ---------------------------------------------------------------------------

describe('扩展迁移机制（真 worker）', () => {
  it('降级：无 migrations/ 目录 → load 成功且 migrationsApplied=0', async () => {
    const extDir = await writeExt('mig-none', {
      'index.js': `'use strict';\ndefineExtension(function () {});\n`,
    });
    const reply = await hostLoad('mig-none', extDir);
    expect(reply.ok).toBe(true);
    expect(reply.migrationsApplied).toBe(0);
    expect(reply.contributions).toMatchObject({ routes: [], events: [], hooks: [], services: [] });
  });

  it('降级：migrations/ 目录为空 → migrationsApplied=0（不建记账表）', async () => {
    const extDir = await writeExt('mig-empty', {
      'index.js': `'use strict';\ndefineExtension(function () {});\n`,
      'migrations/.keep': '',
    });
    const reply = await hostLoad('mig-empty', extDir);
    expect(reply.migrationsApplied).toBe(0);
    const db = extDbOf('mig-empty');
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='migrations_log'").all();
    expect(table).toHaveLength(0);
  });

  it('正常执行：文件名序 010→011，setup 在迁移之后执行，applied=2 随 load 回执', async () => {
    const extDir = await writeExt('mig-flow', {
      'index.js': SETUP_INDEX,
      'migrations/010_create.js': `'use strict';
module.exports = {
  async up(db) { await db.run('CREATE TABLE t (a TEXT)'); },
  async down(db) { await db.run('DROP TABLE t'); },
};
`,
      'migrations/011_seed.js': `'use strict';
module.exports = {
  async up(db) { await db.run('INSERT INTO t (a) VALUES (?)', ['seed-011']); },
};
`,
    });
    const reply = await hostLoad('mig-flow', extDir);
    expect(reply.ok).toBe(true);
    expect(reply.migrationsApplied).toBe(2);

    const db = extDbOf('mig-flow');
    // 执行序 = 文件名序：010 建表 → 011 插入 → setup（迁移后）再插一行
    const rows = db.prepare('SELECT a FROM t ORDER BY rowid').all() as Array<{ a: string }>;
    expect(rows.map((r) => r.a)).toEqual(['seed-011', 'setup-ran']);
  });

  it('记账表 migrations_log：name/batch/applied_at 形状、顺序与批次（首个批次 = 1）', async () => {
    const db = extDbOf('mig-flow');
    const rows = db.prepare('SELECT name, batch, applied_at FROM migrations_log ORDER BY rowid').all() as Array<{
      name: string;
      batch: number;
      applied_at: number;
    }>;
    expect(rows).toEqual([
      { name: '010_create.js', batch: 1, applied_at: expect.any(Number) },
      { name: '011_seed.js', batch: 1, applied_at: expect.any(Number) },
    ]);
    expect(rows.every((r) => Number.isFinite(r.applied_at) && r.applied_at > 0)).toBe(true);
  });

  it('幂等：unload 后重 load → applied=0，已记账迁移跳过且数据不重复', async () => {
    await hostUnload('mig-flow');
    const reply = await hostLoad('mig-flow', path.join(tmpRoot, 'extensions', 'mig-flow'));
    expect(reply.ok).toBe(true);
    expect(reply.migrationsApplied).toBe(0);
    const db = extDbOf('mig-flow');
    const seeds = db.prepare("SELECT COUNT(*) AS n FROM t WHERE a = 'seed-011'").get() as { n: number };
    expect(seeds.n).toBe(1);
    const logCount = db.prepare('SELECT COUNT(*) AS n FROM migrations_log').get() as { n: number };
    expect(logCount.n).toBe(2);
  });

  it('续跑：unload 后新增迁移 → 再 load applied=1，新批次 batch = max+1', async () => {
    const extDir = path.join(tmpRoot, 'extensions', 'mig-flow');
    await writeFile(
      path.join(extDir, 'migrations', '012_addcol.js'),
      `'use strict';
module.exports = { async up(db) { await db.run('ALTER TABLE t ADD COLUMN b TEXT'); } };
`,
      'utf8',
    );
    await hostUnload('mig-flow');
    const reply = await hostLoad('mig-flow', extDir);
    expect(reply.migrationsApplied).toBe(1);
    const db = extDbOf('mig-flow');
    const rows = db.prepare('SELECT name, batch FROM migrations_log ORDER BY rowid').all() as Array<{ name: string; batch: number }>;
    expect(rows.map((r) => r.name)).toEqual(['010_create.js', '011_seed.js', '012_addcol.js']);
    expect(rows[2]?.batch).toBe(2); // 前一批次为 1：新 load 一个批次，batch = max+1
  });

  it('失败语义：up 抛错 → load 整体失败（HARNESS-4001，message 带迁移名），setup 未执行', async () => {
    const extDir = await writeExt('mig-boom', {
      'index.js': SETUP_INDEX,
      'migrations/010_create.js': `'use strict';
module.exports = { async up(db) { await db.run('CREATE TABLE t (a TEXT)'); } };
`,
      'migrations/011_boom.js': `'use strict';
module.exports = { async up() { throw new Error('boom-011'); } };
`,
    });
    const err0 = await hostLoad('mig-boom', extDir).then(
      () => { throw new Error('load must fail when a migration throws'); },
      (e: unknown) => e,
    );
    const failure = expectMigrationFailure(err0);
    expect(failure.message).toContain('011_boom.js');
    expect(failure.message).toContain('boom-011');
    expect((failure.detail as { file?: string }).file).toBe('migrations/011_boom.js');

    // 中止语义：main 未加载、setup 未执行 → t 里只有迁移数据，没有 setup 标记
    const db = extDbOf('mig-boom');
    const rows = db.prepare('SELECT a FROM t').all() as Array<{ a: string }>;
    expect(rows).toEqual([]);
  });

  it('失败续跑：失败迁移不记账（部分记账保留）→ 修复文件后同 worker 重 load 成功', async () => {
    const extDir = path.join(tmpRoot, 'extensions', 'mig-boom');
    const db = extDbOf('mig-boom');
    // 失败后：010 已记账（batch 1），011 未记账
    let rows = db.prepare('SELECT name, batch FROM migrations_log ORDER BY rowid').all() as Array<{ name: string; batch: number }>;
    expect(rows).toEqual([{ name: '010_create.js', batch: 1 }]);

    // 修复 011（同一路径覆写）后重新 load：010 跳过、011 执行，batch = max+1 = 2
    await writeFile(
      path.join(extDir, 'migrations', '011_boom.js'),
      `'use strict';
module.exports = { async up(db) { await db.run('INSERT INTO t (a) VALUES (?)', ['seed-011']); } };
`,
      'utf8',
    );
    const reply = await hostLoad('mig-boom', extDir); // 失败的 load 不入注册表：同 worker 允许重试
    expect(reply.ok).toBe(true);
    expect(reply.migrationsApplied).toBe(1);
    rows = db.prepare('SELECT name, batch FROM migrations_log ORDER BY rowid').all() as Array<{ name: string; batch: number }>;
    expect(rows).toEqual([
      { name: '010_create.js', batch: 1 },
      { name: '011_boom.js', batch: 2 },
    ]);
    const data = db.prepare('SELECT a FROM t ORDER BY rowid').all() as Array<{ a: string }>;
    expect(data.map((r) => r.a)).toEqual(['seed-011', 'setup-ran']);
  });

  it('fail-fast：up 缺失（module.exports = {}）→ load 失败 HARNESS-4001，未执行任何迁移（无记账表）', async () => {
    const extDir = await writeExt('mig-invalid', {
      'index.js': SETUP_INDEX,
      'migrations/010_invalid.js': `'use strict';\nmodule.exports = {};\n`,
    });
    const err0 = await hostLoad('mig-invalid', extDir).then(
      () => { throw new Error('load must fail when migration shape is invalid'); },
      (e: unknown) => e,
    );
    const failure = expectMigrationFailure(err0);
    expect(failure.message).toContain('010_invalid.js');
    expect((failure.detail as { file?: string }).file).toBe('migrations/010_invalid.js');
    const db = extDbOf('mig-invalid');
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    expect(tables).toEqual([]); // 形状校验在任何执行之前 fail-fast：记账表都未建
  });

  it('归一：module.exports.default = { up } 亦可（worker 级）', async () => {
    const extDir = await writeExt('mig-default', {
      'index.js': `'use strict';\ndefineExtension(function () {});\n`,
      'migrations/010_d.js': `'use strict';
module.exports.default = { async up(db) { await db.run('CREATE TABLE d (x TEXT)'); } };
`,
    });
    const reply = await hostLoad('mig-default', extDir);
    expect(reply.migrationsApplied).toBe(1);
    const db = extDbOf('mig-default');
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='d'").all();
    expect(tables).toHaveLength(1);
  });

  it('双保险：up 内违禁 SQL（ATTACH）→ 内核侧拒绝被包装为 HARNESS-4001，激活中止', async () => {
    const extDir = await writeExt('mig-forbidden', {
      'index.js': SETUP_INDEX,
      'migrations/010_escape.js': `'use strict';
module.exports = { async up(db) { await db.run("ATTACH DATABASE 'other.sqlite' AS other"); } };
`,
    });
    const err0 = await hostLoad('mig-forbidden', extDir).then(
      () => { throw new Error('forbidden sql must fail the load'); },
      (e: unknown) => e,
    );
    const failure = expectMigrationFailure(err0);
    expect(failure.message).toContain('010_escape.js');
    expect(failure.message).toMatch(/attach/i); // 双保险：沙箱侧单语句预检先行拒绝（内核侧同规则复核）
    expect((failure.detail as { file?: string }).file).toBe('migrations/010_escape.js');
  });

  it('扫描边界：非 .js 文件与子目录被忽略，仅执行顶层 *.js；down v1 不被调用', async () => {
    const extDir = await writeExt('mig-scan', {
      'index.js': `'use strict';\ndefineExtension(function () {});\n`,
      'migrations/README.md': 'docs only',
      'migrations/010_ok.js': `'use strict';
let downCalled = false;
module.exports = {
  async up(db) { await db.run('CREATE TABLE s (x TEXT)'); },
  down() { downCalled = true; throw new Error('down must not run in v1'); },
};
`,
      'migrations/nested/990_nested.js': `'use strict';
module.exports = { async up() { throw new Error('nested must not run'); } };
`,
    });
    const reply = await hostLoad('mig-scan', extDir);
    expect(reply.migrationsApplied).toBe(1); // 仅 010_ok.js
    const db = extDbOf('mig-scan');
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='s'").all();
    expect(tables).toHaveLength(1);
  });
});
