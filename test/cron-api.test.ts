/**
 * cron REST API 集成测试（真实 fastify 注入，经 createHttpServer 挂载 registerCronRoutes）。
 *
 * - 鉴权：真 openSqlite 临时库供 history 读数；CronSchedulerLike 用内存 stub
 *   记录全部调用（schedule/update/delete/runNow/list 入参可断言）；
 * - 覆盖：无 token 401、normal 角色 403、root 放行、创建 201 + 规范化入参
 *   （tz 缺省 'UTC'、enabled 缺省 true）、zod 校验失败 400、非法 JSON body 400、
 *   列表 extId 过滤、GET/PATCH/DELETE 的 404 HARNESS-3004、run 202（stub 收到
 *   runNow）、history 透传 limit 与默认 50。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pino from 'pino';
import type { FastifyInstance } from 'fastify';
import type { Knex } from 'knex';

import {
  registerCronRoutes,
  type CronJobCreateInput,
  type CronJobPatch,
  type CronSchedulerLike,
} from '../src/api/cron.js';
import { CronJobStore, type CronJobRecord } from '../src/kernel/cron/store.js';
import { loadConfig } from '../src/kernel/config/index.js';
import { err } from '../src/kernel/errors/HarnessError.js';
import { createHttpServer } from '../src/kernel/http/server.js';
import { closeDb, openSqlite } from '../src/kernel/storage/db.js';
import { KERNEL_MIGRATIONS } from '../src/kernel/storage/kernel-migrations.js';
import { Migrator } from '../src/kernel/storage/migrator.js';

const ADMIN_TOKEN = 'token-admin';
const ROOT_TOKEN = 'token-root';
const NORMAL_TOKEN = 'token-normal';

const AUTH_ADMIN = { authorization: `Bearer ${ADMIN_TOKEN}` };
const AUTH_ROOT = { authorization: `Bearer ${ROOT_TOKEN}` };
const AUTH_NORMAL = { authorization: `Bearer ${NORMAL_TOKEN}` };

/** 全部路由（鉴权用例遍历；POST/PATCH 附带合法 body，证明 401/403 先于校验发生） */
const ALL_ROUTES = [
  { method: 'GET', url: '/api/v1/cron' },
  { method: 'POST', url: '/api/v1/cron', body: { name: 'n', expr: '* * * * *' } },
  { method: 'GET', url: '/api/v1/cron/job-1' },
  { method: 'PATCH', url: '/api/v1/cron/job-1', body: { name: 'n2' } },
  { method: 'DELETE', url: '/api/v1/cron/job-1' },
  { method: 'POST', url: '/api/v1/cron/job-1/run' },
  { method: 'GET', url: '/api/v1/cron/job-1/history' },
] as const;

// ---------------------------------------------------------------------------
// CronSchedulerLike 内存 stub（记录调用 + 供 GET/PATCH/DELETE 读取）
// ---------------------------------------------------------------------------

class SchedulerStub implements CronSchedulerLike {
  readonly jobs = new Map<string, CronJobRecord>();
  readonly scheduleInputs: CronJobCreateInput[] = [];
  readonly updateInputs: Array<{ id: string; patch: CronJobPatch }> = [];
  readonly deletedIds: string[] = [];
  readonly runNowIds: string[] = [];
  readonly listOpts: Array<{ extId?: string | null } | undefined> = [];

  private seq = 0;

  seed(rec: CronJobRecord): void {
    this.jobs.set(rec.id, rec);
  }

  async schedule(input: CronJobCreateInput): Promise<CronJobRecord> {
    this.scheduleInputs.push(input);
    this.seq += 1;
    const rec: CronJobRecord = {
      ...input,
      id: `job-${this.seq}`,
      lastRun: null,
      nextRun: null,
      createdAt: 1_000 + this.seq,
    };
    this.jobs.set(rec.id, rec);
    return rec;
  }

  async list(opts?: { extId?: string | null }): Promise<CronJobRecord[]> {
    this.listOpts.push(opts);
    const all = [...this.jobs.values()];
    if (opts?.extId === undefined) return all;
    return opts.extId === null ? all.filter((r) => r.extId === null) : all.filter((r) => r.extId === opts.extId);
  }

  async get(id: string): Promise<CronJobRecord | null> {
    return this.jobs.get(id) ?? null;
  }

  async update(id: string, patch: CronJobPatch): Promise<CronJobRecord | null> {
    this.updateInputs.push({ id, patch });
    const rec = this.jobs.get(id);
    if (rec === undefined) return null;
    const next = { ...rec, ...patch };
    this.jobs.set(id, next);
    return next;
  }

