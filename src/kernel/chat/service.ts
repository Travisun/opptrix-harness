/**
 * chat — 聊天领域服务（ChatService）。
 *
 * - 频道 CRUD（slug 规范化 + 冲突随机后缀；webhook_token 始终生成）与成员管理；
 * - `sendMessage`：构造 draft → 经 `hooks.apply('chat.beforeSend', draft)` filter 链
 *   （handler 可改写消息，或抛 `HookAbort(result)` 短路拦截）→ 落库 →
 *   SSE publish（topic `chat:<slug>`）+ 事件 `chat.message.created` →
 *   bridge 分发（fire-and-forget，错误自捕获）。
 * - 拦截不落库，发事件 `chat.message.blocked`，返回 `{ blocked: true, reason }`。
 *
 * HookAbort 双通道兼容：`HookManager.apply` 的契约是捕获 HookAbort 后以
 * `result` 作为 apply 返回值短路（不向调用方抛出）；部分自定义 hook 门面可能
 * 直接重抛 HookAbort。两种形态在此统一识别为"拦截"。
 */
import { randomBytes, randomUUID } from 'node:crypto';

import type { Logger } from 'pino';

import { HOOK_POINTS, HookAbort } from '../hooks/index.js';
import { err } from '../errors/index.js';
import type { ChatMessagePayload } from '../channels/types.js';
import type { ChannelMemberRow, ChannelPatch, ChannelRow, ChatMessage, ChatStore } from './store.js';

/**
 * 跨桥分发的消息线格式（draft 与落库消息的公共视图，多一个 channelSlug）。
 *
 * 单一事实来源是 channels 包契约（`../channels/types.js`）；此处 re-export 保持
 * `chat/index.js` 既有导出兼容（dispatcher/bridges 均按 channels 契约实现）。
 */
export type { ChatMessagePayload } from '../channels/types.js';

/** sendMessage 入参：channelId 与 slug 二选一（channelId 优先） */
export interface ChatSendMessageInput {
  channelId?: string;
  slug?: string;
  senderType: string;
  senderId: string;
  content: unknown;
  attachments?: unknown;
}

/** sendMessage 结果：被 hook 拦截（不落库）或成功（返回落库消息） */
export type ChatSendResult =
  | { blocked: true; reason: unknown }
  | { blocked: false; message: ChatMessage };

/** hook 链门面契约（与内核 HookManager.apply 结构兼容） */
export interface ChatHookPort {
  apply(name: string, value: unknown, ctx?: { meta?: Record<string, unknown> }): Promise<unknown>;
}

/** ChatService 依赖集合 */
export interface ChatServiceDeps {
  /** 聊天持久化存储（channels / members / messages） */
  store: ChatStore;
  /** hook 拦截链（chat.beforeSend） */
  hooks: ChatHookPort;
  /** SSE 广播（同步、不等待；无订阅者时 no-op） */
  publish(topic: string, event: string, data: unknown): void;
  /** 内核事件总线（监听器异常已被隔离，emit 不 reject） */
  emit(name: string, payload: unknown, opts?: { source?: string }): Promise<unknown> | unknown;
  /** 内核 logger（pino）；令牌/消息内容不入日志 */
  logger: Logger;
  /** 渠道桥分发（可选）：异步 fire-and-forget，内部自捕获错误，不影响发送结果 */
  bridgeDispatch?: (message: ChatMessagePayload, channel: ChannelRow) => Promise<void>;
}

/** createChannel 入参（id / webhookToken 由服务生成） */
export interface ChatChannelCreateInput {
  slug?: string;
  name: string;
  type?: string;
  meta?: unknown;
}

/** slug 规范化后的兜底名（name 全部被清洗掉时使用） */
const FALLBACK_SLUG = 'channel';
/** slug 冲突时随机后缀的字节数（hex 6 字符） */
const SLUG_SUFFIX_BYTES = 4;
/** slug 冲突重试上限（单次创建内；每轮随机后缀，碰撞概率可忽略） */
const SLUG_MAX_ATTEMPTS = 5;

/** slug 规范化：小写、非 [a-z0-9] 连字符化、折叠重复连字符、去首尾连字符；空结果回退 'channel' */
function slugify(raw: string): string {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return slug === '' ? FALLBACK_SLUG : slug;
}

/** 频道未找到（EXT_NOT_FOUND → 404 HARNESS-3004；与 webhook 无效令牌的语义一致） */
function channelNotFound(ref: string): ReturnType<typeof err> {
  return err('EXT_NOT_FOUND', { message: `chat channel "${ref}" not found`, detail: { ref } });
}

