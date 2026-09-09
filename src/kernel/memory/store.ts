/**
 * 记忆存储层：内核全局库（kernel.sqlite）中的 `memories` 表 + `memories_fts`（FTS5）。
 *
 * 与扩展库的"惰性建表"模式不同——记忆是**内核全局**数据，但建表仍走惰性 DDL
 * （`ensureTable` 共享 Promise，参照 SettingsService）：内核迁移清单
 * （kernel-migrations.ts）由装配方统一管理，本模块以 `CREATE … IF NOT EXISTS`
 * 幂等共存，迁移先行或本模块先行都成立。
 *
 * FTS5 同步策略（external content 模式）：
 * - `memories_fts(content, tags)` 以 `content='memories', content_rowid='rowid'`
 *   外挂内容——索引正文不重复落库，磁盘占用减半；
 * - 一致性由三个**数据库级触发器**保证（AFTER INSERT/UPDATE/DELETE 同步写虚表），
 *   应用层三写（insert 后手动同步 fts）在异常路径上会漏写，故不用；
 * - 提供 `rebuildFts()` 兜底修复口（`INSERT INTO memories_fts(memories_fts)
 *   VALUES('rebuild')`），供索引损坏/触发器缺失时运维重建。
 *
 * 检索（search）：FTS5 MATCH（unicode61 分词）**优先**；零命中时回退 LIKE
 * 子串匹配——unicode61 不切 CJK（整段中文是单 token），两字中文词 MATCH 恒空，
 * LIKE 兜底保证中文查询可用（sqlite-vec 向量检索为 T1.5 路线，见 docs/memory.mdx）。
 * 排序为 SQL ORDER BY 简化加权：相关性(-bm25) + strength*4 + recency（详见
 * search JSDoc）。
 */
import type { Knex } from 'knex';

import { err } from '../errors/index.js';
import type {
  MemoryForgetFilter,
  MemoryListOptions,
  MemoryRecord,
  MemorySearchHit,
} from './types.js';

/** 表名（内核全局库；迁移清单之外的惰性 DDL，IF NOT EXISTS 幂等共存） */
export const MEMORIES_TABLE = 'memories';

/** FTS5 虚表名（external content → memories） */
export const MEMORIES_FTS_TABLE = 'memories_fts';

/** 检索加权：strength 满值（1.0）最多可抵 4 分 bm25 相关性（简化加权，v1 口径） */
const W_STRENGTH = 4.0;

/** 检索加权：recency 项 = 时间戳 / 1e13（epoch ms ≈ 0.17，恒为正的小额新近加成） */
const RECENCY_DIVISOR = 1e13;

/** LIKE 兜底命中的基础相关性分（低于典型 FTS 命中，避免兜底压过精确命中） */
const LIKE_BASE_SCORE = 1.0;

/** 检索缺省 limit */
export const DEFAULT_SEARCH_LIMIT = 8;

// ---------------------------------------------------------------------------
// DDL（每条语句单独执行：knex better-sqlite3 走 prepare()，仅编译单语句；
// CREATE TRIGGER 的 BEGIN…END 体是单语句语法，可整体 prepare）
// ---------------------------------------------------------------------------