  async unschedule(id: string): Promise<boolean> {
    this.deletedIds.push(id);
    return this.jobs.delete(id);
  }

  async runNow(id: string): Promise<void> {
    this.runNowIds.push(id);
  }
}

// ---------------------------------------------------------------------------
// 环境
// ---------------------------------------------------------------------------

let dir: string;
let db: Knex;
let store: CronJobStore;

let jobSeq = 0;

function makeJob(overrides: Partial<CronJobRecord> = {}): CronJobRecord {
  jobSeq += 1;
  return {
    id: overrides.id ?? `seed-${jobSeq}`,
    extId: null,
    name: 'seeded job',
    expr: '* * * * *',
    tz: 'UTC',
    payload: null,
    enabled: true,
    overlap: 'skip',
    misfire: 'skip',
    lastRun: null,
    nextRun: null,
    createdAt: 1_000 + jobSeq,
    ...overrides,
  };
}

interface BuildCtx {
  app: FastifyInstance;
  scheduler: SchedulerStub;
  historyCalls: Array<{ jobId: string; limit?: number }>;
}

/** 组装被测服务器：真 openSqlite 库 + 内存 scheduler stub + 可断言的 history 透传层 */
function buildServer(): BuildCtx {
  const scheduler = new SchedulerStub();
  const historyCalls: Array<{ jobId: string; limit?: number }> = [];
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
      registerCronRoutes(a, {
        checker: async ({ token }) => {
          if (token === ADMIN_TOKEN) return { userId: 'admin-1', role: 'admin', scopes: ['cron'] };
          if (token === ROOT_TOKEN) return { userId: 'root', role: 'root', scopes: ['*'] };
          if (token === NORMAL_TOKEN) return { userId: 'user-1', role: 'normal', scopes: [] };
          throw err('UNAUTHORIZED', { detail: 'token rejected by all auth providers' });
        },
        scheduler,
        history: async (jobId, limit) => {
          historyCalls.push({ jobId, limit });
          return store.history(jobId, limit);
        },
      });
    },
  });
  return { app, scheduler, historyCalls };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'opptrix-cron-api-'));
  db = await openSqlite(join(dir, 'cron-api.sqlite'));
  const migrator = new Migrator(db, { migrations: KERNEL_MIGRATIONS });
  await migrator.latest();
  store = new CronJobStore(db);
});

afterAll(async () => {
  await closeDb(db);
  rmSync(dir, { recursive: true, force: true });
});

