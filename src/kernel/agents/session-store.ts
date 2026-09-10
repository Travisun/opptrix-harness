/**
 * agents/session-store — Agent 会话持久化存储（AgentSessionStore，knex + SQLite）。
 *
 * - 两表：`agent_sessions`（会话元数据）+ `agent_messages`（消息流水）；`ensureTables()`
 *   惰性幂等建表（与 SubagentStore 同款模式），未跑内核迁移的独立 SQLite 上也可直接使用；
 * - 时间列一律 UTC epoch ms；tool_calls / usage 以 JSON 字符串落库（序列化/反序列化由本模块负责）；
 * - 记录字段命名遵循 Agent Session 契约：会话 `created_at/updated_at/last_message_at`、
 *   消息 `session_id/created_at`（JSON 视图与 REST/UI 面一致，camel 与 snake 混用为契约刻意形状）；
 * - JSON 反序列化失败（脏数据/损坏）不抛错：该字段置 null，其余字段正常返回。
 */
import { randomUUID } from 'node:crypto';

import type { Knex } from 'knex';

import { err } from '../errors/index.js';

export const AGENT_SESSIONS_TABLE = 'agent_sessions';
export const AGENT_MESSAGES_TABLE = 'agent_messages';

/** 会话状态：active（进行中）/ archived（已归档；列表默认不过滤，按 ?status= 显式筛选） */
export type AgentSessionStatus = 'active' | 'archived';

export const AGENT_SESSION_STATUSES: readonly AgentSessionStatus[] = ['active', 'archived'];

/** 会话记录（agent_sessions 行的 JSON 视图；时间字段均为 UTC epoch ms） */
export interface AgentSessionRecord {
  id: string;
  /** 标题（创建时缺省 '新对话'；UI 以首条 user 消息前 30 字符自动改名） */
  title: string;
  /** 模型标识（null = sendMessage 期按解析链解析：显式 → settings 'agents.defaultModel' → 第一可用 provider） */
  model: string | null;
  /** 会话级系统提示（null = runner 侧缺省） */
  systemPrompt: string | null;
  status: AgentSessionStatus;
  created_at: number;
  updated_at: number;
  /** 最近一条消息时间（null = 尚无消息；列表按其降序） */
  last_message_at: number | null;
  /** 属主用户 id（null = system 会话；所有权判定与工作区目录布局用，REST 层从 checker identity 注入） */
  userId: string | null;
  /** 父会话 id（null = 一级/根会话；子会话不建工作区目录，沿本链解析到根会话的工作区） */
  parentId: string | null;
}

/** 消息角色：user / assistant / system（tool 结果以 system 角色落库） */
export type AgentMessageRole = 'user' | 'assistant' | 'system';

/** 工具调用（与 llm/types.ts LlmToolCall 同形状；JSON 落库） */
export interface AgentMessageToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** token 用量（JSON 落库） */
export interface AgentMessageUsage {
  inputTokens: number;
  outputTokens: number;
}

/** 消息记录（agent_messages 行的 JSON 视图） */
export interface AgentMessageRecord {
  id: string;
  session_id: string;
  role: AgentMessageRole;
  content: string;
  /** assistant 消息请求的工具调用（模型未调用工具时不出现） */
  toolCalls?: AgentMessageToolCall[];
  /** token 用量（仅落最终 assistant 回复） */
  usage?: AgentMessageUsage;
  created_at: number;
}

/** addMessage 入参（id/created_at 由 store 生成） */
export interface AgentMessageInput {
  role: AgentMessageRole;
  content: string;
  toolCalls?: AgentMessageToolCall[];
  usage?: AgentMessageUsage;
}

/** updateSession 允许的补丁字段 */
export interface AgentSessionPatch {
  title?: string;
  status?: AgentSessionStatus;
}

/** 列出会话的过滤条件 */
export interface AgentSessionListFilter {
  status?: AgentSessionStatus;
  /** 按属主过滤（undefined = 不过滤；注意 system 会话 userId 为 null，不命中任何具体 userId） */
  userId?: string;
}

/** agent_sessions 表原始行（snake_case） */
interface SessionRow {
  id: string;
  title: string;
  model: string | null;
  system_prompt: string | null;
  status: string;
  created_at: number;
  updated_at: number;
  last_message_at: number | null;
  user_id: string | null;
  parent_id: string | null;
}

/** agent_messages 表原始行（snake_case） */
interface MessageRow {
  id: string;
  session_id: string;
  role: string;
  content: string;
  tool_calls: string | null;
  usage: string | null;
  created_at: number;
}

/** JSON 文本 → 反序列化值；空/损坏（非法 JSON）返回 null，不抛错 */
function parseJson(text: string | null): unknown {
  if (text === null || text === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null; // 脏数据容错：单字段损坏不影响整体读取
  }
}

function sessionRowToRecord(row: SessionRow): AgentSessionRecord {
  return {
    id: row.id,
    title: row.title,
    model: row.model,
    systemPrompt: row.system_prompt,
    status: row.status as AgentSessionStatus,
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_message_at: row.last_message_at,
    userId: row.user_id ?? null,
    parentId: row.parent_id ?? null,
  };
}

