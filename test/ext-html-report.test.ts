/**
 * ext-html-report — html-report 社区扩展 + report_* 系统工具桥 E2E（真实内核 boot）。
 *
 * 覆盖面（见 extensions/html-report/ 与 src/kernel/mcp/system-tools.ts 的 report_ 域）：
 * - 扩展安装/激活：boot 后清单含 html-report（社区池、disabled 起步）→ enable →
 *   路由表含 GET /reports/:id 与 GET /api/reports（auth 'user'）；
 * - 四工具全周期：系统工具目录（SystemToolRuntime）report_create / report_list /
 *   report_get / report_delete——工具在内核目录静态登记、经扩展桥（extManager →
 *   bridgeFor → host.call('reports.*')）委托扩展执行；
 * - 校验语义：路径穿越拒绝（reportId 含 ../ → 工具 zod 层拒绝；直连扩展服务 →
 *   扩展侧 UUID 校验拒绝，纵深防御）；超长 HTML（>2MB UTF-8 字节）拒绝；
 * - 路由：预览端点 200 + text/html + 防脚本 CSP 头、未认证 401、未知/非法 id 404、
 *   api 列表端点 200 JSON；删除后预览 404；
 * - 未启用时工具调用收敛为 {ok:false}（SERVICE_UNAVAILABLE），路由 503（禁用墓碑）。
 *
 * worker 模式：HARNESS_WORKER_MODE='dev' 显式钉死 src 入口（tsx loader，与 integration.* 同款）。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

// worker 入口解析在工厂调用期读 env：boot 之前设置即可（模块加载期设置更稳）
process.env['HARNESS_WORKER_MODE'] = 'dev';

import { HOST_METHODS } from '../src/extension-host/protocol.js';
import { CONTAINER_KEYS, Kernel } from '../src/kernel/Kernel.js';
import { loadConfig } from '../src/kernel/config/index.js';
import {
  HTML_REPORT_EXT_ID,
  HTML_REPORT_MAX_BYTES,
  SYSTEM_TOOLS_CONTAINER_KEY,
} from '../src/kernel/mcp/system-tools.js';
import type { SystemToolRuntime } from '../src/kernel/mcp/system-server.js';
import type { ExtensionManager } from '../src/kernel/extensions/manager.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

// ---------------------------------------------------------------------------
// 环境：真实 Kernel（临时 dataDir、端口 0、静音日志、dev worker）
// ---------------------------------------------------------------------------

let dataDir = '';
let kernel: Kernel;
let app: FastifyInstance;
let rootToken = '';
let runtime: SystemToolRuntime;
let manager: ExtensionManager;

const auth = { authorization: '' }; // beforeAll 中填充

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 系统工具目录调用（SystemToolRuntime.call：zod 校验 + execute，结果恒 {ok,...} 形状） */
async function call(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return await runtime.call(name, args);
}

/** 有效的报告 HTML（可指定占位内容） */
const reportHtml = (body: string): string =>
  `<!doctype html><html><head><meta charset="utf-8"><title>t</title></head><body><h1>${body}</h1></body></html>`;

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'opptrix-html-report-'));
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

  rootToken = kernel.container.resolve<{ token: string }>(CONTAINER_KEYS.authIdentity).token;
  auth.authorization = `Bearer ${rootToken}`;
  app = kernel.container.resolve<{ app: FastifyInstance }>(CONTAINER_KEYS.http).app;
  runtime = kernel.container.resolve<SystemToolRuntime>(SYSTEM_TOOLS_CONTAINER_KEY);
  manager = kernel.container.resolve<ExtensionManager>(CONTAINER_KEYS.extManager);
});

