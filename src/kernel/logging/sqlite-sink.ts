/**
 * SQLite 日志汇（pino DestinationStream → `logs` 表）。
 *
 * - `createSqliteLogSink(db, opts)`：把 pino logger 的输出批量落库到
 *   内核迁移 003（`kernel-migrations.ts`）定义的 `logs` 表（也可用同名同构表）
 * - 行写入采用**缓冲批量**：每 `flushIntervalMs`（默认 500ms）定时 flush，
 *   或缓冲积满 `flushBatch`（默认 50）行立即 flush
 * - 环形裁剪：每累计 20 次 batch 插入后保留最新 `maxRows`（默认 5000）行
 * - 容错：任何数据库错误都不进入流（catch → `process.emitWarning`
 *   按 60s 窗口去重 → 丢弃本批继续运行），日志系统永不拖垮内核
 *
 * 落库映射：`level` 数字 → 名称（30→'info'…）；`scope` 取 `chunk.scope ?? ''`；
 * `data` 为除 level/time/msg/scope 外其余字段的 JSON 串（序列化失败置 null，
 * 无附加字段时置 null）。pino 的 redact 在序列化层先于本 sink 生效，
 * 因此密钥字段落库前已被替换为 [REDACTED]。
 */
import { Writable } from 'node:stream';

import type { Knex } from 'knex';
import type { DestinationStream, Level } from 'pino';

/** pino 级别名 → 数字（pino 官方映射） */
export const LOG_LEVEL_NUM: Readonly<Record<Level, number>> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

/** pino 数字级别 → 名称（落库 `level` TEXT 列用）；未知数字原样字符串化 */
const LEVEL_NAME: Readonly<Record<number, string>> = {
  10: 'trace',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal',
};

/** 环形裁剪节奏：每累计 20 次 batch 插入执行一次裁剪 */
const PRUNE_EVERY_BATCHES = 20;

/** 数据库错误告警去重窗口（毫秒）：窗口内最多 `process.emitWarning` 一次 */
const WARN_DEDUPE_MS = 60_000;

export interface SqliteSinkOptions {
  /** 日志表名，默认 `logs`（内核迁移 003 的同构表） */
  table?: string;
  /** 环形裁剪保留的最新行数，默认 5000 */
  maxRows?: number;
  /** 定时 flush 间隔（毫秒），默认 500；传 <=0 关闭定时 flush（仅靠定量/显式 flush） */
  flushIntervalMs?: number;
  /** 批量阈值：缓冲积满该行数立即 flush；也是单条 INSERT 的最大行数。默认 50 */
  flushBatch?: number;
  /** 落库最低级别（含本级），默认 `trace`（不过滤） */
  minLevel?: Level;
}

export interface SqliteLogSink {
  /** 供 pino 作为 destination 的对象模式 Writable（接收 pino 序列化行或日志对象） */
  stream: DestinationStream;
  /** 把当前缓冲写尽（内部串行化排队；可安全并发/重复调用） */
  flush(): Promise<void>;
  /** 停止定时器 → 写尽缓冲 → end 流（幂等） */
  close(): Promise<void>;
  /** 已接收入队的日志行数（minLevel 过滤后）；全部 flush 成功时等于已落库行数 */
  written(): number;
}

/** 待落库的一行日志（列对应 `logs` 表：ts/level/scope/message/data） */
interface LogRow {
  ts: number;
  level: string;
  scope: string;
  message: string;
  data: string | null;
}

/**
 * 创建 SQLite 日志汇。
 *
 * @param db knex 实例（通常为 `openSqlite()` 打开的内核库；表可由内核迁移
 *   003 预先创建，或由 sink 首次 flush 时惰性建表）
 * @param opts 见 {@link SqliteSinkOptions}
 */
