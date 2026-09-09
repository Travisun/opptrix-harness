/**
 * agents — 子代理持久化存储（SubagentStore，knex + SQLite）。
 *
 * - 表结构同构于内核迁移 016_subagents（权威 Schema 见 `src/kernel/storage/kernel-migrations.ts`）；
 *   `ensureTable()` 惰性幂等建表，因此在未跑内核迁移的独立 SQLite 上也可直接使用
 *   （先到先建：迁移先跑则本层跳过建表；本层先建则 016 迁移不再对该库执行——单一方向，勿混用）；
 * - 时间列一律 UTC epoch ms；tool_names/transcript 以 JSON 字符串落库（序列化/反序列化由本模块负责）；
 * - 实现 `SubagentStoreLike` 契约（manager 的 deps.store）；状态转移的条件守卫在 manager 侧
 *   （经 update 的条件 patch 由 manager 判定后再写入），本层只做朴素读写；
 * - JSON 反序列化失败（脏数据/损坏）不抛错：该字段置 null，其余字段正常返回。
 */
import type { Knex } from 'knex';

import { err, HarnessError } from '../errors/index.js';
import {
  SUBAGENT_STATUSES,
  type SubagentPatch,
  type SubagentRecord,
  type SubagentStatus,
  type SubagentStoreLike,
} from './types.js';

const SUBAGENTS_TABLE = 'subagents';

/** 子代理状态守卫（zod 枚举与调用方校验共用） */
export const SUBAGENT_STATUS_SET: ReadonlySet<string> = new Set(SUBAGENT_STATUSES);

