/**
 * files REST API 集成测试（真实 fastify 注入 + @fastify/multipart + 真库 + 临时目录）。
 *
 * 覆盖：无 token 401（全部路由）、multipart 上传 201（field 'file'，?extId= 透传）、
 * normal 角色可上传（已认证即可）、列表 extId/limit 过滤、public 下载内容一致
 * （Content-Type / Content-Disposition）、private 下载 normal 403 / admin 可读、
 * 下载与删除 404、删除 admin-only、超大文件 413 PAYLOAD_TOO_LARGE、
 * 非 multipart Content-Type → 400。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pino from 'pino';
import type { FastifyInstance } from 'fastify';
import type { Knex } from 'knex';

import { registerFileRoutes } from '../src/api/files.js';
import { err } from '../src/kernel/errors/HarnessError.js';
import { createLocalDriver } from '../src/kernel/files/drivers/local.js';
import { FileService } from '../src/kernel/files/service.js';
import { HookManager } from '../src/kernel/hooks/manager.js';
import { EventBus } from '../src/kernel/events/bus.js';
import { createHttpServer } from '../src/kernel/http/server.js';
import { closeDb, openSqlite } from '../src/kernel/storage/db.js';
import { KERNEL_MIGRATIONS } from '../src/kernel/storage/kernel-migrations.js';
import { Migrator } from '../src/kernel/storage/migrator.js';
import { loadConfig } from '../src/kernel/config/index.js';

const ADMIN_TOKEN = 'token-admin';
const ROOT_TOKEN = 'token-root';
const NORMAL_TOKEN = 'token-normal';

const AUTH_ADMIN = { authorization: `Bearer ${ADMIN_TOKEN}` };
const AUTH_ROOT = { authorization: `Bearer ${ROOT_TOKEN}` };
const AUTH_NORMAL = { authorization: `Bearer ${NORMAL_TOKEN}` };

// ---------------------------------------------------------------------------
// 环境
// ---------------------------------------------------------------------------

let dir: string;
let db: Knex;
let rootSeq = 0;
let boundarySeq = 0;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'opptrix-files-api-'));
  db = await openSqlite(join(dir, 'kernel.sqlite'));
  const migrator = new Migrator(db, { migrations: KERNEL_MIGRATIONS });
  await migrator.latest();
});

afterAll(async () => {
  await closeDb(db);
  rmSync(dir, { recursive: true, force: true });
});

/** 构造被测服务器：真库（每次清空 files 表）+ 真 FileService + 独立 driver root */
async function buildServer(opts: { maxUploadBytes?: number } = {}): Promise<{
  app: FastifyInstance;
  service: FileService;
}> {
  await db('files').del();
  rootSeq += 1;
  const driver = createLocalDriver(join(dir, `root-${rootSeq}`));
  const service = new FileService({
    driver,
    db,
    hooks: new HookManager(),
    emit: new EventBus().emit.bind(new EventBus()),
    logger: pino({ level: 'silent' }),
    maxUploadBytes: opts.maxUploadBytes ?? 1024 * 1024,
  });
  const config = loadConfig({ NODE_ENV: 'test', HARNESS_LOG_LEVEL: 'error', HARNESS_DATA_DIR: dir });
  const { app } = createHttpServer({
    config,
    logger: pino({ level: 'silent' }),
    isReady: () => true,
    state: () => 'ready',
    registerExtra: (a) => {
      registerFileRoutes(a, {
        checker: async ({ token }) => {
          if (token === ADMIN_TOKEN) return { userId: 'admin-1', role: 'admin', scopes: ['files'] };
          if (token === ROOT_TOKEN) return { userId: 'root', role: 'root', scopes: ['*'] };
          if (token === NORMAL_TOKEN) return { userId: 'user-1', role: 'normal', scopes: [] };
          throw err('UNAUTHORIZED', { detail: 'token rejected by all auth providers' });
        },
        service,
        maxUploadBytes: opts.maxUploadBytes ?? 1024 * 1024,
      });
    },
  });
  return { app, service };
}

