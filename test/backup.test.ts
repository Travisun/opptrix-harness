import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import Database from 'better-sqlite3';
import knex, { type Knex } from 'knex';
import { extract } from 'tar-stream';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { HarnessError } from '../src/kernel/errors/index.js';
import { createBackup, listBackups, pruneBackups } from '../src/kernel/storage/backup.js';

/* ---------- fixtures ---------- */

let baseDir: string;
const dbs: Knex[] = [];

interface Fixture {
  dataDir: string;
  db: Knex;
  dbFile: string;
}

beforeAll(async () => {
  baseDir = await mkdtemp(path.join(tmpdir(), 'opptrix-backup-'));
});

afterEach(async () => {
  for (const db of dbs.splice(0)) await db.destroy();
});

afterAll(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

async function makeFixture(dirname?: string): Promise<Fixture> {
  const dataDir = path.join(baseDir, dirname ?? randomUUID());
  await mkdir(dataDir, { recursive: true });
  const dbFile = path.join(dataDir, 'app.sqlite');
  const db = knex({
    client: 'better-sqlite3',
    connection: { filename: dbFile },
    useNullAsDefault: true,
  });
  dbs.push(db);
  await db.schema.createTable('items', (t) => {
    t.increments('id');
    t.text('name');
  });
  await db('items').insert([{ name: 'hello' }, { name: 'world' }]);
  return { dataDir, db, dbFile };
}

async function writeUploads(dataDir: string, relPath: string, content: string): Promise<void> {
  const abs = path.join(dataDir, 'uploads', relPath);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content, 'utf8');
}

/* ---------- 解包工具：直接用 tar-stream extract 校验归档内容 ---------- */

interface ArchiveContents {
  /** 条目顺序（manifest.json 应为第一项） */
  order: string[];
  files: Map<string, Buffer>;
  headers: Map<string, { size: number; mtime: Date }>;
}

async function extractArchive(archivePath: string): Promise<ArchiveContents> {
  const tar = gunzipSync(await readFile(archivePath));
  const ex = extract();
  const order: string[] = [];
  const files = new Map<string, Buffer>();
  const headers = new Map<string, { size: number; mtime: Date }>();

  // 先挂上迭代器再喂数据，确保不丢 'entry' 事件
  const consuming = (async () => {
    for await (const source of ex) {
      const name = source.header.name;
      const chunks: Buffer[] = [];
      for await (const chunk of source) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
      }
      order.push(name);
      files.set(name, Buffer.concat(chunks));
      headers.set(name, { size: source.header.size, mtime: source.header.mtime });
    }
  })();
  ex.end(tar);
  await consuming;
  return { order, files, headers };
}

function errCodeOf(e: unknown): string {
  expect(e).toBeInstanceOf(HarnessError);
  return (e as HarnessError).code;
}

/* ---------- tests ---------- */

