/**
 * 系统 API 集成测试（真实 fastify 注入，经 createHttpServer + registerExtra 挂载）。
 *
 * 覆盖：统一鉴权（401 HARNESS-1006）、info 字段完整性、doctor 结构、
 * backup 501/200 两态、logs 门禁/透传/501/校验、openapi 文档端点、
 * /api/v1 请求计数增长；另含 Kernel 接线的真实端到端用例（logs 表 data 损坏 JSON → null）。
 */
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pino from 'pino';
import type { FastifyInstance } from 'fastify';
import type { Knex } from 'knex';

import { registerSystemRoutes, type SystemLogSource } from '../src/api/system.js';
import { loadConfig, type HarnessConfig } from '../src/kernel/config/index.js';
import { err } from '../src/kernel/errors/HarnessError.js';
import { CONTAINER_KEYS, Kernel } from '../src/kernel/Kernel.js';
import { createHttpServer } from '../src/kernel/http/server.js';
import { Counters } from '../src/kernel/system/info.js';

const ROOT_TOKEN = 'test-root-token';
/** SEC-6：normal 角色令牌（备份 admin 门测试用） */
const NORMAL_TOKEN = 'test-normal-token';

const AUTHZ: Record<string, string> = { authorization: `Bearer ${ROOT_TOKEN}` };
const AUTHZ_NORMAL: Record<string, string> = { authorization: `Bearer ${NORMAL_TOKEN}` };

let dataDir = '';

beforeAll(async () => {
  dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'opptrix-system-api-'));
});

function makeConfig(): HarnessConfig {
  return loadConfig({
    NODE_ENV: 'test',
    HARNESS_LOG_LEVEL: 'error',
    HARNESS_DATA_DIR: dataDir,
  });
}

interface BuildOpts {
  runDbBackup?: (cfg: HarnessConfig) => Promise<{ path: string; sizeBytes: number }>;
  logs?: SystemLogSource;
}

/** 经 createHttpServer 的 registerExtra 钩子挂载系统路由（与内核集成方式一致） */
function buildServer(
  opts: BuildOpts = {},
): { app: FastifyInstance; counters: Counters; config: HarnessConfig } {
  const counters = new Counters();
  const config = makeConfig();
  const { app } = createHttpServer({
    config,
    logger: pino({ level: 'silent' }),
    isReady: () => true,
    state: () => 'ready',
    registerExtra: (a) => {
      registerSystemRoutes(a, {
        config,
        checker: async (input) => {
          if (input.token === NORMAL_TOKEN) {
            return { userId: 'bob', role: 'normal', scopes: [] };
          }
          if (input.token !== ROOT_TOKEN) {
            throw err('UNAUTHORIZED', { detail: 'token rejected by all auth providers' });
          }
          return { userId: 'root', role: 'root', scopes: ['*'] };
        },
        counters,
        ...(opts.runDbBackup ? { runDbBackup: opts.runDbBackup } : {}),
        ...(opts.logs ? { logs: opts.logs } : {}),
      });
    },
  });
  return { app, counters, config };
}

describe('system api — 鉴权', () => {
  it.each([
    ['GET', '/api/v1/system/info'],
    ['GET', '/api/v1/system/doctor'],
    ['POST', '/api/v1/system/backup'],
    ['GET', '/api/v1/system/openapi'],
  ] as Array<['GET' | 'POST', string]>)('%s %s 无 token 返回 401 HARNESS-1006', async (method, url) => {
    const { app } = buildServer();
    const res = await app.inject({ method, url });
    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.code).toBe('HARNESS-1006');
    expect(body.retryable).toBe(false);
  });

  it('token 错误同样 401；query.token 亦可认证', async () => {
    const { app } = buildServer();

    const bad = await app.inject({ method: 'GET', url: '/api/v1/system/info', headers: { authorization: 'Bearer wrong' } });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().code).toBe('HARNESS-1006');

    const viaQuery = await app.inject({ method: 'GET', url: `/api/v1/system/info?token=${ROOT_TOKEN}` });
    expect(viaQuery.statusCode).toBe(200);
    expect(viaQuery.json().name).toBe('opptrix-harness');
  });
});