/** 建表语句（顺序敏感：主表 → 虚表 → 触发器） */
const DDL_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'fact',
    tags TEXT NOT NULL DEFAULT '[]',
    source TEXT NOT NULL DEFAULT 'manual',
    scope TEXT NOT NULL DEFAULT 'main',
    session_ref TEXT,
    strength REAL NOT NULL DEFAULT 1.0,
    access_count INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER,
    updated_at INTEGER,
    last_accessed_at INTEGER
  )`,
  'CREATE INDEX IF NOT EXISTS memories_kind_index ON memories (kind)',
  'CREATE INDEX IF NOT EXISTS memories_updated_at_index ON memories (updated_at)',
  `CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
    content, tags, content='memories', content_rowid='rowid'
  )`,
  `CREATE TRIGGER IF NOT EXISTS memories_fts_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts(rowid, content, tags) VALUES (new.rowid, new.content, new.tags);
  END`,
  `CREATE TRIGGER IF NOT EXISTS memories_fts_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content, tags) VALUES ('delete', old.rowid, old.content, old.tags);
  END`,
  `CREATE TRIGGER IF NOT EXISTS memories_fts_au AFTER UPDATE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content, tags) VALUES ('delete', old.rowid, old.content, old.tags);
    INSERT INTO memories_fts(rowid, content, tags) VALUES (new.rowid, new.content, new.tags);
  END`,
];

/** 数据库行（snake_case 原始形状） */
interface MemoryRow {
  id: string;
  content: string;
  kind: string;
  tags: string;
  source: string;
  scope: string;
  session_ref: string | null;
  strength: number;
  access_count: number;
  created_at: number | null;
  updated_at: number | null;
  last_accessed_at: number | null;
}

/** snake_case 行 → camelCase 记录（tags JSON 损坏容错为空数组） */
function rowToRecord(row: MemoryRow): MemoryRecord {
  let tags: string[] = [];
  if (typeof row.tags === 'string' && row.tags !== '') {
    try {
      const parsed: unknown = JSON.parse(row.tags);
      if (Array.isArray(parsed)) tags = parsed.filter((t): t is string => typeof t === 'string');
    } catch {
      tags = []; // 损坏 tags 不拖垮整条记录
    }
  }
  return {
    id: row.id,
    content: row.content,
    kind: row.kind as MemoryRecord['kind'],
    tags,
    source: row.source as MemoryRecord['source'],
    scope: row.scope,
    sessionRef: row.session_ref,
    strength: Number(row.strength),
    accessCount: Number(row.access_count),
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
    lastAccessedAt: row.last_accessed_at === null ? null : Number(row.last_accessed_at),
  };
}

/** FTS5 MATCH 词项转义：拆分空白/逗号，剥掉引号与语法符后逐词加引号（隐式 AND） */
export function ftsMatchQuery(raw: string): string | null {
  const terms = raw
    .split(/[\s,;.，。;；]+/u)
    .map((t) => t.replace(/["*()^:{}]/g, '').trim())
    .filter((t) => t !== '');
  if (terms.length === 0) return null;
  return terms.map((t) => `"${t}"`).join(' ');
}

/** LIKE 模式转义（\、%、_）；返回含 % 通配的子串匹配模式 */
function likePattern(term: string): string {
  const escaped = term.replace(/[\\%_]/g, (c) => `\\${c}`);
  return `%${escaped}%`;
}

// ---------------------------------------------------------------------------
// MemoryStore
// ---------------------------------------------------------------------------

/** 记忆存储（内核全局库；一次连接一个实例） */
export class MemoryStore {
  /** 惰性建表共享 Promise：并发调用只触发一次；失败后重置以便重试 */
  private tableReady?: Promise<void>;

  constructor(private readonly db: Knex) {}

  /** 幂等建表：主表 + 索引 + FTS5 虚表 + 同步触发器（与内核迁移幂等共存） */
  ensureTable(): Promise<void> {
    this.tableReady ??= (async () => {
      for (const statement of DDL_STATEMENTS) {
        try {
          await this.db.raw(statement);
        } catch (e) {
          this.tableReady = undefined; // 失败后允许下次重试
          throw err('DB_ERROR', {
            message: `memory store: failed to ensure schema (statement: ${statement.slice(0, 60)}…): ${
              e instanceof Error ? e.message : String(e)
            }`,
            cause: e,
          });
        }
      }
    })();
    return this.tableReady;
  }

  /** 插入一条记忆（tags 已是 JSON 字符串；id 由调用方生成） */
  async insert(row: {
    id: string;
    content: string;
    kind: string;
    tags: string;
    source: string;
    scope: string;
    sessionRef: string | null;
    strength: number;
    createdAt: number;
    updatedAt: number;
  }): Promise<void> {
    await this.ensureTable();
    await this.db(MEMORIES_TABLE).insert({
      id: row.id,
      content: row.content,
      kind: row.kind,
      tags: row.tags,
      source: row.source,
      scope: row.scope,
      session_ref: row.sessionRef,
      strength: row.strength,
      access_count: 0,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
      last_accessed_at: null,
    });
  }

  /** 按 id 读取（缺失返回 null） */
  async get(id: string): Promise<MemoryRecord | null> {
    await this.ensureTable();
    const row = (await this.db(MEMORIES_TABLE).where('id', id).first('*')) as MemoryRow | undefined;
    return row === undefined ? null : rowToRecord(row);
  }

  /** 精确内容匹配（trim 后全等；同 scope 内）——add 去重用（v1 口径：仅精确匹配） */
  async findByExactContent(content: string, scope: string): Promise<MemoryRecord | null> {
    await this.ensureTable();
    const row = (await this.db(MEMORIES_TABLE)
      .where('scope', scope)
      .where('content', content)
      .first('*')) as MemoryRow | undefined;
    return row === undefined ? null : rowToRecord(row);
  }

  /**
   * 精确 **或前缀** 匹配：既有 content 与待查 content 相同、或一方是另一方的前缀
   * （抽取管线的"相似即跳过"用——LLM 常输出同一事实的长短两种措辞）。
   * 命中多条取 updated_at 最新的一条。
   */
  async findByExactOrPrefix(content: string, scope: string): Promise<MemoryRecord | null> {
    await this.ensureTable();
    const rows = (await this.db.raw(
      `SELECT * FROM memories
       WHERE scope = ?
         AND (
           content = ?
           OR (length(content) > 0 AND instr(?, content) = 1)
           OR (length(?) > 0 AND instr(content, ?) = 1)
         )
       ORDER BY updated_at DESC
       LIMIT 1`,
      [scope, content, content, content, content],
    )) as unknown as MemoryRow[];
    const first = (Array.isArray(rows) ? rows : [rows as unknown as MemoryRow]).find(
      (r): r is MemoryRow => r !== null && typeof r === 'object',
    );
    return first === undefined ? null : rowToRecord(first);
  }

  /** 去重命中后的"刷新"：只推 updated_at（内容/强度不动，避免重复写入膨胀） */
  async touch(id: string, at: number): Promise<void> {
    await this.ensureTable();
    await this.db(MEMORIES_TABLE).where('id', id).update({ updated_at: at });
  }

  /**
   * 检索：FTS5 MATCH 优先，零命中回退 LIKE 子串（CJK 短词）。
   *
   * 简化加权（SQL ORDER BY，越大越相关）：
   *   score = -bm25(fts)          相关性（bm25 越负越相关 → 取负为正分）
   *         + strength * 4.0      强度加成（满强度 +4）
   *         + last_accessed_at / 1e13   新近加成（≈ +0.17 上限，恒小于强度项）
   *   LIKE 兜底命中无 bm25，以固定 1.0 作相关性基线。
   *
   * 命中行由调用方（manager）负责回写 access_count / last_accessed_at。
   */
  async search(query: string, opts: { limit?: number; kind?: string } = {}): Promise<MemorySearchHit[]> {
    await this.ensureTable();
    const limit = opts.limit && opts.limit >= 1 ? Math.floor(opts.limit) : DEFAULT_SEARCH_LIMIT;
    const match = ftsMatchQuery(query);
    const recency = `COALESCE(m.last_accessed_at, m.updated_at, m.created_at, 0) / ${RECENCY_DIVISOR}`;

    let rows: (MemoryRow & { score: number })[] = [];
    if (match !== null) {
      const bindings: Knex.RawBinding[] = [match];
      let kindSql = '';
      if (opts.kind !== undefined) {
        kindSql = ' AND m.kind = ?';
        bindings.push(opts.kind);
      }
      bindings.push(limit);
      rows = (await this.db.raw(
        `SELECT m.*, ((-bm25(memories_fts)) + (m.strength * ${W_STRENGTH}) + ${recency}) AS score FROM memories m
         JOIN memories_fts ON memories_fts.rowid = m.rowid
         WHERE memories_fts MATCH ?${kindSql}
         ORDER BY score DESC
         LIMIT ?`,
        bindings,
      )) as unknown as (MemoryRow & { score: number })[];
    }

    if ((Array.isArray(rows) ? rows : []).length === 0) {
      // LIKE 兜底：逐词 OR 子串匹配（unicode61 不切 CJK，两字中文词 FTS 恒空）
      const terms = query
        .split(/[\s,;.，。;；]+/u)
        .map((t) => t.trim())
        .filter((t) => t !== '');
      if (terms.length === 0) return [];
      const likeClauses = terms.map(() => `(m.content LIKE ? ESCAPE '\\' OR m.tags LIKE ? ESCAPE '\\')`);
      const likeBindings: Knex.RawBinding[] = terms.flatMap((t) => [likePattern(t), likePattern(t)]);
      const where = likeClauses.join(' OR ');
      const kindSql = opts.kind !== undefined ? ' AND m.kind = ?' : '';
      const bindings: Knex.RawBinding[] = [...likeBindings, ...(opts.kind !== undefined ? [opts.kind] : []), limit];
      const likeRows = (await this.db.raw(
        `SELECT m.*, (${LIKE_BASE_SCORE} + (m.strength * ${W_STRENGTH}) + ${recency}) AS score FROM memories m
         WHERE (${where})${kindSql}
         ORDER BY score DESC
         LIMIT ?`,
        bindings,
      )) as unknown as (MemoryRow & { score: number })[];
      return (Array.isArray(likeRows) ? likeRows : []).filter(isRow).map((row) => ({
        ...rowToRecord(row),
        score: Number(row.score),
      }));
    }

    return (Array.isArray(rows) ? rows : []).filter(isRow).map((row) => ({
      ...rowToRecord(row),
      score: Number(row.score),
    }));
  }

  /** 检索命中回写：access_count +1、last_accessed_at = now */
  async trackAccess(ids: string[], at: number): Promise<void> {
    if (ids.length === 0) return;
    await this.ensureTable();
    await this.db(MEMORIES_TABLE)
      .whereIn('id', ids)
      .update({ access_count: this.db.raw('access_count + 1'), last_accessed_at: at });
  }

  /** 列表（updated_at 倒序；kind 可选过滤；limit 服务端兜底防全表拉取） */
  async list(opts: MemoryListOptions = {}): Promise<MemoryRecord[]> {
    await this.ensureTable();
    const limit = opts.limit && opts.limit >= 1 ? Math.floor(opts.limit) : 50;
    let q = this.db(MEMORIES_TABLE).select('*');
    if (opts.kind !== undefined) q = q.where('kind', opts.kind);
    const rows = (await q.orderBy('updated_at', 'desc').limit(limit)) as unknown as MemoryRow[];
    return rows.filter(isRow).map(rowToRecord);
  }

  /** 按 id 删除；返回是否确有行被删除 */
  async remove(id: string): Promise<boolean> {
    await this.ensureTable();
    const affected = await this.db(MEMORIES_TABLE).where('id', id).del();
    return affected > 0;
  }

  /** 条件批量删除；返回删除行数 */
  async removeWhere(filter: MemoryForgetFilter): Promise<number> {
    await this.ensureTable();
    let q = this.db(MEMORIES_TABLE);
    if (filter.kind !== undefined) q = q.where('kind', filter.kind);
    if (filter.source !== undefined) q = q.where('source', filter.source);
    if (filter.scope !== undefined) q = q.where('scope', filter.scope);
    if (filter.sessionRef !== undefined) q = q.where('session_ref', filter.sessionRef);
    if (filter.updatedBefore !== undefined) q = q.where('updated_at', '<', filter.updatedBefore);
    return q.del();
  }

  /** 总条数 */
  async count(): Promise<number> {
    await this.ensureTable();
    const row = (await this.db(MEMORIES_TABLE).count({ n: '*' }).first()) as { n?: unknown } | undefined;
    return Number(row?.n ?? 0);
  }

  /** 按类别计数（stats.byKind） */
  async countByKind(): Promise<Record<string, number>> {
    await this.ensureTable();
    const rows = (await this.db(MEMORIES_TABLE)
      .groupBy('kind')
      .select('kind')
      .count({ n: '*' })) as unknown as Array<{ kind: string; n: unknown }>;
    const out: Record<string, number> = {};
    for (const row of Array.isArray(rows) ? rows : []) {
      if (row !== null && typeof row === 'object') out[String(row.kind)] = Number(row.n ?? 0);
    }
    return out;
  }

  /**
   * 容量治理：超出 max 时删除"最旧最弱"——`strength * access_count` 最低者先删，
   * 同分按 updated_at / created_at 升序（最旧优先）；返回实际删除行数。
   */
  async pruneToMax(max: number): Promise<number> {
    await this.ensureTable();
    const total = await this.count();
    const overflow = total - max;
    if (overflow <= 0) return 0;
    const victims = (await this.db(MEMORIES_TABLE)
      .select('id')
      .orderByRaw('(strength * access_count) ASC, updated_at ASC, created_at ASC')
      .limit(overflow)) as unknown as Array<{ id: string }>;
    const ids = (Array.isArray(victims) ? victims : []).map((v) => v?.id).filter((v): v is string => typeof v === 'string');
    if (ids.length === 0) return 0;
    return this.db(MEMORIES_TABLE).whereIn('id', ids).del();
  }

  /** FTS 索引全量重建（`rebuild` 命令；索引损坏/触发器缺失时的运维修复口） */
  async rebuildFts(): Promise<void> {
    await this.ensureTable();
    await this.db.raw(`INSERT INTO memories_fts(memories_fts) VALUES('rebuild')`);
  }
}

/** 行对象守卫（knex raw 结果容错） */
function isRow(value: unknown): value is MemoryRow {
  return value !== null && typeof value === 'object';
}
