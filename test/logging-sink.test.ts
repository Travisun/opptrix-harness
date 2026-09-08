/**
 * SQLite 日志汇（sqlite-sink.ts）与启动期 logger（createBootLogger）单测。
 *
 * 覆盖：pino 写入落库、ensureTable 惰性建表、data JSON、环形裁剪（maxRows）、
 * 定时/定量 flush、minLevel 过滤、DB 抛错容错（告警去重、不炸流）、close 语义、
 * level 数字→名称映射、multistream 双流分发与 per-stream 级别过滤。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import type { Knex } from 'knex';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/kernel/config/index.js';
import { createBootLogger, createLogger, scoped } from '../src/kernel/logging/index.js';
import {
  createSqliteLogSink,
  type SqliteLogSink,
  type SqliteSinkOptions,
} from '../src/kernel/logging/sqlite-sink.js';
import { openSqlite } from '../src/kernel/storage/db.js';
import { KERNEL_MIGRATIONS } from '../src/kernel/storage/kernel-migrations.js';
import { Migrator } from '../src/kernel/storage/migrator.js';

// ---------------------------------------------------------------------------
// 测试基建
// ---------------------------------------------------------------------------

interface Ctx {
  db: Knex;
  dir: string;
  sink: SqliteLogSink;
  logger: pino.Logger;
}

/** 打开临时文件库（可选跑内核迁移建表）并创建 sink + pino logger（级别 trace 全放行） */
async function setup(sinkOpts: SqliteSinkOptions = {}, migrate = true): Promise<Ctx> {
  const dir = await mkdtemp(join(tmpdir(), 'opptrix-logsink-'));
  const db = await openSqlite(join(dir, 'test.sqlite'));
  if (migrate) await new Migrator(db, { migrations: KERNEL_MIGRATIONS }).latest();
  const sink = createSqliteLogSink(db, { flushIntervalMs: 60_000, flushBatch: 1000, ...sinkOpts });
  const logger = createLogger(loadConfig({ HARNESS_LOG_LEVEL: 'trace' }), sink.stream);
  return { db, dir, sink, logger };
}

/** 打开的测试上下文登记表：afterEach 统一回收（sink.close → db.destroy → 删目录） */
const openCtx: Ctx[] = [];

afterEach(async () => {
  while (openCtx.length > 0) {
    const ctx = openCtx.pop()!;
    await ctx.sink.close().catch(() => {});
    await ctx.db.destroy();
    await rm(ctx.dir, { recursive: true, force: true });
  }
});

/** 收集流输出的内存 Writable（pino destination 替身） */
function capture(sink: string[]): Writable {
  return new Writable({
    write(chunk: unknown, _enc: BufferEncoding, cb: (error?: Error | null) => void) {
      sink.push(String(chunk));
      cb();
    },
  });
}

