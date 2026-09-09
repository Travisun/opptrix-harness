/**
 * subagents REST API 集成测试（真实 fastify 注入 + 真 SubagentManager + 真实库 + StubRunner）。
 *
 * - 鉴权：无 token 401；role normal 可读写（子代理是 LLM 驱动核心面）；
 * - POST /api/v1/subagents：201（缺省 parentId='main'）、prompt 缺失 400、非法 JSON 400、
 *   树约束违反（深度超限）400 BAD_REQUEST；
 * - GET /api/v1/subagents：status/depth 过滤、非法 status 400；
 * - GET /api/v1/subagents/:id：200 / 404 HARNESS-3004 形状；
 * - GET /api/v1/subagents/:id/transcript：transcript 事件落库后返回消息数组；
 * - POST /api/v1/subagents/:id/cancel：running → cancelled=true、终态幂等 cancelled=false、404。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import pino from 'pino';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Knex } from 'knex';

import { registerSubagentRoutes } from '../src/api/subagents.js';
import { SubagentManager } from '../src/kernel/agents/manager.js';
import { SubagentStore } from '../src/kernel/agents/store.js';
import type { SubagentRunnerEvent } from '../src/kernel/agents/types.js';
import { loadConfig } from '../src/kernel/config/index.js';
import { err } from '../src/kernel/errors/HarnessError.js';
import { createHttpServer } from '../src/kernel/http/server.js';
import { closeDb, openSqlite } from '../src/kernel/storage/db.js';
import { KERNEL_MIGRATIONS } from '../src/kernel/storage/kernel-migrations.js';
import { Migrator } from '../src/kernel/storage/migrator.js';

const logger = pino({ level: 'silent' });
const tick = (ms = 25): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const NORMAL_TOKEN = 'token-normal';
const AUTH = { authorization: `Bearer ${NORMAL_TOKEN}` };

/** 统一认证入口替身：任意已知 token 以 normal 角色放行（子代理面对全部角色开放） */
const checker = async ({ token }: { token?: string }): Promise<{ role: string } & Record<string, unknown>> => {
  if (token === NORMAL_TOKEN) return { userId: 'user-1', role: 'normal', scopes: [] };
  throw err('UNAUTHORIZED', { detail: 'token rejected by all auth providers' });
};

/** StubRunner：run 只登记不执行（事件/释放由测试手动驱动） */
class StubRunner {
  readonly held: Array<{
    agentId: string;
    onEvent: (e: SubagentRunnerEvent) => Promise<void>;
    release: () => void;
  }> = [];

  run(
    input: { agentId: string },
    onEvent: (e: SubagentRunnerEvent) => Promise<void>,
  ): Promise<void> {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.held.push({ agentId: input.agentId, onEvent, release });
    return promise;
  }

  byId(id: string): { agentId: string; onEvent: (e: SubagentRunnerEvent) => Promise<void>; release: () => void } {
    const call = this.held.find((c) => c.agentId === id);
    if (call === undefined) throw new Error(`StubRunner: no held call for "${id}"`);
    return call;
  }

  async done(id: string, result: string): Promise<void> {
    await this.byId(id).onEvent({ type: 'done', result });
    this.byId(id).release();
  }
}

let dir: string;
let db: Knex;
let store: SubagentStore;
let app: FastifyInstance;
let stub: StubRunner;
let manager: SubagentManager;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'opptrix-subagents-api-'));
  db = await openSqlite(join(dir, 'subagents-api.sqlite'));
  const migrator = new Migrator(db, { migrations: KERNEL_MIGRATIONS });
  await migrator.latest();
  store = new SubagentStore(db);
  stub = new StubRunner();
  manager = new SubagentManager({ store, runner: (input, onEvent) => stub.run(input, onEvent), logger });

  const config = loadConfig({ NODE_ENV: 'test', HARNESS_LOG_LEVEL: 'error', HARNESS_DATA_DIR: dir });
  const server = createHttpServer({
    config,
    logger: pino({ level: 'silent' }),
    isReady: () => true,
    state: () => 'ready',
    registerExtra: (a) => {
      registerSubagentRoutes(a, { checker, manager });
    },
  });
  app = server.app;
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await closeDb(db);
  rmSync(dir, { recursive: true, force: true });
});

describe('鉴权', () => {
  it('无 token → 401（全部路由）', async () => {
    const get = await app.inject({ method: 'GET', url: '/api/v1/subagents' });
    expect(get.statusCode).toBe(401);
    const post = await app.inject({ method: 'POST', url: '/api/v1/subagents', payload: { prompt: 'x' } });
    expect(post.statusCode).toBe(401);
  });
});

