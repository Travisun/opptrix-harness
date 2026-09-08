/**
 * cron — 定时任务持久化存储（CronJobStore，knex + SQLite）。
 *
 * - 表结构同构于内核迁移 006_cron_jobs / 007_cron_runs（权威 Schema 见
 *   `src/kernel/storage/kernel-migrations.ts`）；`ensureTable()` 惰性幂等建表，
 *   便于在未跑内核迁移的独立 SQLite 上使用（与迁移先到先建，可安全共存）。
 * - 时间列一律 UTC epoch ms；布尔语义列 0/1；payload 以 JSON 字符串落库。
 * - payload 反序列化失败（脏数据/损坏）不抛错：该字段置 null，其余字段正常返回。
 * - schema 信任约定与 SettingsService 一致：返回值按 CronJobRecord 形状信任，
 *   不做逐行运行时校验。
 */
import type { Knex } from 'knex';

import { err, HarnessError } from '../errors/index.js';
import type { CronJobRecord } from './scheduler.js';

/** 定时任务记录（权威定义见调度器模块，此处 re-export 供存储/REST 层共用） */
export type { CronJobRecord };

const JOBS_TABLE = 'cron_jobs';
const RUNS_TABLE = 'cron_runs';

/** history() 未显式给 limit 时的默认条数（与 REST 层默认一致） */
const DEFAULT_HISTORY_LIMIT = 50;
/** history() 硬上限：防御性钳制，避免负数/超大 limit 造成全表倾泻 */
const MAX_HISTORY_LIMIT = 1000;

/**
 * 单次执行历史条目（cron_runs 行的 camelCase 视图）。
 */
export interface CronRunEntry {
  /** 开始时间（UTC epoch ms） */
  startedAt: number;
  /** 结束时间（UTC epoch ms；null = 尚未结束） */
  finishedAt: number | null;
  /** 是否成功 */
  ok: boolean;
  /** 执行耗时（毫秒；null = 未知） */
  durationMs: number | null;
  /** 失败原因（null = 成功） */
  error: string | null;
}

/** cron_jobs 表原始行（snake_case） */
interface CronJobRow {
  id: string;
  ext_id: string | null;
  name: string;
  expr: string;
  tz: string;
  payload: string | null;
  enabled: number;
  overlap: string;
  misfire: string;
  last_run: number | null;
  next_run: number | null;
  created_at: number;
}

/** cron_runs 表原始行（snake_case） */
interface CronRunRow {
  started_at: number;
  finished_at: number | null;
  ok: number;
  duration_ms: number | null;
  error: string | null;
}

/** CronJobRecord 可更新字段 → 列名映射（id 为主键不可更新，刻意不在表内） */
const PATCH_COLUMN_MAP = {
  extId: 'ext_id',
  name: 'name',
  expr: 'expr',
  tz: 'tz',
  payload: 'payload',
  enabled: 'enabled',
  overlap: 'overlap',
  misfire: 'misfire',
  lastRun: 'last_run',
  nextRun: 'next_run',
  createdAt: 'created_at',
} as const;

/**
 * payload 序列化为 JSON 字符串（落库形状）。
 * undefined / null → SQL NULL；不可序列化（循环引用、BigInt 等）抛 DB_ERROR，
 * 错误信息可操作：指出是哪个任务的 payload、该怎么改。
 */
function serializePayload(payload: unknown, context: string): string | null {
  if (payload === undefined || payload === null) return null;
  let json: string;
  try {
    json = JSON.stringify(payload) as string;
  } catch (e) {
    throw err('DB_ERROR', {
      message:
        `cron store ${context}: payload is not JSON-serializable ` +
        '(circular reference or BigInt?). Serialize the payload to plain JSON before saving.',
      detail: { context },
      cause: e,
    });
  }
  if (typeof json !== 'string') {
    throw err('DB_ERROR', {
      message:
        `cron store ${context}: payload is not JSON-serializable ` +
        '(undefined has no JSON form). Store null instead of undefined.',
      detail: { context },
    });
  }
  return json;
}

/** cron_jobs 行 → CronJobRecord；payload 损坏（非法 JSON）置 null，不抛错 */
function rowToRecord(row: CronJobRow): CronJobRecord {
  let payload: unknown = null;
  if (row.payload !== null && row.payload !== undefined) {
    try {
      payload = JSON.parse(row.payload) as unknown;
    } catch {
      payload = null; // 脏数据容错：单条损坏不影响整体读取
    }
  }
  return {
    id: row.id,
    extId: row.ext_id ?? null,
    name: row.name,
    expr: row.expr,
    tz: row.tz,
    payload,
    enabled: row.enabled !== 0,
    overlap: row.overlap as CronJobRecord['overlap'],
    misfire: row.misfire as CronJobRecord['misfire'],
    lastRun: row.last_run ?? null,
    nextRun: row.next_run ?? null,
    createdAt: row.created_at,
  };
}

