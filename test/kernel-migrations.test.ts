/**
 * 内核迁移契约测试：临时文件库 → 依次 up 全部迁移 → 权威 Schema 抽查 →
 * 唯一约束行为验证 → 逆序 down 后无内核表残留。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import knex from 'knex';
import type { Knex } from 'knex';
import { KERNEL_MIGRATIONS } from '../src/kernel/storage/kernel-migrations.js';

/** 权威 Schema 的全部内核表（按迁移顺序）。 */
const KERNEL_TABLES = [
  'settings',
  'secrets',
  'logs',
  'extensions',
  'ext_kv',
  'cron_jobs',
  'cron_runs',
  'notifications',
  'channels',
  'channel_members',
  'messages',
  'files',
  'tasks',
  'deliveries',
  'subagents',
] as const;

/** 期望的迁移名（顺序敏感）。015_extensions_trust：第三方扩展信任确认列（ext-trust 工作包追加）；
 *  016_subagents：子代理表（subagents 工作包追加）。 */
const EXPECTED_MIGRATION_NAMES = [
  '001_settings',
  '002_secrets',
  '003_logs',
  '004_extensions',
  '005_ext_kv',
  '006_cron_jobs',
  '007_cron_runs',
  '008_notifications',
  '009_channels',
  '010_channel_members',
  '011_messages',
  '012_files',
  '013_tasks',
  '014_deliveries',
  '015_extensions_trust',
  '016_subagents',
] as const;

type RawRow = Record<string, unknown>;

/** knex raw 结果归一化为对象行数组（兼容行对象/行数组两种驱动形态）。 */
function toRows(result: unknown): RawRow[] {
  if (Array.isArray(result)) {
    return result.every((r) => Array.isArray(r))
      ? (result as unknown[][]).map((r) => ({ 1: r[1], 2: r[2], 3: r[3], 5: r[5] }))
      : (result as RawRow[]);
  }
  const nested = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(nested) ? (nested as RawRow[]) : [];
}

/** 查询当前用户表名（排除 sqlite_ 内部表）。 */
async function userTables(db: Knex): Promise<string[]> {
  const raw = await db.raw(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite%'",
  );
  return toRows(raw)
    .map((r) => String(r.name))
    .sort();
}

/** 查询用户索引名（排除 sqlite_ 自动索引）。 */
async function userIndexes(db: Knex): Promise<string[]> {
  const raw = await db.raw(
    "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite%'",
  );
  return toRows(raw)
    .map((r) => String(r.name))
    .sort();
}

interface ColumnInfo {
  type: string;
  notnull: number;
  pk: number;
  dflt: string | null;
}

/** PRAGMA table_info 归一化为 列名 → 列信息。 */
async function tableColumns(db: Knex, table: string): Promise<Map<string, ColumnInfo>> {
  const raw = await db.raw(`PRAGMA table_info(${table})`);
  const map = new Map<string, ColumnInfo>();
  for (const row of toRows(raw)) {
    map.set(String(row.name), {
      type: String(row.type).toUpperCase(),
      notnull: Number(row.notnull),
      pk: Number(row.pk),
      dflt: row.dflt_value == null ? null : String(row.dflt_value),
    });
  }
  return map;
}

let dir: string;
let db: Knex;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'opptrix-kernel-migrations-'));
  db = knex({
    client: 'better-sqlite3',
    connection: { filename: join(dir, 'harness-test.sqlite3') },
    useNullAsDefault: true,
  });
  // 依次 up 全部迁移（失败即整个用例失败）
  for (const migration of KERNEL_MIGRATIONS) {
    await migration.up(db);
  }
});

afterAll(async () => {
  await db?.destroy();
  rmSync(dir, { recursive: true, force: true });
});