/**
 * 判定 hook 链返回值是否仍是一条消息（draft 形状）。
 * filter 链短路时 `HookManager.apply` 会以 `HookAbort.result`（"拦截说明"，
 * 通常是 string/对象而非消息）作为返回值——形状不符即视为被拦截。
 */
function asMessageDraft(value: unknown): ChatMessagePayload | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v['id'] !== 'string') return null;
  if (typeof v['channelId'] !== 'string') return null;
  if (typeof v['senderType'] !== 'string' || typeof v['senderId'] !== 'string') return null;
  if (!('content' in v)) return null;
  if (typeof v['createdAt'] !== 'number') return null;
  return {
    id: v['id'],
    channelId: v['channelId'],
    channelSlug: typeof v['channelSlug'] === 'string' ? v['channelSlug'] : '',
    // sender_type 在存储层为 open 枚举（ChatMessage.senderType: string）；
    // channels 契约收窄为 'user' | 'ext' | 'webhook'，边界处信任收窄（运行时仍放行任意字符串）
    senderType: v['senderType'] as ChatMessagePayload['senderType'],
    senderId: v['senderId'],
    content: v['content'],
    attachments: v['attachments'] ?? null,
    createdAt: v['createdAt'],
  };
}

/**
 * 聊天领域服务：频道/成员/消息的用例编排（hook 拦截、SSE、事件、桥分发）。
 */
export class ChatService {
  constructor(private readonly deps: ChatServiceDeps) {}

  // -----------------------------------------------------------------------
  // channels
  // -----------------------------------------------------------------------

  /**
   * 创建频道。
   * - slug 缺省由 name 规范化（小写/连字符）；显式 slug 亦做同样规范化；
   * - slug 冲突时追加随机后缀重试（最多 {@link SLUG_MAX_ATTEMPTS} 轮）；
   * - webhook_token 始终生成（`crypto.randomBytes(16).hex`）。
   *
   * @returns 落库后的频道记录
   * @throws HarnessError（DB_ERROR）多轮重试后 slug 仍冲突（理论不可达，防御性兜底）
   */
  async createChannel(input: ChatChannelCreateInput): Promise<ChannelRow> {
    const base = slugify(input.slug ?? input.name);
    for (let attempt = 0; attempt < SLUG_MAX_ATTEMPTS; attempt++) {
      const slug = attempt === 0 ? base : `${base}-${randomBytes(SLUG_SUFFIX_BYTES).toString('hex')}`;
      const existing = await this.deps.store.getChannelBySlug(slug);
      if (existing !== null) continue;
      return this.deps.store.createChannel({
        id: randomUUID(),
        slug,
        name: input.name,
        type: input.type ?? 'public',
        webhookToken: randomBytes(16).toString('hex'),
        meta: input.meta,
        createdAt: Date.now(),
      });
    }
    throw err('DB_ERROR', {
      message:
        `chat service: failed to allocate a unique slug for "${input.name}" ` +
        `after ${SLUG_MAX_ATTEMPTS} attempts (base slug "${base}" is taken). Rename the channel or retry.`,
      detail: { name: input.name, base },
    });
  }

  /** 列出全部频道（created_at 升序）。 */
  listChannels(): Promise<ChannelRow[]> {
    return this.deps.store.listChannels();
  }

  /** 按 ID 或 slug 读取频道；不存在返回 null。 */
  async getChannel(idOrSlug: string): Promise<ChannelRow | null> {
    const byId = await this.deps.store.getChannelById(idOrSlug);
    if (byId !== null) return byId;
    return this.deps.store.getChannelBySlug(idOrSlug);
  }

  /** 按入站 webhook 令牌读取频道；不存在返回 null（令牌永不入日志）。 */
  getChannelByToken(token: string): Promise<ChannelRow | null> {
    return this.deps.store.getChannelByToken(token);
  }

  /**
   * 部分更新频道（name / meta）。
   * @returns 更新后的记录；频道不存在返回 null
   */
  async updateChannel(idOrSlug: string, patch: ChannelPatch): Promise<ChannelRow | null> {
    const channel = await this.getChannel(idOrSlug);
    if (channel === null) return null;
    return this.deps.store.updateChannel(channel.id, patch);
  }

