/**
 * notifications REST API 集成测试（真实 fastify 注入，经 createHttpServer 挂载
 * registerNotificationRoutes；store/checker/getRoutes/setRoutes/drivers/send 全部 stub）。
 *
 * 覆盖：无 token 401、normal 角色写操作 403 / 读操作 200、list 透传 query
 * （unread/level/limit + 缺省 limit=50）、limit 非法 400、read 命中与
 * markRead false → 404 HARNESS-3004、read-all 计数、send 两态（deps.send
 * 注入 → 201 + 规范化入参；缺省 → 501 HARNESS-9004）、send body 校验 400、
 * GET routes 透传、PUT routes 校验失败 400、drivers 清单；
 * 渠道配置 GET/PUT /channels（admin 门禁、settings 桩持久化往返、缺省合并、
 * zod 校验与未知密钥键剥离、未接线 501）、send 对象形渠道归一化。
 */
import { describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import pino from 'pino';

import {
  registerNotificationRoutes,
  NOTIFY_EMAIL_CHANNEL_KEY,
  NOTIFY_WEBHOOK_CHANNEL_KEY,
  type NotificationChannelsConfig,
  type NotificationRoutesDeps,
  type NotificationSendInput,
} from '../src/api/notifications.js';
import { loadConfig } from '../src/kernel/config/index.js';
import { err } from '../src/kernel/errors/HarnessError.js';
import { createHttpServer } from '../src/kernel/http/server.js';

const ADMIN_TOKEN = 'token-admin';
const ROOT_TOKEN = 'token-root';
const NORMAL_TOKEN = 'token-normal';

const AUTH_ADMIN = { authorization: `Bearer ${ADMIN_TOKEN}` };
const AUTH_ROOT = { authorization: `Bearer ${ROOT_TOKEN}` };
const AUTH_NORMAL = { authorization: `Bearer ${NORMAL_TOKEN}` };

/** 全部路由（401/403 矩阵遍历；写操作附合法 body，证明门禁先于校验发生） */
const PUT_ROUTES_BODY = [
  {
    match: { level: 'error' },
    channels: [{ driver: 'email', target: { smtp: { host: 'smtp.example.com' }, from: 'h@x.com', to: 'o@x.com' } }],
  },
  { match: {}, channels: [{ driver: 'webhook', target: 'https://hooks.example.com/x' }] },
];

/** PUT /channels 合法 body（渠道凭据与目标；密码只给 secrets 引用名） */
const PUT_CHANNELS_BODY = {
  webhook: { url: 'https://hooks.example.com/opptrix', secret: 'shh' },
  email: {
    smtp: { host: 'smtp.example.com', port: 465, secure: true, user: 'ops', passSecretRef: 'smtp.pass' },
    from: 'opptrix@example.com',
    to: 'oncall@example.com',
  },
};

const ALL_ROUTES = [
  { method: 'GET', url: '/api/v1/notifications' },
  { method: 'GET', url: '/api/v1/notifications/routes' },
  { method: 'GET', url: '/api/v1/notifications/drivers' },
  { method: 'POST', url: '/api/v1/notifications/ntf-1/read' },
  { method: 'POST', url: '/api/v1/notifications/read-all' },
  { method: 'POST', url: '/api/v1/notifications/send', body: { title: 'hello' } },
  { method: 'PUT', url: '/api/v1/notifications/routes', body: PUT_ROUTES_BODY },
  { method: 'GET', url: '/api/v1/notifications/channels' },
  { method: 'PUT', url: '/api/v1/notifications/channels', body: PUT_CHANNELS_BODY },
] as const;

const WRITE_ROUTES = ALL_ROUTES.slice(3);

const SEED_ROWS: Record<string, unknown>[] = [
  { id: 'ntf-1', level: 'error', title: 'disk almost full', read_at: null },
  { id: 'ntf-2', level: 'info', title: 'deploy ok', read_at: 123 },
];

// ---------------------------------------------------------------------------
// 依赖 stub
// ---------------------------------------------------------------------------

/** NotificationStore 契约别名（store 依赖的结构形状） */
type NotificationStoreLike = NotificationRoutesDeps['store'];

/** NotificationStore 契约的内存 stub（记录全部调用，可断言透传参数） */
class StoreStub implements NotificationStoreLike {
  readonly listOpts: Array<{ unreadOnly?: boolean; level?: string; limit?: number }> = [];
  readonly markReadIds: string[] = [];
  readonly created: Record<string, unknown>[] = [];
  markAllReadCalls = 0;
  unreadCountCalls = 0;

  constructor(private rows: Record<string, unknown>[] = SEED_ROWS) {}

  async list(opts: { unreadOnly?: boolean; level?: string; limit?: number } = {}): Promise<Record<string, unknown>[]> {
    this.listOpts.push(opts);
    let out = this.rows;
    if (opts.unreadOnly === true) out = out.filter((r) => r.read_at === null);
    if (opts.level !== undefined) out = out.filter((r) => r.level === opts.level);
    return out.slice(0, opts.limit ?? out.length);
  }

  async markRead(id: string): Promise<boolean> {
    this.markReadIds.push(id);
    return this.rows.some((r) => r.id === id);
  }

  async markAllRead(): Promise<number> {
    this.markAllReadCalls += 1;
    return 7;
  }

  async unreadCount(): Promise<number> {
    this.unreadCountCalls += 1;
    return 3;
  }

  async create(rec: Record<string, unknown>): Promise<void> {
    this.created.push(rec);
  }
}

interface BuildCtx {
  app: FastifyInstance;
  store: StoreStub;
  setRoutesInputs: unknown[];
  sendInputs: NotificationSendInput[];
  /** settings 桩（notify.channels.* 持久化落点） */
  settings: SettingsStub;
  /** PUT /channels 透传给 deps.setChannels 的归一化值 */
  setChannelsInputs: NotificationChannelsConfig[];
}

/** settings 桩（与 SettingsService 的 get/set 契约一致的最小内存实现） */
class SettingsStub {
  readonly map = new Map<string, unknown>();

  async get<T>(key: string, fallback?: T): Promise<T | undefined> {
    return this.map.has(key) ? (this.map.get(key) as T) : fallback;
  }

  async set(key: string, value: unknown): Promise<void> {
    this.map.set(key, value);
  }
}

/** 组装被测服务器：stub checker + stub store + 可断言的 routes/channels/send 透传层 */
function buildServer(opts: { withSend?: boolean; withChannels?: boolean } = {}): BuildCtx {
  const store = new StoreStub();
  const settings = new SettingsStub();
  const setRoutesInputs: unknown[] = [];
  const sendInputs: NotificationSendInput[] = [];
  const setChannelsInputs: NotificationChannelsConfig[] = [];
  const sendSpy = vi.fn(async (input: NotificationSendInput) => ({ id: 'ntf-new', ...input }));
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
        store,
        getRoutes: async () => [{ match: {}, channels: [{ driver: 'ui', target: null }] }],
        setRoutes: async (rules) => {
          setRoutesInputs.push(rules);
        },
        drivers: () => ({ notification: ['ui', 'email'], chat: ['slack'] }),
        ...(opts.withChannels === false
          ? {}
          : {
              getChannels: async () => ({
                webhook: (await settings.get(NOTIFY_WEBHOOK_CHANNEL_KEY)) ?? null,
                email: (await settings.get(NOTIFY_EMAIL_CHANNEL_KEY)) ?? null,
              }),
              setChannels: async (next: NotificationChannelsConfig) => {
                setChannelsInputs.push(next);
                await settings.set(NOTIFY_WEBHOOK_CHANNEL_KEY, next.webhook);
                await settings.set(NOTIFY_EMAIL_CHANNEL_KEY, next.email);
              },
            }),
        ...(opts.withSend === false ? {} : { send: async (input) => { sendInputs.push(input); return sendSpy(input); } }),
      };
      registerNotificationRoutes(a, deps);
    },
  });
  return { app, store, setRoutesInputs, sendInputs, settings, setChannelsInputs };
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

