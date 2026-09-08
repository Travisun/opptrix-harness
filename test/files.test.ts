/**
 * FileService 单元测试（临时目录 + 真实迁移库 + 真 HookManager/EventBus）。
 *
 * 覆盖：store 落盘落库/元数据往返、大小闸门（超限/边界）、MIME 白名单、
 * beforeStore hook 拒收（HookAbort）/改写、afterStore hook、每扩展配额、
 * read 可见性门禁、remove（磁盘+行+事件）、list 过滤排序、usedBytes、
 * origName 路径净化，以及 createLocalDriver 的安全校验与幂等删除。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pino from 'pino';
import type { Knex } from 'knex';

import { HarnessError } from '../src/kernel/errors/index.js';
import { createLocalDriver } from '../src/kernel/files/drivers/local.js';
import { FileService, type FileServiceDeps } from '../src/kernel/files/service.js';
import { EventBus } from '../src/kernel/events/bus.js';
import { HookAbort, HookManager } from '../src/kernel/hooks/manager.js';
import { HOOK_POINTS } from '../src/kernel/hooks/points.js';
import { closeDb, openSqlite } from '../src/kernel/storage/db.js';
import { KERNEL_MIGRATIONS } from '../src/kernel/storage/kernel-migrations.js';
import { Migrator } from '../src/kernel/storage/migrator.js';

// ---------------------------------------------------------------------------
// 环境
// ---------------------------------------------------------------------------

let dir: string;
let db: Knex;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'opptrix-files-'));
  db = await openSqlite(join(dir, 'kernel.sqlite'));
  const migrator = new Migrator(db, { migrations: KERNEL_MIGRATIONS });
  await migrator.latest();
});

afterAll(async () => {
  await closeDb(db);
  rmSync(dir, { recursive: true, force: true });
});

/** 捕获事件总线的投递（file.* 事件） */
interface CapturedEvent {
  name: string;
  source: string;
  payload: unknown;
}

let rootSeq = 0;

/** 组装一套真实依赖（每个 service 独立 driver root，互不串扰） */
function makeService(overrides: Partial<FileServiceDeps> = {}): {
  service: FileService;
  bus: EventBus;
  hooks: HookManager;
} {
  rootSeq += 1;
  const driver = createLocalDriver(join(dir, `root-${rootSeq}`));
  const bus = new EventBus();
  const hooks = new HookManager();
  const service = new FileService({
    driver,
    db,
    hooks,
    emit: bus.emit.bind(bus),
    logger: pino({ level: 'silent' }),
    maxUploadBytes: 1024,
    ...overrides,
  });
  return { service, bus, hooks };
}

/** 订阅 file.* 事件并返回捕获列表 */
function captureEvents(bus: EventBus): CapturedEvent[] {
  const seen: CapturedEvent[] = [];
  bus.on('file.*', (payload, meta) => {
    seen.push({ name: meta.name, source: meta.source, payload });
  });
  return seen;
}

/** 清空 files 表：套件共享同一个库，计数/配额类断言需要干净起点 */
async function freshFiles(): Promise<void> {
  await db('files').del();
}

const TEXT = Buffer.from('hello', 'utf8');

// ---------------------------------------------------------------------------
// store — 落盘与落库
// ---------------------------------------------------------------------------

describe('FileService.store — 落盘与落库', () => {
  it('store 后记录与磁盘内容、数据库行一致（元数据完整往返）', async () => {
    const { service, bus } = makeService();
    const seen = captureEvents(bus);

    const record = await service.store({
      data: TEXT,
      origName: 'notes.txt',
      mime: 'text/plain',
      extId: 'demo',
      visibility: 'public',
    });

    expect(record.origName).toBe('notes.txt');
    expect(record.mime).toBe('text/plain');
    expect(record.size).toBe(5);
    expect(record.extId).toBe('demo');
    expect(record.visibility).toBe('public');
    expect(record.id).toMatch(/^[0-9a-f-]{36}$/);
    // relPath = <yyyy>/<mm>/<uuid>.txt（UTC）
    expect(record.path).toMatch(/^\d{4}\/\d{2}\/[0-9a-f-]{36}\.txt$/);
    expect(Math.abs(record.createdAt - Date.now())).toBeLessThan(5_000);

    // 磁盘内容一致
    const driver = createLocalDriver(join(dir, `root-${rootSeq}`));
    expect((await driver.read(record.path)).toString('utf8')).toBe('hello');
    // 数据库行一致
    const row = (await db('files').where({ id: record.id }).first()) as { ext_id: string | null; size: number };
    expect(row.ext_id).toBe('demo');
    expect(Number(row.size)).toBe(5);
    // get 往返
    expect(await service.get(record.id)).toEqual(record);
    // 事件：file.uploaded，source=kernel，payload=record
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ name: 'file.uploaded', source: 'kernel' });
    expect(seen[0].payload).toEqual(record);
  });

  it('缺省值：visibility=private、extId=null、mime=application/octet-stream', async () => {
    const { service } = makeService();
    const record = await service.store({ data: TEXT, origName: 'blob' });
    expect(record.visibility).toBe('private');
    expect(record.extId).toBeNull();
    expect(record.mime).toBe('application/octet-stream');
    expect(record.path).not.toMatch(/\.\w+$/); // 无扩展名
  });
});