  /**
   * 删除频道（级联删除成员关系与消息）。
   * @returns 是否确有删除；频道不存在返回 false
   */
  async deleteChannel(idOrSlug: string): Promise<boolean> {
    const channel = await this.getChannel(idOrSlug);
    if (channel === null) return false;
    return this.deps.store.deleteChannel(channel.id);
  }

  // -----------------------------------------------------------------------
  // members
  // -----------------------------------------------------------------------

  /** 添加成员（幂等）。@throws HarnessError（EXT_NOT_FOUND）频道不存在 */
  async addMember(idOrSlug: string, memberType: string, memberId: string): Promise<ChannelMemberRow> {
    const channel = await this.getChannel(idOrSlug);
    if (channel === null) throw channelNotFound(idOrSlug);
    return this.deps.store.addMember(channel.id, memberType, memberId);
  }

  /** 移除成员。@returns 是否确有删除；@throws HarnessError（EXT_NOT_FOUND）频道不存在 */
  async removeMember(idOrSlug: string, memberType: string, memberId: string): Promise<boolean> {
    const channel = await this.getChannel(idOrSlug);
    if (channel === null) throw channelNotFound(idOrSlug);
    return this.deps.store.removeMember(channel.id, memberType, memberId);
  }

  /** 列出频道成员（joined_at 升序）。@throws HarnessError（EXT_NOT_FOUND）频道不存在 */
  async listMembers(idOrSlug: string): Promise<ChannelMemberRow[]> {
    const channel = await this.getChannel(idOrSlug);
    if (channel === null) throw channelNotFound(idOrSlug);
    return this.deps.store.listMembers(channel.id);
  }

  /** 以 user 身份 upsert 成员。@throws HarnessError（EXT_NOT_FOUND）频道不存在 */
  async upsertUserMember(idOrSlug: string, userId: string): Promise<ChannelMemberRow> {
    const channel = await this.getChannel(idOrSlug);
    if (channel === null) throw channelNotFound(idOrSlug);
    return this.deps.store.upsertUserMember(channel.id, userId);
  }

  // -----------------------------------------------------------------------
  // messages
  // -----------------------------------------------------------------------

  /**
   * 发送消息（chat.beforeSend hook 拦截点）。
   *
   * 流程：取频道 → 构造 draft（uuid + channelSlug + UTC createdAt）→
   * `hooks.apply('chat.beforeSend', draft, { meta: { channelId } })` →
   * 被拦截（HookAbort 短路，或 hook 门面重抛 HookAbort）→ 不落库，发事件
   * `chat.message.blocked`，返回 `{ blocked: true, reason }` →
   * 否则落库 → publish `chat:<slug>` / `chat.message.created` →
   * emit `chat.message.created`（source 'kernel'）→ bridge fire-and-forget。
   *
   * @throws HarnessError（EXT_NOT_FOUND）频道不存在；（INTERNAL）channelId 与 slug 均缺省
   */
  async sendMessage(input: ChatSendMessageInput): Promise<ChatSendResult> {
    const channel = await this.#resolveChannelForSend(input);
    const draft: ChatMessagePayload = {
      id: randomUUID(),
      channelId: channel.id,
      channelSlug: channel.slug,
      // 输入侧保持 open 枚举（见 ChatSendMessageInput.senderType），channels 契约收窄见 asMessageDraft
      senderType: input.senderType as ChatMessagePayload['senderType'],
      senderId: input.senderId,
      content: input.content,
      attachments: input.attachments === undefined ? null : input.attachments,
      createdAt: Date.now(),
    };

    let final: unknown;
    try {
      final = await this.deps.hooks.apply(HOOK_POINTS.chatBeforeSend, draft, { meta: { channelId: channel.id } });
    } catch (e) {
      // 兼容直接重抛 HookAbort 的自定义 hook 门面（内核 HookManager 契约是捕获后返回 result）
      if (e instanceof HookAbort) {
        await this.#emitBlocked(channel, draft, e.result);
        return { blocked: true, reason: e.result };
      }
      throw e;
    }

    const payload = asMessageDraft(final);
    if (payload === null) {
      // HookManager 短路语义：apply 返回值即 HookAbort(result)（"拦截说明"），非消息形状
      await this.#emitBlocked(channel, draft, final);
      return { blocked: true, reason: final };
    }

    const message = await this.deps.store.insertMessage({
      id: payload.id,
      channelId: channel.id,
      senderType: payload.senderType,
      senderId: payload.senderId,
      content: payload.content,
      attachments: payload.attachments,
      createdAt: payload.createdAt,
      updatedAt: payload.createdAt,
    });

    this.deps.publish(`chat:${channel.slug}`, 'chat.message.created', message);
    // 事件载荷遵循 ChatMessagePayload 契约（channels/types.ts）：携带 channelSlug
    // （store 行只有 channelId；订阅方如 echo-bot 依赖 slug 回发频道）
    await this.deps.emit('chat.message.created', { ...message, channelSlug: channel.slug }, { source: 'kernel' });

    if (this.deps.bridgeDispatch !== undefined) {
      const dispatch = this.deps.bridgeDispatch;
      // fire-and-forget：不阻塞发送结果，内部自捕获错误（桥故障不影响消息已落库的事实）
      void dispatch(
        {
          id: message.id,
          channelId: message.channelId,
          channelSlug: channel.slug,
          senderType: message.senderType as ChatMessagePayload['senderType'], // 存储层 open 枚举 → channels 契约收窄
          senderId: message.senderId,
          content: message.content,
          attachments: message.attachments,
          createdAt: message.createdAt,
        },
        channel,
      ).catch((e: unknown) => {
        this.deps.logger.warn({ channelId: channel.id, messageId: message.id }, '[chat] bridge dispatch failed');
        void e; // 桥错误细节不外抛，仅计数/告警由桥自身负责
      });
    }

    return { blocked: false, message };
  }

