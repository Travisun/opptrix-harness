/**
 * update API 集成测试（真实 fastify 注入，经 createHttpServer + registerExtra 挂载）。
 *
 * 覆盖：401/403 鉴权矩阵（三条路由）；check 透传（含 feedOk=false 也 200）；
 * apply 成功 202 {accepted:true,...}（透传 target 字段）；失败按 stage 映射
 * （verify→400 HARNESS-8002、preflight→500 HARNESS-8003、download→500 INTERNAL）；
 * 非法 body → 400 HARNESS-1009；UPDATE_IN_PROGRESS（HARNESS-8004）→ 409；history 透传。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import pino from 'pino';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { registerUpdateRoutes, type UpdateRoutesDeps } from '../src/api/update.js';
import { err } from '../src/kernel/errors/HarnessError.js';
import type { HarnessConfig } from '../src/kernel/config/index.js';
import { createHttpServer } from '../src/kernel/http/server.js';
import type { UpdateApplyResult, UpdateCheckResult, UpdateHistoryEntry } from '../src/kernel/update/updater.js';

const ROOT_TOKEN = 'test-root-token';
const AUTHZ = { authorization: `Bearer ${ROOT_TOKEN}` };

let dataDir = '';

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'opptrix-update-api-'));
});

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

/* ---------- fake updater ---------- */

interface FakeUpdater {
  check: ReturnType<typeof vi.fn>;
  apply: ReturnType<typeof vi.fn>;
  history: ReturnType<typeof vi.fn>;
}

function makeFakeUpdater(
  overrides: {
    checkResult?: UpdateCheckResult;
    applyResult?: UpdateApplyResult;
    applyError?: Error;
    historyResult?: UpdateHistoryEntry[];
  } = {},
): FakeUpdater {
  return {
    check: vi.fn(async (): Promise<UpdateCheckResult> =>
      overrides.checkResult ?? { currentVersion: '0.1.0', available: null, feedOk: true }),
    apply: vi.fn(async (): Promise<UpdateApplyResult> => {
      if (overrides.applyError !== undefined) throw overrides.applyError;
      return overrides.applyResult ?? { ok: true, slot: 'slot-b', version: '2.0.0' };
    }),
    history: vi.fn(async (): Promise<UpdateHistoryEntry[]> =>
      overrides.historyResult ?? [{ version: '2.0.0', appliedAt: 1_700_000_000_000, ok: true }]),
  };
}

function minimalConfig(): HarnessConfig {
  return {
    env: 'test',
    dataDir,
    port: 0,
    host: '127.0.0.1',
    token: ROOT_TOKEN,
    persistRootToken: true,
    corsOrigin: '*',
    trustProxy: false,
    logLevel: 'error',
    timezone: 'UTC',
    taskWorkers: 1,
    rpcTimeoutMs: 30_000,
    routeTimeoutMs: 30_000,
    maxBodyBytes: 1_048_576,
    maxUploadBytes: 1_048_576,
    maxRpcPayloadBytes: 1_048_576,
    maxRoutesPerExt: 100,
    maxConcurrentPerExt: 32,
    sandboxEnabled: false,
    sandboxImage: 'x',
    dockerHost: '',
    updateAuto: false,
    updateFeed: '',
    updateChannel: 'stable',
    updateToken: '',
    updateWindow: '0 4 * * *',
    crashLoopWindowMs: 60_000,
    crashLoopMax: 5,
  };
}

/** checker 工厂：默认 root 放行、其他 token 401；可替换为任意身份 */
function makeChecker(roleForRoot: 'root' | 'admin' | 'normal' = 'root'): UpdateRoutesDeps['checker'] {
  return async ({ token }) => {
    if (token !== ROOT_TOKEN) {
      throw err('UNAUTHORIZED', { detail: 'token rejected by all auth providers' });
    }
    return { userId: 'u1', role: roleForRoot, scopes: roleForRoot === 'root' ? ['*'] : [] };
  };
}

