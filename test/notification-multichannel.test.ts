/**
 * 通知多渠道管理测试（channel-store / manager 多渠道派发 / 渠道 CRUD REST 全链）。
 *
 * - store：真实 SettingsService + SQLite（settings 表惰性建表）→ 验证
 *   NotificationChannelStore CRUD（create/get/list/update/remove/enabled 过滤）、
 *   create/update 入参按 type 校验 target、脏数据容错（非数组/非法条目跳过）。
 * - manager：deps.getChannelConfigs 注入（真 store 数据源）→ 验证多渠道自动派发
 *   （2 webhook + 1 email 全部收到）、禁用渠道不投递、显式 channels 优先（不读
 *   配置/路由）、路由命中优先于渠道配置回落、路由未命中回落、配置读取失败/含
 *   非法条目容错。
 * - REST：真 fastify inject（createHttpServer 挂载 registerNotificationRoutes）+
 *   真 NotificationChannelStore → 渠道 CRUD 五端点全链（创建/列表/更新/启停切换/
 *   删除 + 404 + 400 校验 + 401/403 门禁 + 未接线 501）+ send 对象形 channels 透传
 *   channelTargets（渠道管理 UI「测试发送」契约）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Knex } from 'knex';

import {
  registerNotificationRoutes,
  type NotificationRoutesDeps,
  type NotificationSendInput,
} from '../src/api/notifications.js';
import { ChannelRegistry, type NotificationPayload } from '../src/kernel/channels/index.js';
import { loadConfig } from '../src/kernel/config/index.js';
import { err } from '../src/kernel/errors/HarnessError.js';
import { createHttpServer } from '../src/kernel/http/server.js';
import { HookManager } from '../src/kernel/hooks/index.js';
import { NOTIFY_CHANNEL_CONFIGS_KEY, NotificationChannelStore } from '../src/kernel/notification/channel-store.js';
import { NotificationManager } from '../src/kernel/notification/manager.js';
import { NotificationStore } from '../src/kernel/notification/store.js';
import { openSqlite } from '../src/kernel/storage/db.js';
import { SettingsService } from '../src/kernel/storage/settings.js';
import { KERNEL_MIGRATIONS } from '../src/kernel/storage/kernel-migrations.js';
import { Migrator } from '../src/kernel/storage/migrator.js';

// ---------------------------------------------------------------------------
// 公共装配（真实 SQLite + SettingsService，store 与 REST 共用同一实例）
// ---------------------------------------------------------------------------

let dir: string;
let db: Knex;
let settings: SettingsService;
let channelStore: NotificationChannelStore;
let notifyStore: NotificationStore;

const ADMIN_TOKEN = 'token-admin';
const ROOT_TOKEN = 'token-root';
const NORMAL_TOKEN = 'token-normal';
const AUTH_ADMIN = { authorization: `Bearer ${ADMIN_TOKEN}` };
const AUTH_ROOT = { authorization: `Bearer ${ROOT_TOKEN}` };
const AUTH_NORMAL = { authorization: `Bearer ${NORMAL_TOKEN}` };

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'opptrix-multichannel-'));
  db = await openSqlite(join(dir, 'multichannel.sqlite'));
  const migrator = new Migrator(db, { migrations: KERNEL_MIGRATIONS });
  await migrator.latest();
  settings = new SettingsService(db);
  channelStore = new NotificationChannelStore(settings);
  notifyStore = new NotificationStore(db);
});

afterAll(async () => {
  await db?.destroy();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await db('notifications').del();
  await settings.delete(NOTIFY_CHANNEL_CONFIGS_KEY); // 用例间隔离
});

// ---------------------------------------------------------------------------
// NotificationChannelStore — CRUD 与容错
// ---------------------------------------------------------------------------

describe('NotificationChannelStore — CRUD', () => {
  it('create：生成 uuid / enabled 缺省 true / createdAt；list 回读一致', async () => {
    const created = await channelStore.create({
      type: 'webhook',
      name: '运维群',
      target: { url: 'https://example.test/hook', secret: 's3cret' },
    });
    expect(created.id).toMatch(/[0-9a-f-]{36}/);
    expect(created.enabled).toBe(true);
    expect(created.createdAt).toBeLessThanOrEqual(Date.now());
    expect(created.target).toEqual({ url: 'https://example.test/hook', secret: 's3cret' });

    const list = await channelStore.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual(created);
    await expect(channelStore.get(created.id)).resolves.toEqual(created);
  });

  it('create 多实例：2 webhook + 1 email 共存（同名/同类型可重复）', async () => {
    await channelStore.create({ type: 'webhook', name: 'A 群', target: { url: 'https://a.test/hook' } });
    await channelStore.create({ type: 'webhook', name: 'B 群', target: { url: 'https://b.test/hook' } });
    await channelStore.create({
      type: 'email',
      name: '运维邮箱',
      target: { smtp: { host: 'smtp.example.com' }, from: 'h@x.com', to: 'o@x.com' },
    });
    const list = await channelStore.list();
    expect(list).toHaveLength(3);
    expect(list.filter((c) => c.type === 'webhook')).toHaveLength(2);
    expect(list.filter((c) => c.type === 'email')).toHaveLength(1);
  });

  it('get 不存在的 id 返回 null', async () => {
    await expect(channelStore.get('missing-id')).resolves.toBeNull();
  });

  it('update：name/enabled/target 部分更新合并（未给字段保持原值）', async () => {
    const created = await channelStore.create({
      type: 'webhook',
      name: '旧名',
      target: { url: 'https://old.test/hook' },
    });
    const next = await channelStore.update(created.id, {
      name: '新名',
      target: { url: 'https://new.test/hook', secret: 'k' },
    });
    expect(next).toEqual({
      id: created.id,
      type: 'webhook',
      name: '新名',
      enabled: true,
      target: { url: 'https://new.test/hook', secret: 'k' },
      createdAt: created.createdAt,
    });
  });

  it('update 不存在的 id 返回 null', async () => {
    await expect(channelStore.update('missing-id', { name: 'x' })).resolves.toBeNull();
  });

  it('update target 按 type 校验：webhook 缺 url → VALIDATION_FAILED 且不落盘', async () => {
    const created = await channelStore.create({ type: 'webhook', name: 'w', target: { url: 'https://a.test' } });
    await expect(channelStore.update(created.id, { target: { secret: 'no-url' } })).rejects.toMatchObject({
      code: 'HARNESS-1009',
    });
    await expect(channelStore.get(created.id)).resolves.toMatchObject({ target: { url: 'https://a.test' } });
  });

  it('update 空 patch → VALIDATION_FAILED', async () => {
    const created = await channelStore.create({ type: 'console', name: 'c', target: {} });
    await expect(channelStore.update(created.id, {})).rejects.toMatchObject({ code: 'HARNESS-1009' });
  });

  it('启停切换（update enabled）：false → true 往返；listEnabled 只回启用渠道', async () => {
    const a = await channelStore.create({ type: 'webhook', name: '启用', target: { url: 'https://a.test' } });
    const b = await channelStore.create({ type: 'console', name: '停用', target: {} });
    await channelStore.update(b.id, { enabled: false });

    await expect(channelStore.listEnabled().then((l) => l.map((c) => c.id))).resolves.toEqual([a.id]);

    await channelStore.update(b.id, { enabled: true });
    await channelStore.update(a.id, { enabled: false });
    await expect(channelStore.listEnabled().then((l) => l.map((c) => c.id))).resolves.toEqual([b.id]);
  });

  it('remove：删除返回 true 且 get 变 null；重复删除返回 false', async () => {
    const created = await channelStore.create({ type: 'webhook', name: '待删', target: { url: 'https://a.test' } });
    await expect(channelStore.remove(created.id)).resolves.toBe(true);
    await expect(channelStore.get(created.id)).resolves.toBeNull();
    await expect(channelStore.remove(created.id)).resolves.toBe(false);
  });

  it('create 入参校验：type 非法 / name 空白 / email 缺 from → VALIDATION_FAILED 且不落盘', async () => {
    await expect(
      channelStore.create({ type: 'slack' as never, name: 'x', target: {} }),
    ).rejects.toMatchObject({ code: 'HARNESS-1009' });
    await expect(
      channelStore.create({ type: 'webhook', name: '   ', target: { url: 'https://a.test' } }),
    ).rejects.toMatchObject({ code: 'HARNESS-1009' });
    await expect(
      channelStore.create({ type: 'email', name: 'x', target: { smtp: { host: 's' }, to: 'o@x.com' } }),
    ).rejects.toMatchObject({ code: 'HARNESS-1009' });
    await expect(channelStore.list()).resolves.toEqual([]);
  });

  it('脏数据容错：settings 值非数组视为空；数组内非法条目逐条跳过', async () => {
    await settings.set(NOTIFY_CHANNEL_CONFIGS_KEY, 'not-an-array');
    await expect(channelStore.list()).resolves.toEqual([]);

    const valid = await channelStore.create({ type: 'webhook', name: 'ok', target: { url: 'https://a.test' } });
    await settings.set(NOTIFY_CHANNEL_CONFIGS_KEY, [
      valid,
      { id: 'bad', type: 'nope' }, // 缺 name/enabled/target + type 非法
      { id: 'bad-2', type: 'webhook', name: 'x', enabled: true, target: {}, createdAt: 'NaN' }, // createdAt 非法
    ]);
    const list = await channelStore.list();
    expect(list.map((c) => c.id)).toEqual([valid.id]);
  });
});

// ---------------------------------------------------------------------------
// NotificationManager — 多渠道自动派发
// ---------------------------------------------------------------------------

/** 构造 manager + 全套可观测替身；getChannelConfigs 缺省接真 store.list() */
function makeManager(overrides: Partial<import('../src/kernel/notification/manager.js').NotificationManagerDeps> = {}) {
  const registry = new ChannelRegistry();
  const hooks = new HookManager();
  const publish = vi.fn();
  const logger = pino({ level: 'silent' });
  const manager = new NotificationManager({
    store: notifyStore,
    registry,
    hooks,
    publish,
    logger,
    ...overrides,
  });
  return { manager, registry, hooks, publish, logger };
}