  /**
   * 更新消息正文 → publish `chat:<slug>` / `chat.message.updated` +
   * emit `chat.message.updated`（source 'kernel'）。
   * @returns 更新后的消息；不存在返回 null
   */
  async patchMessage(id: string, content: unknown): Promise<ChatMessage | null> {
    const updated = await this.deps.store.updateMessage(id, content);
    if (updated === null) return null;
    const channel = await this.deps.store.getChannelById(updated.channelId);
    // 频道已被删除的边缘场景：topic 退化为 channelId，事件照常发出
    const topic = `chat:${channel !== null ? channel.slug : updated.channelId}`;
    this.deps.publish(topic, 'chat.message.updated', updated);
    // 事件载荷同样补 channelSlug（频道仍在时；已删除频道退化为原样载荷）
    await this.deps.emit(
      'chat.message.updated',
      channel !== null ? { ...updated, channelSlug: channel.slug } : updated,
      { source: 'kernel' },
    );
    return updated;
  }

  /** 按 ID 读取消息；不存在返回 null。 */
  getMessage(id: string): Promise<ChatMessage | null> {
    return this.deps.store.getMessage(id);
  }

  /**
   * 列出频道消息（created_at 升序；limit 缺省 50、钳制 1..200；before 游标分页）。
   * @throws HarnessError（EXT_NOT_FOUND）频道不存在
   */
  async listMessages(idOrSlug: string, opts: { before?: number; limit?: number } = {}): Promise<ChatMessage[]> {
    const channel = await this.getChannel(idOrSlug);
    if (channel === null) throw channelNotFound(idOrSlug);
    return this.deps.store.listMessages(channel.id, opts);
  }

  // -----------------------------------------------------------------------
  // 内部
  // -----------------------------------------------------------------------

  /** 解析发送目标频道：channelId 优先，其次 slug；均缺省属编程错误（fail-fast）。 */
  async #resolveChannelForSend(input: ChatSendMessageInput): Promise<ChannelRow> {
    const ref = input.channelId ?? input.slug;
    if (input.channelId !== undefined) {
      const byId = await this.deps.store.getChannelById(input.channelId);
      if (byId !== null) return byId;
    } else if (input.slug !== undefined) {
      const bySlug = await this.deps.store.getChannelBySlug(input.slug);
      if (bySlug !== null) return bySlug;
    } else {
      throw err('INTERNAL', { message: '[chat] sendMessage requires "channelId" or "slug"' });
    }
    throw channelNotFound(ref ?? '');
  }

  /** 拦截路径：发 `chat.message.blocked` 事件（不落库）。reason 不入日志（内容任意）。 */
  async #emitBlocked(channel: ChannelRow, draft: ChatMessagePayload, reason: unknown): Promise<void> {
    this.deps.logger.debug({ channelId: channel.id, senderType: draft.senderType }, '[chat] message blocked by chat.beforeSend hook');
    await this.deps.emit(
      'chat.message.blocked',
      {
        channelId: channel.id,
        channelSlug: channel.slug,
        messageId: draft.id,
        senderType: draft.senderType,
        senderId: draft.senderId,
        reason,
      },
      { source: 'kernel' },
    );
  }
}
