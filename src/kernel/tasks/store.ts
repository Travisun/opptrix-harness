/**
 * tasks — 长任务持久化存储（TaskStore，knex + SQLite）。
 *
 * - 表结构同构于内核迁移 013_tasks（权威 Schema 见 `src/kernel/storage/kernel-migrations.ts`）；
 *   `ensureTable()` 惰性幂等建表，便于在未跑内核迁移的独立 SQLite 上使用（与迁移先到先建，可安全共存）。
 * - 时间列一律 UTC epoch ms；args/result 以 JSON 字符串落库（读写由本模块负责序列化/反序列化）。
 * - 状态机（由 `transition()` 的条件更新守卫）：
 *     queued → running | cancelled；running → done | failed | cancelled；done / failed / cancelled 终态。
 * - JSON 反序列化失败（脏数据/损坏）不抛错：该字段置 null，其余字段正常返回。
 * - schema 信任约定与 CronJobStore 一致：返回值按 TaskRecord 形状信任，不做逐行运行时校验。
 */
import type { Knex } from 'knex';

import { err, HarnessError } from '../errors/index.js';

const TASKS_TABLE = 'tasks';

/** list() 未显式给 limit 时的默认条数（与 REST 层默认一致） */
export const TASK_LIST_DEFAULT_LIMIT = 50;
/** list() 硬上限：防御性钳制，避免负数/超大 limit 造成全表倾泻 */
export const TASK_LIST_MAX_LIMIT = 500;

/** 任务全量状态集合（zod 枚举与状态机共用） */
export const TASK_STATUSES = ['queued', 'running', 'done', 'failed', 'cancelled'] as const;

/** 任务状态 */
export type TaskStatus = (typeof TASK_STATUSES)[number];

/**
 * 状态机合法转移表：queued → running|cancelled；running → done|failed|cancelled；
 * done / failed / cancelled 为终态（无出边）。
 */
export const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  queued: ['running', 'cancelled'],
  running: ['done', 'failed', 'cancelled'],
  done: [],
  failed: [],
  cancelled: [],
};

