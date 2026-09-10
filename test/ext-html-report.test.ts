/**
 * ext-html-report — html-report 社区扩展 + report_* 系统工具桥 E2E（真实内核 boot）。
 *
 * 覆盖面（见 extensions/html-report/ 与 src/kernel/mcp/system-tools.ts 的 report_ 域）：
 * - 扩展安装/激活：boot 后清单含 html-report（社区池、disabled 起步）→ enable →
 *   路由表含 GET /reports/:id 与 GET /api/reports（auth 'user'）；
 * - 四工具全周期（MCP-First 存储分工）：report_create 的正文经 WorkspaceService 落
 *   **对话工作区** reports/{uuid}.html，扩展只登记索引；report_get 回 title/meta/url
 *   （不回正文）；report_list 为索引列表；report_delete 删索引 + 删工作区正文（幂等）；
 * - 校验语义：session_id 必填（无会话上下文不产生报告）；路径穿越拒绝（reportId 含
 *   ../ → 工具 zod 层拒绝；直连扩展服务 → 扩展侧 UUID 校验拒绝，纵深防御）；超长
 *   HTML（>2MB UTF-8 字节）拒绝；
 * - 路由：预览端点 302 重定向到工作区 REST 预览端点（正文在工作区）、未认证 401、
 *   未知/非法 id 404、api 列表端点 200 JSON；删除后预览 404；
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
  WORKSPACE_CONTAINER_KEY,
  type WorkspaceServiceLike,
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
let workspace: WorkspaceServiceLike;

const auth = { authorization: '' }; // beforeAll 中填充

// 会话坐标（beforeAll 建真实 agent 会话后填充；跨 describe 共享）
let sessionIdA = '';
let sessionIdB = '';
let rootIdA = '';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 系统工具目录调用（SystemToolRuntime.call：zod 校验 + execute，结果恒 {ok,...} 形状） */
async function call(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return await runtime.call(name, args);
}

/** 有效的报告 HTML（可指定占位内容） */
const reportHtml = (body: string): string =>
  `<!doctype html><html><head><meta charset="utf-8"><title>t</title></head><body><h1>${body}</h1></body></html>`;

/** 建一个真实 agent 会话（session_id 的合法来源；正文将落到其对话工作区） */
async function createAgentSession(title: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/agents/sessions',
    headers: auth,
    payload: { title },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { id: string }).id;
}

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
  // MCP-First 集成前提：工作区服务由内核装配登记（src/kernel/workspace）
  expect(kernel.container.has(WORKSPACE_CONTAINER_KEY)).toBe(true);
  workspace = kernel.container.resolve<WorkspaceServiceLike>(WORKSPACE_CONTAINER_KEY);
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
    expect(ext?.version).toBe('0.2.0');
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
    // 桥接工具不在 builtin 目录：total ≥ builtin + 报告四工具 + 工作区四工具
    expect(runtime.size).toBeGreaterThanOrEqual(51);
  });
});

// ---------------------------------------------------------------------------
// 四工具全周期（系统 MCP 工具目录 → 工作区正文 + 扩展索引）
// ---------------------------------------------------------------------------