// ---------------------------------------------------------------------------
// store — 闸门
// ---------------------------------------------------------------------------

describe('FileService.store — 大小与 MIME 闸门', () => {
  it('超过 maxUploadBytes → PAYLOAD_TOO_LARGE（HARNESS-1005），不落盘不落库', async () => {
    await freshFiles();
    const { service } = makeService({ maxUploadBytes: 4 });
    const err = await service.store({ data: Buffer.alloc(5), origName: 'big.bin' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HarnessError);
    expect((err as HarnessError).code).toBe('HARNESS-1005');
    expect((err as HarnessError).status).toBe(413);
    expect(await service.list()).toHaveLength(0);
  });

  it('恰好等于 maxUploadBytes 允许（边界）', async () => {
    await freshFiles();
    const { service } = makeService({ maxUploadBytes: 8 });
    const record = await service.store({ data: Buffer.alloc(8, 7), origName: 'edge.bin' });
    expect(record.size).toBe(8);
  });

  it('mime 白名单：配置 ["text/plain"] 时 image/png → VALIDATION_FAILED', async () => {
    await freshFiles();
    const { service } = makeService({ mimeAllowlist: ['text/plain'] });
    const err = await service
      .store({ data: Buffer.alloc(4), origName: 'pic.png', mime: 'image/png' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HarnessError);
    expect((err as HarnessError).code).toBe('HARNESS-1009');
    expect(await service.list()).toHaveLength(0);
  });

  it('缺省白名单 */* 放行任意 mime', async () => {
    await freshFiles();
    const { service } = makeService();
    const record = await service.store({ data: Buffer.alloc(4), origName: 'pic.png', mime: 'image/png' });
    expect(record.mime).toBe('image/png');
  });
});

// ---------------------------------------------------------------------------
// store — hooks
// ---------------------------------------------------------------------------

describe('FileService.store — file.beforeStore / file.afterStore hook', () => {
  it('beforeStore 抛 HookAbort(false) → BAD_REQUEST 拒收，不落盘不落库', async () => {
    await freshFiles();
    const { service, hooks } = makeService();
    const off = hooks.add(HOOK_POINTS.fileBeforeStore, () => {
      throw new HookAbort(false);
    });

    const err = await service.store({ data: TEXT, origName: 'x.txt' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HarnessError);
    expect((err as HarnessError).code).toBe('HARNESS-1008');
    expect((err as HarnessError).message).toBe('rejected by file.beforeStore hook');
    expect(await service.list()).toHaveLength(0);
    off();
  });

  it('beforeStore handler 直接返回 false 同样拒收', async () => {
    await freshFiles();
    const { service, hooks } = makeService();
    const off = hooks.add(HOOK_POINTS.fileBeforeStore, () => false);
    await expect(service.store({ data: TEXT, origName: 'x.txt' })).rejects.toMatchObject({ code: 'HARNESS-1008' });
    off();
  });

  it('beforeStore 改写 origName 生效（记录与 relPath 扩展随之更新）', async () => {
    await freshFiles();
    const { service, hooks } = makeService();
    const off = hooks.add(HOOK_POINTS.fileBeforeStore, (value) => {
      const v = value as { origName: string };
      return { ...(v as object), origName: 'renamed.md' };
    });
    const record = await service.store({ data: TEXT, origName: 'original.txt' });
    expect(record.origName).toBe('renamed.md');
    expect(record.path.endsWith('.md')).toBe(true);
    off();
  });

  it('beforeStore 改写 data 后以新内容落盘（大小复核闸门仍生效）', async () => {
    await freshFiles();
    const { service, hooks } = makeService();
    const payload = Buffer.from('rewritten-bytes', 'utf8');
    const off = hooks.add(HOOK_POINTS.fileBeforeStore, (value) => ({ ...(value as object), data: payload }));
    const record = await service.store({ data: Buffer.alloc(2), origName: 'a.txt' });
    expect(record.size).toBe(payload.byteLength);
    expect(await service.read(record.id, { allowPrivate: true }).then((r) => r.data.toString('utf8')))
      .toBe('rewritten-bytes');
    off();
  });

  it('hook 改写 data 超限 → 仍抛 PAYLOAD_TOO_LARGE', async () => {
    await freshFiles();
    const { service, hooks } = makeService({ maxUploadBytes: 4 });
    const off = hooks.add(HOOK_POINTS.fileBeforeStore, (value) => ({ ...(value as object), data: Buffer.alloc(64) }));
    await expect(service.store({ data: Buffer.alloc(2), origName: 'a.txt' })).rejects.toMatchObject({
      code: 'HARNESS-1005',
    });
    off();
  });

  it('afterStore hook 收到落库后的完整记录', async () => {
    await freshFiles();
    const { service, hooks } = makeService();
    const seen: unknown[] = [];
    const off = hooks.add(HOOK_POINTS.fileAfterStore, (value) => {
      seen.push(value);
      return value;
    });
    const record = await service.store({ data: TEXT, origName: 'a.txt' });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(record);
    off();
  });
});

// ---------------------------------------------------------------------------
// store — 每扩展配额
// ---------------------------------------------------------------------------

describe('FileService.store — 每扩展存储配额', () => {
  it('maxExtStorageBytes=16：首个 10B 成功，第二个 10B → EXT_DB_QUOTA；无 extId 不受限', async () => {
    await freshFiles();
    const { service } = makeService({ maxExtStorageBytes: 16 });

    const first = await service.store({ data: Buffer.alloc(10, 1), origName: 'a.bin', extId: 'demo' });
    expect(first.size).toBe(10);

    const err = await service
      .store({ data: Buffer.alloc(10, 2), origName: 'b.bin', extId: 'demo' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HarnessError);
    expect((err as HarnessError).code).toBe('HARNESS-3010');
    expect((err as HarnessError).status).toBe(507);

    // 恰好用满配额允许
    const fill = await service.store({ data: Buffer.alloc(6, 3), origName: 'c.bin', extId: 'demo' });
    expect(fill.size).toBe(6);

    // 其他扩展不受影响；内核级（无 extId）完全不受配额约束
    await expect(service.store({ data: Buffer.alloc(10, 4), origName: 'd.bin', extId: 'other' })).resolves
      .toBeInstanceOf(Object);
    await expect(service.store({ data: Buffer.alloc(64, 5), origName: 'e.bin' })).resolves.toBeInstanceOf(Object);
  });

  it('usedBytes 统计 SUM(size)，remove 后回落', async () => {
    await freshFiles();
    const { service } = makeService();
    expect(await service.usedBytes('quota-ext')).toBe(0);
    const a = await service.store({ data: Buffer.alloc(3, 1), origName: 'a.bin', extId: 'quota-ext' });
    await service.store({ data: Buffer.alloc(4, 2), origName: 'b.bin', extId: 'quota-ext' });
    expect(await service.usedBytes('quota-ext')).toBe(7);
    await service.remove(a.id);
    expect(await service.usedBytes('quota-ext')).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// get / read / remove / list
// ---------------------------------------------------------------------------

describe('FileService — get/read/remove', () => {
  it('get/read 不存在的 id → EXT_NOT_FOUND（HARNESS-3004）', async () => {
    const { service } = makeService();
    const err = await service.get('ghost').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HarnessError);
    expect((err as HarnessError).code).toBe('HARNESS-3004');
    await expect(service.read('ghost')).rejects.toMatchObject({ code: 'HARNESS-3004' });
  });

  it('private 文件 read 需 allowPrivate=true，否则 FORBIDDEN；public 直接可读且内容一致', async () => {
    const { service } = makeService();
    const priv = await service.store({ data: TEXT, origName: 'secret.txt', mime: 'text/plain' });
    const pub = await service.store({ data: TEXT, origName: 'open.txt', mime: 'text/plain', visibility: 'public' });

    const denied = await service.read(priv.id).catch((e: unknown) => e);
    expect(denied).toBeInstanceOf(HarnessError);
    expect((denied as HarnessError).code).toBe('HARNESS-1007');

    const allowed = await service.read(priv.id, { allowPrivate: true });
    expect(allowed.record.id).toBe(priv.id);
    expect(allowed.data.toString('utf8')).toBe('hello');

    const publicRead = await service.read(pub.id);
    expect(publicRead.data.toString('utf8')).toBe('hello');
  });

  it('remove 删磁盘+删行并 emit file.deleted；二次 remove → EXT_NOT_FOUND', async () => {
    const { service, bus } = makeService();
    const seen = captureEvents(bus);
    const record = await service.store({ data: TEXT, origName: 'gone.txt' });

    const removed = await service.remove(record.id);
    expect(removed.id).toBe(record.id);

    const driver = createLocalDriver(join(dir, `root-${rootSeq}`));
    expect(await driver.stat(record.path)).toBeNull();
    await expect(service.get(record.id)).rejects.toMatchObject({ code: 'HARNESS-3004' });
    await expect(service.remove(record.id)).rejects.toMatchObject({ code: 'HARNESS-3004' });

    expect(seen).toHaveLength(2);
    expect(seen[1]).toMatchObject({ name: 'file.deleted', source: 'kernel' });
    expect(seen[1].payload).toEqual(record);
  });
});

describe('FileService — list', () => {
  it('按 extId 过滤（null=仅内核级）、limit 生效、created_at 降序', async () => {
    await freshFiles();
    const { service } = makeService();
    await service.store({ data: TEXT, origName: 'k1.txt' });
    await new Promise((r) => setTimeout(r, 10));
    const a = await service.store({ data: TEXT, origName: 'a.txt', extId: 'list-ext' });
    await new Promise((r) => setTimeout(r, 10));
    const b = await service.store({ data: TEXT, origName: 'b.txt', extId: 'list-ext' });

    const filtered = await service.list({ extId: 'list-ext' });
    expect(filtered.map((r) => r.id)).toEqual([b.id, a.id]); // 最新在前

    expect(await service.list({ extId: null })).toHaveLength(1); // 仅内核级
    expect((await service.list({ extId: 'list-ext', limit: 1 })).map((r) => r.id)).toEqual([b.id]);

    const bad = await service.list({ limit: 0 }).catch((e: unknown) => e);
    expect(bad).toBeInstanceOf(HarnessError);
    expect((bad as HarnessError).code).toBe('HARNESS-1009');
  });
});

// ---------------------------------------------------------------------------
// 路径净化与驱动
// ---------------------------------------------------------------------------

describe('FileService — origName 净化', () => {
  it('origName 含 ../ 被净化：只剩基名，文件落在 root 内', async () => {
    const { service } = makeService();
    const record = await service.store({ data: TEXT, origName: '../../etc/passwd' });
    expect(record.origName).toBe('passwd');
    expect(record.path).not.toContain('..');
    expect(record.path.startsWith('/')).toBe(false);

    const driver = createLocalDriver(join(dir, `root-${rootSeq}`));
    expect(await driver.stat(record.path)).toEqual({ size: 5 });
    // root 之外无逃逸文件
    expect(await driver.list()).toEqual([record.path]);
  });

  it('origName 为 ".." 或空路径成分 → 回退 "file"', async () => {
    const { service } = makeService();
    const r1 = await service.store({ data: TEXT, origName: '..' });
    const r2 = await service.store({ data: TEXT, origName: 'a/..' });
    expect(r1.origName).toBe('file');
    expect(r2.origName).toBe('file');
  });
});

describe('createLocalDriver — 安全校验与幂等', () => {
  it('put 自动建目录、stat 返回 size、delete 成功 true / 不存在 false', async () => {
    const driver = createLocalDriver(join(dir, `drv-${(rootSeq += 1)}`));
    // 反斜杠按分隔符规范化（不拒绝、不逃逸）
    await driver.put('with\\backslash.txt', Buffer.from('bs', 'utf8'));
    expect(await driver.list()).toEqual(['with/backslash.txt']);
    await driver.put('x/y/z.txt', Buffer.from('abc', 'utf8'));
    expect(await driver.stat('x/y/z.txt')).toEqual({ size: 3 });
    expect(await driver.list('x/')).toEqual(['x/y/z.txt']);
    expect(await driver.delete('x/y/z.txt')).toBe(true);
    expect(await driver.delete('x/y/z.txt')).toBe(false);
    await expect(driver.read('x/y/z.txt')).rejects.toMatchObject({ code: 'HARNESS-3004' });
  });

  it.each(['/etc/passwd', 'C:/evil.txt', 'a/../../escape.txt', '..', ''])(
    '非法 relPath（%s）→ BAD_REQUEST',
    async (relPath) => {
      const driver = createLocalDriver(join(dir, `drv-${(rootSeq += 1)}`));
      await expect(driver.put(relPath, Buffer.alloc(1))).rejects.toMatchObject({ code: 'HARNESS-1008' });
      await expect(driver.read(relPath)).rejects.toMatchObject({ code: 'HARNESS-1008' });
      await expect(driver.stat(relPath)).rejects.toMatchObject({ code: 'HARNESS-1008' });
    },
  );
});