function buildServer(
  fake: FakeUpdater,
  opts: { roleForRoot?: 'root' | 'admin' | 'normal' } = {},
): { app: FastifyInstance; deps: UpdateRoutesDeps } {
  const deps: UpdateRoutesDeps = {
    checker: makeChecker(opts.roleForRoot ?? 'root'),
    updater: fake as unknown as UpdateRoutesDeps['updater'],
  };
  const { app } = createHttpServer({
    config: minimalConfig(),
    logger: pino({ level: 'silent' }),
    isReady: () => true,
    state: () => 'ready',
    registerExtra: (a) => {
      registerUpdateRoutes(a, deps);
    },
  });
  return { app, deps };
}

/* ---------- 401 / 403 矩阵 ---------- */

const ROUTES = [
  ['GET', '/api/v1/system/update'],
  ['POST', '/api/v1/system/update/apply'],
  ['GET', '/api/v1/system/update/history'],
] as const;

describe('update api — 鉴权矩阵', () => {
  it.each(ROUTES)('%s %s 无 token → 401 HARNESS-1006', async (method, url) => {
    const { app } = buildServer(makeFakeUpdater());
    const res = await app.inject({ method, url });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('HARNESS-1006');
  });

  it.each(ROUTES)('%s %s 错误 token → 401', async (method, url) => {
    const { app } = buildServer(makeFakeUpdater());
    const res = await app.inject({ method, url, headers: { authorization: 'Bearer wrong' } });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('HARNESS-1006');
  });

  it.each(ROUTES)('%s %s normal 角色 → 403 HARNESS-1007 且不触达 updater', async (method, url) => {
    const fake = makeFakeUpdater();
    const { app } = buildServer(fake, { roleForRoot: 'normal' });
    const res = await app.inject({ method, url, headers: AUTHZ });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('HARNESS-1007');
    expect(fake.check).not.toHaveBeenCalled();
    expect(fake.apply).not.toHaveBeenCalled();
    expect(fake.history).not.toHaveBeenCalled();
  });

  it('query.token 亦可认证（GET update）', async () => {
    const fake = makeFakeUpdater();
    const { app } = buildServer(fake);
    const res = await app.inject({ method: 'GET', url: `/api/v1/system/update?token=${ROOT_TOKEN}` });
    expect(res.statusCode).toBe(200);
    expect(fake.check).toHaveBeenCalledTimes(1);
  });
});

/* ---------- 路由行为 ---------- */