describe('POST /api/v1/subagents', () => {
  it('normal 角色 201（缺省 parentId=main）→ 记录 running、runner 收到 prompt', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/subagents',
      headers: AUTH,
      payload: { prompt: 'do research', model: 'm1' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as Record<string, unknown>;
    expect(body).toMatchObject({ parentId: 'main', depth: 1, status: 'running', prompt: 'do research', model: 'm1' });
    await tick();
    expect(stub.byId(body.id as string).agentId).toBe(body.id);
  });

  it('prompt 缺失 → 400 VALIDATION_FAILED', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/subagents', headers: AUTH, payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'HARNESS-1009' });
  });

  it('非法 JSON body → 400 VALIDATION_FAILED', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/subagents',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: '{not-json',
    });
    expect(res.statusCode).toBe(400);
  });

  it('树约束违反（孙辈超 maxDepth=2）→ 400 BAD_REQUEST', async () => {
    const parent = await app.inject({
      method: 'POST',
      url: '/api/v1/subagents',
      headers: AUTH,
      payload: { prompt: 'p1' },
    });
    const parentId = (parent.json() as { id: string }).id;
    const child = await app.inject({
      method: 'POST',
      url: '/api/v1/subagents',
      headers: AUTH,
      payload: { prompt: 'p2', parentId },
    });
    expect(child.statusCode).toBe(201);
    const grandchild = await app.inject({
      method: 'POST',
      url: '/api/v1/subagents',
      headers: AUTH,
      payload: { prompt: 'p3', parentId: (child.json() as { id: string }).id },
    });
    expect(grandchild.statusCode).toBe(400);
    expect(grandchild.json()).toMatchObject({
      code: 'HARNESS-1008',
      message: expect.stringContaining('max subagent depth exceeded'),
    });
  });
});

describe('GET /api/v1/subagents（列表）', () => {
  it('status/depth 过滤 + 非法 status 400', async () => {
    const a = await app.inject({ method: 'POST', url: '/api/v1/subagents', headers: AUTH, payload: { prompt: 'a' } });
    const aId = (a.json() as { id: string }).id;
    await tick();
    await stub.done(aId, 'ok');
    await tick();
    const b = await app.inject({ method: 'POST', url: '/api/v1/subagents', headers: AUTH, payload: { prompt: 'b' } });
    await tick();

    const done = await app.inject({ method: 'GET', url: '/api/v1/subagents?status=done', headers: AUTH });
    expect(done.statusCode).toBe(200);
    const doneItems = done.json() as Array<Record<string, unknown>>;
    expect(doneItems.map((r) => r.id)).toContain(aId);

    const running = await app.inject({ method: 'GET', url: '/api/v1/subagents?status=running', headers: AUTH });
    const runningItems = running.json() as Array<Record<string, unknown>>;
    expect(runningItems.map((r) => r.id)).toContain((b.json() as { id: string }).id);
    expect(runningItems.map((r) => r.id)).not.toContain(aId);

    const depth1 = await app.inject({ method: 'GET', url: '/api/v1/subagents?depth=1', headers: AUTH });
    expect((depth1.json() as unknown[]).length).toBeGreaterThanOrEqual(2);

    const bad = await app.inject({ method: 'GET', url: '/api/v1/subagents?status=bogus', headers: AUTH });
    expect(bad.statusCode).toBe(400);
  });
});

describe('GET /:id 与 /:id/transcript', () => {
  it('读取单个（200）；未知 id → 404 HARNESS-3004 形状', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/subagents',
      headers: AUTH,
      payload: { prompt: 'get me' },
    });
    const id = (created.json() as { id: string }).id;
    const got = await app.inject({ method: 'GET', url: `/api/v1/subagents/${id}`, headers: AUTH });
    expect(got.statusCode).toBe(200);
    expect(got.json()).toMatchObject({ id, prompt: 'get me' });

    const missing = await app.inject({ method: 'GET', url: '/api/v1/subagents/no-such-id', headers: AUTH });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: 'HARNESS-3004' });
  });

  it('transcript 事件落库后 GET /:id/transcript 返回消息数组', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/subagents',
      headers: AUTH,
      payload: { prompt: 'transcript me' },
    });
    const id = (created.json() as { id: string }).id;
    await tick();
    await stub.byId(id).onEvent({ type: 'transcript', messages: [{ role: 'user', content: 'transcript me' }] });
    await stub.done(id, 'ok');
    await tick();
    const res = await app.inject({ method: 'GET', url: `/api/v1/subagents/${id}/transcript`, headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id,
      status: 'done',
      messages: [{ role: 'user', content: 'transcript me' }],
    });
  });
});

describe('POST /:id/cancel', () => {
  it('running → cancelled=true；终态幂等 cancelled=false；未知 id 404', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/subagents',
      headers: AUTH,
      payload: { prompt: 'cancel me' },
    });
    const id = (created.json() as { id: string }).id;
    await tick();
    const cancel = await app.inject({ method: 'POST', url: `/api/v1/subagents/${id}/cancel`, headers: AUTH });
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json()).toMatchObject({ ok: true, cancelled: true });

    const again = await app.inject({ method: 'POST', url: `/api/v1/subagents/${id}/cancel`, headers: AUTH });
    expect(again.json()).toMatchObject({ ok: true, cancelled: false }); // 终态幂等

    const missing = await app.inject({ method: 'POST', url: '/api/v1/subagents/no-such-id/cancel', headers: AUTH });
    expect(missing.statusCode).toBe(404);
  });
});