describe('createBackup', () => {
  it('完整流程：产出 tar.gz、listBackups 可见、manifest 正确、db/uploads/extensions 均归档、空目录跳过', async () => {
    const { dataDir, db } = await makeFixture();
    await writeUploads(dataDir, 'a.txt', 'A');
    await writeUploads(dataDir, 'nested/b.txt', 'BB');
    await mkdir(path.join(dataDir, 'uploads', 'empty-dir'), { recursive: true }); // 空目录
    await mkdir(path.join(dataDir, 'extensions'), { recursive: true });
    await writeFile(path.join(dataDir, 'extensions', 'e.json'), '{"x":1}', 'utf8');

    const t0 = Date.now();
    const info = await createBackup({ dataDir }, db);
    const t1 = Date.now();

    // 返回值与落盘文件
    expect(path.basename(info.path)).toMatch(/^backup-\d{14}-[0-9a-f]{4}\.tar\.gz$/);
    expect(path.dirname(info.path)).toBe(path.join(dataDir, 'backups'));
    expect(info.sizeBytes).toBeGreaterThan(0);
    expect(info.createdAt).toBeGreaterThanOrEqual(t0);
    expect(info.createdAt).toBeLessThanOrEqual(t1);
    const onDisk = await stat(info.path);
    expect(onDisk.isFile()).toBe(true);
    expect(onDisk.size).toBe(info.sizeBytes);

    // listBackups 可见
    const list = await listBackups({ dataDir });
    expect(list).toHaveLength(1);
    expect(list[0]!.path).toBe(info.path);
    expect(list[0]!.sizeBytes).toBe(info.sizeBytes);

    // 解包校验
    const { order, files, headers } = await extractArchive(info.path);
    expect(order[0]).toBe('manifest.json');
    expect(order).toEqual([
      'manifest.json',
      'db.sqlite',
      'uploads/a.txt',
      'uploads/nested/b.txt',
      'extensions/e.json',
    ]);
    expect(order.some((n) => n.includes('empty-dir'))).toBe(false);

    const manifest = JSON.parse(files.get('manifest.json')!.toString('utf8')) as {
      createdAt: number;
      kernelVersion: string;
      files: string[];
    };
    const rootPkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string;
    };
    expect(manifest.createdAt).toBe(info.createdAt);
    expect(manifest.kernelVersion).toBe(rootPkg.version);
    expect(manifest.files).not.toContain('manifest.json');
    expect(manifest.files).toEqual([
      'db.sqlite',
      'uploads/a.txt',
      'uploads/nested/b.txt',
      'extensions/e.json',
    ]);

    // 文件内容与头部元数据
    expect(files.get('uploads/a.txt')!.toString('utf8')).toBe('A');
    expect(files.get('uploads/nested/b.txt')!.toString('utf8')).toBe('BB');
    expect(files.get('extensions/e.json')!.toString('utf8')).toBe('{"x":1}');
    expect(headers.get('uploads/a.txt')!.size).toBe(1);
    expect(headers.get('uploads/nested/b.txt')!.mtime).toBeInstanceOf(Date);

    // db.sqlite 快照可用（better-sqlite3 支持从 Buffer 打开）
    const snapshot = new Database(files.get('db.sqlite')!);
    const rows = snapshot.prepare('SELECT name FROM items ORDER BY id').all() as { name: string }[];
    snapshot.close();
    expect(rows.map((r) => r.name)).toEqual(['hello', 'world']);

    // 临时快照已清理
    expect(await readdir(path.join(dataDir, 'backups'))).toEqual([path.basename(info.path)]);
  });

  it('快照隔离：备份之后对主库的写入不进入归档', async () => {
    const { dataDir, db } = await makeFixture();
    const info = await createBackup({ dataDir }, db);
    await db('items').insert({ name: 'later' });

    const { files } = await extractArchive(info.path);
    const snapshot = new Database(files.get('db.sqlite')!);
    const rows = snapshot.prepare('SELECT name FROM items ORDER BY id').all() as { name: string }[];
    snapshot.close();
    expect(rows.map((r) => r.name)).toEqual(['hello', 'world']);
  });

  it('dataDir 含单引号 → VACUUM INTO 路径正确转义', async () => {
    const { dataDir, db } = await makeFixture(`quote'dir-${randomUUID()}`);
    const info = await createBackup({ dataDir }, db);
    const { files } = await extractArchive(info.path);
    const snapshot = new Database(files.get('db.sqlite')!);
    const rows = snapshot.prepare('SELECT name FROM items ORDER BY id').all() as { name: string }[];
    snapshot.close();
    expect(rows.map((r) => r.name)).toEqual(['hello', 'world']);
  });

  it('VACUUM 失败（损坏库）→ DB_ERROR（HARNESS-403）且临时快照清理、无半成品归档', async () => {
    const { dataDir, db, dbFile } = await makeFixture();
    await db.destroy(); // 释放句柄后破坏库文件
    await writeFile(dbFile, Buffer.concat([Buffer.from('SQLite format 3\0'), randomBytes(8192)]));

    try {
      await createBackup({ dataDir }, db);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(errCodeOf(e)).toBe('HARNESS-4003');
      expect((e as HarnessError).message).toContain('VACUUM INTO');
    }

    const leftovers = await readdir(path.join(dataDir, 'backups'));
    expect(leftovers.filter((n) => n.includes('.snapshot') || n.endsWith('.sqlite'))).toEqual([]);
    expect(leftovers.filter((n) => n.endsWith('.tar.gz'))).toEqual([]);
  });
});

describe('listBackups', () => {
  it('无 backups 目录 → []；杂文件不误报', async () => {
    const dataDir = path.join(baseDir, randomUUID());
    await mkdir(dataDir, { recursive: true });
    expect(await listBackups({ dataDir })).toEqual([]);

    const backupsDir = path.join(dataDir, 'backups');
    await mkdir(backupsDir, { recursive: true });
    await writeFile(path.join(backupsDir, 'notes.txt'), 'not a backup', 'utf8');
    await writeFile(path.join(backupsDir, '.snapshot-20260101000000-abcd.sqlite.tmp'), 'junk');
    expect(await listBackups({ dataDir })).toEqual([]);
  });
});

describe('pruneBackups', () => {
  it('保留最新 keep 份，返回删除数；keep 超量/清空均正确', async () => {
    const { dataDir, db } = await makeFixture();
    const first = await createBackup({ dataDir }, db);
    await new Promise((r) => setTimeout(r, 30)); // 确保 mtime 可分序
    const second = await createBackup({ dataDir }, db);
    await new Promise((r) => setTimeout(r, 30));
    const third = await createBackup({ dataDir }, db);

    expect(await pruneBackups({ dataDir }, 2)).toBe(1);
    const after = await listBackups({ dataDir });
    expect(after).toHaveLength(2);
    expect(after.map((b) => b.path)).not.toContain(first.path); // 最旧被删
    expect(after[0]!.path).toBe(third.path); // 最新在前
    expect(after.map((b) => b.path)).toContain(second.path);

    expect(await pruneBackups({ dataDir }, 5)).toBe(0); // keep 超量 → 不删
    expect(await pruneBackups({ dataDir }, 0)).toBe(2); // 清空
    expect(await listBackups({ dataDir })).toEqual([]);
  });

  it('非法入参 fail-fast：dataDir 非空 / keep 非负整数（VALIDATION_FAILED）', async () => {
    const { dataDir, db } = await makeFixture();
    await expect(createBackup({ dataDir: '' }, db)).rejects.toThrowError(HarnessError);
    try {
      await pruneBackups({ dataDir }, -1);
      expect.unreachable();
    } catch (e) {
      expect(errCodeOf(e)).toBe('HARNESS-1009');
    }
    try {
      await pruneBackups({ dataDir }, 1.5);
      expect.unreachable();
    } catch (e) {
      expect(errCodeOf(e)).toBe('HARNESS-1009');
    }
  });
});