afterAll(async () => {
  await kernel?.shutdown('html-report-afterall'); // 幂等
  if (dataDir !== '') await rm(dataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 安装/激活与路由表
// ---------------------------------------------------------------------------

describe('html-report 扩展安装与激活', () => {
  it('boot 后扩展清单含 html-report：社区池、builtin:false、disabled 起步', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/extensions', headers: auth });
    expect(res.statusCode).toBe(200);
    const list = res.json() as Array<{ id: string; enabled: boolean; builtin: boolean; host: string; version: string }>;
    const ext = list.find((s) => s.id === HTML_REPORT_EXT_ID);
    expect(ext).toBeDefined();
    expect(ext?.enabled).toBe(false);
    expect(ext?.builtin).toBe(false);
    expect(ext?.host).toBe('community');
    expect(ext?.version).toBe('0.1.0');
  });

  it('enable 成功；路由表含 GET /reports/:id 与 GET /api/reports（auth user）', async () => {
    const on = await app.inject({
      method: 'POST',
      url: `/api/v1/extensions/${HTML_REPORT_EXT_ID}/enable`,
      headers: auth,
    });
    expect(on.statusCode).toBe(200);
    expect(on.json()).toEqual({ ok: true });

    const res = await app.inject({ method: 'GET', url: '/api/v1/extensions/routes', headers: auth });
    expect(res.statusCode).toBe(200);
    const routes = res.json() as Array<{ extId: string; method: string; path: string; auth: string }>;
    expect(routes).toContainEqual(
      expect.objectContaining({ extId: HTML_REPORT_EXT_ID, method: 'GET', path: '/reports/:id', auth: 'user' }),
    );
    expect(routes).toContainEqual(
      expect.objectContaining({ extId: HTML_REPORT_EXT_ID, method: 'GET', path: '/api/reports', auth: 'user' }),
    );
  });

  it('系统工具目录含 report_* 四工具（桥接登记，未修改既有工具）', () => {
    const names = runtime.listTools().map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['report_create', 'report_list', 'report_get', 'report_delete']));
    // 桥接工具不在 builtin 目录：total ≥ builtin + 4（历史断言口径是 ≥30，保持宽松）
    expect(runtime.size).toBeGreaterThanOrEqual(47);
  });
});

// ---------------------------------------------------------------------------
// 四工具全周期（系统 MCP 工具目录 → 扩展桥 → h.expose('reports')）
// ---------------------------------------------------------------------------