/**
 * patch 对象 → 更新列集合。规则：
 * - `id` 忽略（主键不可变）；未声明字段忽略；值 undefined 视为"未提供"忽略；
 * - payload 序列化、enabled 布尔转 0/1、可空引用字段 undefined→null 由各自分支处理；
 * - 无任何可更新列时返回 null（调用方只回读）。
 */
function patchToColumns(patch: Partial<CronJobRecord>, context: string): Record<string, unknown> | null {
  const cols: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'id' || value === undefined) continue;
    if (!(key in PATCH_COLUMN_MAP)) continue; // 未知字段忽略（容错而非抛错）
    switch (key) {
      case 'payload':
        cols['payload'] = serializePayload(value, context);
        break;
      case 'enabled':
        cols['enabled'] = value ? 1 : 0;
        break;
      case 'extId':
      case 'lastRun':
      case 'nextRun':
      case 'createdAt':
        cols[PATCH_COLUMN_MAP[key]] = value ?? null;
        break;
      default:
        cols[PATCH_COLUMN_MAP[key as keyof typeof PATCH_COLUMN_MAP]] = value;
    }
  }
  return Object.keys(cols).length > 0 ? cols : null;
}

/**
 * 定时任务持久化存储（cron_jobs / cron_runs 两表）。
 *
 * 所有方法先经 `ensureTable()` 惰性建表（幂等、Promise 缓存去重），
 * 因此在已跑内核迁移的库与空白库上均可直接使用。
 */
export class CronJobStore {
  /** 惰性建表的共享 Promise：并发调用只触发一次；失败后重置以便重试 */
  private tableReady?: Promise<void>;

  constructor(private readonly db: Knex) {}

  /**
   * 惰性幂等建表：cron_jobs / cron_runs 缺哪张补哪张（结构同构于内核迁移
   * 006/007，含同名索引）。表已存在时直接跳过，不校验亦不修改既有结构。
   * 并发调用共享同一次建表；失败后允许下次调用重试。
   *
   * @throws HarnessError（DB_ERROR）建表失败
   */
  ensureTable(): Promise<void> {
    this.tableReady ??= this.createTables().catch((e: unknown) => {
      this.tableReady = undefined; // 失败后重置，允许下次重试
      throw HarnessError.wrap(e, 'DB_ERROR');
    });
    return this.tableReady;
  }

  /**
   * 新增一条任务记录（id 由调用方生成并保证唯一，重复 id 将因主键冲突抛错）。
   *
   * @throws HarnessError（DB_ERROR）payload 不可序列化或插入失败
   */
  async create(rec: CronJobRecord): Promise<void> {
    await this.ensureTable();
    await this.db(JOBS_TABLE).insert({
      id: rec.id,
      ext_id: rec.extId ?? null,
      name: rec.name,
      expr: rec.expr,
      tz: rec.tz,
      payload: serializePayload(rec.payload, `create(${rec.id})`),
      enabled: rec.enabled ? 1 : 0,
      overlap: rec.overlap,
      misfire: rec.misfire,
      last_run: rec.lastRun ?? null,
      next_run: rec.nextRun ?? null,
      created_at: rec.createdAt ?? Date.now(),
    });
  }

  /**
   * 按 ID 读取任务记录；不存在返回 null。
   * payload 损坏（非法 JSON）时记录仍返回，payload 字段置 null。
   */
  async get(id: string): Promise<CronJobRecord | null> {
    await this.ensureTable();
    const row = (await this.db(JOBS_TABLE).where('id', id).first()) as CronJobRow | undefined;
    return row === undefined ? null : rowToRecord(row);
  }

  /**
   * 列出任务记录，按 created_at 升序（次序键 id 升序，保证同毫秒稳定排序）。
   *
   * @param opts.extId 给定字符串时按扩展过滤；给定 null 时只列内核级任务
   *   （ext_id IS NULL）；缺省（undefined）时不过滤。
   */
  async list(opts?: { extId?: string | null }): Promise<CronJobRecord[]> {
    await this.ensureTable();
    let query = this.db(JOBS_TABLE).select('*');
    if (opts?.extId !== undefined) {
      query = opts.extId === null ? query.whereNull('ext_id') : query.where('ext_id', opts.extId);
    }
    const rows = (await query.orderBy('created_at', 'asc').orderBy('id', 'asc')) as CronJobRow[];
    return rows.map(rowToRecord);
  }

  /**
   * 部分更新任务记录：只写 patch 中显式提供的字段（undefined 与未知字段忽略；
   * id 不可变）。更新成功后返回最新记录。
   *
   * @returns 更新后的记录；任务不存在返回 null
   * @throws HarnessError（DB_ERROR）payload 不可序列化或更新失败
   */
  async update(id: string, patch: Partial<CronJobRecord>): Promise<CronJobRecord | null> {
    await this.ensureTable();
    const cols = patchToColumns(patch, `update(${id})`);
    if (cols === null) return this.get(id); // 空 patch：仅回读
    await this.db(JOBS_TABLE).where('id', id).update(cols);
    return this.get(id);
  }

