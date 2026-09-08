/**
 * chat REST API 集成测试（真实 fastify 注入，经 createHttpServer 挂载 registerChatRoutes）。
 *
 * - 真库 + 真 ChatService（真 HookManager 无 handler）+ 记录器 publish/emit；
 * - 覆盖：全部受保护路由无 token 401、normal 管理类路由 403、admin 建频道 201
 *   （slug 规范化 + webhook_token）、zod 校验 400、非法 JSON 400、双寻址读取与
 *   404 HARNESS-3004、成员增删列、消息发送 senderId=身份 + 真库落库、消息分页
 *   （before/limit）、PATCH 消息（admin v1）、入站 webhook 202 全链路
 *   （真库校验 senderType='webhook'）与无效 token 404。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Knex } from 'knex';

import { registerChatRoutes } from '../src/api/chat.js';
import { ChatService } from '../src/kernel/chat/service.js';
import { ChatStore } from '../src/kernel/chat/store.js';
import { err } from '../src/kernel/errors/HarnessError.js';
import { createHttpServer } from '../src/kernel/http/server.js';
import { HookManager } from '../src/kernel/hooks/index.js';
import { loadConfig } from '../src/kernel/config/index.js';
import { closeDb, openSqlite } from '../src/kernel/storage/db.js';
import { KERNEL_MIGRATIONS } from '../src/kernel/storage/kernel-migrations.js';
import { Migrator } from '../src/kernel/storage/migrator.js';

const ADMIN_TOKEN = 'token-admin';
const ROOT_TOKEN = 'token-root';
const NORMAL_TOKEN = 'token-normal';

const AUTH_ADMIN = { authorization: `Bearer ${ADMIN_TOKEN}` };
const AUTH_ROOT = { authorization: `Bearer ${ROOT_TOKEN}` };
const AUTH_NORMAL = { authorization: `Bearer ${NORMAL_TOKEN}` };

// ---------------------------------------------------------------------------
// 受保护路由（鉴权/角色用例遍历；POST/PATCH/DELETE 附带合法 body，证明 401/403 先于校验）
// ---------------------------------------------------------------------------

const ADMIN_ROUTES = [
  { method: 'POST', url: '/api/v1/channels', body: { name: 'ops' } },
  { method: 'PATCH', url: '/api/v1/channels/ops', body: { name: 'ops2' } },
  { method: 'DELETE', url: '/api/v1/channels/ops' },
  { method: 'POST', url: '/api/v1/channels/ops/members', body: { memberType: 'user', memberId: 'u1' } },
  { method: 'DELETE', url: '/api/v1/channels/ops/members', body: { memberType: 'user', memberId: 'u1' } },
  { method: 'PATCH', url: '/api/v1/messages/m-1', body: { type: 'text', text: 'x' } },
] as const;

const AUTH_ROUTES = [
  { method: 'GET', url: '/api/v1/channels' },
  { method: 'GET', url: '/api/v1/channels/ops' },
  { method: 'GET', url: '/api/v1/channels/ops/members' },
  { method: 'GET', url: '/api/v1/channels/ops/messages' },
  { method: 'POST', url: '/api/v1/channels/ops/messages', body: { type: 'text', text: 'hi' } },
  ...ADMIN_ROUTES,
] as const;

// ---------------------------------------------------------------------------
// 环境
// ---------------------------------------------------------------------------

let dir: string;
let db: Knex;
let store: ChatStore;

interface Ctx {
  app: FastifyInstance;
  service: ChatService;
  published: Array<{ topic: string; event: string; data: unknown }>;
}

/** 组装被测服务器：真库 + 真 ChatService + stub checker + 记录器 publish */
function buildServer(): Ctx {
  const published: Array<{ topic: string; event: string; data: unknown }> = [];
  const service = new ChatService({
    store,
    hooks: new HookManager({ logger: pino({ level: 'silent' }) }),
    publish: (topic, event, data) => published.push({ topic, event, data }),
    emit: () => Promise.resolve({ delivered: 1, errors: [] }),
    logger: pino({ level: 'silent' }),
  });
  const config = loadConfig({
    NODE_ENV: 'test',
    HARNESS_LOG_LEVEL: 'error',
    HARNESS_DATA_DIR: dir,
  });
  const { app } = createHttpServer({
    config,
    logger: pino({ level: 'silent' }),
    isReady: () => true,
    state: () => 'ready',
    registerExtra: (a) => {
      registerChatRoutes(a, {
        checker: async ({ token }) => {
          if (token === ADMIN_TOKEN) return { userId: 'admin-1', role: 'admin', scopes: ['chat'] };
          if (token === ROOT_TOKEN) return { userId: 'root', role: 'root', scopes: ['*'] };
          if (token === NORMAL_TOKEN) return { userId: 'user-9', role: 'normal', scopes: [] };
          throw err('UNAUTHORIZED', { detail: 'token rejected by all auth providers' });
        },
        service,
      });
    },
  });
  return { app, service, published };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'opptrix-chat-api-'));
  db = await openSqlite(join(dir, 'chat-api.sqlite'));
  const migrator = new Migrator(db, { migrations: KERNEL_MIGRATIONS });
  await migrator.latest();
  store = new ChatStore(db);
});