describe('report_* 四工具全周期', () => {
  const SESSION_A = 'sess-html-1';
  const SESSION_B = 'sess-html-2';
  let reportA = '';
  let reportB = '';
  let reportC = '';

  it('report_create 成功：返回 uuid 形状 reportId + 逻辑 path + 预览 url（契约形状）', async () => {
    const created = await call('report_create', {
      title: '周报',
      html: reportHtml('hello-report'),
      session_id: SESSION_A,
    });
    expect(created['ok']).toBe(true);
    expect(typeof created['reportId']).toBe('string');
    reportA = String(created['reportId']);
    expect(reportA).toMatch(UUID_RE);
    expect(String(created['path'])).toMatch(/^extensions-data\/html-report\/\d{4}-\d{2}\/[0-9a-f-]{36}\.html$/);
    expect(created['url']).toBe(`/ext/html-report/reports/${reportA}`);
    expect(created['size']).toBeGreaterThan(0);
  });

  it('report_get 回读：title/html 与写入一致，meta 携带 createdAt/sessionId/size/path/url', async () => {
    const got = await call('report_get', { reportId: reportA });
    expect(got['ok']).toBe(true);
    expect(got['title']).toBe('周报');
    expect(got['html']).toBe(reportHtml('hello-report'));
    const meta = got['meta'] as Record<string, unknown>;
    expect(meta['reportId']).toBe(reportA);
    expect(meta['sessionId']).toBe(SESSION_A);
    expect(typeof meta['createdAt']).toBe('number');
    expect(meta['size']).toBe(Buffer.byteLength(reportHtml('hello-report'), 'utf8'));
    expect(meta['url']).toBe(`/ext/html-report/reports/${reportA}`);
  });

  it('report_list：createdAt 降序 + session_id 过滤 + total 计数', async () => {
    const b = await call('report_create', { title: 'B', html: reportHtml('b'), session_id: SESSION_A });
    reportB = String(b['reportId']);
    const c = await call('report_create', { title: 'C', html: reportHtml('c'), session_id: SESSION_B });
    reportC = String(c['reportId']);

    const all = await call('report_list', {});
    expect(all['ok']).toBe(true);
    const reports = all['reports'] as Array<Record<string, unknown>>;
    expect(reports.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < reports.length; i++) {
      expect(Number(reports[i - 1]?.['createdAt'])).toBeGreaterThanOrEqual(Number(reports[i]?.['createdAt']));
    }
    expect(reports.map((r) => r['reportId'])).toContain(reportA);
    expect(reports.map((r) => r['reportId'])).toContain(reportB);
    expect(reports.map((r) => r['reportId'])).toContain(reportC);

    const filtered = await call('report_list', { session_id: SESSION_A });
    const onlyA = (filtered['reports'] as Array<Record<string, unknown>>).map((r) => r['reportId']);
    expect(onlyA).toEqual(expect.arrayContaining([reportA, reportB]));
    expect(onlyA).not.toContain(reportC);
    expect(filtered['total']).toBe(2);
  });

  it('report_list 分页：limit/offset 生效（offset=1 跳过全局最新的第 1 条）', async () => {
    // 与全局降序清单对账（created_at 并列时按 report_id 破并列，避免同毫秒抖动）
    const all = await call('report_list', {});
    const ordered = (all['reports'] as Array<Record<string, unknown>>).map((r) => String(r['reportId']));
    const page = await call('report_list', { limit: 1, offset: 1 });
    const ids = (page['reports'] as Array<Record<string, unknown>>).map((r) => r['reportId']);
    expect(ids).toEqual(ordered.slice(1, 2));
    expect(page['limit']).toBe(1);
    expect(page['offset']).toBe(1);
  });

  it('路径穿越拒绝：reportId 含 ../ 在工具入参校验层即失败（ok:false）', async () => {
    for (const tool of ['report_get', 'report_delete'] as const) {
      const bad = await call(tool, { reportId: '../../etc/passwd' });
      expect(bad['ok']).toBe(false);
      expect(bad['error']).toMatchObject({ code: 'HARNESS-1009' });
      const dotdot = await call(tool, { reportId: `a/../${reportA}` });
      expect(dotdot['ok']).toBe(false);
    }
  });

  it('路径穿越纵深防御：绕过工具直连扩展服务，扩展侧 UUID 校验仍拒绝', async () => {
    const bridge = manager.bridgeFor(HTML_REPORT_EXT_ID);
    expect(bridge).not.toBeNull();
    await expect(
      bridge!.callToWorker(HTML_REPORT_EXT_ID, HOST_METHODS.callService, {
        service: 'reports',
        method: 'get',
        args: { reportId: '../escape' },
      }),
    ).rejects.toThrow(/UUID/);
    await expect(
      bridge!.callToWorker(HTML_REPORT_EXT_ID, HOST_METHODS.callService, {
        service: 'reports',
        method: 'delete',
        args: { reportId: 'x/../../y' },
      }),
    ).rejects.toThrow(/UUID/);
  });

  it('超长 HTML（>2MB UTF-8 字节，多字节字符）→ ok:false HARNESS-1005，携带 bytes/maxBytes', async () => {
    // 700k 个三字节字符 = 1.4M 码元（通过 zod 的 2M 码元上限）但 2.1MB 字节（超字节上限）
    const oversized = '哈'.repeat(700_000);
    expect(Buffer.byteLength(oversized, 'utf8')).toBeGreaterThan(HTML_REPORT_MAX_BYTES);
    const bad = await call('report_create', { title: 'too-big', html: oversized });
    expect(bad['ok']).toBe(false);
    expect(bad['error']).toMatchObject({ code: 'HARNESS-1005' });
    expect((bad['error'] as Record<string, unknown>)['detail']).toMatchObject({ maxBytes: HTML_REPORT_MAX_BYTES });

    // ASCII 直超 2MB：zod 形状层同样拒绝
    const ascii = await call('report_create', { title: 'too-big', html: 'a'.repeat(HTML_REPORT_MAX_BYTES + 1) });
    expect(ascii['ok']).toBe(false);
  });

  it('report_delete 全周期：删除成功 → get 失败 → 预览 404 → 列表收敛', async () => {
    const before = await call('report_list', { session_id: SESSION_A });
    const removed = await call('report_delete', { reportId: reportB });
    expect(removed).toMatchObject({ ok: true, reportId: reportB, deleted: true });

    const got = await call('report_get', { reportId: reportB });
    expect(got['ok']).toBe(false);
    expect(got['error']).toMatchObject({ code: expect.stringMatching(/^HARNESS-\d+$/) });

    const res = await app.inject({
      method: 'GET',
      url: `/ext/html-report/reports/${reportB}?token=${rootToken}`,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'HARNESS-3004' });

    const after = await call('report_list', { session_id: SESSION_A });
    expect(after['total']).toBe((before['total'] as number) - 1);
    void reportC;
  });

  it('未知 reportId：get → ok:false；预览路由 404（合法 uuid 但不存在）', async () => {
    const ghost = '00000000-0000-4000-8000-000000000000';
    const got = await call('report_get', { reportId: ghost });
    expect(got['ok']).toBe(false);
    const res = await app.inject({ method: 'GET', url: `/ext/html-report/reports/${ghost}?token=${rootToken}` });
    expect(res.statusCode).toBe(404);
    const badShape = await app.inject({
      method: 'GET',
      url: `/ext/html-report/reports/not-a-uuid?token=${rootToken}`,
    });
    expect(badShape.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// 预览/列表路由（auth:'user'：token 走 ?token= 查询通道）
// ---------------------------------------------------------------------------

describe('html-report 扩展路由', () => {
  it('预览端点（认证）：200 + text/html + 防脚本 CSP 头 + nosniff + 正文原样', async () => {
    const list = await call('report_list', {});
    const reportId = (list['reports'] as Array<Record<string, unknown>>)[0]?.['reportId'] as string;
    expect(reportId).toMatch(UUID_RE);

    const res = await app.inject({ method: 'GET', url: `/ext/html-report/reports/${reportId}?token=${rootToken}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.headers['content-security-policy']).toBe("default-src 'none'; style-src 'unsafe-inline'; img-src data:");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.body).toContain('<h1>');
  });

  it('预览端点未认证（无 token）→ 401', async () => {
    const list = await call('report_list', {});
    const reportId = (list['reports'] as Array<Record<string, unknown>>)[0]?.['reportId'] as string;
    const res = await app.inject({ method: 'GET', url: `/ext/html-report/reports/${reportId}` });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: expect.stringMatching(/^HARNESS-\d+$/) });
  });

  it('列表端点（认证）：200 JSON，与 report_list 同语义（session_id 过滤生效）', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/ext/html-report/api/reports?token=${rootToken}&session_id=sess-html-1`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { reports: Array<{ reportId: string }>; total: number };
    expect(body.total).toBe(1);
    expect(body.reports).toHaveLength(1);
  });

  it('列表端点未认证 → 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/ext/html-report/api/reports' });
    expect(res.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// 生命周期联动：未启用时工具调用收敛为 {ok:false}，路由 503；再 enable 恢复
// ---------------------------------------------------------------------------

describe('禁用/启用生命周期联动', () => {
  it('disable 后 report_list → ok:false（扩展未启用），预览路由 503；re-enable 后恢复', async () => {
    const off = await app.inject({
      method: 'POST',
      url: `/api/v1/extensions/${HTML_REPORT_EXT_ID}/disable`,
      headers: auth,
    });
    expect(off.statusCode).toBe(200);

    const listed = await call('report_list', {});
    expect(listed['ok']).toBe(false);
    expect((listed['error'] as Record<string, unknown>)['message']).toContain('not enabled');

    const res = await app.inject({ method: 'GET', url: '/ext/html-report/api/reports' });
    expect(res.statusCode).toBe(503);

    const on = await app.inject({
      method: 'POST',
      url: `/api/v1/extensions/${HTML_REPORT_EXT_ID}/enable`,
      headers: auth,
    });
    expect(on.statusCode).toBe(200);
    const recovered = await call('report_list', {});
    expect(recovered['ok']).toBe(true);
  });
});