describe('cron api — 鉴权与角色门禁', () => {
  it.each(ALL_ROUTES)('$method $url 无 token → 401 HARNESS-1006', async (route) => {
    const { app } = buildServer();
    const res = await app.inject({
      method: route.method,
      url: route.url,
      ...( 'body' in route ? { payload: route.body } : {}),
    });
    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.code).toBe('HARNESS-1006');
    expect(body.retryable).toBe(false);
  });

  it.each(ALL_ROUTES)('$method $url normal 角色 → 403 HARNESS-1007', async (route) => {
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

  it('root 角色放行；?token= 亦可认证', async () => {
    const { app } = buildServer();
    const viaHeader = await app.inject({ method: 'GET', url: '/api/v1/cron', headers: AUTH_ROOT });
    expect(viaHeader.statusCode).toBe(200);
    const viaQuery = await app.inject({ method: 'GET', url: `/api/v1/cron?token=${ADMIN_TOKEN}` });
    expect(viaQuery.statusCode).toBe(200);
  });
});

describe('cron api — POST /api/v1/cron（创建与校验）', () => {
  it('最小 body 创建 → 201；scheduler.schedule 收到规范化参数（tz 缺省 UTC、enabled 缺省 true）', async () => {
    const { app, scheduler } = buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/cron',
      headers: AUTH_ADMIN,
      payload: { name: 'nightly', expr: '0 3 * * *' },
    });
    expect(res.statusCode).toBe(201);
    expect(scheduler.scheduleInputs).toEqual([
      {
        name: 'nightly',
        expr: '0 3 * * *',
        tz: 'UTC',
        payload: null,
        enabled: true,
        overlap: 'skip',
        misfire: 'skip',
        extId: null,
      },
    ]);
    expect(res.json()).toMatchObject({ id: 'job-1', name: 'nightly', tz: 'UTC', enabled: true, extId: null });
  });

  it('全量 body 创建 → 各字段原样透传给 schedule', async () => {
    const { app, scheduler } = buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/cron',
      headers: AUTH_ADMIN,
      payload: {
        name: 'export',
        expr: '*/10 * * * *',
        tz: 'Asia/Shanghai',
        payload: { kind: 'report', rows: 10 },
        enabled: false,
        overlap: 'queue',
        misfire: 'runOnce',
        extId: 'echo-bot',
      },
    });
    expect(res.statusCode).toBe(201);
    expect(scheduler.scheduleInputs[0]).toEqual({
      name: 'export',
      expr: '*/10 * * * *',
      tz: 'Asia/Shanghai',
      payload: { kind: 'report', rows: 10 },
      enabled: false,
      overlap: 'queue',
      misfire: 'runOnce',
      extId: 'echo-bot',
    });
    expect(res.json()).toMatchObject({ id: 'job-1', enabled: false, overlap: 'queue', extId: 'echo-bot' });
  });

  it.each([
    ['name 缺失', { expr: '* * * * *' }],
    ['name 超 128 字符', { name: 'x'.repeat(129), expr: '* * * * *' }],
    ['expr 缺失', { name: 'a' }],
    ['expr 空串', { name: 'a', expr: '' }],
    ['overlap 非法枚举', { name: 'a', expr: '* * * * *', overlap: 'sometimes' }],
    ['enabled 非布尔', { name: 'a', expr: '* * * * *', enabled: 'yes' }],
    ['extId 空串', { name: 'a', expr: '* * * * *', extId: '' }],
  ])('body 非法（%s）→ 400 HARNESS-1009 VALIDATION_FAILED', async (_label, body) => {
    const { app } = buildServer();
    const res = await app.inject({ method: 'POST', url: '/api/v1/cron', headers: AUTH_ADMIN, payload: body });
    expect(res.statusCode).toBe(400);
    const json = res.json();
    expect(json.code).toBe('HARNESS-1009');
    expect(Array.isArray(json.detail)).toBe(true);
    expect(json.detail.length).toBeGreaterThan(0);
  });

  it('body 非法 JSON（解析失败）→ 400 HARNESS-1009', async () => {
    const { app } = buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/cron',
      headers: { ...AUTH_ADMIN, 'content-type': 'application/json' },
      payload: '{"name": not-json',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('HARNESS-1009');
  });
});

describe('cron api — 列表与详情', () => {
  it('GET 列表返回全部；?extId= 过滤参数透传给 scheduler.list', async () => {
    const { app, scheduler } = buildServer();
    scheduler.seed(makeJob({ id: 'j-kernel', extId: null }));
    scheduler.seed(makeJob({ id: 'j-ext', extId: 'echo-bot' }));

    const all = await app.inject({ method: 'GET', url: '/api/v1/cron', headers: AUTH_ADMIN });
    expect(all.statusCode).toBe(200);
    expect(all.json().map((r: { id: string }) => r.id).sort()).toEqual(['j-ext', 'j-kernel']);
    expect(scheduler.listOpts).toEqual([undefined]);

    const filtered = await app.inject({ method: 'GET', url: '/api/v1/cron?extId=echo-bot', headers: AUTH_ADMIN });
    expect(filtered.statusCode).toBe(200);
    expect(filtered.json().map((r: { id: string }) => r.id)).toEqual(['j-ext']);
    expect(scheduler.listOpts).toEqual([undefined, { extId: 'echo-bot' }]);
  });

  it('GET /:id 存在 → 200 record；不存在 → 404 HARNESS-3004', async () => {
    const { app, scheduler } = buildServer();
    scheduler.seed(makeJob({ id: 'j1', name: 'seen' }));

    const ok = await app.inject({ method: 'GET', url: '/api/v1/cron/j1', headers: AUTH_ADMIN });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ id: 'j1', name: 'seen' });

    const miss = await app.inject({ method: 'GET', url: '/api/v1/cron/ghost', headers: AUTH_ADMIN });
    expect(miss.statusCode).toBe(404);
    expect(miss.json().code).toBe('HARNESS-3004');
  });
});

