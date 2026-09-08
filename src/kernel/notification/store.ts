/**
 * notification — 通知中心持久化存储（NotificationStore，knex + SQLite）。
 *
 * - 表结构同构于内核迁移 008_notifications（权威 Schema 见
 *   `src/kernel/storage/kernel-migrations.ts`）：notifications 表由内核迁移创建，
 *   本存储不做建表（调用方保证迁移先于本存储使用）。
 * - 时间列一律 UTC epoch ms；已读语义 read_at 非空；data/channels 以 JSON 字符串落库。
 * - data/channels 反序列化失败（脏数据/损坏）不抛错：该字段置 null，其余字段正常返回。
 * - schema 信任约定与 CronJobStore 一致：返回值按 NotificationRecord 形状信任，
 *   不做逐行运行时校验。
 */
import type { Knex } from 'knex';

import { err } from '../errors/index.js';

/**
 * 一条通知记录（notifications 行的 camelCase 视图）。
 *
 * 刻意用 type alias（而非 interface）：type alias 携带隐式索引签名，
 * 可直接赋给 REST 层 `NotificationRoutesDeps['store']` 的
 * `Promise<Record<string, unknown>[]>` 形状（interface 不行），便于内核装配期直连。
 */
export type NotificationRecord = {
  /** 通知唯一 ID（uuid，调用方生成） */
  id: string;
  /** 级别（'info' | 'success' | 'warn' | 'error'；存储层不限定，字符串透传） */
  level: string;
  /** 标题（单行摘要） */
  title: string;
  /** 正文（纯文本） */
  body: string;
  /** 结构化附加数据（任意可 JSON 序列化值；损坏/缺省为 null） */
  data?: unknown;
  /** 本次投递计划/渠道信息（JSON；损坏/缺省为 null） */
  channels?: unknown;
  /** 已读时间（UTC epoch ms；null/缺省 = 未读） */
  readAt?: number | null;
  /** 创建时间（UTC epoch ms） */
  createdAt: number;
};

/** notifications 表原始行（snake_case） */
interface NotificationRow {
  id: string;
  level: string;
  title: string;
  body: string;
  data: string | null;
  channels: string | null;
  read_at: number | null;
  created_at: number;
}

const TABLE = 'notifications';

/** list() 未显式给 limit 时的默认条数 */
const DEFAULT_LIST_LIMIT = 50;
/** list() 硬上限：防御性钳制，避免 0/负数/超大 limit 造成全表倾泻 */
const MAX_LIST_LIMIT = 500;

/**
 * data/channels 序列化为 JSON 字符串（落库形状）。
 * undefined / null → SQL NULL；不可序列化（循环引用、BigInt 等）抛 DB_ERROR，
 * 错误信息可操作：指出是哪条通知的哪个字段、该怎么改。
 */
function serializeJson(value: unknown, context: string): string | null {
  if (value === undefined || value === null) return null;
  let json: string;
  try {
    json = JSON.stringify(value) as string;
  } catch (e) {
    throw err('DB_ERROR', {
      message:
        `notification store ${context}: value is not JSON-serializable ` +
        '(circular reference or BigInt?). Serialize it to plain JSON before sending.',
      detail: { context },
      cause: e,
    });
  }
  if (typeof json !== 'string') {
    throw err('DB_ERROR', {
      message: `notification store ${context}: value is not JSON-serializable. Store null instead.`,
      detail: { context },
    });
  }
  return json;
}

/** JSON 字符串 → 反序列化值；损坏（非法 JSON）置 null，不抛错（脏数据容错） */
function parseJson(text: string | null | undefined): unknown {
  if (text === null || text === undefined) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null; // 单字段损坏不影响整条记录读取
  }
}

/** notifications 行 → NotificationRecord；data/channels 损坏置 null */
function rowToRecord(row: NotificationRow): NotificationRecord {
  return {
    id: row.id,
    level: row.level,
    title: row.title,
    body: row.body,
    data: parseJson(row.data),
    channels: parseJson(row.channels),
    readAt: row.read_at ?? null,
    createdAt: row.created_at,
  };
}

/**
 * 通知中心持久化存储（notifications 表）。
 *
 * 由通知管理器（manager）与 REST 层共用：manager 负责写入与投递计划记录，
 * REST/UI 负责列表、已读与未读统计。
 */
export class NotificationStore {
  constructor(private readonly db: Knex) {}

  /**
   * 新增一条通知记录（id 由调用方生成并保证唯一，重复 id 因主键冲突抛错）。
   *
   * @throws HarnessError（DB_ERROR）data/channels 不可序列化或插入失败
   */
  async create(rec: NotificationRecord): Promise<void> {
    await this.db(TABLE).insert({
      id: rec.id,
      level: rec.level,
      title: rec.title,
      body: rec.body,
      data: serializeJson(rec.data, `create(${rec.id}).data`),
      channels: serializeJson(rec.channels, `create(${rec.id}).channels`),
      read_at: rec.readAt ?? null,
      created_at: rec.createdAt,
    });
  }

  /**
   * 按 ID 读取通知；不存在返回 null。
   * data/channels 损坏（非法 JSON）时记录仍返回，对应字段置 null。
   */
  async get(id: string): Promise<NotificationRecord | null> {
    const row = (await this.db(TABLE).where('id', id).first()) as NotificationRow | undefined;
    return row === undefined ? null : rowToRecord(row);
  }

  /**
   * 列出通知，按 created_at 降序（最新在前；次序键 id 降序，保证同毫秒稳定排序）。
   *
   * @param opts.unreadOnly true 时只列未读（read_at IS NULL）
   * @param opts.level 给定时按级别精确过滤
   * @param opts.limit 返回条数上限；缺省 {@link DEFAULT_LIST_LIMIT}，
   *   实际取值钳制到 [1, 500]
   */
  async list(opts?: { unreadOnly?: boolean; level?: string; limit?: number }): Promise<NotificationRecord[]> {
    let query = this.db(TABLE).select('*');
    if (opts?.unreadOnly === true) query = query.whereNull('read_at');
    if (opts?.level !== undefined) query = query.where('level', opts.level);
    const requested = typeof opts?.limit === 'number' && Number.isFinite(opts.limit)
      ? Math.trunc(opts.limit)
      : DEFAULT_LIST_LIMIT;
    const effective = Math.min(Math.max(requested, 1), MAX_LIST_LIMIT);
    const rows = (await query.orderBy('created_at', 'desc').orderBy('id', 'desc').limit(effective)) as NotificationRow[];
    return rows.map(rowToRecord);
  }

  /**
   * 标记单条通知为已读（read_at = 当前 UTC epoch ms）。
   * 幂等：已读的通知再次标记不更新、返回 false。
   *
   * @returns 是否确有未读通知被转为已读（不存在或已读返回 false）
   */
  async markRead(id: string): Promise<boolean> {
    const affected = await this.db(TABLE).where('id', id).whereNull('read_at').update({ read_at: Date.now() });
    return affected > 0;
  }

  /**
   * 全部未读通知标记为已读。
   *
   * @returns 本次转为已读的条数（无未读时为 0）
   */
  async markAllRead(): Promise<number> {
    const affected = await this.db(TABLE).whereNull('read_at').update({ read_at: Date.now() });
    return affected;
  }

  /** 未读通知条数（read_at IS NULL） */
  async unreadCount(): Promise<number> {
    const row = (await this.db(TABLE).whereNull('read_at').count({ n: '*' }).first()) as { n: number | string } | undefined;
    return Number(row?.n ?? 0);
  }
}
