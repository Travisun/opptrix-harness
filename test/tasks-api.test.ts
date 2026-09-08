/**
 * tasks REST API 集成测试（真实 fastify 注入 + 真 TaskManager + 真实库）。
 *
 * - 两个被测服务器：
 *   - real：真 TaskWorkerPool(size=2)——echo 全链路（dispatch 201 → 轮询 get 直到 done）；
 *   - stub：StubPool（run 只登记不执行）——cancel（queued/running）、list 过滤的确定性断言；
 * - 覆盖：无 token 401、normal dispatch 403（GET 任意已认证角色可读）、dispatch echo 201
 *   → 轮询至 done（≤5s）、未知 name 400 BAD_REQUEST、body 校验 400、404 形状、
 *   cancel → 状态 cancelled（含幂等）、list extId/status/limit 过滤。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import pino from 'pino';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Knex } from 'knex';

import { registerTaskRoutes } from '../src/api/tasks.js';
import { TaskManager } from '../src/kernel/tasks/manager.js';
import { TaskStore, type TaskRecord } from '../src/kernel/tasks/store.js';
import { TaskWorkerPool } from '../src/kernel/tasks/worker-pool.js';
import { loadConfig } from '../src/kernel/config/index.js';
import { err } from '../src/kernel/errors/HarnessError.js';
import { createHttpServer } from '../src/kernel/http/server.js';
import { closeDb, openSqlite } from '../src/kernel/storage/db.js';
import { KERNEL_MIGRATIONS } from '../src/kernel/storage/kernel-migrations.js';
import { Migrator } from '../src/kernel/storage/migrator.js';

const logger = pino({ level: 'silent' });
const tick = (ms = 25): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const ADMIN_TOKEN = 'token-admin';
const ROOT_TOKEN = 'token-root';
const NORMAL_TOKEN = 'token-normal';

const AUTH_ADMIN = { authorization: `Bearer ${ADMIN_TOKEN}` };
const AUTH_ROOT = { authorization: `Bearer ${ROOT_TOKEN}` };
const AUTH_NORMAL = { authorization: `Bearer ${NORMAL_TOKEN}` };

/** 统一认证入口（与 authProxy.createAuthChecker 语义一致的测试替身） */
const checker = async ({ token }: { token?: string }): Promise<{ role: string } & Record<string, unknown>> => {
  if (token === ADMIN_TOKEN) return { userId: 'admin-1', role: 'admin', scopes: ['tasks'] };
  if (token === ROOT_TOKEN) return { userId: 'root', role: 'root', scopes: ['*'] };
  if (token === NORMAL_TOKEN) return { userId: 'user-1', role: 'normal', scopes: [] };
  throw err('UNAUTHORIZED', { detail: 'token rejected by all auth providers' });
};

/** 池替身：run() 只登记不执行（cancel/list 用例的确定性时序） */
class StubPool {
  readonly held: Array<{ taskId: string; name: string; args: unknown }> = [];

  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  run(taskId: string, name: string, args: unknown): Promise<void> {
    this.held.push({ taskId, name, args });
    return Promise.resolve();
  }
}

interface ServerCtx {
  app: FastifyInstance;
  manager: TaskManager;
  stop: () => Promise<void>;
}

let dir: string;
let db: Knex;
let store: TaskStore;
let real: ServerCtx; // 真 TaskWorkerPool：echo 全链路
let stub: ServerCtx; // StubPool：cancel/list 确定性