/** 注册按名记录 target 的桩驱动，返回其 deliver spy */
function registerSpyDriver(registry: ChannelRegistry, name: string): ReturnType<typeof vi.fn> {
  const deliver = vi.fn(async (_payload: NotificationPayload, _target: unknown) => {});
  registry.registerNotificationDriver({ name, deliver });
  return deliver;
}

/** 播种 2 webhook + 1 email 渠道实例，返回 [webhookA, webhookB, email] */
async function seedThreeChannels(): Promise<[string, string, string]> {
  const a = await channelStore.create({ type: 'webhook', name: 'A 群', target: { url: 'https://a.test/hook' } });
  const b = await channelStore.create({ type: 'webhook', name: 'B 群', target: { url: 'https://b.test/hook', secret: 'k' } });
  const c = await channelStore.create({
    type: 'email',
    name: '运维邮箱',
    target: { smtp: { host: 'smtp.example.com' }, from: 'h@x.com', to: 'o@x.com' },
  });
  return [a.id, b.id, c.id];
}

describe('NotificationManager — 多渠道自动派发', () => {
  it('未显式传 channels 且无路由：全部启用渠道（2 webhook + 1 email）各收到一次，driver=type target=配置原值', async () => {
    await seedThreeChannels();
    const { manager, registry } = makeManager({ getChannelConfigs: () => channelStore.list() });
    const webhookDeliver = registerSpyDriver(registry, 'webhook');
    const emailDeliver = registerSpyDriver(registry, 'email');

    const rec = await manager.send({ title: '全渠道广播' });

    expect(webhookDeliver).toHaveBeenCalledTimes(2);
    expect(emailDeliver).toHaveBeenCalledTimes(1);
    const targets = webhookDeliver.mock.calls.map((call) => call[1]);
    expect(targets).toEqual([{ url: 'https://a.test/hook' }, { url: 'https://b.test/hook', secret: 'k' }]);
    // 投递计划随记录落库（secret 脱敏）
    const plan = (await notifyStore.get(rec.id))?.channels as Array<{ driver: string; target: Record<string, unknown> }>;
    expect(plan).toHaveLength(3);
    expect(plan.map((p) => p.driver)).toEqual(['webhook', 'webhook', 'email']);
    expect(plan[1]?.target.secret).toBe('***');
  });

  it('禁用渠道不投递：3 渠道停用 1 个 → 只投 2 个，启用渠道照常', async () => {
    const [, bId] = await seedThreeChannels();
    await channelStore.update(bId, { enabled: false });
    const { manager, registry } = makeManager({ getChannelConfigs: () => channelStore.list() });
    const webhookDeliver = registerSpyDriver(registry, 'webhook');
    const emailDeliver = registerSpyDriver(registry, 'email');

    await manager.send({ title: '部分禁用' });

    expect(webhookDeliver).toHaveBeenCalledTimes(1);
    expect(webhookDeliver.mock.calls[0]?.[1]).toEqual({ url: 'https://a.test/hook' });
    expect(emailDeliver).toHaveBeenCalledTimes(1);
  });

  it('全部渠道禁用：空计划 → 只入库 + created 事件，不发布 delivered', async () => {
    await seedThreeChannels();
    const list = await channelStore.list();
    for (const c of list) await channelStore.update(c.id, { enabled: false });
    const { manager, registry, publish } = makeManager({ getChannelConfigs: () => channelStore.list() });
    registerSpyDriver(registry, 'webhook');
    registerSpyDriver(registry, 'email');

    const rec = await manager.send({ title: '全禁用' });

    expect(rec.channels).toEqual([]);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith('notifications', 'notification.created', expect.objectContaining({ id: rec.id }));
  });

  it('显式传入 channels 优先：getChannelConfigs 与 getRoutes 均不被调用', async () => {
    await seedThreeChannels();
    const getChannelConfigs = vi.fn(() => channelStore.list());
    const getRoutes = vi.fn(async () => [{ match: {}, channels: [{ driver: 'webhook', target: { kind: 'routed' } }] }]);
    const { manager, registry } = makeManager({ getChannelConfigs, getRoutes });
    const deliver = registerSpyDriver(registry, 'webhook');

    await manager.send({ title: '显式优先', channels: [{ driver: 'webhook', target: { kind: 'explicit' } }] });

    expect(getChannelConfigs).not.toHaveBeenCalled();
    expect(getRoutes).not.toHaveBeenCalled();
    expect(deliver).toHaveBeenCalledTimes(1);
    expect((deliver.mock.calls[0]?.[1] as { kind: string }).kind).toBe('explicit');
  });

  it('路由规则命中非空时优先于渠道配置回落（不投渠道实例）', async () => {
    await seedThreeChannels();
    const getChannelConfigs = vi.fn(() => channelStore.list());
    const { manager, registry } = makeManager({
      getChannelConfigs,
      getRoutes: async () => [{ match: {}, channels: [{ driver: 'webhook', target: { kind: 'routed' } }] }],
    });
    const deliver = registerSpyDriver(registry, 'webhook');
    registerSpyDriver(registry, 'email');

    await manager.send({ title: '路由优先' });

    expect(getChannelConfigs).not.toHaveBeenCalled();
    expect(deliver).toHaveBeenCalledTimes(1);
    expect((deliver.mock.calls[0]?.[1] as { kind: string }).kind).toBe('routed');
  });

  it('路由规则未命中（level 不匹配）→ 回落到全部启用渠道', async () => {
    await seedThreeChannels();
    const { manager, registry } = makeManager({
      getChannelConfigs: () => channelStore.list(),
      getRoutes: async () => [{ match: { level: 'error' }, channels: [{ driver: 'webhook', target: { kind: 'error-only' } }] }],
    });
    const webhookDeliver = registerSpyDriver(registry, 'webhook');
    const emailDeliver = registerSpyDriver(registry, 'email');

    await manager.send({ title: 'info 落到渠道实例', level: 'info' });

    expect(webhookDeliver).toHaveBeenCalledTimes(2);
    expect(emailDeliver).toHaveBeenCalledTimes(1);
  });

  it('getChannelConfigs 读取失败：warn + 空计划（通知照常入库，不抛）', async () => {
    const logger = pino({ level: 'silent' });
    const warnSpy = vi.spyOn(logger, 'warn');
    const { manager, publish } = makeManager({
      getChannelConfigs: async () => {
        throw new Error('settings unavailable');
      },
      logger,
    });

    const rec = await manager.send({ title: '配置读取失败' });

    expect(rec.channels).toEqual([]);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('getChannelConfigs 返回含非法条目：非法跳过并 warn，合法渠道照常投递', async () => {
    const logger = pino({ level: 'silent' });
    const warnSpy = vi.spyOn(logger, 'warn');
    const { manager, registry } = makeManager({
      getChannelConfigs: async () => [
        { id: 'ok', type: 'webhook', name: 'ok', enabled: true, target: { url: 'https://a.test' }, createdAt: 1 },
        { id: 'bad', type: 'nope', name: 'bad', enabled: true, target: {}, createdAt: 1 },
      ] as never,
      logger,
    });
    const deliver = registerSpyDriver(registry, 'webhook');

    await manager.send({ title: '非法条目容错' });

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0]?.[1]).toEqual({ url: 'https://a.test' });
    expect(warnSpy).toHaveBeenCalled();
  });

  it('未注入 getChannelConfigs：行为与既有语义一致（空计划只入库）', async () => {
    const { manager, publish } = makeManager();
    const rec = await manager.send({ title: '无渠道依赖' });
    expect(rec.channels).toEqual([]);
    expect(publish).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 渠道 CRUD REST — 真 fastify inject + 真 NotificationChannelStore
// ---------------------------------------------------------------------------

interface BuildCtx {
  app: FastifyInstance;
  sendInputs: NotificationSendInput[];
  channelStore: NotificationChannelStore;
}

/** 组装被测服务器：stub checker + 真 store/SettingsService；withChannelStore=false 模拟未接线 */
function buildServer(opts: { withChannelStore?: boolean } = {}): BuildCtx {
  const sendInputs: NotificationSendInput[] = [];
  const store = new NotificationChannelStore(settings);
  const config = loadConfig({ NODE_ENV: 'test', HARNESS_LOG_LEVEL: 'error', HARNESS_DATA_DIR: './data' });
  const { app } = createHttpServer({
    config,
    logger: pino({ level: 'silent' }),
    isReady: () => true,
    state: () => 'ready',
    registerExtra: (a) => {
      const deps: NotificationRoutesDeps = {
        checker: async ({ token }) => {
          if (token === ADMIN_TOKEN) return { userId: 'admin-1', role: 'admin', scopes: ['notifications'] };
          if (token === ROOT_TOKEN) return { userId: 'root', role: 'root', scopes: ['*'] };
          if (token === NORMAL_TOKEN) return { userId: 'user-1', role: 'normal', scopes: [] };
          throw err('UNAUTHORIZED', { detail: 'token rejected by all auth providers' });
        },
        store: notifyStore,
        getRoutes: async () => [],
        setRoutes: async () => {},
        drivers: () => ({ notification: ['webhook', 'email', 'inbox', 'console'], chat: [] }),
        send: async (input) => {
          sendInputs.push(input);
          return { id: 'ntf-new' };
        },
        ...(opts.withChannelStore === false ? {} : { channelStore: store }),
      };
      registerNotificationRoutes(a, deps);
    },
  });
  return { app, sendInputs, channelStore: store };
}

describe('渠道 CRUD REST — 创建与列表', () => {
  it('POST /channels（webhook）→ 201 配置；GET /channels/list 含该渠道', async () => {
    const { app } = buildServer();
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/notifications/channels',
      headers: AUTH_ADMIN,
      payload: { type: 'webhook', name: '运维群', target: { url: 'https://a.test/hook', secret: 'k' } },
    });
    expect(created.statusCode).toBe(201);
    const config = created.json();
    expect(config).toMatchObject({ type: 'webhook', name: '运维群', enabled: true });
    expect(config.target).toEqual({ url: 'https://a.test/hook', secret: 'k' });

    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/notifications/channels/list',
      headers: AUTH_ROOT,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().items).toHaveLength(1);
    expect(list.json().items[0]).toMatchObject({ id: config.id, name: '运维群', enabled: true });
  });

  it('POST /channels 缺省 target（console）→ 201 target={}；email 全字段合法创建', async () => {
    const { app } = buildServer();
    const consoleRes = await app.inject({
      method: 'POST',
      url: '/api/v1/notifications/channels',
      headers: AUTH_ADMIN,
      payload: { type: 'console', name: '控制台' },
    });
    expect(consoleRes.statusCode).toBe(201);
    expect(consoleRes.json().target).toEqual({});

    const emailRes = await app.inject({
      method: 'POST',
      url: '/api/v1/notifications/channels',
      headers: AUTH_ADMIN,
      payload: {
        type: 'email',
        name: '告警邮箱',
        target: { smtp: { host: 'smtp.example.com', port: 465, secure: true }, from: 'h@x.com', to: ['a@x.com', 'b@x.com'] },
      },
    });
    expect(emailRes.statusCode).toBe(201);
    expect(emailRes.json().target.smtp).toMatchObject({ host: 'smtp.example.com', port: 465, secure: true });
  });

  it.each([
    ['type 非法', { type: 'slack', name: 'x' }],
    ['缺 name', { type: 'webhook' }],
    ['name 空白', { type: 'webhook', name: '  ' }],
    ['webhook target 缺 url', { type: 'webhook', name: 'x', target: { secret: 'k' } }],
    ['email target 缺 from', { type: 'email', name: 'x', target: { smtp: { host: 's' }, to: 'o@x.com' } }],
  ])('POST /channels 非法（%s）→ 400 HARNESS-1009 且不落盘', async (_label, body) => {
    const { app, channelStore } = buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/notifications/channels',
      headers: AUTH_ADMIN,
      payload: body,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('HARNESS-1009');
    expect(await channelStore.list()).toEqual([]);
  });
});

describe('渠道 CRUD REST — 更新与启停', () => {
  it('PUT /channels/:id → 200 更新后配置；GET list 反映新值', async () => {
    const { app } = buildServer();
    const created = await channelStore.create({ type: 'webhook', name: '旧', target: { url: 'https://old.test' } });
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/notifications/channels/${created.id}`,
      headers: AUTH_ADMIN,
      payload: { name: '新', target: { url: 'https://new.test' }, enabled: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: created.id, name: '新', enabled: false, target: { url: 'https://new.test' } });
  });

  it('PUT 不存在的 id → 404 HARNESS-3004；PUT 全空 body → 400', async () => {
    const { app } = buildServer();
    const missing = await app.inject({
      method: 'PUT',
      url: '/api/v1/notifications/channels/ghost',
      headers: AUTH_ADMIN,
      payload: { name: 'x' },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().code).toBe('HARNESS-3004');

    const created = await channelStore.create({ type: 'webhook', name: 'w', target: { url: 'https://a.test' } });
    const empty = await app.inject({
      method: 'PUT',
      url: `/api/v1/notifications/channels/${created.id}`,
      headers: AUTH_ADMIN,
      payload: {},
    });
    expect(empty.statusCode).toBe(400);
    expect(empty.json().code).toBe('HARNESS-1009');
  });

  it('PATCH /:id/toggle 无 body → 取反；显式 {enabled:true} → 置 true；不存在 → 404', async () => {
    const { app } = buildServer();
    const created = await channelStore.create({ type: 'webhook', name: 'w', target: { url: 'https://a.test' } });

    const off = await app.inject({
      method: 'PATCH',
      url: `/api/v1/notifications/channels/${created.id}/toggle`,
      headers: AUTH_ADMIN,
    });
    expect(off.statusCode).toBe(200);
    expect(off.json().enabled).toBe(false);

    const on = await app.inject({
      method: 'PATCH',
      url: `/api/v1/notifications/channels/${created.id}/toggle`,
      headers: { ...AUTH_ADMIN, 'content-type': 'application/json' },
      payload: { enabled: true },
    });
    expect(on.statusCode).toBe(200);
    expect(on.json().enabled).toBe(true);

    const ghost = await app.inject({
      method: 'PATCH',
      url: '/api/v1/notifications/channels/ghost/toggle',
      headers: AUTH_ADMIN,
    });
    expect(ghost.statusCode).toBe(404);
  });
});

describe('渠道 CRUD REST — 删除与门禁', () => {
  it('DELETE /:id → {ok:true} 且列表移除；重复删除 → 404', async () => {
    const { app } = buildServer();
    const created = await channelStore.create({ type: 'webhook', name: '待删', target: { url: 'https://a.test' } });
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v1/notifications/channels/${created.id}`,
      headers: AUTH_ADMIN,
    });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ ok: true });
    await expect(channelStore.get(created.id)).resolves.toBeNull();

    const again = await app.inject({
      method: 'DELETE',
      url: `/api/v1/notifications/channels/${created.id}`,
      headers: AUTH_ADMIN,
    });
    expect(again.statusCode).toBe(404);
  });

  const CRUD_ROUTES = [
    { method: 'GET', url: '/api/v1/notifications/channels/list' },
    { method: 'POST', url: '/api/v1/notifications/channels', body: { type: 'webhook', name: 'x', target: { url: 'https://a.test' } } },
    { method: 'PUT', url: '/api/v1/notifications/channels/some-id', body: { name: 'x' } },
    { method: 'DELETE', url: '/api/v1/notifications/channels/some-id' },
    { method: 'PATCH', url: '/api/v1/notifications/channels/some-id/toggle' },
  ] as const;

  it.each(CRUD_ROUTES)('$method $url 无 token → 401', async (route) => {
    const { app } = buildServer();
    const res = await app.inject({
      method: route.method,
      url: route.url,
      ...('body' in route ? { payload: route.body } : {}),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('HARNESS-1006');
  });

  it.each(CRUD_ROUTES)('$method $url normal 角色 → 403（target 含凭据，读也需 admin）', async (route) => {
    const { app } = buildServer();
    const res = await app.inject({
      method: route.method,
      url: route.url,
      headers: AUTH_NORMAL,
      ...('body' in route ? { payload: route.body } : {}),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('HARNESS-1007');
  });

  it('未注入 channelStore → 渠道 CRUD 返回 501 HARNESS-9004', async () => {
    const { app } = buildServer({ withChannelStore: false });
    const list = await app.inject({ method: 'GET', url: '/api/v1/notifications/channels/list', headers: AUTH_ADMIN });
    expect(list.statusCode).toBe(501);
    expect(list.json().code).toBe('HARNESS-9004');
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/notifications/channels',
      headers: AUTH_ADMIN,
      payload: { type: 'webhook', name: 'x', target: { url: 'https://a.test' } },
    });
    expect(created.statusCode).toBe(501);
  });
});

