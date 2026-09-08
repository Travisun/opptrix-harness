/**
 * chat — 聊天持久化存储（ChatStore，knex + SQLite）。
 *
 * - 表结构同构于内核迁移 009_channels / 010_channel_members / 011_messages
 *   （权威 Schema 见 `src/kernel/storage/kernel-migrations.ts`）。
 * - 时间列一律 UTC epoch ms；meta/content/attachments 以 JSON 字符串落库，
 *   读取时反序列化，损坏（非法 JSON / 非 string）一律置 null 不抛错。
 * - schema 信任约定与 CronJobStore 一致：返回值按记录形状信任，不做逐行运行时校验。
 */
import type { Knex } from 'knex';

import { err } from '../errors/index.js';

const CHANNELS_TABLE = 'channels';
const MEMBERS_TABLE = 'channel_members';
const MESSAGES_TABLE = 'messages';

/** messages.list() 未显式给 limit 时的默认条数（与 REST 层默认一致） */
export const DEFAULT_MESSAGE_LIMIT = 50;
/** messages.list() 硬上限：防御性钳制，避免 0/负数/超大 limit 造成全表倾泻 */
export const MAX_MESSAGE_LIMIT = 200;

/** channels 表记录（camelCase 视图；meta 为反序列化后的 JSON 值，损坏/缺失为 null） */
export interface ChannelRow {
  id: string;
  slug: string;
  name: string;
  /** public | private 等（open 枚举，内核不做领域语义限定） */
  type: string;
  /** 入站 webhook 令牌（hex；永不出现在日志） */
  webhookToken: string | null;
  meta: unknown;
  createdAt: number;
}

/** channel_members 表记录（复合主键 channelId+memberType+memberId） */
export interface ChannelMemberRow {
  channelId: string;
  memberType: string;
  memberId: string;
  joinedAt: number;
}

/** messages 表记录（camelCase 视图；content/attachments 为反序列化 JSON，损坏置 null） */
export interface ChatMessage {
  id: string;
  channelId: string;
  senderType: string;
  senderId: string;
  content: unknown;
  attachments: unknown;
  createdAt: number;
  updatedAt: number;
}

/** createChannel 的规范化入参（id/slug/webhookToken 由 service 层生成） */
export interface ChannelCreateInput {
  id: string;
  slug: string;
  name: string;
  type: string;
  webhookToken: string;
  meta?: unknown;
  createdAt: number;
}

/** updateChannel 允许修改的字段（undefined = 未提供，跳过该列） */
export interface ChannelPatch {
  name?: string;
  meta?: unknown;
}

/** messages 表原始行（snake_case） */
interface MessageRow {
  id: string;
  channel_id: string;
  sender_type: string;
  sender_id: string;
  content: string | null;
  attachments: string | null;
  created_at: number;
  updated_at: number;
}

/** channels 表原始行（snake_case） */
interface ChannelDbRow {
  id: string;
  slug: string;
  name: string;
  type: string;
  webhook_token: string | null;
  meta: string | null;
  created_at: number;
}

/** channel_members 表原始行（snake_case） */
interface MemberDbRow {
  channel_id: string;
  member_type: string;
  member_id: string;
  joined_at: number;
}

/**
 * JSON 值序列化为 TEXT 落库：undefined / null → SQL NULL；不可序列化
 * （循环引用、BigInt 等）抛 DB_ERROR，错误信息可操作。
 */
function serializeJson(value: unknown, context: string, field: string): string | null {
  if (value === undefined || value === null) return null;
  try {
    return JSON.stringify(value);
  } catch (e) {
    throw err('DB_ERROR', {
      message:
        `chat store ${context}: ${field} is not JSON-serializable ` +
        '(circular reference or BigInt?). Serialize it to plain JSON before saving.',
      detail: { context, field },
      cause: e,
    });
  }
}

/** TEXT 列反序列化为 JSON 值：NULL / 非 string / 非法 JSON 一律置 null（脏数据容错） */
function parseJson(raw: string | null | undefined): unknown {
  if (raw === null || raw === undefined || typeof raw !== 'string') return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function rowToChannel(row: ChannelDbRow): ChannelRow {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    type: row.type,
    webhookToken: row.webhook_token ?? null,
    meta: parseJson(row.meta),
    createdAt: row.created_at,
  };
}

function rowToMember(row: MemberDbRow): ChannelMemberRow {
  return {
    channelId: row.channel_id,
    memberType: row.member_type,
    memberId: row.member_id,
    joinedAt: row.joined_at,
  };
}