/** 组装被测服务器（真库 + 真 manager + 注入池），manager 由本函数负责启停 */
function buildServer(manager: TaskManager): ServerCtx {
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
      registerTaskRoutes(a, { checker, manager });
    },
  });
  return {
    app,
    manager,
    stop: async () => {
      await manager.stop();
    },
  };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'opptrix-tasks-api-'));
  db = await openSqlite(join(dir, 'tasks-api.sqlite'));
  const migrator = new Migrator(db, { migrations: KERNEL_MIGRATIONS });
  await migrator.latest();
  store = new TaskStore(db);

  // manager 需在路由注册前存在；真池回调经 holder 回接（规避 manager/pool 构造互指）
  const holder: { manager?: TaskManager } = {};
  const realPool = new TaskWorkerPool({
    size: 2,
    logger,
    onProgress: (id, pct, msg) => holder.manager?.onProgress(id, pct, msg),
    onDone: (id, result) => holder.manager?.onDone(id, result),
    onFailed: (id, error) => holder.manager?.onFailed(id, error),
  });
  const realManager = new TaskManager({
    store,
    pool: realPool,
    emit: (name, payload) => {
      logger.debug({ name }, '[tasks:test] emit');
      return { name, payload };
    },
    publish: () => {},
    logger,
    defaultTimeoutMs: 2000,
  });
  holder.manager = realManager;
  real = buildServer(realManager);

  const stubManager = new TaskManager({
    store,
    pool: new StubPool(),
    emit: () => ({ delivered: 0, errors: [] }),
    publish: () => {},
    logger,
    defaultTimeoutMs: 2000,
  });
  stub = buildServer(stubManager);

  await real.manager.start();
  await stub.manager.start();
});

/** 轮询 GET /api/v1/tasks/:id 直到条件满足（≤5s） */
async function pollTask(
  app: FastifyInstance,
  id: string,
  until: (rec: TaskRecord) => boolean,
  timeoutMs = 5000,
): Promise<TaskRecord> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await app.inject({ method: 'GET', url: `/api/v1/tasks/${id}`, headers: AUTH_ADMIN });
    expect(res.statusCode, `GET /tasks/${id} 应为 200（实际 ${res.statusCode}: ${res.body}）`).toBe(200);
    const rec = res.json() as TaskRecord;
    if (until(rec)) return rec;
    if (Date.now() > deadline) {
      throw new Error(`poll timeout for task ${id}: ${JSON.stringify(rec)}`);
    }
    await tick(20);
  }
}