/** 下一轮事件循环（pino 同步写入后的排队写、process.nextTick 告警派发） */
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** 轮询等待条件成立（定时 flush 等 异步落库 场景） */
async function until(cond: () => Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error('until: condition not met before timeout');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function logCount(db: Knex): Promise<number> {
  const result = (await db('logs').count({ c: '*' })) as Array<{ c: number }>;
  return Number(result[0]?.c ?? 0);
}

async function logRows(db: Knex): Promise<Record<string, unknown>[]> {
  return (await db('logs').select('*').orderBy('id', 'asc')) as Record<string, unknown>[];
}

// ---------------------------------------------------------------------------
// createSqliteLogSink
// ---------------------------------------------------------------------------

describe('createSqliteLogSink', () => {
  it('pino 写入 → flush 后行数与 level 名称/scope/message/ts 正确（Migrator 建表）', async () => {
    const ctx = openCtx[openCtx.push(await setup()) - 1]!;
    const before = Date.now() - 1;

    scoped(ctx.logger, 'rpc.server').warn({ attempt: 2 }, 'retrying');
    ctx.logger.info('boot ok');
    await ctx.sink.flush();

    const rows = await logRows(ctx.db);
    expect(rows).toHaveLength(2);

    const first = rows[0]!;
    expect(first.level).toBe('warn');
    expect(first.scope).toBe('rpc.server');
    expect(first.message).toBe('retrying');
    expect(first.id).toBe(1);
    expect(first.ts as number).toBeGreaterThanOrEqual(before);
    expect(first.ts as number).toBeLessThanOrEqual(Date.now());

    const second = rows[1]!;
    expect(second.level).toBe('info');
    expect(second.scope).toBe(''); // 无 scope 缺省空串
    expect(second.message).toBe('boot ok');
    expect(ctx.sink.written()).toBe(2);
  });

  it('ensureTable 惰性建表：无迁移时首次 flush 自动建同构 logs 表', async () => {
    const ctx = openCtx[openCtx.push(await setup({}, false)) - 1]!;
    expect(await ctx.db.schema.hasTable('logs')).toBe(false);

    ctx.logger.info('lazy create');
    await ctx.sink.flush();

    expect(await ctx.db.schema.hasTable('logs')).toBe(true);
    const cols = await ctx.db('logs').columnInfo();
    expect(cols.id?.type).toBe('integer');
    expect(cols.ts?.type).toBe('integer');
    expect(cols.level?.type).toBe('text');
    expect(cols.scope?.type).toBe('text');
    expect(cols.message?.type).toBe('text');
    expect(cols.data?.type).toBe('text');
    expect((await logRows(ctx.db))[0]!.message).toBe('lazy create');
  });

  it('data 为 JSON 且含额外字段（排除 level/time/msg/scope；token 已 redact）', async () => {
    const ctx = openCtx[openCtx.push(await setup()) - 1]!;
    ctx.logger.info({ requestId: 'r-1', attempt: 2, token: 'super-secret' }, 'with extras');
    await ctx.sink.flush();

    const row = (await logRows(ctx.db))[0]!;
    expect(row.data).toBeTypeOf('string');
    const data = JSON.parse(row.data as string) as Record<string, unknown>;
    expect(data.requestId).toBe('r-1');
    expect(data.attempt).toBe(2);
    expect(data.token).toBe('[REDACTED]'); // pino redact 先于 sink 序列化生效
    for (const key of ['level', 'time', 'msg', 'scope']) {
      expect(key in data).toBe(false);
    }
  });

  it('无额外字段的行 data 为 null（直接写 pino 序列化行）', async () => {
    const ctx = openCtx[openCtx.push(await setup()) - 1]!;
    ctx.sink.stream.write(JSON.stringify({ level: 30, time: Date.now(), msg: 'bare' }));
    await ctx.sink.flush();

    const row = (await logRows(ctx.db))[0]!;
    expect(row.data).toBeNull();
    expect(row.level).toBe('info');
    expect(row.message).toBe('bare');
  });

  it('minLevel 过滤：低于阈值的行不入库、written 只计放行行', async () => {
    const ctx = openCtx[openCtx.push(await setup({ minLevel: 'warn' })) - 1]!;
    ctx.logger.trace('t');
    ctx.logger.debug('d');
    ctx.logger.info('i');
    ctx.logger.warn('w');
    ctx.logger.error('e');
    await ctx.sink.flush();

    const rows = await logRows(ctx.db);
    expect(rows.map((r) => r.level)).toEqual(['warn', 'error']);
    expect(ctx.sink.written()).toBe(2);
  });

  it('环形裁剪：累计 20 次 batch 插入后裁到 maxRows（保留最新 id 段）', async () => {
    const ctx = openCtx[openCtx.push(await setup({ maxRows: 40, flushBatch: 5, flushIntervalMs: 0 })) - 1]!;
    for (let i = 1; i <= 100; i++) {
      ctx.sink.stream.write(JSON.stringify({ level: 30, time: Date.now(), msg: `m${i}` }));
      if (i % 5 === 0) await ctx.sink.flush(); // 每批恰好 5 行 → 100 行共 20 次 batch 插入
    }
    await ctx.sink.flush();

    expect(await logCount(ctx.db)).toBe(40); // 写入 100 > maxRows → 总行数收敛到 maxRows
    const rows = await logRows(ctx.db);
    expect(rows[0]!.id).toBe(61); // 保留最新 40 行：id 61..100
    expect(rows[rows.length - 1]!.id).toBe(100);
  });

  it('flushIntervalMs 到时自动 flush（无需显式调用）', async () => {
    const ctx = openCtx[openCtx.push(await setup({ flushIntervalMs: 50, flushBatch: 1000 })) - 1]!;
    ctx.logger.info('by timer');
    await until(async () => (await logCount(ctx.db)) === 1);
    expect(ctx.sink.written()).toBe(1);
  });

  it('flushBatch 定量触发：积满即写库；未满的行留到显式 flush', async () => {
    const ctx = openCtx[openCtx.push(await setup({ flushIntervalMs: 0, flushBatch: 3 })) - 1]!;
    ctx.logger.info('a');
    ctx.logger.info('b');
    ctx.logger.info('c');
    await until(async () => (await logCount(ctx.db)) === 3);

    ctx.logger.info('d'); // 未达 flushBatch 且无定时器：仍在缓冲
    await tick();
    expect(await logCount(ctx.db)).toBe(3);

    await ctx.sink.flush();
    expect(await logCount(ctx.db)).toBe(4);
    expect(ctx.sink.written()).toBe(4);
  });

  it('DB 抛错不炸流：flush 不抛、流保持可用、process.emitWarning 按 60s 窗口去重', async () => {
    const boom = new Error('simulated sqlite failure');
    // 最小 knex 替身：可调用（db(table).insert 抛错）+ schema.hasTable / raw 抛错
    const failing = Object.assign(
      (_table: string) => ({
        insert: async () => {
          throw boom;
        },
      }),
      {
        schema: { hasTable: async () => true },
        raw: async () => {
          throw boom;
        },
      },
    ) as unknown as Knex;

    const warnings: Error[] = [];
    const onWarning = (w: Error): void => {
      warnings.push(w);
    };
    process.on('warning', onWarning);
    const errors: unknown[] = [];
    try {
      const sink = createSqliteLogSink(failing, { flushIntervalMs: 0, flushBatch: 1000 });
      const stream = sink.stream as Writable;
      stream.on('error', (e: unknown) => errors.push(e));
      const logger = createLogger(loadConfig({ HARNESS_LOG_LEVEL: 'info' }), sink.stream);

      logger.info('first');
      await expect(sink.flush()).resolves.toBeUndefined(); // flush 自身不抛
      logger.info('second');
      await sink.flush();
      await new Promise((resolve) => setTimeout(resolve, 20)); // emitWarning 异步派发

      const ours = warnings.filter((w) => w.name === 'SqliteLogSinkWriteFailed');
      expect(ours).toHaveLength(1); // 1 分钟窗口内两次失败只告警一次
      expect(ours[0]!.message).toContain('simulated sqlite failure');

      expect(errors).toHaveLength(0); // 错误未进入流
      expect(stream.writable).toBe(true);

      logger.info('third'); // 继续可用
      await sink.flush();
      expect(sink.written()).toBe(3);
    } finally {
      process.off('warning', onWarning);
    }
  });

  it('close：缓冲写尽、written 计数稳定、流结束、幂等', async () => {
    const ctx = openCtx[openCtx.push(await setup()) - 1]!; // flushBatch=1000：行不会定量触发
    ctx.logger.info('one');
    ctx.logger.info('two');
    ctx.logger.info('three');

    await ctx.sink.close(); // 未显式 flush，close 写尽缓冲
    expect(await logCount(ctx.db)).toBe(3);

    const written = ctx.sink.written();
    expect(written).toBe(3);
    await tick();
    expect(ctx.sink.written()).toBe(written); // close 后计数稳定

    const stream = ctx.sink.stream as Writable;
    expect(stream.writableEnded).toBe(true);
    await expect(ctx.sink.close()).resolves.toBeUndefined(); // 幂等
  });

  it('level 数字→名称全映射（含对象模式直写 chunk）', async () => {
    const ctx = openCtx[openCtx.push(await setup()) - 1]!;
    const mapping: Array<[number, string]> = [
      [10, 'trace'],
      [20, 'debug'],
      [30, 'info'],
      [40, 'warn'],
      [50, 'error'],
      [60, 'fatal'],
    ];
    for (const [num] of mapping) {
      ctx.sink.stream.write(JSON.stringify({ level: num, time: Date.now(), msg: `l${num}` }));
    }
    (ctx.sink.stream as Writable).write({ level: 30, time: Date.now(), msg: 'obj-mode', scope: 'obj' }); // 对象模式直写
    await ctx.sink.flush();

    const rows = await logRows(ctx.db);
    expect(rows.map((r) => r.level)).toEqual([...mapping.map(([, name]) => name), 'info']);
    expect(rows[rows.length - 1]!.scope).toBe('obj');
  });
});

// ---------------------------------------------------------------------------
// createBootLogger
// ---------------------------------------------------------------------------

describe('createBootLogger', () => {
  it('addSink 后 stdout 流仍收到日志（双流同达）', async () => {
    const out: string[] = [];
    const extra: string[] = [];
    const boot = createBootLogger(loadConfig({ HARNESS_LOG_LEVEL: 'info' }), { stdout: capture(out) });
    boot.addSink(capture(extra));

    boot.logger.info('both streams');
    await tick();

    expect(out).toHaveLength(1);
    expect((JSON.parse(out[0] ?? '{}') as { msg?: string }).msg).toBe('both streams');
    expect(extra).toHaveLength(1);
    expect((JSON.parse(extra[0] ?? '{}') as { msg?: string }).msg).toBe('both streams');
  });

  it('addSink 低级别触发 logger 级别下调；stdout 按自身级别过滤', async () => {
    const out: string[] = [];
    const extra: string[] = [];
    const boot = createBootLogger(loadConfig({ HARNESS_LOG_LEVEL: 'error' }), { stdout: capture(out) });
    boot.addSink(capture(extra), 'debug');

    boot.logger.debug('only sink sees debug');
    boot.logger.error('both see error');
    await tick();

    expect(extra).toHaveLength(2);
    expect((JSON.parse(extra[0] ?? '{}') as { level?: number }).level).toBe(20);
    expect(out).toHaveLength(1); // stdout 条目级别 error：debug 被该流过滤
    expect((JSON.parse(out[0] ?? '{}') as { msg?: string }).msg).toBe('both see error');
  });

  it('addSink 未传 level 沿用 cfg.logLevel；redact 与时间戳语义一致', async () => {
    const out: string[] = [];
    const extra: string[] = [];
    const boot = createBootLogger(loadConfig({ HARNESS_LOG_LEVEL: 'warn' }), { stdout: capture(out) });
    boot.addSink(capture(extra));

    boot.logger.debug('dropped below cfg.logLevel');
    boot.logger.warn({ token: 'leak-me' }, 'kept');
    await tick();

    expect(extra).toHaveLength(1);
    const row = JSON.parse(extra[0] ?? '{}') as { token?: string; level?: number; time?: number };
    expect(row.token).toBe('[REDACTED]');
    expect(row.level).toBe(40);
    expect(typeof row.time).toBe('number');
    expect(out).toHaveLength(1); // stdout 同步收到同一条
  });
});