  /**
   * 删除任务记录。
   * @returns 是否确有行被删除（不存在返回 false）
   */
  async delete(id: string): Promise<boolean> {
    await this.ensureTable();
    const affected = await this.db(JOBS_TABLE).where('id', id).del();
    return affected > 0;
  }

  /**
   * 仅更新启用开关。
   * @returns 更新后的记录；任务不存在返回 null
   */
  async setEnabled(id: string, enabled: boolean): Promise<CronJobRecord | null> {
    await this.ensureTable();
    const existing = await this.get(id);
    if (existing === null) return null;
    await this.db(JOBS_TABLE).where('id', id).update({ enabled: enabled ? 1 : 0 });
    return this.get(id);
  }

  /**
   * 调度器回写执行水位：last_run / next_run（两个值都写，传 null 即清除）。
   * 任务不存在时静默无操作（水位回写允许晚于任务删除到达）。
   */
  async touchRun(id: string, patch: { lastRun: number | null; nextRun: number | null }): Promise<void> {
    await this.ensureTable();
    await this.db(JOBS_TABLE).where('id', id).update({
      last_run: patch.lastRun ?? null,
      next_run: patch.nextRun ?? null,
    });
  }

  /**
   * 追加一条执行记录（cron_runs）。
   *
   * @throws HarnessError（DB_ERROR）插入失败
   */
  async recordRun(entry: {
    jobId: string;
    startedAt: number;
    finishedAt?: number;
    ok: boolean;
    durationMs?: number;
    error?: string;
  }): Promise<void> {
    await this.ensureTable();
    await this.db(RUNS_TABLE).insert({
      job_id: entry.jobId,
      started_at: entry.startedAt,
      finished_at: entry.finishedAt ?? null,
      ok: entry.ok ? 1 : 0,
      duration_ms: entry.durationMs ?? null,
      error: entry.error ?? null,
    });
  }

  /**
   * 读取某任务的执行历史，按 started_at 降序（最新在前；次序键 id 降序）。
   *
   * @param limit 返回条数上限；缺省 {@link DEFAULT_HISTORY_LIMIT}，
   *   实际取值钳制到 [1, 1000]
   */
  async history(jobId: string, limit?: number): Promise<CronRunEntry[]> {
    await this.ensureTable();
    const requested = typeof limit === 'number' && Number.isFinite(limit) ? Math.trunc(limit) : DEFAULT_HISTORY_LIMIT;
    const effective = Math.min(Math.max(requested, 1), MAX_HISTORY_LIMIT);
    const rows = (await this.db(RUNS_TABLE)
      .select('started_at', 'finished_at', 'ok', 'duration_ms', 'error')
      .where('job_id', jobId)
      .orderBy('started_at', 'desc')
      .orderBy('id', 'desc')
      .limit(effective)) as CronRunRow[];
    return rows.map((row) => ({
      startedAt: row.started_at,
      finishedAt: row.finished_at ?? null,
      ok: row.ok !== 0,
      durationMs: row.duration_ms ?? null,
      error: row.error ?? null,
    }));
  }

  /** 实际建表：cron_jobs / cron_runs 缺哪张补哪张（幂等） */
  private async createTables(): Promise<void> {
    if (!(await this.db.schema.hasTable(JOBS_TABLE))) {
      await this.db.schema.createTable(JOBS_TABLE, (t) => {
        t.text('id').primary();
        t.text('ext_id'); // null = 内核级任务
        t.text('name').notNullable();
        t.text('expr').notNullable(); // cron 表达式
        t.text('tz').notNullable(); // IANA 时区
        t.text('payload'); // JSON 字符串（任务负载）
        t.integer('enabled').notNullable().defaultTo(1); // 0/1
        t.text('overlap').notNullable().defaultTo('skip'); // skip | allow
        t.text('misfire').notNullable().defaultTo('skip'); // skip | run
        t.integer('last_run'); // UTC epoch ms
        t.integer('next_run'); // UTC epoch ms
        t.integer('created_at').notNullable(); // UTC epoch ms
        t.index(['ext_id'], 'cron_jobs_ext_id_index');
      });
    }
    if (!(await this.db.schema.hasTable(RUNS_TABLE))) {
      await this.db.schema.createTable(RUNS_TABLE, (t) => {
        t.increments('id'); // INTEGER PK AUTOINCREMENT
        t.text('job_id').notNullable();
        t.integer('started_at').notNullable(); // UTC epoch ms
        t.integer('finished_at'); // UTC epoch ms
        t.integer('ok').notNullable(); // 0/1
        t.integer('duration_ms'); // 执行耗时
        t.text('error'); // 失败原因
        t.index(['job_id', 'started_at'], 'cron_runs_job_id_started_at_index');
      });
    }
  }
}
