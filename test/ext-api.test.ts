/**
 * extensions REST API 集成测试（真实 fastify 注入，经 createHttpServer 挂载
 * registerExtensionRoutes；manager/registry/checker 全部 stub）。
 *
 * 覆盖：无 token 401（全路由矩阵）、normal 403 且不触达 manager、root/?token= 放行、
 * 三只读端点（list/routes/registry）透传、enable 200 且调用透传、enable 失败
 * EXT_DEPENDENCY_MISSING 409 / EXT_ACTIVATION_FAILED 500 原样状态码透传、
 * disable/reload 200、uninstall 缺省与 ?purge=1 透传、purge 非法 400、GET :id 200/404。
 */
import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import pino from 'pino';

import {
  registerExtensionRoutes,
  type ExtSummaryLike,
  type ExtensionsApiDeps,
} from '../src/api/extensions.js';
import { loadConfig } from '../src/kernel/config/index.js';
import { err, HarnessError } from '../src/kernel/errors/index.js';
import { createHttpServer } from '../src/kernel/http/server.js';

const ADMIN_TOKEN = 'token-admin';
const ROOT_TOKEN = 'token-root';
const NORMAL_TOKEN = 'token-normal';

const AUTH_ADMIN = { authorization: `Bearer ${ADMIN_TOKEN}` };
const AUTH_ROOT = { authorization: `Bearer ${ROOT_TOKEN}` };
const AUTH_NORMAL = { authorization: `Bearer ${NORMAL_TOKEN}` };

/** 全部路由（401/403 矩阵遍历） */
const ALL_ROUTES = [
  { method: 'GET', url: '/api/v1/extensions' },
  { method: 'GET', url: '/api/v1/extensions/routes' },
  { method: 'GET', url: '/api/v1/extensions/registry' },
  { method: 'GET', url: '/api/v1/extensions/doc-demo' },
  { method: 'POST', url: '/api/v1/extensions/rescan' },
  { method: 'POST', url: '/api/v1/extensions/doc-demo/enable' },
  { method: 'POST', url: '/api/v1/extensions/doc-demo/disable' },
  { method: 'POST', url: '/api/v1/extensions/doc-demo/reload' },
  { method: 'POST', url: '/api/v1/extensions/doc-demo/uninstall' },
] as const;

const SEED_ROWS: ExtSummaryLike[] = [
  { id: 'doc-demo', version: '1.0.0', enabled: true, builtin: false },
  { id: 'echo-bot', version: '0.2.0', enabled: false, builtin: false },
];

// ---------------------------------------------------------------------------
// 依赖 stub
// ---------------------------------------------------------------------------

/** ExtensionManager 门面形状（deps.manager 的结构契约） */
type ManagerLike = ExtensionsApiDeps['manager'];

/** ExtensionManager 门面 stub：记录全部调用，支持注入失败 */
class ManagerStub implements ManagerLike {
  readonly enableIds: string[] = [];
  readonly disableIds: string[] = [];
  readonly reloadIds: string[] = [];
  readonly uninstallCalls: Array<{ id: string; opts?: { purge?: boolean } }> = [];
  rescanResult: { discovered: string[] } = { discovered: ['late-ext'] };
  enableError: HarnessError | null = null;
  disableError: HarnessError | null = null;

  constructor(private readonly rows: ExtSummaryLike[] = SEED_ROWS) {}

  list(): ExtSummaryLike[] {
    return this.rows;
  }

  async enable(id: string): Promise<void> {
    this.enableIds.push(id);
    if (this.enableError !== null) throw this.enableError;
  }

  async disable(id: string): Promise<void> {
    this.disableIds.push(id);
    if (this.disableError !== null) throw this.disableError;
  }

  async reload(id: string): Promise<void> {
    this.reloadIds.push(id);
  }

  async uninstall(id: string, opts?: { purge?: boolean }): Promise<void> {
    this.uninstallCalls.push({ id, opts });
  }

  async rescan(): Promise<{ discovered: string[] }> {
    return this.rescanResult;
  }

  getRoutes(): unknown[] {
    return [{ method: 'GET', url: '/doc/parse', extId: 'doc-demo' }];
  }

  /** 断言辅助：写操作计数合计 */
  get writeCallCount(): number {
    return this.enableIds.length + this.disableIds.length + this.reloadIds.length + this.uninstallCalls.length;
  }
}