function messageRowToRecord(row: MessageRow): AgentMessageRecord {
  const toolCalls = parseJson(row.tool_calls);
  const usage = parseJson(row.usage);
  return {
    id: row.id,
    session_id: row.session_id,
    role: row.role as AgentMessageRole,
    content: row.content,
    ...(Array.isArray(toolCalls) && toolCalls.length > 0
      ? { toolCalls: toolCalls as AgentMessageToolCall[] }
      : {}),
    ...(usage !== null && typeof usage === 'object' && !Array.isArray(usage)
      ? { usage: usage as AgentMessageUsage }
      : {}),
    created_at: row.created_at,
  };
}

/**
 * Agent 会话持久化存储（agent_sessions + agent_messages 两表）。
 *
 * 所有方法先经 `ensureTables()` 惰性建表（幂等、Promise 缓存去重）。
 */
export class AgentSessionStore {
  /** 惰性建表的共享 Promise：并发调用只触发一次；失败后重置以便重试 */
  private tableReady?: Promise<void>;
  /** 单调化后的最近消息时间戳（同毫秒插入依次 +1，保证 created_at 严格递增 = 消息插入序） */
  #lastMessageTs = 0;

  constructor(private readonly db: Knex) {}

  /**
   * 惰性幂等建两表（含索引）。
   *
   * @throws HarnessError（DB_ERROR）建表失败
   */
  ensureTables(): Promise<void> {
    this.tableReady ??= this.createTables().catch((e: unknown) => {
      this.tableReady = undefined; // 失败后重置，允许下次重试
      throw err('DB_ERROR', {
        message: 'agent session store: ensure tables failed',
        cause: e,
      });
    });
    return this.tableReady;
  }

  /** 新增会话（id 由 manager 生成 UUID；created_at/updated_at 取记录值） */
  async createSession(rec: AgentSessionRecord): Promise<void> {
    await this.ensureTables();
    await this.db(AGENT_SESSIONS_TABLE).insert({
      id: rec.id,
      title: rec.title,
      model: rec.model,
      system_prompt: rec.systemPrompt,
      status: rec.status,
      created_at: rec.created_at,
      updated_at: rec.updated_at,
      last_message_at: rec.last_message_at,
      user_id: rec.userId ?? null,
      parent_id: rec.parentId ?? null,
    });
  }

  /** 按 ID 读取会话；不存在返回 null */
  async getSession(id: string): Promise<AgentSessionRecord | null> {
    await this.ensureTables();
    const row = (await this.db(AGENT_SESSIONS_TABLE).where('id', id).first()) as SessionRow | undefined;
    return row === undefined ? null : sessionRowToRecord(row);
  }

  /**
   * 列出会话：按 last_message_at 降序（无消息的会话 NULL 在 SQLite DESC 排序中天然靠后），
   * 次序键 created_at 降序、id 升序保证同毫秒稳定排序。
   */
  async listSessions(filter?: AgentSessionListFilter): Promise<AgentSessionRecord[]> {
    await this.ensureTables();
    let query = this.db(AGENT_SESSIONS_TABLE).select('*');
    if (filter?.status !== undefined) query = query.where('status', filter.status);
    if (filter?.userId !== undefined) query = query.where('user_id', filter.userId);
    const rows = (await query
      .orderBy('last_message_at', 'desc')
      .orderBy('created_at', 'desc')
      .orderBy('id', 'asc')) as SessionRow[];
    return rows.map(sessionRowToRecord);
  }

  /** 按 ID 更新允许的字段（updated_at 由本方法统一刷新；行不存在时静默 no-op 并返回 null） */
  async updateSession(id: string, patch: AgentSessionPatch): Promise<AgentSessionRecord | null> {
    await this.ensureTables();
    const cols: Record<string, unknown> = { updated_at: Date.now() };
    if (patch.title !== undefined) cols['title'] = patch.title;
    if (patch.status !== undefined) cols['status'] = patch.status;
    const updated = await this.db(AGENT_SESSIONS_TABLE).where('id', id).update(cols);
    if (updated === 0) return null;
    return this.getSession(id);
  }

  /**
   * 删除会话并级联删除其全部消息（单事务）。返回是否确有删除（不存在的 id 返回 false）。
   */
  async deleteSession(id: string): Promise<boolean> {
    await this.ensureTables();
    let deleted = false;
    await this.db.transaction(async (tx) => {
      await tx(AGENT_MESSAGES_TABLE).where('session_id', id).del();
      deleted = (await tx(AGENT_SESSIONS_TABLE).where('id', id).del()) > 0;
    });
    return deleted;
  }