export function createSqliteLogSink(db: Knex, opts: SqliteSinkOptions = {}): SqliteLogSink {
  const table = opts.table ?? 'logs';
  const maxRows = opts.maxRows ?? 5000;
  const flushBatch = Math.max(1, Math.floor(opts.flushBatch ?? 50));
  const flushIntervalMs = opts.flushIntervalMs ?? 500;
  const minLevelNum = LOG_LEVEL_NUM[opts.minLevel ?? 'trace'];

  /** 待落库缓冲 */
  let buffer: LogRow[] = [];
  /** 已接收入队的行数（{@link SqliteLogSink.written}） */
  let writtenCount = 0;
  /** 距上次环形裁剪累计的 batch 插入次数 */
  let batchesSincePrune = 0;
  /** 上次 emitWarning 时刻（去重窗口起点） */
  let lastWarnAt = 0;
  /** 窗口内被抑制的错误数（随下一次告警一并上报） */
  let suppressedErrors = 0;
  let closed = false;
  /** 建表备忘录（惰性、只确保一次；失败可重试） */
  let tableReady: Promise<void> | null = null;
  /**
   * 写库操作串行化链：定时 / 定量 / 显式 flush 全部在此排队，绝不交错执行。
   * performFlush 内部吞掉一切错误，链条永不变 rejected。
   */
  let writeChain: Promise<void> = Promise.resolve();

  const timer =
    flushIntervalMs > 0
      ? setInterval(() => {
          void flushQueued();
        }, flushIntervalMs)
      : null;
  // 定时器不阻止进程退出（close 之外的生命周期结束不因日志汇挂起）
  timer?.unref();

  // ---------------------------------------------------------------------------
  // flush 管线
  // ---------------------------------------------------------------------------

  /** 把一次 flush 追加到串行化链尾并返回链尾 promise（调用方 await 即等全部积压完成） */
  function flushQueued(): Promise<void> {
    writeChain = writeChain.then(
      () => performFlush(),
      () => performFlush(),
    );
    return writeChain;
  }

  /**
   * 把当前缓冲批量写尽：swap 出缓冲 → 确保表存在 → 按 `flushBatch` 分片 INSERT；
   * 每累计 20 个分片执行一次环形裁剪。任何数据库错误都被吞掉
   * （reportDbError 去重告警），本批日志丢弃、sink 继续可用。
   */
  async function performFlush(): Promise<void> {
    if (buffer.length === 0) return;
    const rows = buffer;
    buffer = [];
    try {
      await ensureTable();
      for (let i = 0; i < rows.length; i += flushBatch) {
        const batch = rows.slice(i, i + flushBatch);
        await db(table).insert(batch);
        batchesSincePrune += 1;
        if (batchesSincePrune >= PRUNE_EVERY_BATCHES) {
          batchesSincePrune = 0;
          await prune();
        }
      }
    } catch (cause) {
      reportDbError(cause);
    }
  }

  /** 环形裁剪：只保留 id 最大的 maxRows 行 */
  async function prune(): Promise<void> {
    await db.raw(
      'DELETE FROM ?? WHERE id NOT IN (SELECT id FROM ?? ORDER BY id DESC LIMIT ?)',
      [table, table, maxRows],
    );
  }

  /** 惰性确保 logs 同构表存在（备忘录化；失败清空备忘录以便下次 flush 重试） */
  function ensureTable(): Promise<void> {
    tableReady ??= (async () => {
      if (await db.schema.hasTable(table)) return;
      await db.schema.createTable(table, (t) => {
        t.increments('id'); // INTEGER PK AUTOINCREMENT
        t.integer('ts').notNullable(); // UTC epoch ms
        t.text('level').notNullable();
        t.text('scope').notNullable().defaultTo('');
        t.text('message').notNullable();
        t.text('data'); // JSON 字符串（附加字段）；无附加字段为 NULL
        t.index(['ts'], `${table}_ts_index`);
      });
    })().catch((cause: unknown) => {
      tableReady = null; // 失败不长期污染备忘录：下次 flush 重建
      throw cause;
    });
    return tableReady;
  }

  /**
   * 数据库错误上报：`process.emitWarning`，按 WARN_DEDUPE_MS 窗口去重，
   * 窗口内后续错误只累计计数（在下一次告警文本中体现），绝不抛入流。
   */
  function reportDbError(cause: unknown): void {
    suppressedErrors += 1;
    const now = Date.now();
    if (now - lastWarnAt < WARN_DEDUPE_MS) return;
    const text = cause instanceof Error ? cause.message : String(cause);
    const warning = new Error(
      `[sqlite-sink] writing to "${table}" failed; dropped buffered log rows, sink stays alive ` +
        `(${suppressedErrors - 1} further error(s) suppressed in the last ${WARN_DEDUPE_MS / 1000}s): ${text}`,
    );
    warning.name = 'SqliteLogSinkWriteFailed';
    lastWarnAt = now;
    suppressedErrors = 0;
    process.emitWarning(warning);
  }

  // ---------------------------------------------------------------------------
  // 入流解析
  // ---------------------------------------------------------------------------

  /**
   * 归一化 chunk 为日志对象。pino 向 destination 写入的是序列化 JSON 行
   * （string/Buffer），此处解析回对象；也兼容直接 write 日志对象的用法。
   * 解析失败（坏行）返回 null 并静默丢弃。
   */
  function parseRecord(chunk: unknown): Record<string, unknown> | null {
    if (typeof chunk === 'string') {
      try {
        return JSON.parse(chunk) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
    if (chunk instanceof Uint8Array) {
      try {
        return JSON.parse(Buffer.from(chunk).toString('utf8')) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
    if (chunk !== null && typeof chunk === 'object') return chunk as Record<string, unknown>;
    return null;
  }

  /** 日志对象 → 待落库行（level 数字→名称；scope 缺省 ''；data 序列化失败置 null） */
  function toRow(rec: Record<string, unknown>): LogRow {
    const { level, time, msg, scope, ...rest } = rec;
    let data: string | null = null;
    try {
      data = Object.keys(rest).length > 0 ? JSON.stringify(rest) : null;
    } catch {
      data = null;
    }
    return {
      ts: typeof time === 'number' && Number.isFinite(time) ? time : Date.now(),
      level: LEVEL_NAME[level as number] ?? String(level ?? 'info'),
      scope: scope == null ? '' : String(scope),
      message: msg == null ? '' : String(msg),
      data,
    };
  }

  const writable = new Writable({
    objectMode: true,
    write(chunk: unknown, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
      const rec = parseRecord(chunk);
      if (rec !== null) {
        // 级别过滤在 sink 内完成（调用方无法在 Writable.write 前按行控制）；
        // level 非数字（异常行）放行，避免静默吞日志
        if (typeof rec.level !== 'number' || rec.level >= minLevelNum) {
          buffer.push(toRow(rec));
          writtenCount += 1;
          if (buffer.length >= flushBatch) void flushQueued();
        }
      }
      callback(); // 永不向流传错：日志写库失败不炸日志流
    },
  });

  // ---------------------------------------------------------------------------
  // 公开 API
  // ---------------------------------------------------------------------------

  return {
    stream: writable,
    flush: () => flushQueued(),
    written: () => writtenCount,
    close: async () => {
      if (closed) return;
      closed = true;
      if (timer) clearInterval(timer);
      await flushQueued(); // 写尽缓冲
      writable.end(); // close 后流结束
    },
  };
}
