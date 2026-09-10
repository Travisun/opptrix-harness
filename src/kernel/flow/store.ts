/**
 * flow — 传入 Webhook（FlowTrigger）持久化存储（FlowEndpointStore，knex + SQLite）。
 *
 * - 表结构同构于内核迁移 017_flow（权威 Schema 见 `src/kernel/storage/kernel-migrations.ts`）；
 * - 时间列一律 UTC epoch ms；flow_config / result 以 JSON 字符串落库（序列化/反序列化由本模块负责）；
 * - 实现 `FlowEndpointStoreLike` 契约（FlowManager 的 deps.store）；本层只做朴素读写，
 *   业务守卫（存在性 / 状态转移 / 签名校验）在 manager 侧；
 * - JSON 反序列化失败（脏数据/损坏）不抛错：该字段置 null，其余字段正常返回；
 * - 事件面天然脱敏：flow_events 只落 payload 的 SHA-256 摘要（payload_digest），
 *   原始 payload 全文不落库，故任何读取路径都不可能泄出原文。
 */
import type { Knex } from 'knex';

import { HarnessError } from '../errors/index.js';
import {
  type FlowEndpointPatch,
  type FlowEndpointRecord,
  type FlowEventRecord,
  type FlowEventStatus,
  type FlowEndpointStoreLike,
} from './types.js';

const ENDPOINTS_TABLE = 'flow_endpoints';
const EVENTS_TABLE = 'flow_events';

/** flow_endpoints 表原始行（snake_case） */
interface FlowEndpointRow {
  id: string;
  name: string;
  slug: string;
  secret_ref: string | null;
  enabled: number;
  flow_type: string;
  flow_config: string | null;
  llm_prompt: string | null;
  created_at: number;
  updated_at: number;
}