function rowToMessage(row: MessageRow): ChatMessage {
  return {
    id: row.id,
    channelId: row.channel_id,
    senderType: row.sender_type,
    senderId: row.sender_id,
    content: parseJson(row.content),
    attachments: parseJson(row.attachments),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * 聊天持久化存储（channels / channel_members / messages 三表）。
 *
 * 表由内核迁移（009/010/011）建立；本类不重复建表，直接信任 schema 已就绪
 * （与 SettingsService 的信任约定一致）。测试使用真迁移建库。
 */
export class ChatStore {
  constructor(private readonly db: Knex) {}

  // -----------------------------------------------------------------------
  // channels
  // -----------------------------------------------------------------------

  /** 插入频道记录（id/slug 唯一性由数据库约束保证，冲突将抛 DB_ERROR）。 */
  async createChannel(input: ChannelCreateInput): Promise<ChannelRow> {
    await this.db(CHANNELS_TABLE).insert({
      id: input.id,
      slug: input.slug,
      name: input.name,
      type: input.type,
      webhook_token: input.webhookToken,
      meta: serializeJson(input.meta, `createChannel(${input.slug})`, 'meta'),
      created_at: input.createdAt,
    });
    return {
      id: input.id,
      slug: input.slug,
      name: input.name,
      type: input.type,
      webhookToken: input.webhookToken,
      meta: input.meta === undefined ? null : input.meta,
      createdAt: input.createdAt,
    };
  }

  /** 列出全部频道，按 created_at 升序（次序键 id 升序，保证同毫秒稳定排序）。 */
  async listChannels(): Promise<ChannelRow[]> {
    const rows = (await this.db(CHANNELS_TABLE).select('*').orderBy('created_at', 'asc').orderBy('id', 'asc')) as ChannelDbRow[];
    return rows.map(rowToChannel);
  }

  /** 按 ID 读取频道；不存在返回 null。 */
  async getChannelById(id: string): Promise<ChannelRow | null> {
    const row = (await this.db(CHANNELS_TABLE).where('id', id).first()) as ChannelDbRow | undefined;
    return row === undefined ? null : rowToChannel(row);
  }

  /** 按 slug 读取频道；不存在返回 null。 */
  async getChannelBySlug(slug: string): Promise<ChannelRow | null> {
    const row = (await this.db(CHANNELS_TABLE).where('slug', slug).first()) as ChannelDbRow | undefined;
    return row === undefined ? null : rowToChannel(row);
  }

  /** 按入站 webhook 令牌读取频道；不存在返回 null（令牌永不入日志）。 */
  async getChannelByToken(token: string): Promise<ChannelRow | null> {
    const row = (await this.db(CHANNELS_TABLE).where('webhook_token', token).first()) as ChannelDbRow | undefined;
    return row === undefined ? null : rowToChannel(row);
  }

  /**
   * 部分更新频道（只写 patch 中显式提供的字段）。
   * @returns 更新后的记录；频道不存在返回 null
   */
  async updateChannel(id: string, patch: ChannelPatch): Promise<ChannelRow | null> {
    const cols: Record<string, unknown> = {};
    if (patch.name !== undefined) cols['name'] = patch.name;
    if (patch.meta !== undefined) cols['meta'] = serializeJson(patch.meta, `updateChannel(${id})`, 'meta');
    if (Object.keys(cols).length > 0) {
      await this.db(CHANNELS_TABLE).where('id', id).update(cols);
    }
    return this.getChannelById(id);
  }

  /**
   * 删除频道并级联删除其成员关系与消息（三表同一逻辑单元，逐表删除）。
   * @returns 是否确有频道行被删除（不存在返回 false）
   */
  async deleteChannel(id: string): Promise<boolean> {
    await this.db(MEMBERS_TABLE).where('channel_id', id).del();
    await this.db(MESSAGES_TABLE).where('channel_id', id).del();
    const affected = await this.db(CHANNELS_TABLE).where('id', id).del();
    return affected > 0;
  }

  // -----------------------------------------------------------------------
  // channel_members
  // -----------------------------------------------------------------------

  /**
   * 添加成员（复合主键冲突时幂等忽略，保留原 joined_at）。
   * @returns 成员关系记录（含已存在的情况）
   */
  async addMember(channelId: string, memberType: string, memberId: string, joinedAt = Date.now()): Promise<ChannelMemberRow> {
    await this.db(MEMBERS_TABLE)
      .insert({ channel_id: channelId, member_type: memberType, member_id: memberId, joined_at: joinedAt })
      .onConflict(['channel_id', 'member_type', 'member_id'])
      .ignore();
    const row = (await this.db(MEMBERS_TABLE)
      .where({ channel_id: channelId, member_type: memberType, member_id: memberId })
      .first()) as MemberDbRow | undefined;
    if (row === undefined) {
      throw err('DB_ERROR', {
        message: `chat store: member "${memberType}:${memberId}" not readable after upsert on channel "${channelId}"`,
        detail: { channelId, memberType, memberId },
      });
    }
    return rowToMember(row);
  }

  /** 移除成员。@returns 是否确有关系被删除（不存在返回 false） */
  async removeMember(channelId: string, memberType: string, memberId: string): Promise<boolean> {
    const affected = await this.db(MEMBERS_TABLE)
      .where({ channel_id: channelId, member_type: memberType, member_id: memberId })
      .del();
    return affected > 0;
  }

  /** 列出频道成员，按 joined_at 升序（次序键 member_type/member_id 升序保证稳定）。 */
  async listMembers(channelId: string): Promise<ChannelMemberRow[]> {
    const rows = (await this.db(MEMBERS_TABLE)
      .select('*')
      .where('channel_id', channelId)
      .orderBy('joined_at', 'asc')
      .orderBy('member_type', 'asc')
      .orderBy('member_id', 'asc')) as MemberDbRow[];
    return rows.map(rowToMember);
  }

  /**
   * 以 user 身份 upsert 成员：已存在时刷新 joined_at（语义为"该用户此刻在频道中"）。
   * @returns upsert 后的成员关系记录
   */
  async upsertUserMember(channelId: string, userId: string, joinedAt = Date.now()): Promise<ChannelMemberRow> {
    await this.db(MEMBERS_TABLE)
      .insert({ channel_id: channelId, member_type: 'user', member_id: userId, joined_at: joinedAt })
      .onConflict(['channel_id', 'member_type', 'member_id'])
      .merge({ joined_at: joinedAt });
    const row = (await this.db(MEMBERS_TABLE)
      .where({ channel_id: channelId, member_type: 'user', member_id: userId })
      .first()) as MemberDbRow | undefined;
    if (row === undefined) {
      throw err('DB_ERROR', {
        message: `chat store: user member "${userId}" not readable after upsert on channel "${channelId}"`,
        detail: { channelId, userId },
      });
    }
    return rowToMember(row);
  }

  // -----------------------------------------------------------------------
  // messages
  // -----------------------------------------------------------------------

  /** 插入消息记录（id 由 service 层生成；content/attachments 以 JSON 字符串落库）。 */
  async insertMessage(rec: {
    id: string;
    channelId: string;
    senderType: string;
    senderId: string;
    content: unknown;
    attachments?: unknown;
    createdAt: number;
    updatedAt: number;
  }): Promise<ChatMessage> {
    const context = `insertMessage(${rec.id})`;
    await this.db(MESSAGES_TABLE).insert({
      id: rec.id,
      channel_id: rec.channelId,
      sender_type: rec.senderType,
      sender_id: rec.senderId,
      // content 列 NOT NULL：undefined 兜底为 JSON 字面量 'null'
      content: rec.content === undefined ? 'null' : serializeJson(rec.content, context, 'content'),
      attachments: serializeJson(rec.attachments, context, 'attachments'),
      created_at: rec.createdAt,
      updated_at: rec.updatedAt,
    });
    return {
      id: rec.id,
      channelId: rec.channelId,
      senderType: rec.senderType,
      senderId: rec.senderId,
      content: rec.content === undefined ? null : rec.content,
      attachments: rec.attachments === undefined ? null : rec.attachments,
      createdAt: rec.createdAt,
      updatedAt: rec.updatedAt,
    };
  }

  /** 按 ID 读取消息；不存在返回 null。content/attachments 损坏置 null。 */
  async getMessage(id: string): Promise<ChatMessage | null> {
    const row = (await this.db(MESSAGES_TABLE).where('id', id).first()) as MessageRow | undefined;
    return row === undefined ? null : rowToMessage(row);
  }

  /**
   * 更新消息正文并刷新 updated_at（UTC epoch ms）。
   * @returns 更新后的记录；消息不存在返回 null
   */
  async updateMessage(id: string, content: unknown): Promise<ChatMessage | null> {
    const existing = await this.getMessage(id);
    if (existing === null) return null;
    const updatedAt = Date.now();
    await this.db(MESSAGES_TABLE)
      .where('id', id)
      .update({
        content: content === undefined ? 'null' : serializeJson(content, `updateMessage(${id})`, 'content'),
        updated_at: updatedAt,
      });
    return { ...existing, content: content === undefined ? null : content, updatedAt };
  }

  /**
   * 列出频道消息：created_at 降序取 limit 条后翻转为升序返回（最旧在前）。
   *
   * @param opts.before 只取 created_at 严格小于该值（UTC epoch ms）的消息（游标分页）
   * @param opts.limit 条数上限；缺省 {@link DEFAULT_MESSAGE_LIMIT}，实际钳制到 [1, {@link MAX_MESSAGE_LIMIT}]
   */
  async listMessages(channelId: string, opts: { before?: number; limit?: number } = {}): Promise<ChatMessage[]> {
    const requested = typeof opts.limit === 'number' && Number.isFinite(opts.limit) ? Math.trunc(opts.limit) : DEFAULT_MESSAGE_LIMIT;
    const limit = Math.min(Math.max(requested, 1), MAX_MESSAGE_LIMIT);
    let query = this.db(MESSAGES_TABLE).select('*').where('channel_id', channelId);
    if (opts.before !== undefined) query = query.andWhere('created_at', '<', opts.before);
    const rows = (await query.orderBy('created_at', 'desc').orderBy('id', 'desc').limit(limit)) as MessageRow[];
    return rows.map(rowToMessage).reverse();
  }
}
