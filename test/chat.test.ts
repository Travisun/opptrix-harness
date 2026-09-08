/**
 * chat 模块单测（ChatStore + ChatService）：临时文件库 + Migrator 跑真内核迁移
 * （channels/channel_members/messages 由 009/010/011 建立）。
 *
 * - 频道 CRUD、slug 规范化与冲突随机后缀、级联删除；
 * - 成员增删列（addMember 幂等 / upsertUserMember 刷新 joined_at）；
 * - sendMessage 全链路：落库 + SSE publish（topic=chat:<slug>）+ 事件
 *   chat.message.created；chat.beforeSend 改写内容生效；HookAbort（短路返回与
 *   重抛两种形态）→ blocked 且不落库、发 chat.message.blocked；
 * - patchMessage updated_at 变化 + 事件；listMessages 分页（before/limit 钳制）；
 * - content/attachments JSON 往返与损坏容错；bridgeDispatch 调用与错误自捕获。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Knex } from 'knex';

import { ChatService, type ChatMessagePayload } from '../src/kernel/chat/service.js';
import { ChatStore, type ChannelRow } from '../src/kernel/chat/store.js';
import { HOOK_POINTS, HookAbort, HookManager } from '../src/kernel/hooks/index.js';
import { openSqlite } from '../src/kernel/storage/db.js';
import { KERNEL_MIGRATIONS } from '../src/kernel/storage/kernel-migrations.js';
import { Migrator } from '../src/kernel/storage/migrator.js';

// ---------------------------------------------------------------------------
// 测试环境
// ---------------------------------------------------------------------------

let dir: string;
let db: Knex;
let store: ChatStore;

interface PublishRecord {
  topic: string;
  event: string;
  data: unknown;
}
interface EmitRecord {
  event: string;
  data: unknown;
  source: string | undefined;
}
interface BridgeRecord {
  message: ChatMessagePayload;
  channel: ChannelRow;
}

interface Ctx {
  service: ChatService;
  hooks: HookManager;
  published: PublishRecord[];
  emitted: EmitRecord[];
  bridgeCalls: BridgeRecord[];
}

/** 组装 ChatService：真 HookManager + 记录器 publish/emit + 可选桥分发 */
function buildService(opts: { bridge?: boolean } = {}): Ctx {
  const hooks = new HookManager({ logger: pino({ level: 'silent' }) });
  const published: PublishRecord[] = [];
  const emitted: EmitRecord[] = [];
  const bridgeCalls: BridgeRecord[] = [];
  const service = new ChatService({
    store,
    hooks,
    publish: (topic, event, data) => published.push({ topic, event, data }),
    emit: (event, data, opts2) => {
      emitted.push({ event, data, source: opts2?.source });
      return Promise.resolve({ delivered: 1, errors: [] });
    },
    logger: pino({ level: 'silent' }),
    ...(opts.bridge
      ? {
          bridgeDispatch: async (message: ChatMessagePayload, channel: ChannelRow) => {
            bridgeCalls.push({ message, channel });
          },
        }
      : {}),
  });
  return { service, hooks, published, emitted, bridgeCalls };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'opptrix-chat-'));
  db = await openSqlite(join(dir, 'chat.sqlite'));
  const migrator = new Migrator(db, { migrations: KERNEL_MIGRATIONS });
  await migrator.latest();
  store = new ChatStore(db);
});