describe('渠道 CRUD REST — 测试发送透传', () => {
  it('POST /send 对象形 channels → deps.send 收到 channels 驱动名 + channelTargets 同下标', async () => {
    const { app, sendInputs } = buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/notifications/send',
      headers: AUTH_ADMIN,
      payload: {
        title: '渠道测试通知（运维群）',
        channels: [{ driver: 'webhook', target: { url: 'https://a.test/hook', secret: 'k' } }],
      },
    });
    expect(res.statusCode).toBe(201);
    expect(sendInputs).toEqual([
      {
        title: '渠道测试通知（运维群）',
        body: '',
        level: 'info',
        data: null,
        channels: ['webhook'],
        channelTargets: [{ url: 'https://a.test/hook', secret: 'k' }],
      },
    ]);
  });

  it('POST /send 混合两形（字符串 + 对象）→ 字符串位 channelTargets 为 undefined', async () => {
    const { app, sendInputs } = buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/notifications/send',
      headers: AUTH_ADMIN,
      payload: {
        title: '混合',
        channels: ['inbox', { driver: 'email', target: { smtp: { host: 's' }, from: 'a@x', to: 'b@x' } }],
      },
    });
    expect(res.statusCode).toBe(201);
    expect(sendInputs[0]).toMatchObject({
      channels: ['inbox', 'email'],
      channelTargets: [undefined, { smtp: { host: 's' }, from: 'a@x', to: 'b@x' }],
    });
  });
});