/** 长任务记录（tasks 行的 camelCase 视图；时间字段均为 UTC epoch ms） */
export interface TaskRecord {
  id: string;
  /** 扩展标识；空串 = 内核级任务（列 NOT NULL，内核任务以 '' 落库） */
  extId: string;
  name: string;
  /** 任务入参（反序列化后；未提供为 null） */
  args: unknown;
  status: TaskStatus;
  /** 0-100 */
  progress: number;
  progressMsg: string | null;
  /** 任务结果（反序列化后；未完成为 null） */
  result: unknown;
  /** 失败原因（null = 未失败） */
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

/** create() 入参（id 由调用方生成并保证唯一；status 固定落 'queued'） */
export interface TaskCreateInput {
  id: string;
  /** 缺省/.null 时落 ''（内核级任务） */
  extId?: string | null;
  name: string;
  args?: unknown;
}

/** tasks 表原始行（snake_case） */
interface TaskRow {
  id: string;
  ext_id: string;
  name: string;
  args: string | null;
  status: string;
  progress: number;
  progress_msg: string | null;
  result: string | null;
  error: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
}

/**
 * 序列化为 JSON 字符串（落库形状）。undefined / null → SQL NULL；
 * 不可序列化（循环引用、BigInt 等）抛 DB_ERROR，错误信息可操作：指出是哪个任务的哪个字段、该怎么改。
 */
function serializeJson(value: unknown, context: string): string | null {
  if (value === undefined || value === null) return null;
  let json: string;
  try {
    json = JSON.stringify(value) as string;
  } catch (e) {
    throw err('DB_ERROR', {
      message:
        `task store ${context}: value is not JSON-serializable ` +
        '(circular reference or BigInt?). Serialize it to plain JSON before saving.',
      detail: { context },
      cause: e,
    });
  }
  return json;
}

/** JSON 文本 → 反序列化值；text 为空返回 null；脏数据（非法 JSON）容错置 null，不抛错 */
function parseJson(text: string | null): unknown {
  if (text === null || text === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null; // 脏数据容错：单字段损坏不影响整体读取
  }
}

/** tasks 行 → TaskRecord；args/result 损坏（非法 JSON）时该字段置 null */
function rowToRecord(row: TaskRow): TaskRecord {
  return {
    id: row.id,
    extId: row.ext_id,
    name: row.name,
    args: parseJson(row.args),
    status: row.status as TaskStatus,
    progress: row.progress,
    progressMsg: row.progress_msg,
    result: parseJson(row.result),
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

/**
 * 长任务持久化存储（tasks 表）。
 *
 * 所有方法先经 `ensureTable()` 惰性建表（幂等、Promise 缓存去重），
 * 因此在已跑内核迁移的库与空白库上均可直接使用。
 */
export class TaskStore {
  /** 惰性建表的共享 Promise：并发调用只触发一次；失败后重置以便重试 */
  private tableReady?: Promise<void>;

  constructor(private readonly db: Knex) {}

  /**
   * 惰性幂等建表（结构同构于内核迁移 013_tasks，含同名索引）。
   * 表已存在时直接跳过，不校验亦不修改既有结构。
   *
   * @throws HarnessError（DB_ERROR）建表失败
   */
  ensureTable(): Promise<void> {
    this.tableReady ??= this.createTable().catch((e: unknown) => {
      this.tableReady = undefined; // 失败后重置，允许下次重试
      throw HarnessError.wrap(e, 'DB_ERROR');
    });
    return this.tableReady;
  }

  /**
   * 新增任务记录：status 固定 'queued'、progress 0、created_at = 当前 UTC epoch ms。
   *
   * @returns 落库后的完整记录（与后续 get() 回读一致）
   * @throws HarnessError（DB_ERROR）args 不可序列化或插入失败（含重复 id 主键冲突）
   */
  async create(input: TaskCreateInput): Promise<TaskRecord> {
    await this.ensureTable();
    const createdAt = Date.now();
    await this.db(TASKS_TABLE).insert({
      id: input.id,
      ext_id: input.extId ?? '',
      name: input.name,
      args: serializeJson(input.args, `create(${input.id}).args`),
      status: 'queued',
      progress: 0,
      progress_msg: null,
      result: null,
      error: null,
      created_at: createdAt,
      started_at: null,
      finished_at: null,
    });
    return {
      id: input.id,
      extId: input.extId ?? '',
      name: input.name,
      args: input.args ?? null,
      status: 'queued',
      progress: 0,
      progressMsg: null,
      result: null,
      error: null,
      createdAt,
      startedAt: null,
      finishedAt: null,
    };
  }

  /** 按 ID 读取任务记录；不存在返回 null。args/result 损坏（非法 JSON）时该字段置 null。 */
  async get(id: string): Promise<TaskRecord | null> {
    await this.ensureTable();
    const row = (await this.db(TASKS_TABLE).where('id', id).first()) as TaskRow | undefined;
    return row === undefined ? null : rowToRecord(row);
  }

  /**
   * 列出任务记录，按 created_at 升序（次序键 id 升序，保证同毫秒稳定排序，契合 FIFO 语义）。
   *
   * @param opts.extId 按扩展过滤（'' 即内核级任务）
   * @param opts.status 按状态过滤
   * @param opts.limit 条数上限，缺省 50，实际取值钳制到 [1, 500]
   */
  async list(opts?: { extId?: string; status?: TaskStatus; limit?: number }): Promise<TaskRecord[]> {
    await this.ensureTable();
    let query = this.db(TASKS_TABLE).select('*');
    if (opts?.extId !== undefined) query = query.where('ext_id', opts.extId);
    if (opts?.status !== undefined) query = query.where('status', opts.status);
    const requested = typeof opts?.limit === 'number' && Number.isFinite(opts.limit) ? Math.trunc(opts.limit) : TASK_LIST_DEFAULT_LIMIT;
    const effective = Math.min(Math.max(requested, 1), TASK_LIST_MAX_LIMIT);
    const rows = (await query.orderBy('created_at', 'asc').orderBy('id', 'asc').limit(effective)) as TaskRow[];
    return rows.map(rowToRecord);
  }

  /**
   * 条件状态转移（状态机守卫）：
   * 1. 先做静态校验——`from` 中每个状态到 `to` 必须都在 {@link TASK_TRANSITIONS} 内，
   *    否则抛 `HARNESS-903`（调用方编程错误，fail-fast）；
   * 2. 再做条件更新——仅当行当前 status ∈ `from` 时写入 `to`（可附 startedAt/finishedAt）。
   *
   * @returns 是否确有行被更新（行不存在或当前状态不在 `from` 内返回 false，行保持原状）
   * @throws HarnessError（INTERNAL）from 为空，或 from→to 组合违反状态机
   */
  async transition(
    id: string,
    from: TaskStatus[],
    to: TaskStatus,
    patch?: { startedAt?: number; finishedAt?: number },
  ): Promise<boolean> {
    if (from.length === 0) {
      throw err('INTERNAL', { message: '[tasks] transition(): from 不能为空', detail: { id, to } });
    }
    for (const s of from) {
      const allowed = TASK_TRANSITIONS[s];
      if (allowed === undefined || !allowed.includes(to)) {
        throw err('INTERNAL', {
          message:
            `[tasks] 非法状态转移 ${s} → ${to}（${s} 的合法出边：` +
            `${(allowed ?? []).join(' | ') || '无（终态）'}）。请检查状态机调用方。`,
          detail: { id, from: [...from], to },
        });
      }
    }
    const cols: Record<string, unknown> = { status: to };
    if (patch?.startedAt !== undefined) cols['started_at'] = patch.startedAt;
    if (patch?.finishedAt !== undefined) cols['finished_at'] = patch.finishedAt;
    const affected = await this.db(TASKS_TABLE)
      .where('id', id)
      .whereIn('status', from)
      .update(cols);
    return affected > 0;
  }

  /**
   * 写入进度（pct 钳制到 [0,100]；msg 提供时一并写入，未提供保留原值）。
   * @returns 是否确有行被更新（任务不存在返回 false）
   */
  async setProgress(id: string, pct: number, msg?: string): Promise<boolean> {
    await this.ensureTable();
    const clamped = Math.min(100, Math.max(0, Math.round(pct)));
    const cols: Record<string, unknown> = { progress: clamped };
    if (msg !== undefined) cols['progress_msg'] = msg;
    const affected = await this.db(TASKS_TABLE).where('id', id).update(cols);
    return affected > 0;
  }

  /**
   * 写入任务结果（JSON 序列化落库）。
   * @returns 是否确有行被更新；任务不存在返回 false
   * @throws HarnessError（DB_ERROR）result 不可序列化
   */
  async setResult(id: string, result: unknown): Promise<boolean> {
    await this.ensureTable();
    const affected = await this.db(TASKS_TABLE)
      .where('id', id)
      .update({ result: serializeJson(result, `setResult(${id})`) });
    return affected > 0;
  }

  /**
   * 写入失败原因。
   * @returns 是否确有行被更新；任务不存在返回 false
   */
  async setError(id: string, error: string): Promise<boolean> {
    await this.ensureTable();
    const affected = await this.db(TASKS_TABLE).where('id', id).update({ error });
    return affected > 0;
  }

  /** 实际建表（幂等；结构同构于内核迁移 013_tasks） */
  private async createTable(): Promise<void> {
    if (await this.db.schema.hasTable(TASKS_TABLE)) return;
    await this.db.schema.createTable(TASKS_TABLE, (t) => {
      t.text('id').primary();
      t.text('ext_id').notNullable();
      t.text('name').notNullable();
      t.text('args'); // JSON 字符串（任务入参）
      t.text('status').notNullable().defaultTo('queued'); // queued | running | done | failed | cancelled
      t.integer('progress').notNullable().defaultTo(0); // 0-100
      t.text('progress_msg');
      t.text('result'); // JSON 字符串（任务结果）
      t.text('error');
      t.integer('created_at').notNullable(); // UTC epoch ms
      t.integer('started_at'); // UTC epoch ms
      t.integer('finished_at'); // UTC epoch ms
      t.index(['ext_id', 'status'], 'tasks_ext_id_status_index');
    });
  }
}