interface BuildCtx {
  app: FastifyInstance;
  manager: ManagerStub;
}

/** 组装被测服务器：stub checker + stub manager/registry */
function buildServer(): BuildCtx {
  const manager = new ManagerStub();
  const config = loadConfig({ NODE_ENV: 'test', HARNESS_LOG_LEVEL: 'error', HARNESS_DATA_DIR: './data' });
  const { app } = createHttpServer({
    config,
    logger: pino({ level: 'silent' }),
    isReady: () => true,
    state: () => 'ready',
    registerExtra: (a) => {
      const deps: ExtensionsApiDeps = {
        checker: async ({ token }) => {
          if (token === ADMIN_TOKEN) return { role: 'admin' };
          if (token === ROOT_TOKEN) return { role: 'root' };
          if (token === NORMAL_TOKEN) return { role: 'normal' };
          throw err('UNAUTHORIZED', { detail: 'token rejected by all auth providers' });
        },
        manager,
        registry: {
          list: () => [
            { extId: 'doc-demo', service: 'ext.doc-demo.parse', methods: ['parse'], status: 'active' },
          ],
        },
      };
      registerExtensionRoutes(a, deps);
    },
  });
  return { app, manager };
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

describe('extensions api — 鉴权与角色门禁（全部 admin/root）', () => {
  it.each(ALL_ROUTES)('$method $url 无 token → 401 HARNESS-1006', async (route) => {
    const { app } = buildServer();
    const res = await app.inject({ method: route.method, url: route.url });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'HARNESS-1006', retryable: false });
  });

  it.each(ALL_ROUTES)('$method $url normal 角色 → 403 HARNESS-1007 且不触达 manager', async (route) => {
    const { app, manager } = buildServer();
    const res = await app.inject({ method: route.method, url: route.url, headers: AUTH_NORMAL });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('HARNESS-1007');
    expect(res.json().message).toContain('admin or root');
    expect(manager.writeCallCount).toBe(0);
    expect(manager.list()).toEqual(SEED_ROWS); // list 只是读取，未被 403 请求污染
  });

  it('root 放行；?token= 亦可认证', async () => {
    const { app } = buildServer();
    const viaHeader = await app.inject({ method: 'GET', url: '/api/v1/extensions', headers: AUTH_ROOT });
    expect(viaHeader.statusCode).toBe(200);
    const viaQuery = await app.inject({ method: 'GET', url: `/api/v1/extensions?token=${ADMIN_TOKEN}` });
    expect(viaQuery.statusCode).toBe(200);
  });
});

describe('extensions api — 三只读端点', () => {
  it('GET /api/v1/extensions → manager.list() 原样返回', async () => {
    const { app } = buildServer();
    const res = await app.inject({ method: 'GET', url: '/api/v1/extensions', headers: AUTH_ADMIN });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(SEED_ROWS);
  });

  it('GET /api/v1/extensions/routes → manager.getRoutes() 透传', async () => {
    const { app } = buildServer();
    const res = await app.inject({ method: 'GET', url: '/api/v1/extensions/routes', headers: AUTH_ADMIN });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([{ method: 'GET', url: '/doc/parse', extId: 'doc-demo' }]);
  });

  it('GET /api/v1/extensions/registry → registry.list() 透传', async () => {
    const { app } = buildServer();
    const res = await app.inject({ method: 'GET', url: '/api/v1/extensions/registry', headers: AUTH_ADMIN });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      { extId: 'doc-demo', service: 'ext.doc-demo.parse', methods: ['parse'], status: 'active' },
    ]);
  });
});