afterAll(async () => {
  await closeDb(db);
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 鉴权与角色门禁
// ---------------------------------------------------------------------------

describe('chat api — 鉴权与角色门禁', () => {
  it.each(AUTH_ROUTES)('$method $url 无 token → 401 HARNESS-1006', async (route) => {
    const { app } = buildServer();
    const res = await app.inject({
      method: route.method,
      url: route.url,
      ...('body' in route ? { payload: route.body } : {}),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('HARNESS-1006');
  });

  it.each(ADMIN_ROUTES)('$method $url normal 角色 → 403 HARNESS-1007', async (route) => {
    const { app } = buildServer();
    const res = await app.inject({
      method: route.method,
      url: route.url,
      headers: AUTH_NORMAL,
      ...('body' in route ? { payload: route.body } : {}),
    });
    expect(res.statusCode).toBe(403);
    const body = res.json();
    expect(body.code).toBe('HARNESS-1007');
    expect(body.message).toContain('admin or root');
  });

  it.each(ADMIN_ROUTES)('$method $url root 角色放行（预置频道后 2xx/4xx 非 401/403）', async (route) => {
    const { app, service } = buildServer();
    const ch = await service.createChannel({ name: 'ops' });
    const url = route.url.replace('ops', ch.slug);
    const res = await app.inject({
      method: route.method,
      url,
      headers: AUTH_ROOT,
      ...('body' in route ? { payload: route.body } : {}),
    });
    expect([401, 403]).not.toContain(res.statusCode);
  });
});

// ---------------------------------------------------------------------------
// 频道管理
// ---------------------------------------------------------------------------

describe('chat api — 频道管理', () => {
  it('admin 建频道 → 201：slug 由 name 规范化、webhook_token 32 位 hex、type 默认 public；normal → 403', async () => {
    const { app } = buildServer();

    const denied = await app.inject({
      method: 'POST',
      url: '/api/v1/channels',
      headers: AUTH_NORMAL,
      payload: { name: 'nope' },
    });
    expect(denied.statusCode).toBe(403);

    const ok = await app.inject({
      method: 'POST',
      url: '/api/v1/channels',
      headers: AUTH_ADMIN,
      payload: { name: 'My Ops Channel!', meta: { team: 'ops' } },
    });
    expect(ok.statusCode).toBe(201);
    const body = ok.json();
    expect(body.slug).toBe('my-ops-channel');
    expect(body.type).toBe('public');
    expect(body.webhookToken).toMatch(/^[0-9a-f]{32}$/);
    expect(body.meta).toEqual({ team: 'ops' });
    // 真库落库
    expect((await store.getChannelById(body.id))?.slug).toBe('my-ops-channel');
  });

  it('建频道 zod 校验：name 缺失/slug 大写非法 → 400 HARNESS-1009；非法 JSON body → 400', async () => {
    const { app } = buildServer();
    for (const body of [{}, { name: 'x', slug: 'UPPER' }, { name: 'x', slug: 'a b' }, { name: '' }]) {
      const res = await app.inject({ method: 'POST', url: '/api/v1/channels', headers: AUTH_ADMIN, payload: body });
      expect(res.statusCode, `body=${JSON.stringify(body)} 应 400`).toBe(400);
      expect(res.json().code).toBe('HARNESS-1009');
    }
    const badJson = await app.inject({
      method: 'POST',
      url: '/api/v1/channels',
      headers: { ...AUTH_ADMIN, 'content-type': 'application/json' },
      payload: '{"name": not-json',
    });
    expect(badJson.statusCode).toBe(400);
    expect(badJson.json().code).toBe('HARNESS-1009');
  });

  it('GET /channels 列表（normal 可读）；GET /:idOrSlug 双寻址；未找到 → 404 HARNESS-3004', async () => {
    const { app, service } = buildServer();
    const ch = await service.createChannel({ name: 'readable' });

    const list = await app.inject({ method: 'GET', url: '/api/v1/channels', headers: AUTH_NORMAL });
    expect(list.statusCode).toBe(200);
    expect(list.json().map((c: { id: string }) => c.id)).toContain(ch.id);

    const byId = await app.inject({ method: 'GET', url: `/api/v1/channels/${ch.id}`, headers: AUTH_NORMAL });
    expect(byId.statusCode).toBe(200);
    expect(byId.json().id).toBe(ch.id);

    const bySlug = await app.inject({ method: 'GET', url: '/api/v1/channels/readable', headers: AUTH_NORMAL });
    expect(bySlug.statusCode).toBe(200);
    expect(bySlug.json().id).toBe(ch.id);

    const miss = await app.inject({ method: 'GET', url: '/api/v1/channels/ghost', headers: AUTH_ADMIN });
    expect(miss.statusCode).toBe(404);
    expect(miss.json().code).toBe('HARNESS-3004');
  });

  it('PATCH/DELETE 频道（admin）：更新生效；删除 {deleted:true} 且级联清空成员/消息；再删 → 404', async () => {
    const { app, service } = buildServer();
    const ch = await service.createChannel({ name: 'patched-later' });
    await service.addMember(ch.id, 'user', 'u1');
    await service.sendMessage({ channelId: ch.id, senderType: 'user', senderId: 'u1', content: { type: 'text', text: 'bye' } });

    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/channels/${ch.id}`,
      headers: AUTH_ADMIN,
      payload: { name: 'patched', meta: { v: 2 } },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json()).toMatchObject({ id: ch.id, name: 'patched' });
    expect(patch.json().meta).toEqual({ v: 2 });

    const del = await app.inject({ method: 'DELETE', url: `/api/v1/channels/${ch.slug}`, headers: AUTH_ADMIN });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ deleted: true });
    expect(await store.listMembers(ch.id)).toEqual([]);
    expect(await store.listMessages(ch.id)).toEqual([]);

    const again = await app.inject({ method: 'DELETE', url: `/api/v1/channels/${ch.slug}`, headers: AUTH_ADMIN });
    expect(again.statusCode).toBe(404);
    expect(again.json().code).toBe('HARNESS-3004');
  });
});

// ---------------------------------------------------------------------------
// 成员
// ---------------------------------------------------------------------------

describe('chat api — 成员管理', () => {
  it('POST members（admin）→ 201 幂等；GET members 列出；DELETE 移除 {removed:true}；缺失再删 → 404', async () => {
    const { app, service } = buildServer();
    const ch = await service.createChannel({ name: 'crew' });

    const add = await app.inject({
      method: 'POST',
      url: `/api/v1/channels/${ch.slug}/members`,
      headers: AUTH_ADMIN,
      payload: { memberType: 'user', memberId: 'u1' },
    });
    expect(add.statusCode).toBe(201);
    expect(add.json()).toMatchObject({ channelId: ch.id, memberType: 'user', memberId: 'u1' });

    const dup = await app.inject({
      method: 'POST',
      url: `/api/v1/channels/${ch.slug}/members`,
      headers: AUTH_ADMIN,
      payload: { memberType: 'user', memberId: 'u1' },
    });
    expect(dup.statusCode).toBe(201);
    expect(await store.listMembers(ch.id)).toHaveLength(1); // 幂等

    const list = await app.inject({ method: 'GET', url: `/api/v1/channels/${ch.slug}/members`, headers: AUTH_NORMAL });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toHaveLength(1);
    expect(list.json()[0]).toMatchObject({ memberType: 'user', memberId: 'u1' });

    const rm = await app.inject({
      method: 'DELETE',
      url: `/api/v1/channels/${ch.slug}/members`,
      headers: AUTH_ADMIN,
      payload: { memberType: 'user', memberId: 'u1' },
    });
    expect(rm.statusCode).toBe(200);
    expect(rm.json()).toEqual({ removed: true });

    const rmAgain = await app.inject({
      method: 'DELETE',
      url: `/api/v1/channels/${ch.slug}/members`,
      headers: AUTH_ADMIN,
      payload: { memberType: 'user', memberId: 'u1' },
    });
    expect(rmAgain.statusCode).toBe(404);

    const badBody = await app.inject({
      method: 'POST',
      url: `/api/v1/channels/${ch.slug}/members`,
      headers: AUTH_ADMIN,
      payload: { memberType: 'user' },
    });
    expect(badBody.statusCode).toBe(400);
    expect(badBody.json().code).toBe('HARNESS-1009');
  });
});

// ---------------------------------------------------------------------------
// 消息（认证发送 / 列表 / PATCH）
// ---------------------------------------------------------------------------

describe('chat api — 消息发送与查询', () => {
  it('POST messages（normal）→ 201 {blocked:false,message}，senderId 锚定身份且真库落库', async () => {
    const { app, service, published } = buildServer();
    const ch = await service.createChannel({ name: 'talk' });

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/channels/${ch.slug}/messages`,
      headers: AUTH_NORMAL,
      payload: { type: 'text', text: 'hello from user-9' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.blocked).toBe(false);
    expect(body.message).toMatchObject({
      channelId: ch.id,
      senderType: 'user',
      senderId: 'user-9',
      content: { type: 'text', text: 'hello from user-9' },
    });
    // 真库校验
    const stored = await store.getMessage(body.message.id);
    expect(stored?.senderId).toBe('user-9');
    expect(stored?.senderType).toBe('user');
    // SSE 广播 topic=chat:<slug>
    expect(published).toEqual([{ topic: `chat:${ch.slug}`, event: 'chat.message.created', data: stored }]);
  });

  it('POST messages zod：text 缺 text / type 非法 → 400 HARNESS-1009（不落库）', async () => {
    const { app, service } = buildServer();
    const ch = await service.createChannel({ name: 'validate' });
    for (const body of [{ type: 'text' }, { type: 'text', text: '' }, { type: 'image' }, {}]) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/channels/${ch.slug}/messages`,
        headers: AUTH_ADMIN,
        payload: body,
      });
      expect(res.statusCode, `body=${JSON.stringify(body)} 应 400`).toBe(400);
      expect(res.json().code).toBe('HARNESS-1009');
    }
    expect(await store.listMessages(ch.id)).toEqual([]);
  });

  it('GET messages：升序 + ?before 游标 + ?limit；limit=0/超大 → 400', async () => {
    const { app, service } = buildServer();
    const ch = await service.createChannel({ name: 'history' });
    const now = Date.now();
    for (let i = 1; i <= 3; i++) {
      await store.insertMessage({
        id: `hm-${i}`,
        channelId: ch.id,
        senderType: 'user',
        senderId: 'u1',
        content: { type: 'text', text: `m${i}` },
        createdAt: now + i,
        updatedAt: now + i,
      });
    }
    const all = await app.inject({ method: 'GET', url: `/api/v1/channels/${ch.slug}/messages`, headers: AUTH_NORMAL });
    expect(all.statusCode).toBe(200);
    expect(all.json().map((m: { id: string }) => m.id)).toEqual(['hm-1', 'hm-2', 'hm-3']);

    const cursor = await app.inject({
      method: 'GET',
      url: `/api/v1/channels/${ch.slug}/messages?before=${now + 3}&limit=2`,
      headers: AUTH_NORMAL,
    });
    expect(cursor.statusCode).toBe(200);
    expect(cursor.json().map((m: { id: string }) => m.id)).toEqual(['hm-1', 'hm-2']);

    for (const q of ['limit=0', 'limit=201', 'limit=abc', 'before=-5']) {
      const bad = await app.inject({
        method: 'GET',
        url: `/api/v1/channels/${ch.slug}/messages?${q}`,
        headers: AUTH_NORMAL,
      });
      expect(bad.statusCode, `query=${q} 应 400`).toBe(400);
      expect(bad.json().code).toBe('HARNESS-1009');
    }
  });

  it('PATCH /api/v1/messages/:id（admin v1）→ 200 更新真库；normal → 403；未找到 → 404', async () => {
    const { app, service } = buildServer();
    const ch = await service.createChannel({ name: 'edit' });
    const sent = await service.sendMessage({ channelId: ch.id, senderType: 'user', senderId: 'u1', content: { type: 'text', text: 'v1' } });
    if (!sent.blocked) {
      const denied = await app.inject({
        method: 'PATCH',
        url: `/api/v1/messages/${sent.message.id}`,
        headers: AUTH_NORMAL,
        payload: { type: 'text', text: 'nope' },
      });
      expect(denied.statusCode).toBe(403);

      const ok = await app.inject({
        method: 'PATCH',
        url: `/api/v1/messages/${sent.message.id}`,
        headers: AUTH_ADMIN,
        payload: { type: 'text', text: 'v2-edited' },
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().content).toEqual({ type: 'text', text: 'v2-edited' });
      expect((await store.getMessage(sent.message.id))?.content).toEqual({ type: 'text', text: 'v2-edited' });

      const miss = await app.inject({
        method: 'PATCH',
        url: '/api/v1/messages/ghost-id',
        headers: AUTH_ADMIN,
        payload: { type: 'text', text: 'x' },
      });
      expect(miss.statusCode).toBe(404);
      expect(miss.json().code).toBe('HARNESS-3004');
    }
  });
});

// ---------------------------------------------------------------------------
// 入站 webhook（公开免鉴权）
// ---------------------------------------------------------------------------

describe('chat api — 入站 webhook /hooks/chat/:token', () => {
  it('有效 token（无鉴权头）→ 202 {accepted:true}，真库落库 senderType=webhook；sender 缺省 webhook、可自定义', async () => {
    const { app, service, published } = buildServer();
    const ch = await service.createChannel({ name: 'inbound' });

    const res = await app.inject({
      method: 'POST',
      url: `/hooks/chat/${ch.webhookToken as string}`,
      payload: { text: 'deploy finished' },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.accepted).toBe(true);
    expect(body.blocked).toBe(false);
    const stored = await store.getMessage(body.messageId);
    expect(stored).toMatchObject({
      channelId: ch.id,
      senderType: 'webhook',
      senderId: 'webhook',
      content: { type: 'text', text: 'deploy finished' },
    });
    expect(published).toEqual([{ topic: `chat:${ch.slug}`, event: 'chat.message.created', data: stored }]);

    const custom = await app.inject({
      method: 'POST',
      url: `/hooks/chat/${ch.webhookToken as string}`,
      payload: { text: 'from ci', sender: 'ci-bot' },
    });
    expect(custom.statusCode).toBe(202);
    const storedCustom = await store.getMessage(custom.json().messageId);
    expect(storedCustom).toMatchObject({ senderType: 'webhook', senderId: 'ci-bot' });
  });

  it('无效 token → 404 HARNESS-3004（响应不回显令牌）；body 缺 text → 400 HARNESS-1009', async () => {
    const { app } = buildServer();
    const invalid = 'definitely-not-a-token';
    const res = await app.inject({ method: 'POST', url: `/hooks/chat/${invalid}`, payload: { text: 'x' } });
    expect(res.statusCode).toBe(404);
    const json = res.json();
    expect(json.code).toBe('HARNESS-3004');
    expect(JSON.stringify(json)).not.toContain(invalid); // 令牌永不入响应

    const { service } = buildServer();
    const ch = await service.createChannel({ name: 'inbound-2' });
    const bad = await app.inject({ method: 'POST', url: `/hooks/chat/${ch.webhookToken as string}`, payload: { sender: 'x' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().code).toBe('HARNESS-1009');

    const badJson = await app.inject({
      method: 'POST',
      url: `/hooks/chat/${ch.webhookToken as string}`,
      headers: { 'content-type': 'application/json' },
      payload: '{not-json',
    });
    expect(badJson.statusCode).toBe(400);
    expect(badJson.json().code).toBe('HARNESS-1009');
  });
});