afterAll(async () => {
  await real.stop();
  await stub.stop();
  await closeDb(db);
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 鉴权与角色门禁
// ---------------------------------------------------------------------------

describe('tasks api — 鉴权与角色门禁', () => {
  it.each([
    { method: 'GET', url: '/api/v1/tasks' },
    { method: 'POST', url: '/api/v1/tasks/dispatch', body: { name: 'echo' } },
    { method: 'GET', url: '/api/v1/tasks/some-id' },
    { method: 'POST', url: '/api/v1/tasks/some-id/cancel' },
  ] as const)('$method $url 无 token → 401 HARNESS-1006', async (route) => {
    const res = await real.app.inject({ method: route.method, url: route.url, ...(('body' in route ? { payload: route.body } : {})) });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('HARNESS-1006');
  });

  it.each([
    { method: 'POST', url: '/api/v1/tasks/dispatch', body: { name: 'echo' } },
    { method: 'POST', url: '/api/v1/tasks/some-id/cancel' },
  ] as const)('$method $url normal 角色 → 403 HARNESS-1007', async (route) => {
    const res = await real.app.inject({
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

  it('GET 列表/详情任意已认证角色可读（normal → 200）；root 亦可派发', async () => {
    const list = await stub.app.inject({ method: 'GET', url: '/api/v1/tasks', headers: AUTH_NORMAL });
    expect(list.statusCode).toBe(200);

    const dispatched = await real.app.inject({
      method: 'POST',
      url: '/api/v1/tasks/dispatch',
      headers: AUTH_ROOT,
      payload: { name: 'echo', args: 'by-root' },
    });
    expect(dispatched.statusCode).toBe(201);
    await pollTask(real.app, dispatched.json().id, (r) => r.status === 'done');
  });
});

// ---------------------------------------------------------------------------
// dispatch 全链路（真池）
// ---------------------------------------------------------------------------

describe('tasks api — POST /dispatch + GET 全链路', () => {
  it('dispatch echo → 201 TaskRecord；轮询 GET /:id 直到 done（≤5s），result/progress/时间戳齐备', async () => {
    const res = await real.app.inject({
      method: 'POST',
      url: '/api/v1/tasks/dispatch',
      headers: AUTH_ADMIN,
      payload: { name: 'echo', args: { answer: 42 }, extId: 'ext-api' },
    });
    expect(res.statusCode).toBe(201);
    const created = res.json() as TaskRecord;
    expect(created.name).toBe('echo');
    expect(created.extId).toBe('ext-api');
    expect(created.args).toEqual({ answer: 42 });
    expect(created.status).toBe('queued');
    expect(created.id).toBeTruthy();

    const done = await pollTask(real.app, created.id, (r) => r.status === 'done');
    expect(done.result).toEqual({ answer: 42 });
    expect(done.progress).toBe(50);
    expect(done.startedAt).not.toBeNull();
    expect(done.finishedAt).not.toBeNull();
  });

  it('未知 name → 400 HARNESS-1008 BAD_REQUEST（task type not registered）', async () => {
    const res = await real.app.inject({
      method: 'POST',
      url: '/api/v1/tasks/dispatch',
      headers: AUTH_ADMIN,
      payload: { name: 'export-report' },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.code).toBe('HARNESS-1008');
    expect(body.message).toContain('task type not registered');
  });

  it.each([
    ['name 缺失', { args: 1 }],
    ['name 空串', { name: '', args: 1 }],
    ['extId 空串', { name: 'echo', extId: '' }],
  ] as const)('body 非法（%s）→ 400 HARNESS-1009 VALIDATION_FAILED', async (_label, body) => {
    const res = await real.app.inject({
      method: 'POST',
      url: '/api/v1/tasks/dispatch',
      headers: AUTH_ADMIN,
      payload: body,
    });
    expect(res.statusCode).toBe(400);
    const json = res.json();
    expect(json.code).toBe('HARNESS-1009');
    expect(Array.isArray(json.detail)).toBe(true);
  });

  it('body 非法 JSON（解析失败）→ 400 HARNESS-1009', async () => {
    const res = await real.app.inject({
      method: 'POST',
      url: '/api/v1/tasks/dispatch',
      headers: { ...AUTH_ADMIN, 'content-type': 'application/json' },
      payload: '{"name": not-json',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('HARNESS-1009');
  });

  it('GET /:id 不存在 → 404 HARNESS-3004 形状', async () => {
    const res = await real.app.inject({ method: 'GET', url: '/api/v1/tasks/ghost', headers: AUTH_ADMIN });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('HARNESS-3004');
  });

  it('查询参数非法（status 枚举外 / limit 越界）→ 400 HARNESS-1009', async () => {
    for (const url of ['/api/v1/tasks?status=somewhere', '/api/v1/tasks?limit=0', '/api/v1/tasks?limit=abc']) {
      const res = await real.app.inject({ method: 'GET', url, headers: AUTH_ADMIN });
      expect(res.statusCode, url).toBe(400);
      expect(res.json().code).toBe('HARNESS-1009');
    }
  });
});

// ---------------------------------------------------------------------------
// cancel 与 list 过滤（stub 池：确定性时序）
// ---------------------------------------------------------------------------

describe('tasks api — POST /:id/cancel', () => {
  it('queued 任务取消 → { ok: true }；GET 状态 cancelled；重复取消幂等', async () => {
    const dispatched = await stub.app.inject({
      method: 'POST',
      url: '/api/v1/tasks/dispatch',
      headers: AUTH_ADMIN,
      payload: { name: 'echo', args: 1 },
    });
    expect(dispatched.statusCode).toBe(201);
    const id = (dispatched.json() as TaskRecord).id;
    expect((await stub.manager.get(id))?.status).toBe('queued'); // stub 池持有不执行

    const cancel = await stub.app.inject({ method: 'POST', url: `/api/v1/tasks/${id}/cancel`, headers: AUTH_ADMIN });
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json()).toEqual({ ok: true });

    const after = await pollTask(stub.app, id, (r) => r.status === 'cancelled');
    expect(after.finishedAt).not.toBeNull();

    const again = await stub.app.inject({ method: 'POST', url: `/api/v1/tasks/${id}/cancel`, headers: AUTH_ADMIN });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ ok: true });
    expect((await stub.manager.get(id))?.status).toBe('cancelled');
  });

  it('running 任务取消 → cancelled（迟到的池回调被 manager 丢弃）', async () => {
    const dispatched = await stub.app.inject({
      method: 'POST',
      url: '/api/v1/tasks/dispatch',
      headers: AUTH_ADMIN,
      payload: { name: 'echo', args: 2 },
    });
    const id = (dispatched.json() as TaskRecord).id;
    stub.manager.onProgress(id, 20, 'working'); // 手动推入 running（模拟池真实开跑）
    await tick();
    expect((await stub.manager.get(id))?.status).toBe('running');

    const cancel = await stub.app.inject({ method: 'POST', url: `/api/v1/tasks/${id}/cancel`, headers: AUTH_ADMIN });
    expect(cancel.statusCode).toBe(200);

    const after = await pollTask(stub.app, id, (r) => r.status === 'cancelled');
    expect(after.result).toBeNull();
  });

  it('cancel 未知 id → 404 HARNESS-3004', async () => {
    const res = await stub.app.inject({ method: 'POST', url: '/api/v1/tasks/ghost/cancel', headers: AUTH_ADMIN });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('HARNESS-3004');
  });
});

describe('tasks api — GET /api/v1/tasks 列表过滤', () => {
  it('?extId= / ?status= / ?limit= 组合过滤；缺省 limit=50', async () => {
    for (const payload of [
      { name: 'echo', args: 'a', extId: 'ext-a' },
      { name: 'echo', args: 'b', extId: 'ext-a' },
      { name: 'echo', args: 'c', extId: 'ext-b' },
    ]) {
      const res = await stub.app.inject({
        method: 'POST',
        url: '/api/v1/tasks/dispatch',
        headers: AUTH_ADMIN,
        payload,
      });
      expect(res.statusCode).toBe(201);
    }

    const byExt = await stub.app.inject({ method: 'GET', url: '/api/v1/tasks?extId=ext-a', headers: AUTH_ADMIN });
    expect(byExt.statusCode).toBe(200);
    const extA = byExt.json() as TaskRecord[];
    expect(extA).toHaveLength(2);
    expect(extA.every((r) => r.extId === 'ext-a')).toBe(true);

    const byStatus = await stub.app.inject({ method: 'GET', url: '/api/v1/tasks?status=queued', headers: AUTH_ADMIN });
    const queued = byStatus.json() as TaskRecord[];
    expect(queued.length).toBeGreaterThanOrEqual(3);
    expect(queued.every((r) => r.status === 'queued')).toBe(true);

    const doneList = await stub.app.inject({ method: 'GET', url: '/api/v1/tasks?status=done', headers: AUTH_ADMIN });
    const doneRows = doneList.json() as TaskRecord[]; // 真池用例已产生 done 任务：断言过滤语义而非空集
    expect(doneRows.length).toBeGreaterThanOrEqual(1);
    expect(doneRows.every((r) => r.status === 'done')).toBe(true);

    const limited = await stub.app.inject({ method: 'GET', url: '/api/v1/tasks?extId=ext-a&limit=1', headers: AUTH_ADMIN });
    expect((limited.json() as TaskRecord[])).toHaveLength(1);

    // 全量列表按 created_at 升序（FIFO）
    const all = await stub.app.inject({ method: 'GET', url: '/api/v1/tasks', headers: AUTH_ADMIN });
    const records = all.json() as TaskRecord[];
    const sorted = [...records].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
    expect(records).toEqual(sorted);
  });
});