describe('extensions api — 生命周期写操作', () => {
  it('POST /:id/enable → 200 {ok:true}，manager.enable 收到 id', async () => {
    const { app, manager } = buildServer();
    const res = await app.inject({ method: 'POST', url: '/api/v1/extensions/echo-bot/enable', headers: AUTH_ADMIN });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(manager.enableIds).toEqual(['echo-bot']);
  });

  it('enable 抛 EXT_DEPENDENCY_MISSING → 409 HARNESS-3005 原样状态码透传（统一错误形状）', async () => {
    const { app, manager } = buildServer();
    manager.enableError = new HarnessError('EXT_DEPENDENCY_MISSING', { detail: { missing: ['auth'] } });
    const res = await app.inject({ method: 'POST', url: '/api/v1/extensions/echo-bot/enable', headers: AUTH_ADMIN });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      code: 'HARNESS-3005',
      message: 'extension hard dependency missing or disabled',
      detail: { missing: ['auth'] },
      retryable: false,
    });
  });

  it('enable 抛 EXT_ACTIVATION_FAILED → 500 HARNESS-3003', async () => {
    const { app, manager } = buildServer();
    manager.enableError = new HarnessError('EXT_ACTIVATION_FAILED', { detail: { phase: 'activate' } });
    const res = await app.inject({ method: 'POST', url: '/api/v1/extensions/echo-bot/enable', headers: AUTH_ADMIN });
    expect(res.statusCode).toBe(500);
    expect(res.json().code).toBe('HARNESS-3003');
  });

  it('disable 失败同样原样透传（EXT_CRASH_LOOP → 503 HARNESS-3006）', async () => {
    const { app, manager } = buildServer();
    manager.disableError = new HarnessError('EXT_CRASH_LOOP');
    const res = await app.inject({ method: 'POST', url: '/api/v1/extensions/doc-demo/disable', headers: AUTH_ADMIN });
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe('HARNESS-3006');
  });

  it('POST /:id/disable → 200 {ok:true}，manager.disable 收到 id', async () => {
    const { app, manager } = buildServer();
    const res = await app.inject({ method: 'POST', url: '/api/v1/extensions/doc-demo/disable', headers: AUTH_ADMIN });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(manager.disableIds).toEqual(['doc-demo']);
  });

  it('POST /:id/reload → 200 {ok:true}，manager.reload 收到 id', async () => {
    const { app, manager } = buildServer();
    const res = await app.inject({ method: 'POST', url: '/api/v1/extensions/doc-demo/reload', headers: AUTH_ADMIN });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(manager.reloadIds).toEqual(['doc-demo']);
  });

  it('POST /:id/uninstall 缺省 → manager.uninstall(id, { purge: false })', async () => {
    const { app, manager } = buildServer();
    const res = await app.inject({ method: 'POST', url: '/api/v1/extensions/echo-bot/uninstall', headers: AUTH_ADMIN });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(manager.uninstallCalls).toEqual([{ id: 'echo-bot', opts: { purge: false } }]);
  });

  it.each([
    ['?purge=1', '?purge=1', true],
    ['?purge=true', '?purge=true', true],
  ])('POST /:id/uninstall %s → manager.uninstall(id, { purge: true })', async (_label, suffix, purge) => {
    const { app, manager } = buildServer();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/extensions/echo-bot/uninstall${suffix}`,
      headers: AUTH_ADMIN,
    });
    expect(res.statusCode).toBe(200);
    expect(manager.uninstallCalls).toEqual([{ id: 'echo-bot', opts: { purge } }]);
  });

  it('POST /:id/uninstall?purge=abc → 400 HARNESS-1009 且不触达 manager', async () => {
    const { app, manager } = buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/extensions/echo-bot/uninstall?purge=abc',
      headers: AUTH_ADMIN,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('HARNESS-1009');
    expect(manager.uninstallCalls).toEqual([]);
  });
});

describe('extensions api — REL-7 rescan（免重启发现新扩展目录）', () => {
  it('POST /api/v1/extensions/rescan（admin）→ 200 { ok, discovered } 透传 manager.rescan', async () => {
    const { app, manager } = buildServer();
    const res = await app.inject({ method: 'POST', url: '/api/v1/extensions/rescan', headers: AUTH_ADMIN });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, discovered: ['late-ext'] });
  });

  it('POST /api/v1/extensions/rescan（root）→ 200', async () => {
    const { app } = buildServer();
    const res = await app.inject({ method: 'POST', url: '/api/v1/extensions/rescan', headers: AUTH_ROOT });
    expect(res.statusCode).toBe(200);
  });
});

describe('extensions api — GET /api/v1/extensions/:id', () => {
  it('清单内命中 → 200 详情', async () => {
    const { app } = buildServer();
    const res = await app.inject({ method: 'GET', url: '/api/v1/extensions/doc-demo', headers: AUTH_ADMIN });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: 'doc-demo', version: '1.0.0', enabled: true, builtin: false });
  });

  it('清单外 → 404 HARNESS-3004', async () => {
    const { app } = buildServer();
    const res = await app.inject({ method: 'GET', url: '/api/v1/extensions/ghost', headers: AUTH_ADMIN });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'HARNESS-3004', retryable: false });
    expect(res.json().message).toContain('ghost');
  });
});