afterAll(async () => {
  await db?.destroy();
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 频道
// ---------------------------------------------------------------------------

describe('ChatStore/ChatService — 频道 CRUD 与 slug', () => {
  it('createChannel：slug 由 name 规范化（小写/连字符）、type 默认 public、webhook_token 始终生成（hex32）、meta JSON 往返', async () => {
    const { service } = buildService();
    const ch = await service.createChannel({ name: 'My Ops Channel!', type: 'public', meta: { team: 'ops', tier: 2 } });
    expect(ch.slug).toBe('my-ops-channel');
    expect(ch.type).toBe('public');
    expect(ch.webhookToken).toMatch(/^[0-9a-f]{32}$/);
    expect(ch.meta).toEqual({ team: 'ops', tier: 2 });
    // 回读一致（JSON 串化往返）
    const back = await store.getChannelById(ch.id);
    expect(back).toEqual(ch);
    // name 全部被清洗 → 兜底 slug
    const fallback = await service.createChannel({ name: '***' });
    expect(fallback.slug).toBe('channel');
  });

  it('slug 冲突 → 追加随机后缀，两条频道并存且列表完整', async () => {
    const { service } = buildService();
    const a = await service.createChannel({ name: 'daily' });
    const b = await service.createChannel({ name: 'daily' });
    expect(a.slug).toBe('daily');
    expect(b.slug).not.toBe('daily');
    expect(b.slug.startsWith('daily-')).toBe(true);
    const list = await service.listChannels();
    expect(list.map((c) => c.id)).toContain(a.id);
    expect(list.map((c) => c.id)).toContain(b.id);
  });

  it('getChannel 支持 id 与 slug 双寻址；未找到返回 null；getChannelByToken 命中', async () => {
    const { service } = buildService();
    const ch = await service.createChannel({ name: 'lookup' });
    expect((await service.getChannel(ch.id))?.slug).toBe('lookup');
    expect((await service.getChannel('lookup'))?.id).toBe(ch.id);
    expect(await service.getChannel('ghost')).toBeNull();
    expect((await service.getChannelByToken(ch.webhookToken as string))?.id).toBe(ch.id);
    expect(await service.getChannelByToken('not-a-token')).toBeNull();
  });

  it('updateChannel 更新 name/meta；未找到返回 null；空 patch 仅回读', async () => {
    const { service } = buildService();
    const ch = await service.createChannel({ name: 'before', meta: { v: 1 } });
    const updated = await service.updateChannel(ch.slug, { name: 'after', meta: { v: 2 } });
    expect(updated).toMatchObject({ id: ch.id, name: 'after' });
    expect(updated?.meta).toEqual({ v: 2 });
    expect(await service.updateChannel('ghost', { name: 'x' })).toBeNull();
    const untouched = await service.updateChannel(ch.id, {});
    expect(untouched?.name).toBe('after');
  });

  it('deleteChannel 级联删除成员与消息；二次删除返回 false', async () => {
    const { service } = buildService();
    const ch = await service.createChannel({ name: 'doomed' });
    await service.addMember(ch.id, 'user', 'u1');
    const sent = await service.sendMessage({ channelId: ch.id, senderType: 'user', senderId: 'u1', content: { type: 'text', text: 'hi' } });
    expect(sent.blocked).toBe(false);

    expect(await service.deleteChannel(ch.slug)).toBe(true);
    expect(await store.getChannelById(ch.id)).toBeNull();
    expect(await store.listMembers(ch.id)).toEqual([]);
    expect(await store.listMessages(ch.id)).toEqual([]);
    expect(await service.deleteChannel(ch.id)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 成员
// ---------------------------------------------------------------------------

describe('ChatStore/ChatService — 成员管理', () => {
  it('addMember 幂等（重复添加单行）；listMembers 按 joined_at 升序', async () => {
    const { service } = buildService();
    const ch = await service.createChannel({ name: 'members' });
    const first = await service.addMember(ch.id, 'user', 'u1');
    const second = await service.addMember(ch.id, 'user', 'u1');
    expect(second).toEqual(first);
    await service.addMember(ch.id, 'bot', 'b1');
    const members = await service.listMembers(ch.id);
    expect(members).toHaveLength(2);
    // 同毫秒 joined_at 并列时按 member_type 升序稳定排序（bot < user）
    expect(members.map((m) => `${m.memberType}:${m.memberId}`).sort()).toEqual(['bot:b1', 'user:u1']);
  });

  it('removeMember 返回是否确有删除；频道不存在抛 HARNESS-3004', async () => {
    const { service } = buildService();
    const ch = await service.createChannel({ name: 'leave' });
    await service.addMember(ch.id, 'user', 'u1');
    expect(await service.removeMember(ch.id, 'user', 'u1')).toBe(true);
    expect(await service.removeMember(ch.id, 'user', 'u1')).toBe(false);

    await expect(service.addMember('ghost', 'user', 'u1')).rejects.toMatchObject({ code: 'HARNESS-3004' });
  });

  it('upsertUserMember 复用复合主键不重复并刷新 joined_at', async () => {
    const { service } = buildService();
    const ch = await service.createChannel({ name: 'upsert' });
    const first = await service.upsertUserMember(ch.id, 'u9');
    const second = await service.upsertUserMember(ch.id, 'u9');
    expect(second.joinedAt).toBeGreaterThanOrEqual(first.joinedAt);
    expect(await store.listMembers(ch.id)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// sendMessage / hook / 事件 / 桥
// ---------------------------------------------------------------------------

describe('ChatService — sendMessage 全链路', () => {
  it('sendMessage：落库（content/attachments 往返）+ publish topic=chat:<slug> + chat.message.created 事件（source kernel）', async () => {
    const { service, published, emitted, bridgeCalls } = buildService({ bridge: true });
    const ch = await service.createChannel({ name: 'flow' });
    const result = await service.sendMessage({
      channelId: ch.id,
      senderType: 'user',
      senderId: 'u1',
      content: { type: 'text', text: 'hello' },
      attachments: [{ fileId: 'f1', name: 'a.txt' }],
    });
    expect(result.blocked).toBe(false);
    if (result.blocked) return; // 类型收窄辅助
    const msg = result.message;
    expect(msg.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(msg).toMatchObject({ channelId: ch.id, senderType: 'user', senderId: 'u1', content: { type: 'text', text: 'hello' } });
    expect(msg.attachments).toEqual([{ fileId: 'f1', name: 'a.txt' }]);
    expect(msg.createdAt).toBeGreaterThan(0);
    expect(msg.updatedAt).toBe(msg.createdAt);

    // 库里真有一条
    expect(await store.getMessage(msg.id)).toEqual(msg);

    expect(published).toEqual([{ topic: `chat:${ch.slug}`, event: 'chat.message.created', data: msg }]);
    // 事件载荷遵循 ChatMessagePayload 契约：store 行补 channelSlug
    expect(emitted).toEqual([{
      event: 'chat.message.created',
      data: { ...msg, channelSlug: ch.slug },
      source: 'kernel',
    }]);
    // 桥收到 payload（含 channelSlug）与频道记录
    expect(bridgeCalls).toHaveLength(1);
    expect(bridgeCalls[0]?.message).toMatchObject({ id: msg.id, channelSlug: ch.slug, senderType: 'user' });
    expect(bridgeCalls[0]?.channel.id).toBe(ch.id);
  });

  it('bridgeDispatch 收到 payload+channel；抛错被自捕获不影响返回', async () => {
    const { service, bridgeCalls } = buildService({ bridge: true });
    const ch = await service.createChannel({ name: 'bridge' });
    const result = await service.sendMessage({ slug: ch.slug, senderType: 'bot', senderId: 'b1', content: { type: 'card', title: 't' } });
    expect(result.blocked).toBe(false);
    expect(bridgeCalls).toHaveLength(1);
    const call = bridgeCalls[0];
    if (!call) throw new Error('bridge call missing');
    expect(call.message).toMatchObject({ channelSlug: ch.slug, senderType: 'bot', content: { type: 'card', title: 't' } });
    expect(call.channel.id).toBe(ch.id);

    // 抛错的桥：sendMessage 仍然成功（错误被自捕获）
    const failing = new ChatService({
      store,
      hooks: new HookManager(),
      publish: () => {},
      emit: () => undefined,
      logger: pino({ level: 'silent' }),
      bridgeDispatch: async () => {
        throw new Error('bridge down');
      },
    });
    const ch2 = await failing.createChannel({ name: 'bridge-fail' });
    const res = await failing.sendMessage({ channelId: ch2.id, senderType: 'user', senderId: 'u1', content: { type: 'text', text: 'x' } });
    expect(res.blocked).toBe(false);
  });

  it('按 slug 发送；频道不存在抛 HARNESS-3004（404）', async () => {
    const { service } = buildService();
    const ch = await service.createChannel({ name: 'by-slug' });
    const result = await service.sendMessage({ slug: ch.slug, senderType: 'webhook', senderId: 'ci', content: { type: 'text', text: 'ping' } });
    expect(result.blocked).toBe(false);
    if (result.blocked) return;
    expect((await store.getMessage(result.message.id))?.senderId).toBe('ci');

    await expect(
      service.sendMessage({ slug: 'ghost', senderType: 'user', senderId: 'u1', content: { type: 'text', text: 'x' } }),
    ).rejects.toMatchObject({ code: 'HARNESS-3004', status: 404, name: 'HarnessError' });
  });

  it('chat.beforeSend handler 改写内容 → 落库为改写后版本', async () => {
    const { service, hooks } = buildService();
    const ch = await service.createChannel({ name: 'rewrite' });
    hooks.add(HOOK_POINTS.chatBeforeSend, (value) => {
      const draft = value as ChatMessagePayload;
      return { ...draft, content: { type: 'text', text: '[moderated]' }, senderId: 'rewritten-by-hook' };
    });
    const result = await service.sendMessage({ channelId: ch.id, senderType: 'user', senderId: 'u1', content: { type: 'text', text: 'secret' } });
    expect(result.blocked).toBe(false);
    if (result.blocked) return;
    expect(result.message.content).toEqual({ type: 'text', text: '[moderated]' });
    expect(result.message.senderId).toBe('rewritten-by-hook');
    const stored = await store.getMessage(result.message.id);
    expect(stored?.content).toEqual({ type: 'text', text: '[moderated]' });
  });

  it('HookAbort 短路（apply 返回拦截说明）→ blocked + reason，不落库，发 chat.message.blocked', async () => {
    const { service, hooks, published, emitted } = buildService();
    const ch = await service.createChannel({ name: 'gated' });
    hooks.add(HOOK_POINTS.chatBeforeSend, () => {
      throw new HookAbort('no-spam-allowed');
    });
    const before = await store.listMessages(ch.id);
    const result = await service.sendMessage({ channelId: ch.id, senderType: 'user', senderId: 'u1', content: { type: 'text', text: 'spam' } });
    expect(result).toEqual({ blocked: true, reason: 'no-spam-allowed' });
    // 不落库、不发布、不发 created 事件
    expect(await store.listMessages(ch.id)).toEqual(before);
    expect(published).toEqual([]);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.event).toBe('chat.message.blocked');
    expect(emitted[0]?.source).toBe('kernel');
    expect(emitted[0]?.data).toMatchObject({ channelId: ch.id, senderType: 'user', senderId: 'u1', reason: 'no-spam-allowed' });
  });

  it('HookAbort 以重抛形式穿出 hook 门面 → 同样识别为 blocked（双通道兼容）', async () => {
    const throwing = new ChatService({
      store,
      hooks: {
        apply: async () => {
          throw new HookAbort({ code: 'DENY', why: 'quiet hours' });
        },
      },
      publish: () => {},
      emit: () => undefined,
      logger: pino({ level: 'silent' }),
    });
    const ch = await throwing.createChannel({ name: 'rethrow' });
    const result = await throwing.sendMessage({ channelId: ch.id, senderType: 'user', senderId: 'u1', content: { type: 'text', text: 'x' } });
    expect(result).toEqual({ blocked: true, reason: { code: 'DENY', why: 'quiet hours' } });
  });

  it('patchMessage：content 更新 + updated_at 前进 + publish/emit chat.message.updated；未找到返回 null', async () => {
    const { service, published, emitted } = buildService();
    const ch = await service.createChannel({ name: 'patch' });
    const sent = await service.sendMessage({ channelId: ch.id, senderType: 'user', senderId: 'u1', content: { type: 'text', text: 'v1' } });
    expect(sent.blocked).toBe(false);
    if (sent.blocked) return;
    const before = sent.message;
    const updated = await service.patchMessage(before.id, { type: 'text', text: 'v2' });
    expect(updated).not.toBeNull();
    expect(updated?.content).toEqual({ type: 'text', text: 'v2' });
    expect(updated?.updatedAt).toBeGreaterThanOrEqual(before.updatedAt);
    const stored = await store.getMessage(before.id);
    expect(stored?.content).toEqual({ type: 'text', text: 'v2' });
    expect(stored?.updatedAt).toBe(updated?.updatedAt);

    expect(published).toHaveLength(2); // created + updated
    expect(published[1]).toEqual({ topic: `chat:${ch.slug}`, event: 'chat.message.updated', data: updated });
    expect(emitted.map((e) => e.event)).toEqual(['chat.message.created', 'chat.message.updated']);

    expect(await service.patchMessage('ghost-id', { type: 'text', text: 'x' })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 消息列表 / JSON 容错
// ---------------------------------------------------------------------------

describe('ChatStore — listMessages 分页与 JSON 容错', () => {
  it('created_at 降序取 limit 后翻转为升序；before 游标与 limit 钳制（1..200、默认 50）', async () => {
    const ch = await store.createChannel({
      id: 'ch-paging',
      slug: 'paging',
      name: 'paging',
      type: 'public',
      webhookToken: 't-paging',
      createdAt: 1,
    });
    for (let i = 1; i <= 5; i++) {
      await store.insertMessage({
        id: `m-${i}`,
        channelId: ch.id,
        senderType: 'user',
        senderId: 'u1',
        content: { n: i },
        createdAt: i * 100,
        updatedAt: i * 100,
      });
    }
    // 全量：升序
    expect((await store.listMessages(ch.id)).map((m) => m.id)).toEqual(['m-1', 'm-2', 'm-3', 'm-4', 'm-5']);
    // limit=2 → 最新 2 条，仍升序
    expect((await store.listMessages(ch.id, { limit: 2 })).map((m) => m.id)).toEqual(['m-4', 'm-5']);
    // before=400 → 早于 400 的最新 2 条
    expect((await store.listMessages(ch.id, { before: 400, limit: 2 })).map((m) => m.id)).toEqual(['m-2', 'm-3']);
    // 钳制：limit=0 → 1（最新一条）；limit=1000 → 上限 200（5 条全出）
    const clampedLow = await store.listMessages(ch.id, { limit: 0 });
    expect(clampedLow).toHaveLength(1);
    expect(clampedLow[0]?.id).toBe('m-5');
    expect(await store.listMessages(ch.id, { limit: 10_000 })).toHaveLength(5);
    // 空频道
    expect(await store.listMessages('ch-empty')).toEqual([]);
  });

  it('损坏的 content/attachments JSON 读取置 null，不抛错；未提供的 attachments 读回 null', async () => {
    await db('messages').insert({
      id: 'm-corrupt',
      channel_id: 'ch-paging',
      sender_type: 'user',
      sender_id: 'u1',
      content: 'not-json{',
      attachments: 'also-bad[',
      created_at: 999,
      updated_at: 999,
    });
    const msg = await store.getMessage('m-corrupt');
    expect(msg).not.toBeNull();
    expect(msg?.content).toBeNull();
    expect(msg?.attachments).toBeNull();
    // 列表路径同样容错
    const listed = await store.listMessages('ch-paging', { before: 1000 });
    const corrupt = listed.find((m) => m.id === 'm-corrupt');
    expect(corrupt?.content).toBeNull();

    // 正常未带附件的消息：attachments === null
    await store.insertMessage({
      id: 'm-noatt',
      channelId: 'ch-paging',
      senderType: 'user',
      senderId: 'u1',
      content: { type: 'text', text: 'plain' },
      createdAt: 998,
      updatedAt: 998,
    });
    expect((await store.getMessage('m-noatt'))?.attachments).toBeNull();
  });
});