describe('update api — 行为', () => {
  it('GET /api/v1/system/update 透传 check() 结果（200）', async () => {
    const fake = makeFakeUpdater({
      checkResult: {
        currentVersion: '0.1.0',
        available: { channel: 'stable', version: '2.0.0', url: 'https://feed/x.tgz', sha256: 'a'.repeat(64) },
        feedOk: true,
      },
    });
    const { app } = buildServer(fake);
    const res = await app.inject({ method: 'GET', url: '/api/v1/system/update', headers: AUTHZ });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ feedOk: true, currentVersion: '0.1.0' });
    expect(res.json().available?.version).toBe('2.0.0');
    expect(fake.check).toHaveBeenCalledTimes(1);
  });

  it('GET /api/v1/system/update 网络失败（feedOk=false + error）也返回 200', async () => {
    const fake = makeFakeUpdater({
      checkResult: {
        currentVersion: null,
        available: null,
        feedOk: false,
        error: 'update feed fetch failed: ECONNREFUSED',
      },
    });
    const { app } = buildServer(fake);
    const res = await app.inject({ method: 'GET', url: '/api/v1/system/update', headers: AUTHZ });
    expect(res.statusCode).toBe(200);
    expect(res.json().feedOk).toBe(false);
    expect(res.json().error).toContain('ECONNREFUSED');
  });

  it('POST apply 成功 → 202 {accepted:true,...}（无 body 视同缺省 target）', async () => {
    const fake = makeFakeUpdater({ applyResult: { ok: true, slot: 'slot-b', version: '2.0.0' } });
    const { app } = buildServer(fake);
    const res = await app.inject({ method: 'POST', url: '/api/v1/system/update/apply', headers: AUTHZ });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ accepted: true, slot: 'slot-b', version: '2.0.0' });
    expect(fake.apply).toHaveBeenCalledWith(undefined);
  });

  it('POST apply 透传 body target 字段', async () => {
    const fake = makeFakeUpdater({ applyResult: { ok: true, slot: 'slot-b', version: '9.9.9' } });
    const { app } = buildServer(fake);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/system/update/apply',
      headers: { ...AUTHZ, 'content-type': 'application/json' },
      payload: JSON.stringify({ version: '9.9.9', sha256: 'b'.repeat(64) }),
    });
    expect(res.statusCode).toBe(202);
    expect(fake.apply).toHaveBeenCalledWith({ version: '9.9.9', sha256: 'b'.repeat(64) });
  });

  it('POST apply sha 不匹配（stage=verify）→ 400 HARNESS-8002', async () => {
    const fake = makeFakeUpdater({
      applyResult: { ok: false, stage: 'verify', error: 'sha256 mismatch: expected a, got b' },
    });
    const { app } = buildServer(fake);
    const res = await app.inject({ method: 'POST', url: '/api/v1/system/update/apply', headers: AUTHZ });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('HARNESS-8002');
    expect(res.json().retryable).toBe(false);
  });

  it('POST apply 预检失败（stage=preflight）→ 500 HARNESS-8003', async () => {
    const fake = makeFakeUpdater({
      applyResult: { ok: false, stage: 'preflight', error: 'preflight process exited prematurely (exitCode=1)' },
    });
    const { app } = buildServer(fake);
    const res = await app.inject({ method: 'POST', url: '/api/v1/system/update/apply', headers: AUTHZ });
    expect(res.statusCode).toBe(500);
    expect(res.json().code).toBe('HARNESS-8003');
  });

  it('POST apply 下载失败（stage=download）→ 500 INTERNAL（固定文案，错误在 detail）', async () => {
    const fake = makeFakeUpdater({
      applyResult: { ok: false, stage: 'download', error: 'release download failed: HTTP 500 from feed' },
    });
    const { app } = buildServer(fake);
    const res = await app.inject({ method: 'POST', url: '/api/v1/system/update/apply', headers: AUTHZ });
    expect(res.statusCode).toBe(500);
    expect(res.json().code).toBe('HARNESS-9003');
    expect(res.json().detail).toMatchObject({ stage: 'download' });
  });

  it('POST apply 非法 body（错误类型/未知字段）→ 400 HARNESS-1009 且不触达 apply', async () => {
    const fake = makeFakeUpdater();
    const { app } = buildServer(fake);

    const bad1 = await app.inject({
      method: 'POST',
      url: '/api/v1/system/update/apply',
      headers: { ...AUTHZ, 'content-type': 'application/json' },
      payload: JSON.stringify({ version: 123 }),
    });
    expect(bad1.statusCode).toBe(400);
    expect(bad1.json().code).toBe('HARNESS-1009');

    const bad2 = await app.inject({
      method: 'POST',
      url: '/api/v1/system/update/apply',
      headers: { ...AUTHZ, 'content-type': 'application/json' },
      payload: JSON.stringify({ nope: true }),
    });
    expect(bad2.statusCode).toBe(400);
    expect(bad2.json().code).toBe('HARNESS-1009');
    expect(fake.apply).not.toHaveBeenCalled();
  });

  it('POST apply 非法 JSON body → 400 HARNESS-1009', async () => {
    const fake = makeFakeUpdater();
    const { app } = buildServer(fake);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/system/update/apply',
      headers: { ...AUTHZ, 'content-type': 'application/json' },
      payload: '{not json',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('HARNESS-1009');
  });

  it('POST apply 抛 UPDATE_IN_PROGRESS → 409 HARNESS-8004', async () => {
    const fake = makeFakeUpdater({ applyError: err('UPDATE_IN_PROGRESS') });
    const { app } = buildServer(fake);
    const res = await app.inject({ method: 'POST', url: '/api/v1/system/update/apply', headers: AUTHZ });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('HARNESS-8004');
  });

  it('GET history 透传历史数组（200）', async () => {
    const fake = makeFakeUpdater({
      historyResult: [
        { version: '2.0.0', appliedAt: 1_700_000_000_000, ok: true },
        { version: '1.9.0', appliedAt: 1_690_000_000_000, ok: true },
      ],
    });
    const { app } = buildServer(fake);
    const res = await app.inject({ method: 'GET', url: '/api/v1/system/update/history', headers: AUTHZ });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(2);
    expect(res.json()[0]).toEqual({ version: '2.0.0', appliedAt: 1_700_000_000_000, ok: true });
    expect(fake.history).toHaveBeenCalledTimes(1);
  });
});