describe('cron api — PATCH / DELETE', () => {
  it('PATCH 只透传给出的字段并返回更新后 record；不存在 → 404；body 非法 → 400', async () => {
    const { app, scheduler } = buildServer();
    scheduler.seed(makeJob({ id: 'j1', name: 'before', tz: 'UTC', expr: '* * * * *' }));

    const ok = await app.inject({
      method: 'PATCH',
      url: '/api/v1/cron/j1',
      headers: AUTH_ADMIN,
      payload: { name: 'renamed', tz: 'Asia/Tokyo' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ id: 'j1', name: 'renamed', tz: 'Asia/Tokyo', expr: '* * * * *' });
    expect(scheduler.updateInputs).toEqual([{ id: 'j1', patch: { name: 'renamed', tz: 'Asia/Tokyo' } }]);

    const miss = await app.inject({
      method: 'PATCH',
      url: '/api/v1/cron/ghost',
      headers: AUTH_ADMIN,
      payload: { name: 'x' },
    });
    expect(miss.statusCode).toBe(404);
    expect(miss.json().code).toBe('HARNESS-3004');

    const bad = await app.inject({
      method: 'PATCH',
      url: '/api/v1/cron/j1',
      headers: AUTH_ADMIN,
      payload: { enabled: 'sure' },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().code).toBe('HARNESS-1009');
  });

  it('DELETE 存在 → {deleted:true}；再次删除 → 404 HARNESS-3004', async () => {
    const { app, scheduler } = buildServer();
    scheduler.seed(makeJob({ id: 'j1' }));

    const ok = await app.inject({ method: 'DELETE', url: '/api/v1/cron/j1', headers: AUTH_ADMIN });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ deleted: true });
    expect(scheduler.deletedIds).toEqual(['j1']);

    const again = await app.inject({ method: 'DELETE', url: '/api/v1/cron/j1', headers: AUTH_ADMIN });
    expect(again.statusCode).toBe(404);
    expect(again.json().code).toBe('HARNESS-3004');
  });
});

describe('cron api — 立即触发与执行历史', () => {
  it('POST /:id/run → 202 {started:true} 且 stub 收到 runNow；不存在 → 404 且不触发', async () => {
    const { app, scheduler } = buildServer();
    scheduler.seed(makeJob({ id: 'j1' }));

    const ok = await app.inject({ method: 'POST', url: '/api/v1/cron/j1/run', headers: AUTH_ADMIN });
    expect(ok.statusCode).toBe(202);
    expect(ok.json()).toEqual({ started: true });
    expect(scheduler.runNowIds).toEqual(['j1']);

    const miss = await app.inject({ method: 'POST', url: '/api/v1/cron/ghost/run', headers: AUTH_ADMIN });
    expect(miss.statusCode).toBe(404);
    expect(miss.json().code).toBe('HARNESS-3004');
    expect(scheduler.runNowIds).toEqual(['j1']); // 未新增触发
  });

  it('GET /:id/history?limit=2 透传 limit；数据来自真实库且最新在前', async () => {
    const { app, scheduler, historyCalls } = buildServer();
    scheduler.seed(makeJob({ id: 'hist-a' }));
    await store.recordRun({ jobId: 'hist-a', startedAt: 300, finishedAt: 310, ok: true, durationMs: 10 });
    await store.recordRun({ jobId: 'hist-a', startedAt: 100, ok: false, error: 'boom' });
    await store.recordRun({ jobId: 'hist-a', startedAt: 200, ok: true });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/cron/hist-a/history?limit=2',
      headers: AUTH_ADMIN,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      { startedAt: 300, finishedAt: 310, ok: true, durationMs: 10, error: null },
      { startedAt: 200, finishedAt: null, ok: true, durationMs: null, error: null },
    ]);
    expect(historyCalls).toEqual([{ jobId: 'hist-a', limit: 2 }]);
  });

  it('缺省 limit 默认 50；limit 非法 → 400；任务不存在 → 404', async () => {
    const { app, scheduler, historyCalls } = buildServer();
    scheduler.seed(makeJob({ id: 'hist-b' }));

    const ok = await app.inject({ method: 'GET', url: '/api/v1/cron/hist-b/history', headers: AUTH_ADMIN });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual([]);
    expect(historyCalls).toEqual([{ jobId: 'hist-b', limit: 50 }]);

    for (const bad of ['0', '501', 'abc', '-3']) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/cron/hist-b/history?limit=${bad}`,
        headers: AUTH_ADMIN,
      });
      expect(res.statusCode, `limit=${bad} 应为 400`).toBe(400);
      expect(res.json().code).toBe('HARNESS-1009');
    }
    expect(historyCalls).toHaveLength(1); // 非法 limit 均未透传

    const miss = await app.inject({ method: 'GET', url: '/api/v1/cron/ghost/history', headers: AUTH_ADMIN });
    expect(miss.statusCode).toBe(404);
    expect(miss.json().code).toBe('HARNESS-3004');
  });
});