describe('KERNEL_MIGRATIONS 清单', () => {
  it('迁移数量与命名与权威 Schema 一致', () => {
    expect(KERNEL_MIGRATIONS.map((m) => m.name)).toEqual([...EXPECTED_MIGRATION_NAMES]);
  });

  it('每个迁移都提供 down 以支持回滚', () => {
    for (const migration of KERNEL_MIGRATIONS) {
      expect(typeof migration.down, `${migration.name} 缺少 down`).toBe('function');
    }
  });
});

describe('up：全部迁移执行后', () => {
  it('15 张内核表全部创建', async () => {
    expect(await userTables(db)).toEqual([...KERNEL_TABLES].sort());
  });

  it('settings：主键 key，value/updated_at 非空，时间为 INTEGER', async () => {
    const cols = await tableColumns(db, 'settings');
    expect([...cols.keys()]).toEqual(['key', 'value', 'updated_at']);
    expect(cols.get('key')).toMatchObject({ type: 'TEXT', pk: 1, notnull: 0 });
    expect(cols.get('value')).toMatchObject({ type: 'TEXT', notnull: 1 });
    expect(cols.get('updated_at')).toMatchObject({ type: 'INTEGER', notnull: 1 });
  });

  it('secrets：主键 name，value/updated_at 非空，时间为 INTEGER', async () => {
    const cols = await tableColumns(db, 'secrets');
    expect([...cols.keys()]).toEqual(['name', 'value', 'updated_at']);
    expect(cols.get('name')).toMatchObject({ type: 'TEXT', pk: 1, notnull: 0 });
    expect(cols.get('value')).toMatchObject({ type: 'TEXT', notnull: 1 });
    expect(cols.get('updated_at')).toMatchObject({ type: 'INTEGER', notnull: 1 });
  });

  it('messages：完整列序、id 主键、channel_id+created_at 联合索引', async () => {
    const cols = await tableColumns(db, 'messages');
    expect([...cols.keys()]).toEqual([
      'id',
      'channel_id',
      'sender_type',
      'sender_id',
      'content',
      'attachments',
      'created_at',
      'updated_at',
    ]);
    expect(cols.get('id')).toMatchObject({ type: 'TEXT', pk: 1 });
    expect(cols.get('channel_id')).toMatchObject({ type: 'TEXT', notnull: 1 });
    expect(cols.get('content')).toMatchObject({ type: 'TEXT', notnull: 1 });
    expect(cols.get('created_at')).toMatchObject({ type: 'INTEGER', notnull: 1 });
    expect(cols.get('updated_at')).toMatchObject({ type: 'INTEGER', notnull: 1 });
    expect(await userIndexes(db)).toContain('messages_channel_id_created_at_index');
  });

  it('files：完整列序、path 非空唯一、ext_id 索引', async () => {
    const cols = await tableColumns(db, 'files');
    expect([...cols.keys()]).toEqual([
      'id',
      'ext_id',
      'orig_name',
      'mime',
      'size',
      'path',
      'visibility',
      'created_at',
    ]);
    expect(cols.get('id')).toMatchObject({ type: 'TEXT', pk: 1 });
    expect(cols.get('path')).toMatchObject({ type: 'TEXT', notnull: 1 });
    expect(cols.get('visibility')).toMatchObject({
      type: 'TEXT',
      notnull: 1,
      dflt: "'private'",
    });
    expect(cols.get('created_at')).toMatchObject({ type: 'INTEGER', notnull: 1 });
    expect(await userIndexes(db)).toContain('files_ext_id_index');
  });

  it('tasks：完整列序、status 默认 queued、ext_id+status 联合索引', async () => {
    const cols = await tableColumns(db, 'tasks');
    expect([...cols.keys()]).toEqual([
      'id',
      'ext_id',
      'name',
      'args',
      'status',
      'progress',
      'progress_msg',
      'result',
      'error',
      'created_at',
      'started_at',
      'finished_at',
    ]);
    expect(cols.get('id')).toMatchObject({ type: 'TEXT', pk: 1 });
    expect(cols.get('ext_id')).toMatchObject({ type: 'TEXT', notnull: 1 });
    expect(cols.get('status')).toMatchObject({ type: 'TEXT', notnull: 1, dflt: "'queued'" });
    expect(cols.get('progress')).toMatchObject({ type: 'INTEGER', notnull: 1, dflt: "'0'" });
    expect(cols.get('created_at')).toMatchObject({ type: 'INTEGER', notnull: 1 });
    expect(await userIndexes(db)).toContain('tasks_ext_id_status_index');
  });

  it('deliveries：id 自增主键、ok 非空、kind+created_at 联合索引', async () => {
    const cols = await tableColumns(db, 'deliveries');
    expect([...cols.keys()]).toEqual([
      'id',
      'kind',
      'target',
      'channel',
      'ok',
      'duration_ms',
      'error',
      'created_at',
    ]);
    expect(cols.get('id')).toMatchObject({ type: 'INTEGER', pk: 1 });
    expect(cols.get('kind')).toMatchObject({ type: 'TEXT', notnull: 1 });
    expect(cols.get('target')).toMatchObject({ type: 'TEXT', notnull: 1 });
    expect(cols.get('ok')).toMatchObject({ type: 'INTEGER', notnull: 1 });
    expect(cols.get('created_at')).toMatchObject({ type: 'INTEGER', notnull: 1 });
    expect(await userIndexes(db)).toContain('deliveries_kind_created_at_index');
  });

  it('subagents：完整列序、id 主键、status 默认 running、parent_id/status 索引', async () => {
    const cols = await tableColumns(db, 'subagents');
    expect([...cols.keys()]).toEqual([
      'id',
      'parent_id',
      'depth',
      'model',
      'system_prompt',
      'prompt',
      'tool_names',
      'status',
      'result',
      'error',
      'transcript',
      'usage_in',
      'usage_out',
      'created_at',
      'started_at',
      'finished_at',
    ]);
    expect(cols.get('id')).toMatchObject({ type: 'TEXT', pk: 1 });
    expect(cols.get('parent_id')).toMatchObject({ type: 'TEXT', notnull: 1 });
    expect(cols.get('depth')).toMatchObject({ type: 'INTEGER', notnull: 1 });
    expect(cols.get('prompt')).toMatchObject({ type: 'TEXT', notnull: 1 });
    expect(cols.get('status')).toMatchObject({ type: 'TEXT', notnull: 1, dflt: "'running'" });
    expect(cols.get('tool_names')).toMatchObject({ type: 'TEXT', notnull: 0 });
    expect(cols.get('transcript')).toMatchObject({ type: 'TEXT', notnull: 0 });
    expect(cols.get('usage_in')).toMatchObject({ type: 'INTEGER', notnull: 0 });
    expect(await userIndexes(db)).toContain('subagents_parent_id_index');
    expect(await userIndexes(db)).toContain('subagents_status_index');
  });
});

describe('唯一约束行为', () => {
  it('channels.slug 插入重复值抛错', async () => {
    await db('channels').insert({ id: 'ch-1', slug: 'dup-slug', name: 'A', created_at: 1 });
    await expect(
      db('channels').insert({ id: 'ch-2', slug: 'dup-slug', name: 'B', created_at: 2 }),
    ).rejects.toThrow();
  });

  it('files.path 插入重复值抛错', async () => {
    await db('files').insert({
      id: 'f-1',
      orig_name: 'a.txt',
      mime: 'text/plain',
      size: 1,
      path: '/data/a.txt',
      created_at: 1,
    });
    await expect(
      db('files').insert({
        id: 'f-2',
        orig_name: 'b.txt',
        mime: 'text/plain',
        size: 2,
        path: '/data/a.txt',
        created_at: 2,
      }),
    ).rejects.toThrow();
  });
});

describe('down：逆序回滚', () => {
  it('全部 down 逆序执行后无内核表与索引残留', async () => {
    for (const migration of [...KERNEL_MIGRATIONS].reverse()) {
      await migration.down?.(db);
    }
    expect(await userTables(db)).toEqual([]);
    expect(await userIndexes(db)).toEqual([]);
  });
});