describe('system api — info / doctor / backup / openapi', () => {
  it('GET /api/v1/system/info 返回字段完整', async () => {
    const { app } = buildServer();
    const res = await app.inject({ method: 'GET', url: '/api/v1/system/info', headers: AUTHZ });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.name).toBe('opptrix-harness');
    expect(body.env).toBe('test');
    expect(typeof body.version).toBe('string');
    expect(body.version.length).toBeGreaterThan(0);
    expect(typeof body.uptimeMs).toBe('number');
    expect(body.uptimeMs).toBeGreaterThanOrEqual(0);
    expect(typeof body.node).toBe('string');
    expect(body.timezone).toBe('UTC');
    expect(body.state).toBe('ready');
    expect(body.counters).toEqual(expect.any(Object));
  });

  it('GET /api/v1/system/doctor 返回体检报告（checks 数组五项）', async () => {
    const { app } = buildServer();
    const res = await app.inject({ method: 'GET', url: '/api/v1/system/doctor', headers: AUTHZ });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(typeof body.ok).toBe('boolean');
    expect(Array.isArray(body.checks)).toBe(true);
    expect(body.checks).toHaveLength(5);
    expect(body.checks.map((c: { id: string }) => c.id).sort()).toEqual([
      'dataDir',
      'diskSpace',
      'memory',
      'nodeVersion',
      'timezone',
    ]);
  });

  it('POST /api/v1/system/backup 未注入 runDbBackup 时返回 501 HARNESS-9004', async () => {
    const { app } = buildServer();
    const res = await app.inject({ method: 'POST', url: '/api/v1/system/backup', headers: AUTHZ });
    expect(res.statusCode).toBe(501);
    const body = res.json();
    expect(body.code).toBe('HARNESS-9004');
    expect(body.retryable).toBe(false);
  });

  it('SEC-6：backup 拒绝 normal 角色 → 403 HARNESS-1007 且备份执行器未被触达', async () => {
    let called = false;
    const { app } = buildServer({
      runDbBackup: async () => {
        called = true;
        return { path: '/tmp/harness.db.bak', sizeBytes: 1 };
      },
    });
    const res = await app.inject({ method: 'POST', url: '/api/v1/system/backup', headers: AUTHZ_NORMAL });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'HARNESS-1007', retryable: false });
    expect(res.json().message).toContain('admin or root');
    expect(called).toBe(false);
  });

  it('POST /api/v1/system/backup 注入 runDbBackup 后返回 BackupInfo（并收到 config）', async () => {
    let receivedCfg: HarnessConfig | undefined;
    const { app, config } = buildServer({
      runDbBackup: async (cfg) => {
        receivedCfg = cfg;
        return { path: '/tmp/harness.db.bak', sizeBytes: 4096 };
      },
    });

    const res = await app.inject({ method: 'POST', url: '/api/v1/system/backup', headers: AUTHZ });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.path).toBe('/tmp/harness.db.bak');
    expect(body.sizeBytes).toBe(4096);
    expect(body.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/); // UTC ISO8601
    expect(new Date(body.createdAt).toISOString()).toBe(body.createdAt);
    expect(receivedCfg).toBe(config);
  });

  it('GET /api/v1/system/openapi 返回文档地址（需鉴权）', async () => {
    const { app } = buildServer();
    const res = await app.inject({ method: 'GET', url: '/api/v1/system/openapi', headers: AUTHZ });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ url: '/api/v1/openapi.json' });
  });
});

describe('system api — OpenAPI 文档', () => {
  it('GET /api/v1/openapi.json 返回 JSON 文档，paths 含系统路由与 system tag', async () => {
    const { app } = buildServer();
    const res = await app.inject({ method: 'GET', url: '/api/v1/openapi.json' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');

    const doc = res.json();
    expect(doc.info.title).toBe('Opptrix Harness OS API');
    expect(doc.info.version).toBe('0.1.0');
    expect(doc.tags).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'system' })]));

    const paths = Object.keys(doc.paths ?? {});
    expect(paths).toContain('/api/v1/system/info');
    expect(paths).toContain('/api/v1/system/doctor');
    expect(paths).toContain('/api/v1/system/backup');
    expect(paths).toContain('/api/v1/system/openapi');
  });
});