/** subagents 表原始行（snake_case） */
interface SubagentRow {
  id: string;
  parent_id: string;
  depth: number;
  model: string | null;
  system_prompt: string | null;
  prompt: string;
  tool_names: string | null;
  status: string;
  result: string | null;
  error: string | null;
  transcript: string | null;
  usage_in: number | null;
  usage_out: number | null;
  created_at: number | null;
  started_at: number | null;
  finished_at: number | null;
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

/** subagents 行 → SubagentRecord；tool_names/transcript 损坏（非法 JSON）时该字段置 null */
function rowToRecord(row: SubagentRow): SubagentRecord {
  const toolNames = parseJson(row.tool_names);
  const transcript = parseJson(row.transcript);
  return {
    id: row.id,
    parentId: row.parent_id,
    depth: row.depth,
    model: row.model,
    systemPrompt: row.system_prompt,
    prompt: row.prompt,
    toolNames: Array.isArray(toolNames) ? (toolNames as string[]) : null,
    status: row.status as SubagentStatus,
    result: row.result,
    error: row.error,
    transcript: Array.isArray(transcript) ? transcript : null,
    usageIn: row.usage_in,
    usageOut: row.usage_out,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

/**
 * 子代理持久化存储（subagents 表）。
 *
 * 所有方法先经 `ensureTable()` 惰性建表（幂等、Promise 缓存去重），
 * 因此在已跑内核迁移的库与空白库上均可直接使用。
 */
export class SubagentStore implements SubagentStoreLike {
  /** 惰性建表的共享 Promise：并发调用只触发一次；失败后重置以便重试 */
  private tableReady?: Promise<void>;

  constructor(private readonly db: Knex) {}

  /**
   * 惰性幂等建表（结构同构于内核迁移 016_subagents，含同名索引）。
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

  /** 新增记录（全部字段按入参原样落库；id 重复抛 DB_ERROR——manager 侧用 UUID 保证唯一） */
  async create(rec: SubagentRecord): Promise<void> {
    await this.ensureTable();
    try {
      await this.db(SUBAGENTS_TABLE).insert({
        id: rec.id,
        parent_id: rec.parentId,
        depth: rec.depth,
        model: rec.model,
        system_prompt: rec.systemPrompt,
        prompt: rec.prompt,
        tool_names: rec.toolNames === null ? null : JSON.stringify(rec.toolNames),
        status: rec.status,
        result: rec.result,
        error: rec.error,
        transcript: rec.transcript === null ? null : JSON.stringify(rec.transcript),
        usage_in: rec.usageIn,
        usage_out: rec.usageOut,
        created_at: rec.createdAt,
        started_at: rec.startedAt,
        finished_at: rec.finishedAt,
      });
    } catch (e) {
      throw err('DB_ERROR', {
        message: `subagent store: insert failed for "${rec.id}" (duplicate id?)`,
        detail: { id: rec.id },
        cause: e,
      });
    }
  }

  /** 按 ID 读取；不存在返回 null。tool_names/transcript 损坏（非法 JSON）时该字段置 null。 */
  async get(id: string): Promise<SubagentRecord | null> {
    await this.ensureTable();
    const row = (await this.db(SUBAGENTS_TABLE).where('id', id).first()) as SubagentRow | undefined;
    return row === undefined ? null : rowToRecord(row);
  }

  /**
   * 按条件列出，按 created_at 升序（次序键 id 升序，保证同毫秒稳定排序，契合 FIFO 排队语义）。
   *
   * @param filter.parentId 按直接父过滤（'main' = 主会话发起）
   * @param filter.status 按状态过滤
   * @param filter.depth 按树深度过滤
   */
  async list(filter?: { parentId?: string; status?: SubagentStatus; depth?: number }): Promise<SubagentRecord[]> {
    await this.ensureTable();
    let query = this.db(SUBAGENTS_TABLE).select('*');
    if (filter?.parentId !== undefined) query = query.where('parent_id', filter.parentId);
    if (filter?.status !== undefined) query = query.where('status', filter.status);
    if (filter?.depth !== undefined) query = query.where('depth', filter.depth);
    const rows = (await query.orderBy('created_at', 'asc').orderBy('id', 'asc')) as SubagentRow[];
    return rows.map(rowToRecord);
  }

  /**
   * 按 ID 更新允许的字段（未提供的字段保持原值；行不存在时静默 no-op）。
   * transcript 以 JSON 序列化落库；状态合法性由调用方（manager 状态机）保证。
   */
  async update(id: string, patch: SubagentPatch): Promise<void> {
    await this.ensureTable();
    const cols: Record<string, unknown> = {};
    if (patch.status !== undefined) cols['status'] = patch.status;
    if (patch.result !== undefined) cols['result'] = patch.result;
    if (patch.error !== undefined) cols['error'] = patch.error;
    if (patch.transcript !== undefined) {
      cols['transcript'] = patch.transcript === null ? null : JSON.stringify(patch.transcript);
    }
    if (patch.usageIn !== undefined) cols['usage_in'] = patch.usageIn;
    if (patch.usageOut !== undefined) cols['usage_out'] = patch.usageOut;
    if (patch.startedAt !== undefined) cols['started_at'] = patch.startedAt;
    if (patch.finishedAt !== undefined) cols['finished_at'] = patch.finishedAt;
    if (Object.keys(cols).length === 0) return;
    await this.db(SUBAGENTS_TABLE).where('id', id).update(cols);
  }

  /** 实际建表（幂等；结构同构于内核迁移 016_subagents） */
  private async createTable(): Promise<void> {
    if (await this.db.schema.hasTable(SUBAGENTS_TABLE)) return;
    await this.db.schema.createTable(SUBAGENTS_TABLE, (t) => {
      t.text('id').primary();
      t.text('parent_id').notNullable(); // 'main' = 主会话；否则为父 subagent id
      t.integer('depth').notNullable(); // 树深度：main 直接子代 = 1
      t.text('model');
      t.text('system_prompt');
      t.text('prompt').notNullable();
      t.text('tool_names'); // JSON 字符串（工具白名单数组）
      t.text('status').notNullable().defaultTo('running'); // queued | running | done | failed | cancelled
      t.text('result');
      t.text('error');
      t.text('transcript'); // JSON 字符串（消息数组）
      t.integer('usage_in');
      t.integer('usage_out');
      t.integer('created_at'); // UTC epoch ms
      t.integer('started_at'); // UTC epoch ms
      t.integer('finished_at'); // UTC epoch ms
      t.index(['parent_id'], 'subagents_parent_id_index');
      t.index(['status'], 'subagents_status_index');
    });
  }
}
