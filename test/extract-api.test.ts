/**
 * extract REST API 集成测试（真实 fastify 注入 + @fastify/multipart + 真库 + 临时目录）。
 *
 * 覆盖：无 token 401（全部路由）、multipart 上传直提（text 内容一致 + 元数据）、
 * multipart 上限 413、query fileId 提取（admin 读 private / normal 403 / 未知 404）、
 * POST /extract/file/:id 落库 file_extracts + 重复提取覆盖、GET /extract/status
 * （not-downloaded / autoDownload 开关透出）、query 参数校验 400。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pino from 'pino';
import type { FastifyInstance } from 'fastify';
import type { Knex } from 'knex';

import { registerExtractRoutes } from '../src/api/extract.js';
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
import { FileExtractService } from '../src/kernel/fileextract/index.js';

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
  delete process.env.HARNESS_OCR_MODEL_DIR; // status 用例断言 not-downloaded，隔离开发机覆盖
  dir = mkdtempSync(join(tmpdir(), 'opptrix-extract-api-'));
  db = await openSqlite(join(dir, 'kernel.sqlite'));
  const migrator = new Migrator(db, { migrations: KERNEL_MIGRATIONS });
  await migrator.latest();
});

afterAll(async () => {
  await closeDb(db);
  rmSync(dir, { recursive: true, force: true });
});

/** 构造被测服务器：真库 + 真 FileService + FileExtractService（无模型、不自动下载） */
async function buildServer(opts: { maxFileBytes?: number; autoDownload?: boolean } = {}): Promise<{
  app: FastifyInstance;
  service: FileExtractService;
  files: FileService;
}> {
  await db('files').del();
  if (await db.schema.hasTable('file_extracts')) {
    await db('file_extracts').del();
  }
  rootSeq += 1;
  const files = new FileService({
    driver: createLocalDriver(join(dir, `root-${rootSeq}`)),
    db,
    hooks: new HookManager(),
    emit: new EventBus().emit.bind(new EventBus()),
    logger: pino({ level: 'silent' }),
    maxUploadBytes: 1024 * 1024,
  });
  const service = new FileExtractService({
    dataDir: join(dir, 'data'),
    autoDownload: opts.autoDownload ?? false,
    logger: pino({ level: 'silent' }),
    files,
    db,
  });
  const config = loadConfig({ NODE_ENV: 'test', HARNESS_LOG_LEVEL: 'error', HARNESS_DATA_DIR: dir });
  const { app } = createHttpServer({
    config,
    logger: pino({ level: 'silent' }),
    isReady: () => true,
    state: () => 'ready',
    registerExtra: (a) => {
      registerExtractRoutes(a, {
        checker: async ({ token }) => {
          if (token === ADMIN_TOKEN) return { userId: 'admin-1', role: 'admin', scopes: ['files'] };
          if (token === ROOT_TOKEN) return { userId: 'root', role: 'root', scopes: ['*'] };
          if (token === NORMAL_TOKEN) return { userId: 'user-1', role: 'normal', scopes: [] };
          throw err('UNAUTHORIZED', { detail: 'token rejected by all auth providers' });
        },
        service,
        files,
        ...(opts.maxFileBytes !== undefined ? { maxFileBytes: opts.maxFileBytes } : {}),
      });
    },
  });
  return { app, service, files };
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

// ---------------------------------------------------------------------------
// 鉴权
// ---------------------------------------------------------------------------

describe('extract api — 鉴权', () => {
  it('1. 无 token → 401 HARNESS-1006（三条路由）', async () => {
    const { app } = await buildServer();
    for (const [method, url] of [
      ['POST', '/api/v1/extract'],
      ['POST', '/api/v1/extract/file/some-id'],
      ['GET', '/api/v1/extract/status'],
    ] as const) {
      const res = await app.inject({ method, url });
      expect(res.statusCode).toBe(401);
      expect(res.json().code).toBe('HARNESS-1006');
    }
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/extract（multipart 直提）
// ---------------------------------------------------------------------------

describe('extract api — POST /api/v1/extract', () => {
  it('2. multipart 上传 txt → 200 ExtractResult（text 引擎 + 内容一致 + truncated:false）', async () => {
    const { app } = await buildServer();
    const { payload, headers } = multipartBody('note.txt', 'text/plain', Buffer.from('extract me body', 'utf8'));
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/extract',
      headers: { ...AUTH_ADMIN, ...headers },
      payload,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      fileExt: '.txt',
      engine: 'text',
      text: 'extract me body',
      charCount: 'extract me body'.length,
      ocrUsed: false,
      truncated: false,
    });
    expect(body.durationMs).toBeTypeOf('number');
  });

  it('3. 上传超过 maxFileBytes → 413 HARNESS-1005', async () => {
    const { app } = await buildServer({ maxFileBytes: 64 });
    const { payload, headers } = multipartBody('big.bin', 'application/octet-stream', Buffer.alloc(256, 1));
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/extract',
      headers: { ...AUTH_ADMIN, ...headers },
      payload,
    });
    expect(res.statusCode).toBe(413);
    expect(res.json().code).toBe('HARNESS-1005');
  });

  it('4. 非 multipart 且无 ?fileId= → 400 BAD_REQUEST', async () => {
    const { app } = await buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/extract',
      headers: { ...AUTH_ADMIN, 'content-type': 'application/json' },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('HARNESS-1008');
  });

  it('5. ?fileId= 引用 private 文件：normal 403 / admin 200', async () => {
    const { app, files } = await buildServer();
    const rec = await files.store({ data: Buffer.from('private doc body', 'utf8'), origName: 'secret.txt' });

    const denied = await app.inject({
      method: 'POST',
      url: `/api/v1/extract?fileId=${rec.id}`,
      headers: AUTH_NORMAL,
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().code).toBe('HARNESS-1007');

    const ok = await app.inject({
      method: 'POST',
      url: `/api/v1/extract?fileId=${rec.id}`,
      headers: AUTH_ADMIN,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ engine: 'text', text: 'private doc body' });

    const unknown = await app.inject({
      method: 'POST',
      url: '/api/v1/extract?fileId=ghost',
      headers: AUTH_ADMIN,
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().code).toBe('HARNESS-3004');
  });

  it('6. query 校验失败（ocr 非法值）→ 400 HARNESS-1009', async () => {
    const { app } = await buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/extract?ocr=bogus',
      headers: AUTH_ADMIN,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('HARNESS-1009');
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/extract/file/:id（提取 + 持久化）
// ---------------------------------------------------------------------------

describe('extract api — POST /api/v1/extract/file/:id', () => {
  it('7. 提取并落库 file_extracts（stored:true）；重复提取覆盖为单行', async () => {
    const { app, files } = await buildServer();
    const rec = await files.store({ data: Buffer.from('persist me', 'utf8'), origName: 'p.txt' });

    const first = await app.inject({ method: 'POST', url: `/api/v1/extract/file/${rec.id}`, headers: AUTH_ADMIN });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ fileId: rec.id, engine: 'text', text: 'persist me', stored: true });

    let rows = await db('file_extracts').where({ file_id: rec.id });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.text).toBe('persist me');

    // 重复提取：覆盖（仍单行，created_at 刷新）
    const second = await app.inject({ method: 'POST', url: `/api/v1/extract/file/${rec.id}`, headers: AUTH_ADMIN });
    expect(second.statusCode).toBe(200);
    rows = await db('file_extracts').where({ file_id: rec.id });
    expect(rows).toHaveLength(1);
  });

  it('8. 未知 fileId → 404 HARNESS-3004', async () => {
    const { app } = await buildServer();
    const res = await app.inject({ method: 'POST', url: '/api/v1/extract/file/ghost', headers: AUTH_ADMIN });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('HARNESS-3004');
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/extract/status
// ---------------------------------------------------------------------------

describe('extract api — GET /api/v1/extract/status', () => {
  it('9. 无模型 → not-downloaded + missingFiles + autoDownload=false；normal 角色亦可读', async () => {
    const { app } = await buildServer();
    const res = await app.inject({ method: 'GET', url: '/api/v1/extract/status', headers: AUTH_NORMAL });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.state).toBe('not-downloaded');
    expect(body.missingFiles).toContain('ch_PP-OCRv4_det_mobile.onnx');
    expect(body.modelDir).toContain(join('models', 'ocr'));
    expect(body.autoDownload).toBe(false);
  });

  it('10. autoDownload=true 透出开关', async () => {
    const { app } = await buildServer({ autoDownload: true });
    const res = await app.inject({ method: 'GET', url: '/api/v1/extract/status', headers: AUTH_ADMIN });
    expect(res.statusCode).toBe(200);
    expect(res.json().autoDownload).toBe(true);
  });
});