/** flow_events 表原始行（snake_case） */
interface FlowEventRow {
  id: string;
  endpoint_id: string;
  status: string;
  payload_digest: string;
  source_ip: string | null;
  error: string | null;
  result: string | null;
  created_at: number;
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

/** flow_endpoints 行 → FlowEndpointRecord */
function endpointRowToRecord(row: FlowEndpointRow): FlowEndpointRecord {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    secretRef: row.secret_ref,
    enabled: row.enabled === 1,
    flowType: row.flow_type as FlowEndpointRecord['flowType'],
    flowConfig: parseJson(row.flow_config),
    llmPrompt: row.llm_prompt,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** flow_events 行 → FlowEventRecord */
function eventRowToRecord(row: FlowEventRow): FlowEventRecord {
  return {
    id: row.id,
    endpointId: row.endpoint_id,
    status: row.status as FlowEventStatus,
    payloadDigest: row.payload_digest,
    sourceIp: row.source_ip,
    error: row.error,
    result: parseJson(row.result),
    createdAt: row.created_at,
  };
}

/**
 * 传入 Webhook 持久化存储（flow_endpoints + flow_events 两表）。
 *
 * 表由内核迁移（017_flow）创建；本层不再惰性建表（与 NotificationStore/ChatStore
 * 同一约定——内核库 schema 单一事实来源在 migrations）。
 */
export class FlowEndpointStore implements FlowEndpointStoreLike {
  constructor(private readonly db: Knex) {}

  // ---- flow_endpoints：端点 CRUD ------------------------------------------

  /** 新增端点（slug 由 manager 生成并保证唯一；slug 重复抛 DB_ERROR——唯一约束兜底） */
  async insert(rec: FlowEndpointRecord): Promise<void> {
    try {
      await this.db(ENDPOINTS_TABLE).insert({
        id: rec.id,
        name: rec.name,
        slug: rec.slug,
        secret_ref: rec.secretRef,
        enabled: rec.enabled ? 1 : 0,
        flow_type: rec.flowType,
        flow_config: rec.flowConfig === null || rec.flowConfig === undefined ? null : JSON.stringify(rec.flowConfig),
        llm_prompt: rec.llmPrompt ?? null,
        created_at: rec.createdAt,
        updated_at: rec.updatedAt,
      });
    } catch (e) {
      throw HarnessError.wrap(e, 'DB_ERROR');
    }
  }

  /** 按 ID 读取；不存在返回 null */
  async get(id: string): Promise<FlowEndpointRecord | null> {
    const row = (await this.db(ENDPOINTS_TABLE).where('id', id).first()) as FlowEndpointRow | undefined;
    return row === undefined ? null : endpointRowToRecord(row);
  }

  /** 按 slug 读取（入站路由键）；不存在返回 null */
  async getBySlug(slug: string): Promise<FlowEndpointRecord | null> {
    const row = (await this.db(ENDPOINTS_TABLE).where('slug', slug).first()) as FlowEndpointRow | undefined;
    return row === undefined ? null : endpointRowToRecord(row);
  }

  /** 全量端点列表（created_at 升序） */
  async list(): Promise<FlowEndpointRecord[]> {
    const rows = (await this.db(ENDPOINTS_TABLE)
      .select()
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')) as FlowEndpointRow[];
    return rows.map(endpointRowToRecord);
  }

  /** 按 ID 更新允许的字段（行不存在时静默 no-op；updatedAt 由 manager 传入） */
  async update(id: string, patch: FlowEndpointPatch): Promise<void> {
    const row: Record<string, unknown> = { updated_at: patch.updatedAt };
    if (patch.name !== undefined) row['name'] = patch.name;
    if (patch.enabled !== undefined) row['enabled'] = patch.enabled ? 1 : 0;
    if (patch.flowType !== undefined) row['flow_type'] = patch.flowType;
    if (patch.flowConfig !== undefined) {
      row['flow_config'] =
        patch.flowConfig === null ? null : JSON.stringify(patch.flowConfig);
    }
    if (patch.llmPrompt !== undefined) row['llm_prompt'] = patch.llmPrompt;
    if (patch.secretRef !== undefined) row['secret_ref'] = patch.secretRef;
    try {
      await this.db(ENDPOINTS_TABLE).where('id', id).update(row);
    } catch (e) {
      throw HarnessError.wrap(e, 'DB_ERROR');
    }
  }

  /** 按 ID 删除（调用方负责级联 events 与 secrets 清理；本层只删端点行） */
  async delete(id: string): Promise<void> {
    try {
      await this.db(ENDPOINTS_TABLE).where('id', id).del();
    } catch (e) {
      throw HarnessError.wrap(e, 'DB_ERROR');
    }
  }

  // ---- flow_events：事件流水 ----------------------------------------------

  /** 新增事件（status 缺省 'received' 由 manager 侧填好） */
  async insertEvent(rec: FlowEventRecord): Promise<void> {
    try {
      await this.db(EVENTS_TABLE).insert({
        id: rec.id,
        endpoint_id: rec.endpointId,
        status: rec.status,
        payload_digest: rec.payloadDigest,
        source_ip: rec.sourceIp,
        error: rec.error,
        result: rec.result === null || rec.result === undefined ? null : JSON.stringify(rec.result),
        created_at: rec.createdAt,
      });
    } catch (e) {
      throw HarnessError.wrap(e, 'DB_ERROR');
    }
  }

  /** 事件状态转移（received → processed | failed；result/error 同步写入） */
  async updateEventStatus(
    id: string,
    patch: { status: FlowEventStatus; error?: string | null; result?: unknown },
  ): Promise<void> {
    const row: Record<string, unknown> = { status: patch.status };
    if (patch.error !== undefined) row['error'] = patch.error;
    if (patch.result !== undefined) {
      row['result'] = patch.result === null ? null : JSON.stringify(patch.result);
    }
    try {
      await this.db(EVENTS_TABLE).where('id', id).update(row);
    } catch (e) {
      throw HarnessError.wrap(e, 'DB_ERROR');
    }
  }

  /**
   * 事件列表（created_at 降序，同毫秒按插入序逆序稳定排序）。
   * @param endpointId 端点 id
   * @param opts.limit 返回条数上限（缺省 50；manager/REST 侧再 clamp）
   * @param opts.before 游标（UTC epoch ms）：只返回 created_at < before 的事件（分页用）
   */
  async listEvents(
    endpointId: string,
    opts?: { limit?: number; before?: number },
  ): Promise<FlowEventRecord[]> {
    const limit = Math.max(1, Math.floor(opts?.limit ?? 50));
    let q = this.db(EVENTS_TABLE).where('endpoint_id', endpointId);
    if (opts?.before !== undefined) {
      q = q.andWhere('created_at', '<', opts.before);
    }
    const rows = (await q
      .select()
      .orderBy('created_at', 'desc')
      .orderBy('rowid', 'desc')
      .limit(limit)) as FlowEventRow[];
    return rows.map(eventRowToRecord);
  }

  /** 删除某端点全部事件（deleteEndpoint 级联清理用） */
  async deleteEventsByEndpoint(endpointId: string): Promise<void> {
    try {
      await this.db(EVENTS_TABLE).where('endpoint_id', endpointId).del();
    } catch (e) {
      throw HarnessError.wrap(e, 'DB_ERROR');
    }
  }
}