/** 手工构造 multipart/form-data 请求体（field 名固定 'file'） */
function multipartBody(filename: string, mime: string, content: Buffer): {
  payload: Buffer;
  headers: Record<string, string>;
} {
  boundarySeq += 1;
  const boundary = `----opptrixboundary${boundarySeq}`;
  const head =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: ${mime}\r\n\r\n`;
  const tail = `\r\n--${boundary}--\r\n`;
  return {
    payload: Buffer.concat([Buffer.from(head, 'utf8'), content, Buffer.from(tail, 'utf8')]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

interface UploadResult {
  id: string;
  origName: string;
  mime: string;
  size: number;
  extId: string | null;
  visibility: string;
  path: string;
  createdAt: number;
}

/** 便捷上传（默认 admin、private） */
async function upload(
  app: FastifyInstance,
  opts: { name?: string; mime?: string; content?: Buffer; extId?: string; token?: Record<string, string> } = {},
): Promise<{ status: number; body: UploadResult }> {
  const { payload, headers } = multipartBody(
    opts.name ?? 'hello.txt',
    opts.mime ?? 'text/plain',
    opts.content ?? Buffer.from('hello world', 'utf8'),
  );
  const res = await app.inject({
    method: 'POST',
    url: opts.extId === undefined ? '/api/v1/files' : `/api/v1/files?extId=${opts.extId}`,
    headers: { ...(opts.token ?? AUTH_ADMIN), ...headers },
    payload,
  });
  return { status: res.statusCode, body: res.json() as UploadResult };
}

// ---------------------------------------------------------------------------
// 鉴权
// ---------------------------------------------------------------------------

describe('files api — 鉴权', () => {
  it.each([
    ['POST', '/api/v1/files'],
    ['GET', '/api/v1/files'],
    ['GET', '/api/v1/files/some-id'],
    ['DELETE', '/api/v1/files/some-id'],
  ])('%s %s 无 token → 401 HARNESS-1006', async (method, url) => {
    const { app } = await buildServer();
    const res = await app.inject({ method, url });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('HARNESS-1006');
  });

  it('?token= 亦可认证（下载场景友好）', async () => {
    const { app, service } = await buildServer();
    const rec = await service.store({ data: Buffer.from('pub', 'utf8'), origName: 'p.txt', visibility: 'public' });
    const res = await app.inject({ method: 'GET', url: `/api/v1/files/${rec.id}?token=${NORMAL_TOKEN}` });
    expect(res.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 上传
// ---------------------------------------------------------------------------

describe('files api — POST /api/v1/files', () => {
  it('multipart 上传 → 201 FileRecord，元数据与磁盘内容一致，?extId= 透传', async () => {
    const { app, service } = await buildServer();
    const { status, body } = await upload(app, { extId: 'demo', name: 'report.txt', content: Buffer.from('R1', 'utf8') });

    expect(status).toBe(201);
    expect(body).toMatchObject({
      origName: 'report.txt',
      mime: 'text/plain',
      size: 2,
      extId: 'demo',
      visibility: 'private',
    });
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.path).toMatch(/^\d{4}\/\d{2}\/[0-9a-f-]{36}\.txt$/);

    const { record, data } = await service.read(body.id, { allowPrivate: true });
    expect(data.toString('utf8')).toBe('R1');
    expect(record.origName).toBe('report.txt');
  });

  it('normal 角色已认证即可上传（无需 admin）', async () => {
    const { app } = await buildServer();
    const { status, body } = await upload(app, { token: AUTH_NORMAL });
    expect(status).toBe(201);
    expect(body.origName).toBe('hello.txt');
  });

  it('非 multipart Content-Type → 400 BAD_REQUEST', async () => {
    const { app } = await buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/files',
      headers: { ...AUTH_ADMIN, 'content-type': 'application/json' },
      payload: { nope: true },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('HARNESS-1008');
  });

  it('超大文件 → 413 HARNESS-1005 PAYLOAD_TOO_LARGE', async () => {
    const { app } = await buildServer({ maxUploadBytes: 64 });
    const { payload, headers } = multipartBody('big.bin', 'application/octet-stream', Buffer.alloc(200, 1));
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/files',
      headers: { ...AUTH_ADMIN, ...headers },
      payload,
    });
    expect(res.statusCode).toBe(413);
    expect(res.json().code).toBe('HARNESS-1005');
  });
});

// ---------------------------------------------------------------------------
// 列表与下载
// ---------------------------------------------------------------------------

describe('files api — GET 列表与下载', () => {
  it('GET ?extId=&limit= 过滤列表', async () => {
    const { app } = await buildServer();
    await upload(app, { extId: 'list-ext', name: 'a.txt' });
    await upload(app, { extId: 'list-ext', name: 'b.txt' });
    await upload(app, { name: 'kernel.txt' });

    const all = await app.inject({ method: 'GET', url: '/api/v1/files', headers: AUTH_ADMIN });
    expect(all.statusCode).toBe(200);
    expect(all.json()).toHaveLength(3);

    const filtered = await app.inject({
      method: 'GET',
      url: '/api/v1/files?extId=list-ext',
      headers: AUTH_ADMIN,
    });
    expect(filtered.json().map((r: UploadResult) => r.origName).sort()).toEqual(['a.txt', 'b.txt']);

    const limited = await app.inject({
      method: 'GET',
      url: '/api/v1/files?extId=list-ext&limit=1',
      headers: AUTH_ADMIN,
    });
    expect(limited.json()).toHaveLength(1);
  });

  it('GET /:id public 任意已认证用户可下载：内容一致 + Content-Type/Disposition', async () => {
    const { app, service } = await buildServer();
    const rec = await service.store({
      data: Buffer.from('PUBLIC-CONTENT', 'utf8'),
      origName: 'pub 文件.txt',
      mime: 'text/plain',
      visibility: 'public',
    });
    const res = await app.inject({ method: 'GET', url: `/api/v1/files/${rec.id}`, headers: AUTH_NORMAL });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('PUBLIC-CONTENT');
    expect(res.headers['content-type']).toBe('text/plain');
    expect(String(res.headers['content-disposition'])).toContain('filename*');
    expect(String(res.headers['content-disposition'])).toContain('UTF-8');
  });

  it('GET /:id private：normal 403 HARNESS-1007，admin 可读且内容一致', async () => {
    const { app } = await buildServer();
    const rec = await upload(app, { name: 'secret.txt', content: Buffer.from('TOPSECRET', 'utf8') });

    const denied = await app.inject({ method: 'GET', url: `/api/v1/files/${rec.body.id}`, headers: AUTH_NORMAL });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().code).toBe('HARNESS-1007');

    const allowed = await app.inject({ method: 'GET', url: `/api/v1/files/${rec.body.id}`, headers: AUTH_ADMIN });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.body).toBe('TOPSECRET');
    expect(String(allowed.headers['content-disposition'])).toContain('secret.txt');

    const rootAllowed = await app.inject({ method: 'GET', url: `/api/v1/files/${rec.body.id}`, headers: AUTH_ROOT });
    expect(rootAllowed.statusCode).toBe(200);
  });

  it('GET 不存在的 id → 404 HARNESS-3004', async () => {
    const { app } = await buildServer();
    const res = await app.inject({ method: 'GET', url: '/api/v1/files/ghost', headers: AUTH_ADMIN });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('HARNESS-3004');
  });
});

// ---------------------------------------------------------------------------
// 删除
// ---------------------------------------------------------------------------

describe('files api — DELETE /api/v1/files/:id', () => {
  it('normal 403；admin 删除成功 {deleted:true}；删除后下载 404', async () => {
    const { app } = await buildServer();
    const rec = await upload(app, { name: 'doomed.txt' });

    const denied = await app.inject({ method: 'DELETE', url: `/api/v1/files/${rec.body.id}`, headers: AUTH_NORMAL });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().code).toBe('HARNESS-1007');

    const ok = await app.inject({ method: 'DELETE', url: `/api/v1/files/${rec.body.id}`, headers: AUTH_ADMIN });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ deleted: true });

    const gone = await app.inject({ method: 'GET', url: `/api/v1/files/${rec.body.id}`, headers: AUTH_ADMIN });
    expect(gone.statusCode).toBe(404);
  });

  it('删除不存在的 id → 404 HARNESS-3004', async () => {
    const { app } = await buildServer();
    const res = await app.inject({ method: 'DELETE', url: '/api/v1/files/ghost', headers: AUTH_ADMIN });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('HARNESS-3004');
  });
});