describe('notifications api — 鉴权与角色门禁', () => {
  it.each(ALL_ROUTES)('$method $url 无 token → 401 HARNESS-1006', async (route) => {
    const { app } = buildServer();
    const res = await app.inject({
      method: route.method,
      url: route.url,
      ...('body' in route ? { payload: route.body } : {}),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'HARNESS-1006', retryable: false });
  });

  it.each(WRITE_ROUTES)('$method $url normal 角色 → 403 HARNESS-1007', async (route) => {
    const { app } = buildServer();
    const res = await app.inject({
      method: route.method,
      url: route.url,
      headers: AUTH_NORMAL,
      ...('body' in route ? { payload: route.body } : {}),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('HARNESS-1007');
    expect(res.json().message).toContain('admin or root');
  });

  it.each([
    ['GET /api/v1/notifications', { method: 'GET', url: '/api/v1/notifications' }],
    ['GET /routes', { method: 'GET', url: '/api/v1/notifications/routes' }],
    ['GET /drivers', { method: 'GET', url: '/api/v1/notifications/drivers' }],
  ] as const)('%s normal 角色（读操作）→ 200', async (_label, route) => {
    const { app } = buildServer();
    const res = await app.inject({ method: route.method, url: route.url, headers: AUTH_NORMAL });
    expect(res.statusCode).toBe(200);
  });

  it('root 放行；?token= 亦可认证', async () => {
    const { app } = buildServer();
    const viaHeader = await app.inject({ method: 'GET', url: '/api/v1/notifications', headers: AUTH_ROOT });
    expect(viaHeader.statusCode).toBe(200);
    const viaQuery = await app.inject({ method: 'GET', url: `/api/v1/notifications?token=${ADMIN_TOKEN}` });
    expect(viaQuery.statusCode).toBe(200);
  });
});

describe('notifications api — GET /api/v1/notifications（列表）', () => {
  it('?unread=1&level=error&limit=5 透传给 store.list；响应 {items, unread}', async () => {
    const { app, store } = buildServer();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/notifications?unread=1&level=error&limit=5',
      headers: AUTH_ADMIN,
    });
    expect(res.statusCode).toBe(200);
    expect(store.listOpts).toEqual([{ unreadOnly: true, level: 'error', limit: 5 }]);
    const body = res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ id: 'ntf-1', level: 'error' });
    expect(body.unread).toBe(3);
    expect(store.unreadCountCalls).toBe(1);
  });

  it('无查询参数时缺省 limit=50 且不透传 unread/level；unread=0 视为不过滤', async () => {
    const { app, store } = buildServer();
    await app.inject({ method: 'GET', url: '/api/v1/notifications', headers: AUTH_ADMIN });
    await app.inject({ method: 'GET', url: '/api/v1/notifications?unread=0', headers: AUTH_ADMIN });
    expect(store.listOpts).toEqual([{ limit: 50 }, { limit: 50 }]);
  });

  it('limit 非法（0/501/abc）→ 400 HARNESS-1009，且不透传', async () => {
    const { app, store } = buildServer();
    for (const bad of ['0', '501', 'abc']) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/notifications?limit=${bad}`,
        headers: AUTH_ADMIN,
      });
      expect(res.statusCode, `limit=${bad} 应为 400`).toBe(400);
      expect(res.json().code).toBe('HARNESS-1009');
    }
    expect(store.listOpts).toEqual([]);
  });
});

describe('notifications api — 已读标记', () => {
  it('POST /:id/read 命中 → {ok:true}，store.markRead 收到 id', async () => {
    const { app, store } = buildServer();
    const res = await app.inject({ method: 'POST', url: '/api/v1/notifications/ntf-1/read', headers: AUTH_ADMIN });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(store.markReadIds).toEqual(['ntf-1']);
  });

  it('POST /:id/read 不存在（markRead false）→ 404 HARNESS-3004', async () => {
    const { app, store } = buildServer();
    const res = await app.inject({ method: 'POST', url: '/api/v1/notifications/ghost/read', headers: AUTH_ADMIN });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'HARNESS-3004', retryable: false });
    expect(store.markReadIds).toEqual(['ghost']);
  });

  it('POST /read-all → {updated:7}（store.markAllRead 的返回值）', async () => {
    const { app, store } = buildServer();
    const res = await app.inject({ method: 'POST', url: '/api/v1/notifications/read-all', headers: AUTH_ADMIN });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ updated: 7 });
    expect(store.markAllReadCalls).toBe(1);
  });
});

describe('notifications api — POST /send（两态）', () => {
  it('注入 deps.send：201 返回记录，入参缺省补齐（body ""、level info、data null、channels []）', async () => {
    const { app, sendInputs } = buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/notifications/send',
      headers: AUTH_ADMIN,
      payload: { title: 'Backup finished' },
    });
    expect(res.statusCode).toBe(201);
    expect(sendInputs).toEqual([
      { title: 'Backup finished', body: '', level: 'info', data: null, channels: [] },
    ]);
    expect(res.json()).toMatchObject({ id: 'ntf-new', title: 'Backup finished', level: 'info' });
  });

  it('注入 deps.send：全量字段原样透传', async () => {
    const { app, sendInputs } = buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/notifications/send',
      headers: AUTH_ADMIN,
      payload: { title: 'disk', body: '85%', level: 'warn', data: { used: 0.85 }, channels: ['ui', 'email'] },
    });
    expect(res.statusCode).toBe(201);
    expect(sendInputs[0]).toEqual({ title: 'disk', body: '85%', level: 'warn', data: { used: 0.85 }, channels: ['ui', 'email'] });
  });

  it('未注入 deps.send → 501 HARNESS-9004 NOT_IMPLEMENTED', async () => {
    const { app, store } = buildServer({ withSend: false });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/notifications/send',
      headers: AUTH_ADMIN,
      payload: { title: 'hello' },
    });
    expect(res.statusCode).toBe(501);
    expect(res.json().code).toBe('HARNESS-9004');
    expect(store.created).toEqual([]); // 未落任何记录
  });

  it('body 非法（title 缺失 / title 空串 / channels 非数组）→ 400 HARNESS-1009 且不调 deps.send', async () => {
    const { app, sendInputs } = buildServer();
    for (const bad of [{}, { title: '' }, { title: 'x', channels: 'ui' }]) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/notifications/send',
        headers: AUTH_ADMIN,
        payload: bad,
      });
      expect(res.statusCode, `body=${JSON.stringify(bad)} 应为 400`).toBe(400);
      expect(res.json().code).toBe('HARNESS-1009');
    }
    expect(sendInputs).toEqual([]);
  });

  it('body 非法 JSON → 400 HARNESS-1009', async () => {
    const { app } = buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/notifications/send',
      headers: { ...AUTH_ADMIN, 'content-type': 'application/json' },
      payload: '{"title": not-json',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('HARNESS-1009');
  });
});

describe('notifications api — 路由规则与驱动清单', () => {
  it('GET /routes 透传 getRoutes() 结果', async () => {
    const { app } = buildServer();
    const res = await app.inject({ method: 'GET', url: '/api/v1/notifications/routes', headers: AUTH_NORMAL });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([{ match: {}, channels: [{ driver: 'ui', target: null }] }]);
  });

  it('PUT /routes 合法规则 → {ok:true}，setRoutes 收到解析后的数组', async () => {
    const { app, setRoutesInputs } = buildServer();
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/notifications/routes',
      headers: AUTH_ADMIN,
      payload: PUT_ROUTES_BODY,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(setRoutesInputs).toEqual([PUT_ROUTES_BODY]);
  });

  it.each([
    ['channels 为空数组', [{ match: {}, channels: [] }]],
    ['缺 channels', [{ match: {} }]],
    ['缺 match', [{ channels: [{ driver: 'email', target: null }] }]],
    ['非数组 body', { match: {}, channels: [] }],
    ['channel 缺 driver', [{ match: {}, channels: [{ target: null }] }]],
  ])('PUT /routes 非法（%s）→ 400 HARNESS-1009 且不落 setRoutes', async (_label, body) => {
    const { app, setRoutesInputs } = buildServer();
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/notifications/routes',
      headers: AUTH_ADMIN,
      payload: body,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('HARNESS-1009');
    expect(setRoutesInputs).toEqual([]);
  });

  it('GET /drivers 返回 {notification, chat} 清单', async () => {
    const { app } = buildServer();
    const res = await app.inject({ method: 'GET', url: '/api/v1/notifications/drivers', headers: AUTH_ADMIN });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ notification: ['ui', 'email'], chat: ['slack'] });
  });
});

// ---------------------------------------------------------------------------
// 渠道凭据与目标（GET/PUT /api/v1/notifications/channels；settings 桩持久化）
// ---------------------------------------------------------------------------

describe('notifications api — GET/PUT /api/v1/notifications/channels（渠道配置）', () => {
  it('GET 未配置（settings 空）→ 合并缺省的完整形状（webhook/email 全字段，端口 587）', async () => {
    const { app } = buildServer();
    const res = await app.inject({ method: 'GET', url: '/api/v1/notifications/channels', headers: AUTH_ADMIN });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      webhook: { url: '', secret: '' },
      email: {
        smtp: { host: '', port: 587, secure: false, user: '', passSecretRef: '' },
        from: '',
        to: '',
      },
    });
  });

  it('PUT 合法 body → {ok:true}，settings 两键持久化；GET 回读一致（持久化往返）', async () => {
    const { app, settings, setChannelsInputs } = buildServer();
    const put = await app.inject({
      method: 'PUT',
      url: '/api/v1/notifications/channels',
      headers: AUTH_ADMIN,
      payload: PUT_CHANNELS_BODY,
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ ok: true });
    // setChannels 收到归一化形状，settings 两键各落一份
    expect(setChannelsInputs).toHaveLength(1);
    expect(settings.map.get(NOTIFY_WEBHOOK_CHANNEL_KEY)).toEqual(PUT_CHANNELS_BODY.webhook);
    expect(settings.map.get(NOTIFY_EMAIL_CHANNEL_KEY)).toEqual(PUT_CHANNELS_BODY.email);

    // GET 回读 = 保存值（passSecretRef 只回引用名，无任何明文密码字段）
    const get = await app.inject({ method: 'GET', url: '/api/v1/notifications/channels', headers: AUTH_ADMIN });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toEqual(PUT_CHANNELS_BODY);
    expect(get.json().email.smtp.passSecretRef).toBe('smtp.pass');
    expect(get.json().email.smtp).not.toHaveProperty('pass');
    expect(get.json().email.smtp).not.toHaveProperty('password');
  });

  it('PUT 部分 body（只给 webhook）→ email 落缺省形状；GET 合并返回', async () => {
    const { app, settings } = buildServer();
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/notifications/channels',
      headers: AUTH_ADMIN,
      payload: { webhook: { url: 'https://hooks.example.com/x' } },
    });
    expect(res.statusCode).toBe(200);
    expect(settings.map.get(NOTIFY_WEBHOOK_CHANNEL_KEY)).toEqual({ url: 'https://hooks.example.com/x', secret: '' });
    expect(settings.map.get(NOTIFY_EMAIL_CHANNEL_KEY)).toEqual({
      smtp: { host: '', port: 587, secure: false, user: '', passSecretRef: '' },
      from: '',
      to: '',
    });
  });

  it('PUT 非法（url 非法 / port 越界 / secure 非布尔 / 非对象 body）→ 400 且不落 setChannels/settings', async () => {
    for (const [label, body] of [
      ['url 非法', { webhook: { url: 'not-a-url' } }],
      ['port 越界', { email: { smtp: { host: 'h', port: 70000 } } }],
      ['port 非数字', { email: { smtp: { host: 'h', port: 'smtp' } } }],
      ['secure 非布尔', { email: { smtp: { host: 'h', secure: 'yes' } } }],
      ['顶层数组', [1, 2]],
    ] as const) {
      const { app, setChannelsInputs, settings } = buildServer();
      const res = await app.inject({
        method: 'PUT',
        url: '/api/v1/notifications/channels',
        headers: AUTH_ADMIN,
        payload: body as unknown as Record<string, unknown>,
      });
      expect(res.statusCode, `${label} 应为 400`).toBe(400);
      expect(res.json().code).toBe('HARNESS-1009');
      expect(setChannelsInputs, label).toEqual([]);
      expect(settings.map.size, label).toBe(0);
    }
  });

  it('PUT 未知键剥离：smtp 里的 pass/password 明文不入 settings（白名单字段）', async () => {
    const { app, settings, setChannelsInputs } = buildServer();
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/notifications/channels',
      headers: AUTH_ADMIN,
      payload: {
        webhook: { url: 'https://hooks.example.com/x', secret: 's', apiKey: 'nope' },
        email: {
          smtp: { host: 'smtp.example.com', pass: 'plaintext', password: 'plaintext2', passSecretRef: 'smtp.pass' },
          from: 'a@b.c',
          to: 'd@e.f',
          cc: 'sneak@x.y',
        },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(settings.map.get(NOTIFY_WEBHOOK_CHANNEL_KEY)).toEqual({ url: 'https://hooks.example.com/x', secret: 's' });
    expect(settings.map.get(NOTIFY_EMAIL_CHANNEL_KEY)).toEqual({
      smtp: { host: 'smtp.example.com', port: 587, secure: false, user: '', passSecretRef: 'smtp.pass' },
      from: 'a@b.c',
      to: 'd@e.f',
    });
    const serialized = JSON.stringify([...settings.map.values()]);
    expect(serialized).not.toContain('plaintext');
    expect(setChannelsInputs[0]).toBeDefined();
  });

  it('GET/PUT 门禁：无 token → 401；normal 角色读与写 → 403（渠道配置含凭据，读也要求 admin）', async () => {
    const { app } = buildServer();
    const getNoToken = await app.inject({ method: 'GET', url: '/api/v1/notifications/channels' });
    expect(getNoToken.statusCode).toBe(401);
    const getNormal = await app.inject({ method: 'GET', url: '/api/v1/notifications/channels', headers: AUTH_NORMAL });
    expect(getNormal.statusCode).toBe(403);
    expect(getNormal.json().code).toBe('HARNESS-1007');
    const putNormal = await app.inject({
      method: 'PUT',
      url: '/api/v1/notifications/channels',
      headers: AUTH_NORMAL,
      payload: PUT_CHANNELS_BODY,
    });
    expect(putNormal.statusCode).toBe(403);
    // root 放行
    const getRoot = await app.inject({ method: 'GET', url: '/api/v1/notifications/channels', headers: AUTH_ROOT });
    expect(getRoot.statusCode).toBe(200);
  });

  it('未接线（getChannels/setChannels 缺省）→ 501 HARNESS-9004', async () => {
    const { app } = buildServer({ withChannels: false });
    const get = await app.inject({ method: 'GET', url: '/api/v1/notifications/channels', headers: AUTH_ADMIN });
    expect(get.statusCode).toBe(501);
    expect(get.json().code).toBe('HARNESS-9004');
    const put = await app.inject({
      method: 'PUT',
      url: '/api/v1/notifications/channels',
      headers: AUTH_ADMIN,
      payload: PUT_CHANNELS_BODY,
    });
    expect(put.statusCode).toBe(501);
    expect(put.json().code).toBe('HARNESS-9004');
  });

  it('GET 形状容错：settings 存脏数据（非对象/数组）→ 按未配置合并缺省，不抛', async () => {
    const { app, settings } = buildServer();
    settings.map.set(NOTIFY_WEBHOOK_CHANNEL_KEY, ['garbage']);
    settings.map.set(NOTIFY_EMAIL_CHANNEL_KEY, 'garbage');
    const res = await app.inject({ method: 'GET', url: '/api/v1/notifications/channels', headers: AUTH_ADMIN });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      webhook: { url: '', secret: '' },
      email: {
        smtp: { host: '', port: 587, secure: false, user: '', passSecretRef: '' },
        from: '',
        to: '',
      },
    });
  });
});

// ---------------------------------------------------------------------------
// POST /send 的对象形渠道（渠道配置 UI「测试发送」：target 携带当前表单值）
// ---------------------------------------------------------------------------

describe('notifications api — POST /send 对象形渠道归一化', () => {
  it('对象形 channels → 201，deps.send 收到 channels 驱动名 + 同下标 channelTargets', async () => {
    const { app, sendInputs } = buildServer();
    const target = { url: 'https://hooks.example.com/x', secret: 'shh' };
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/notifications/send',
      headers: AUTH_ADMIN,
      payload: { title: '渠道测试', level: 'info', channels: [{ driver: 'webhook', target }] },
    });
    expect(res.statusCode).toBe(201);
    expect(sendInputs).toEqual([
      { title: '渠道测试', body: '', level: 'info', data: null, channels: ['webhook'], channelTargets: [target] },
    ]);
  });

  it('混合形（字符串 + 对象）按同下标对齐；纯字符串形不带 channelTargets（既有形状不变）', async () => {
    const { app, sendInputs } = buildServer();
    const target = { smtp: { host: 'smtp.example.com' }, from: 'a@b.c', to: 'd@e.f' };
    await app.inject({
      method: 'POST',
      url: '/api/v1/notifications/send',
      headers: AUTH_ADMIN,
      payload: { title: '混合', channels: ['ui', { driver: 'email', target }] },
    });
    expect(sendInputs[0]).toEqual({
      title: '混合',
      body: '',
      level: 'info',
      data: null,
      channels: ['ui', 'email'],
      channelTargets: [undefined, target],
    });

    await app.inject({
      method: 'POST',
      url: '/api/v1/notifications/send',
      headers: AUTH_ADMIN,
      payload: { title: '纯字符串', channels: ['ui'] },
    });
    expect(sendInputs[1]).toEqual({ title: '纯字符串', body: '', level: 'info', data: null, channels: ['ui'] });
  });

  it('对象形渠道缺 driver → 400 HARNESS-1009 且不调 deps.send', async () => {
    const { app, sendInputs } = buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/notifications/send',
      headers: AUTH_ADMIN,
      payload: { title: 'bad', channels: [{ target: {} }] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('HARNESS-1009');
    expect(sendInputs).toEqual([]);
  });
});