describe('system api — 请求计数', () => {
  it('/api/v1 请求后 api.requests 计数增长，非 /api/v1 不计数', async () => {
    const { app, counters } = buildServer();

    const before = counters.snapshot();
    const apiRequestsBefore = Object.entries(before)
      .filter(([k]) => k.startsWith('api.requests'))
      .reduce((sum, [, v]) => sum + v, 0);
    expect(apiRequestsBefore).toBe(0);

    await app.inject({ method: 'GET', url: '/api/v1/system/info', headers: AUTHZ }); // 200
    await app.inject({ method: 'GET', url: '/api/v1/system/info' }); // 401 也计数
    await app.inject({ method: 'GET', url: '/health' }); // 非 /api/v1 不计数

    const after = counters.snapshot();
    const apiRequestsAfter = Object.entries(after)
      .filter(([k]) => k.startsWith('api.requests'))
      .reduce((sum, [, v]) => sum + v, 0);
    expect(apiRequestsAfter).toBe(2);
    expect(after['api.requests{route=/api/v1/system/info}']).toBe(2);
    expect(after['api.requests{route=/health}']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/system/logs（stub 数据源：门禁 / 校验 / 透传 / 501）
// ---------------------------------------------------------------------------

describe('system api — logs（门禁与未注入）', () => {
  it('无 token 返回 401 HARNESS-1006，数据源未被触达', async () => {
    let called = false;
    const { app } = buildServer({
      logs: {
        list: async () => {
          called = true;
          return [];
        },
      },
    });
    const res = await app.inject({ method: 'GET', url: '/api/v1/system/logs' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'HARNESS-1006', retryable: false });
    expect(called).toBe(false);
  });

  it('normal 角色返回 403 HARNESS-1007（日志仅 admin/root），数据源未被触达', async () => {
    let called = false;
    const { app } = buildServer({
      logs: {
        list: async () => {
          called = true;
          return [];
        },
      },
    });
    const res = await app.inject({ method: 'GET', url: '/api/v1/system/logs', headers: AUTHZ_NORMAL });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'HARNESS-1007', retryable: false });
    expect(res.json().message).toContain('admin or root');
    expect(called).toBe(false);
  });

  it('未注入 deps.logs 时返回 501 HARNESS-9004（与其他可选端点同款）', async () => {
    const { app } = buildServer();
    const res = await app.inject({ method: 'GET', url: '/api/v1/system/logs', headers: AUTHZ });
    expect(res.statusCode).toBe(501);
    expect(res.json()).toMatchObject({ code: 'HARNESS-9004', retryable: false });
    expect(res.json().message).toBe('not implemented');
  });
});

describe('system api — logs（校验与透传）', () => {
  it('正常透传：limit/level 传给数据源，行原样返回；无 query 时默认 limit=200 且不过滤级别', async () => {
    const calls: Array<{ level?: string; limit: number }> = [];
    const { app } = buildServer({
      logs: {
        list: async (opts) => {
          calls.push({ ...opts });
          return [
            { ts: 2000, level: 'warn', scope: 'ext.demo', message: 'newer', data: { k: 1 } },
            { ts: 1000, level: 'info', scope: 'kernel', message: 'older', data: null },
          ];
        },
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/system/logs?limit=50&level=warn',
      headers: AUTHZ,
    });
    expect(res.statusCode).toBe(200);
    expect(calls).toEqual([{ level: 'warn', limit: 50 }]);
    const body = res.json();
    expect(body.items).toHaveLength(2);
    expect(body.items[0]).toEqual({ ts: 2000, level: 'warn', scope: 'ext.demo', message: 'newer', data: { k: 1 } });
    expect(body.items[1]).toEqual({ ts: 1000, level: 'info', scope: 'kernel', message: 'older', data: null });

    // 无 query：level 不传（undefined），limit 缺省 200
    const res2 = await app.inject({ method: 'GET', url: '/api/v1/system/logs', headers: AUTHZ });
    expect(res2.statusCode).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual({ limit: 200 });
  });

  it.each([
    ['limit=0', '/api/v1/system/logs?limit=0'],
    ['limit=1001（超上限）', '/api/v1/system/logs?limit=1001'],
    ['limit=abc（非数字）', '/api/v1/system/logs?limit=abc'],
    ['level=bogus（非法级别）', '/api/v1/system/logs?level=bogus'],
  ])('非法 query（%s）返回 400 HARNESS-1009，数据源未被触达', async (_name, url) => {
    let called = false;
    const { app } = buildServer({
      logs: {
        list: async () => {
          called = true;
          return [];
        },
      },
    });
    const res = await app.inject({ method: 'GET', url, headers: AUTHZ });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('HARNESS-1009');
    expect(called).toBe(false);
  });

  it('limit=1000 边界值合法，可正常透传', async () => {
    const calls: Array<{ level?: string; limit: number }> = [];
    const { app } = buildServer({
      logs: {
        list: async (opts) => {
          calls.push({ ...opts });
          return [];
        },
      },
    });
    const res = await app.inject({ method: 'GET', url: '/api/v1/system/logs?limit=1000', headers: AUTHZ });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toEqual([]);
    expect(calls).toEqual([{ limit: 1000 }]);
  });
});

// ---------------------------------------------------------------------------
// Kernel 接线端到端：真实 Kernel boot → logs 表 → 行映射（data 损坏 JSON → null）
// ---------------------------------------------------------------------------

describe('system api — logs（Kernel 接线端到端）', () => {
  let dataDir = '';
  let kernel: Kernel | undefined;
  let app: FastifyInstance;
  let db: Knex;
  const auth: Record<string, string> = { authorization: '' };

  beforeAll(async () => {
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'opptrix-system-logs-e2e-'));
    kernel = new Kernel({
      config: {
        ...loadConfig({
          NODE_ENV: 'test',
          HARNESS_LOG_LEVEL: 'error',
          HARNESS_TASK_WORKERS: '1',
          HARNESS_DATA_DIR: dataDir,
          HARNESS_PERSIST_ROOT_TOKEN: '0',
        }),
        port: 0,
      },
    });
    await kernel.boot();
    auth.authorization = `Bearer ${kernel.container.resolve<{ token: string }>(CONTAINER_KEYS.authIdentity).token}`;
    app = kernel.container.resolve<{ app: FastifyInstance }>(CONTAINER_KEYS.http).app;
    db = kernel.container.resolve<Knex>(CONTAINER_KEYS.db);
    // 造三行 fatal 级别日志（内核自省日志不产生 fatal，隔离 sqlite sink 异步写入的干扰）：
    // 插入顺序 good → corrupt → plain（id 递增），倒序期望 plain, corrupt, good
    await db('logs').insert([
      { ts: 1000, level: 'fatal', scope: 'k', message: 'good-row', data: JSON.stringify({ requestId: 'req-1', n: 2 }) },
      { ts: 2000, level: 'fatal', scope: 'k', message: 'corrupt-row', data: '{broken json' },
      { ts: 3000, level: 'fatal', scope: 'k', message: 'plain-row', data: null },
    ]);
  });

  afterAll(async () => {
    await kernel?.shutdown('system-logs-e2e-afterall');
    if (dataDir !== '') await fsp.rm(dataDir, { recursive: true, force: true });
  });

  it('倒序（最新在前）+ data JSON 解析：好行解析为对象、损坏行与 NULL 行 → null', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/system/logs?level=fatal', headers: auth });
    expect(res.statusCode).toBe(200);
    const items = res.json().items as Array<{
      ts: number;
      level: string;
      scope: string;
      message: string;
      data: unknown;
    }>;
    expect(items.map((r) => r.message)).toEqual(['plain-row', 'corrupt-row', 'good-row']);
    expect(items[0]).toMatchObject({ ts: 3000, level: 'fatal', scope: 'k', data: null });
    expect(items[1]).toMatchObject({ ts: 2000, data: null }); // 损坏 JSON 不拖垮列表 → null
    expect(items[2]).toMatchObject({ ts: 1000, data: { requestId: 'req-1', n: 2 } });
  });

  it('limit 收窄生效（id 倒序取前 N 条）+ 未知级别过滤为空列表', async () => {
    const limited = await app.inject({
      method: 'GET',
      url: '/api/v1/system/logs?level=fatal&limit=2',
      headers: auth,
    });
    expect(limited.statusCode).toBe(200);
    expect((limited.json().items as Array<{ message: string }>).map((r) => r.message)).toEqual([
      'plain-row',
      'corrupt-row',
    ]);

    const empty = await app.inject({ method: 'GET', url: '/api/v1/system/logs?level=trace', headers: auth });
    expect(empty.statusCode).toBe(200);
    expect(empty.json().items).toEqual([]);
  });
});
