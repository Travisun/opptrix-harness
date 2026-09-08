/**
 * 系统 API 集成测试（真实 fastify 注入，经 createHttpServer + registerExtra 挂载）。
 *
 * 覆盖：统一鉴权（401 HARNESS-1006）、info 字段完整性、doctor 结构、
 * backup 501/200 两态、openapi 文档端点、/api/v1 请求计数增长。
 */
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';
import pino from 'pino';
import type { FastifyInstance } from 'fastify';

import { registerSystemRoutes } from '../src/api/system.js';
import { loadConfig, type HarnessConfig } from '../src/kernel/config/index.js';
import { err } from '../src/kernel/errors/HarnessError.js';
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