describe('report_* 四工具全周期', () => {
  let reportA = '';
  let reportB = '';
  let reportC = '';

  beforeAll(async () => {
    sessionIdA = await createAgentSession('report-a');
    sessionIdB = await createAgentSession('report-b');
    rootIdA = (await workspace.resolve(sessionIdA)).rootSessionId;
  });

  it('report_create 成功：正文落对话工作区 + 返回 uuid 形状 reportId + 工作区相对 path + REST 预览 url', async () => {
    const created = await call('report_create', {
      title: '周报',
      html: reportHtml('hello-report'),
      session_id: sessionIdA,
    });
    expect(created['ok']).toBe(true);
    expect(typeof created['reportId']).toBe('string');
    reportA = String(created['reportId']);
    expect(reportA).toMatch(UUID_RE);
    // path 变为工作区相对路径（reports/{uuid}.html），不再是 extensions-data 逻辑路径
    expect(created['path']).toBe(`reports/${reportA}.html`);
    expect(created['sessionId']).toBe(sessionIdA);
    expect(created['size']).toBe(Buffer.byteLength(reportHtml('hello-report'), 'utf8'));
    expect(typeof created['createdAt']).toBe('number');
    // url 指向工作区 REST 预览端点形状
    expect(created['url']).toBe(
      `/api/v1/agents/sessions/${rootIdA}/workspace/file?path=${encodeURIComponent(`reports/${reportA}.html`)}`,
    );

    // 物理存在性：正文确实落在该会话的工作区（经 WorkspaceService 读回逐字节一致）
    const body = await workspace.read(sessionIdA, `reports/${reportA}.html`);
    expect(body.toString('utf8')).toBe(reportHtml('hello-report'));
  });

  it('report_get 回读：title/meta/url，不再回 html 全文', async () => {
    const got = await call('report_get', { reportId: reportA });
    expect(got['ok']).toBe(true);
    expect(got['title']).toBe('周报');
    expect(got).not.toHaveProperty('html');
    const meta = got['meta'] as Record<string, unknown>;
    expect(meta['reportId']).toBe(reportA);
    expect(meta['sessionId']).toBe(sessionIdA);
    expect(meta['path']).toBe(`reports/${reportA}.html`);
    expect(meta['size']).toBe(Buffer.byteLength(reportHtml('hello-report'), 'utf8'));
    expect(got['url']).toBe(
      `/api/v1/agents/sessions/${rootIdA}/workspace/file?path=${encodeURIComponent(`reports/${reportA}.html`)}`,
    );
  });

  it('report_create 缺 session_id → ok:false HARNESS-1009（无会话上下文不产生报告）', async () => {
    const missing = await call('report_create', { title: 'orphan', html: reportHtml('x') });
    expect(missing['ok']).toBe(false);
    expect(missing['error']).toMatchObject({ code: 'HARNESS-1009' });
  });

  it('report_list：createdAt 降序 + session_id 过滤 + total 计数（索引列表，每条带预览 url）', async () => {
    const b = await call('report_create', { title: 'B', html: reportHtml('b'), session_id: sessionIdA });
    reportB = String(b['reportId']);
    const c = await call('report_create', { title: 'C', html: reportHtml('c'), session_id: sessionIdB });
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
    // 索引条目不含正文
    expect(reports.every((r) => !('html' in r))).toBe(true);

    const filtered = await call('report_list', { session_id: sessionIdA });
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
    const bad = await call('report_create', { title: 'too-big', html: oversized, session_id: sessionIdA });
    expect(bad['ok']).toBe(false);
    expect(bad['error']).toMatchObject({ code: 'HARNESS-1005' });
    expect((bad['error'] as Record<string, unknown>)['detail']).toMatchObject({ maxBytes: HTML_REPORT_MAX_BYTES });

    // ASCII 直超 2MB：zod 形状层同样拒绝
    const ascii = await call('report_create', { title: 'too-big', html: 'a'.repeat(HTML_REPORT_MAX_BYTES + 1), session_id: sessionIdA });
    expect(ascii['ok']).toBe(false);
  });

  it('report_delete 全周期：删索引 + 删工作区正文 → get 失败 → 预览 404 → 列表收敛', async () => {
    const before = await call('report_list', { session_id: sessionIdA });
    const removed = await call('report_delete', { reportId: reportB });
    expect(removed).toMatchObject({ ok: true, reportId: reportB, deleted: true });

    const got = await call('report_get', { reportId: reportB });
    expect(got['ok']).toBe(false);
    expect(got['error']).toMatchObject({ code: expect.stringMatching(/^HARNESS-\d+$/) });

    // 工作区正文一并删除
    await expect(workspace.read(sessionIdA, `reports/${reportB}.html`)).rejects.toThrow();

    const res = await app.inject({
      method: 'GET',
      url: `/ext/html-report/reports/${reportB}?token=${rootToken}`,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'HARNESS-3004' });

    const after = await call('report_list', { session_id: sessionIdA });
    expect(after['total']).toBe((before['total'] as number) - 1);
  });

  it('report_delete 正文缺失幂等：工作区正文已被手工清理时删除仍成功（只删索引不报错）', async () => {
    const d = await call('report_create', { title: 'D', html: reportHtml('d'), session_id: sessionIdB });
    const reportD = String(d['reportId']);
    // 手工清掉正文（模拟外部清理/已损坏场景）
    await workspace.delete(sessionIdB, `reports/${reportD}.html`);
    const removed = await call('report_delete', { reportId: reportD });
    expect(removed).toMatchObject({ ok: true, reportId: reportD, deleted: true });
    expect((await call('report_get', { reportId: reportD }))['ok']).toBe(false);
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
// 预览/列表路由（auth:'user'：token 走 ?token= 查询通道；预览 = 工作区端点重定向）
// ---------------------------------------------------------------------------

describe('html-report 扩展路由', () => {
  it('预览端点（认证）：302 重定向到工作区 REST 预览端点（透传 token、携带 path 坐标）', async () => {
    const list = await call('report_list', {});
    const first = (list['reports'] as Array<Record<string, unknown>>)[0] as Record<string, string>;
    expect(first['reportId']).toMatch(UUID_RE);

    const res = await app.inject({ method: 'GET', url: `/ext/html-report/reports/${first['reportId']}?token=${rootToken}` });
    expect(res.statusCode).toBe(302);
    const location = String(res.headers['location']);
    expect(location).toContain(`/api/v1/agents/sessions/${first['sessionId']}/workspace/file`);
    expect(location).toContain(`path=${encodeURIComponent(first['path'])}`);
    expect(location).toContain(`token=${rootToken}`);
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
      url: `/ext/html-report/api/reports?token=${rootToken}&session_id=${sessionIdA}`,
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