  /** 追加一条消息（id 生成 UUID；同时触碰会话 last_message_at/updated_at） */
  async addMessage(sessionId: string, input: AgentMessageInput, now?: number): Promise<AgentMessageRecord> {
    await this.ensureTables();
    // 时间戳单调化：同毫秒内的连续插入依次 +1，使 (created_at, id) 排序与插入顺序严格一致
    // （消息时间同为列表排序/分页游标的次序键，回放乱序不可接受）
    let ts = now ?? Date.now();
    if (ts <= this.#lastMessageTs) ts = this.#lastMessageTs + 1;
    this.#lastMessageTs = ts;
    const record: AgentMessageRecord = {
      id: randomUUID(),
      session_id: sessionId,
      role: input.role,
      content: input.content,
      ...(input.toolCalls !== undefined && input.toolCalls.length > 0 ? { toolCalls: input.toolCalls } : {}),
      ...(input.usage !== undefined ? { usage: input.usage } : {}),
      created_at: ts,
    };
    await this.db(AGENT_MESSAGES_TABLE).insert({
      id: record.id,
      session_id: record.session_id,
      role: record.role,
      content: record.content,
      tool_calls: record.toolCalls === undefined ? null : JSON.stringify(record.toolCalls),
      usage: record.usage === undefined ? null : JSON.stringify(record.usage),
      created_at: record.created_at,
    });
    await this.db(AGENT_SESSIONS_TABLE).where('id', sessionId).update({
      last_message_at: ts,
      updated_at: ts,
    });
    return record;
  }

  /**
   * 读取会话消息（升序返回）。分页：`before` 为消息 id 游标——取严格早于该消息的
   * 最近 limit 条再反转为升序；游标不存在/不属于该会话 → 空数组（显式游标无效即空页）。
   */
  async getMessages(
    sessionId: string,
    opts: { before?: string; limit?: number } = {},
  ): Promise<AgentMessageRecord[]> {
    await this.ensureTables();
    const limit = Math.min(Math.max(Math.floor(opts.limit ?? 50), 1), 500);
    if (opts.before !== undefined) {
      const cursor = (await this.db(AGENT_MESSAGES_TABLE)
        .where('id', opts.before)
        .andWhere('session_id', sessionId)
        .first()) as MessageRow | undefined;
      if (cursor === undefined) return [];
      const rows = (await this.db(AGENT_MESSAGES_TABLE)
        .where('session_id', sessionId)
        .andWhere('created_at', '<', cursor.created_at)
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .limit(limit)) as MessageRow[];
      return rows.reverse().map(messageRowToRecord);
    }
    const rows = (await this.db(AGENT_MESSAGES_TABLE)
      .where('session_id', sessionId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(limit)) as MessageRow[];
    return rows.reverse().map(messageRowToRecord);
  }

  /** 实际建表（幂等；agent_sessions + agent_messages）+ 旧库加列（ALTER 守卫） */
  private async createTables(): Promise<void> {
    if (!(await this.db.schema.hasTable(AGENT_SESSIONS_TABLE))) {
      await this.db.schema.createTable(AGENT_SESSIONS_TABLE, (t) => {
        t.text('id').primary();
        t.text('title').notNullable(); // 创建时缺省 '新对话'
        t.text('model'); // null = sendMessage 期按解析链解析
        t.text('system_prompt'); // null = runner 侧缺省
        t.text('status').notNullable().defaultTo('active'); // active | archived
        t.integer('created_at').notNullable(); // UTC epoch ms
        t.integer('updated_at').notNullable(); // UTC epoch ms
        t.integer('last_message_at'); // UTC epoch ms；null = 尚无消息
        t.text('user_id'); // 属主用户 id；null = system 会话（所有权 + 工作区布局用）
        t.text('parent_id'); // 父会话 id；null = 一级/根会话（子会话工作区沿链继承）
        t.index(['status'], 'agent_sessions_status_index');
        t.index(['last_message_at'], 'agent_sessions_last_message_at_index');
        t.index(['user_id'], 'agent_sessions_user_id_index');
      });
    } else {
      await this.#addSessionColumnsIfMissing();
    }
    if (!(await this.db.schema.hasTable(AGENT_MESSAGES_TABLE))) {
      await this.db.schema.createTable(AGENT_MESSAGES_TABLE, (t) => {
        t.text('id').primary();
        t.text('session_id').notNullable(); // 所属会话（级联删除按此清理）
        t.text('role').notNullable(); // user | assistant | system
        t.text('content').notNullable();
        t.text('tool_calls'); // JSON 字符串（工具调用数组）
        t.text('usage'); // JSON 字符串（token 用量）
        t.integer('created_at').notNullable(); // UTC epoch ms
        t.index(['session_id'], 'agent_messages_session_id_index');
      });
    }
  }

  /**
   * 旧库加列（ALTER 守卫模式）：早期版本建的 agent_sessions 无 user_id/parent_id 列，
   * 逐列做存在性检查后 ALTER TABLE ADD COLUMN；新库 DDL 已含新列，检查即跳过（幂等）。
   */
  async #addSessionColumnsIfMissing(): Promise<void> {
    for (const column of ['user_id', 'parent_id'] as const) {
      if (await this.db.schema.hasColumn(AGENT_SESSIONS_TABLE, column)) continue;
      await this.db.schema.alterTable(AGENT_SESSIONS_TABLE, (t) => {
        t.text(column); // 旧会话一律 null：user_id=null 视作 system 会话、parent_id=null 视作根会话
      });
    }
  }
}
