/**
 * notifications REST API 集成测试（真实 fastify 注入，经 createHttpServer 挂载
 * registerNotificationRoutes；store/checker/getRoutes/setRoutes/drivers/send 全部 stub）。
 *
 * 覆盖：无 token 401、normal 角色写操作 403 / 读操作 200、list 透传 query
 * （unread/level/limit + 缺省 limit=50）、limit 非法 400、read 命中与
 * markRead false → 404 HARNESS-3004、read-all 计数、send 两态（deps.send
 * 注入 → 201 + 规范化入参；缺省 → 501 HARNESS-9004）、send body 校验 400、
 * GET routes 透传、PUT routes 校验失败 400、drivers 清单。
 */
import { describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import pino from 'pino';

import {
  registerNotificationRoutes,
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

const ALL_ROUTES = [
  { method: 'GET', url: '/api/v1/notifications' },
  { method: 'GET', url: '/api/v1/notifications/routes' },
  { method: 'GET', url: '/api/v1/notifications/drivers' },
  { method: 'POST', url: '/api/v1/notifications/ntf-1/read' },
  { method: 'POST', url: '/api/v1/notifications/read-all' },
  { method: 'POST', url: '/api/v1/notifications/send', body: { title: 'hello' } },
  { method: 'PUT', url: '/api/v1/notifications/routes', body: PUT_ROUTES_BODY },
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
}

/** 组装被测服务器：stub checker + stub store + 可断言的 routes/send 透传层 */
function buildServer(opts: { withSend?: boolean } = {}): BuildCtx {
  const store = new StoreStub();
  const setRoutesInputs: unknown[] = [];
  const sendInputs: NotificationSendInput[] = [];
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
        ...(opts.withSend === false ? {} : { send: async (input) => { sendInputs.push(input); return sendSpy(input); } }),
      };
      registerNotificationRoutes(a, deps);
    },
  });
  return { app, store, setRoutesInputs, sendInputs };
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
