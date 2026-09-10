/**
 * workspace-tools — workspace_* 系统工具 + MCP-First 三引擎工作区接入 单测。
 *
 * 覆盖面（src/kernel/mcp/system-tools.ts 的 workspace_/report_ 域与 browser_/coding_
 * 工具的工作区链路；src/kernel/browser/engine.ts 的 targetDir 覆写；src/kernel/coding/
 * engine.ts 的 rootPath 覆写）：
 * - workspace_write/read/list/delete 全周期（fs 落地的内存替身 WorkspaceService，契约
 *   形状与冻结契约一致；真实 WorkspaceService 的 E2E 由 ext-html-report.test.ts 覆盖）；
 * - 无会话上下文（ctx.agentId 缺失）→ 四工具统一收敛 {ok:false,'no session context'}；
 * - 工作区服务未装配 → HARNESS-9001；workspace_write 超 8MB → HARNESS-1005；
 * - workspace_read 文本预览语义：≤256KB 回正文、超限/二进制回 {size, hint}；
 * - report_create：session_id 必填 + 正文物理落对话工作区 + 扩展索引可查 + url 为
 *   REST 预览端点形状；report_get 不回正文；report_list 索引带 url；report_delete
 *   正文缺失幂等；
 * - browser_screenshot 落工作区（引擎替身）与 coding 覆写目录生效（真实子进程 node
 *   脚本写文件到工作区再断言）。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { CodingEngine } from '../src/kernel/coding/index.js';
import {
  HTML_REPORT_EXT_ID,
  WORKSPACE_CONTAINER_KEY,
  WORKSPACE_READ_HINT,
  WORKSPACE_READ_PREVIEW_MAX_BYTES,
  WORKSPACE_WRITE_MAX_BYTES,
  createBrowserTools,
  createCodingTools,
  createHtmlReportTools,
  createWorkspaceTools,
  type SystemTool,
  type SystemToolContext,
  type WorkspaceServiceLike,
} from '../src/kernel/mcp/system-tools.js';

// ---------------------------------------------------------------------------
// 测试替身：fs 落地的 WorkspaceService（冻结契约的最小实现）+ 扩展索引桩
// ---------------------------------------------------------------------------

/** fs 落地的契约实现：scopeId → <root>/<scopeId>；path 语义 = 工作区内相对路径 */
function makeFsWorkspace(root: string): WorkspaceServiceLike {
  const dirOf = (scopeId: string): string => join(root, scopeId);
  const safe = (relPath: string): string => {
    if (typeof relPath !== 'string' || relPath === '' || relPath.includes('\0') || relPath.includes('..')) {
      throw new Error(`invalid workspace path: ${String(relPath).slice(0, 64)}`);
    }
    return relPath;
  };
  return {
    async resolve(scopeId: string) {
      if (typeof scopeId !== 'string' || scopeId === '') throw new Error('scopeId is required');
      return { rootSessionId: scopeId, userId: null, path: dirOf(scopeId) };
    },
    async write(scopeId: string, relPath: string, data: Buffer) {
      const target = join(dirOf(scopeId), safe(relPath));
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, data);
      return { path: safe(relPath), size: data.byteLength };
    },
    async read(scopeId: string, relPath: string) {
      return readFileSync(join(dirOf(scopeId), safe(relPath)));
    },
    async list(scopeId: string, relPath?: string, recursive?: boolean) {
      const base = join(dirOf(scopeId), relPath === undefined || relPath === '' ? '.' : safe(relPath));
      const out: Array<{ name: string; path: string; type: 'file' | 'dir'; size: number; mtime: number }> = [];
      const walk = (dir: string, prefix: string): void => {
        for (const name of readdirSync(dir)) {
          const full = join(dir, name);
          const rel = prefix === '' ? name : `${prefix}/${name}`;
          const st = statSync(full);
          if (st.isDirectory()) {
            out.push({ name, path: rel, type: 'dir', size: st.size, mtime: st.mtimeMs });
            if (recursive === true) walk(full, rel);
          } else {
            out.push({ name, path: rel, type: 'file', size: st.size, mtime: st.mtimeMs });
          }
        }
      };
      walk(base, '');
      return out;
    },
    async delete(scopeId: string, relPath: string) {
      rmSync(join(dirOf(scopeId), safe(relPath)), { force: true, recursive: true });
    },
  };
}

/** html-report 扩展的索引桩（reports 服务 index/list/get/delete 的内存实现） */
function makeIndexExtManager() {
  const rows = new Map<string, { reportId: string; title: string; sessionId: string; path: string; size: number; createdAt: number }>();
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const service = {
    async index(args: Record<string, unknown>) {
      const reportId = String(args['reportId']);
      if (!UUID_RE.test(reportId)) throw new Error(`reportId must be a UUID (got "${reportId}")`);
      const row = {
        reportId,
        title: String(args['title']),
        sessionId: String(args['sessionId']),
        path: String(args['path']),
        size: Number(args['size']),
        createdAt: Number(args['createdAt']),
      };
      rows.set(reportId, row);
      return { ...row };
    },
    async list(args: Record<string, unknown>) {
      const sessionId = typeof args['sessionId'] === 'string' ? args['sessionId'] : undefined;
      const all = [...rows.values()]
        .filter((r) => sessionId === undefined || r.sessionId === sessionId)
        .sort((a, b) => b.createdAt - a.createdAt);
      return { reports: all.map((r) => ({ ...r })), total: all.length, limit: 50, offset: 0 };
    },
    async get(args: Record<string, unknown>) {
      const reportId = String(args['reportId']);
      if (!UUID_RE.test(reportId)) throw new Error(`reportId must be a UUID (got "${reportId}")`);
      const row = rows.get(reportId);
      if (row === undefined) throw new Error(`report "${reportId}" not found`);
      return { ...row };
    },
    async delete(args: Record<string, unknown>) {
      const reportId = String(args['reportId']);
      if (!UUID_RE.test(reportId)) throw new Error(`reportId must be a UUID (got "${reportId}")`);
      const row = rows.get(reportId);
      if (row === undefined) throw new Error(`report "${reportId}" not found`);
      rows.delete(reportId);
      return { ...row, deleted: true };
    },
  };
  const manager = {
    list: () => [{ id: HTML_REPORT_EXT_ID, enabled: true }],
    bridgeFor: () => ({
      callToWorker: async (_extId: string, _topic: string, payload: unknown) => {
        const { method, args } = payload as { method: string; args: Record<string, unknown> };
        const fn = (service as Record<string, (a: Record<string, unknown>) => Promise<unknown>>)[method];
        if (fn === undefined) throw new Error(`unknown reports method: ${method}`);
        return await fn.call(service, args);
      },
    }),
  };
  return { manager, rows };
}

// ---------------------------------------------------------------------------
// ctx 装配
// ---------------------------------------------------------------------------

let dataDir = '';
const tempDirs: string[] = [];

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'workspace-tools-'));
  tempDirs.push(dataDir);
});

afterEach(() => {
  // 只清 report 用例产生的临时根；dataDir 由最后统一清（此处保留）
});

/** 工具按名取用 */
function toolOf(tools: SystemTool[], name: string): SystemTool {
  const tool = tools.find((t) => t.name === name);
  if (tool === undefined) throw new Error(`tool "${name}" not found`);
  return tool;
}

/** 标准执行上下文（含 agentId + fs 工作区 + 索引扩展桩） */
function makeCtx(opts: { agentId?: string; workspace?: WorkspaceServiceLike | null } = {}): SystemToolContext {
  const container = new Map<string, unknown>([
    ['ext.manager', makeIndexExtManager().manager],
  ]);
  if (opts.workspace !== null) {
    container.set(WORKSPACE_CONTAINER_KEY, opts.workspace ?? makeFsWorkspace(dataDir));
  }
  return {
    kernel: { container: { has: (k: string) => container.has(k), resolve: (k: string) => container.get(k) } },
    agentId: opts.agentId,
    updater: {} as SystemToolContext['updater'],
    cronHistory: async () => [],
  } as unknown as SystemToolContext;
}

const wsTools = createWorkspaceTools();
const reportTools = createHtmlReportTools();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hasNode = spawnSync(process.execPath, ['--version'], { stdio: 'ignore' }).status === 0;

// ---------------------------------------------------------------------------
// workspace_* 四工具
// ---------------------------------------------------------------------------

describe('workspace_* 系统工具', () => {
  it('目录形状：四个工具、中文描述、path 声明为「相对当前对话工作区」', () => {
    expect(wsTools.map((t) => t.name)).toEqual(['workspace_write', 'workspace_read', 'workspace_list', 'workspace_delete']);
    for (const t of wsTools) {
      expect(t.description.length).toBeGreaterThan(4);
      expect((t.inputSchema as { type?: string }).type).toBe('object');
    }
    for (const t of wsTools.filter((x) => x.name !== 'workspace_list')) {
      expect(t.description).toContain('相对当前对话工作区');
    }
  });

  it('全周期：write → read 往返一致 → list 可见 → delete 幂等消失', async () => {
    const ctx = makeCtx({ agentId: 'sess-cycle' });
    const written = await toolOf(wsTools, 'workspace_write').execute({ path: 'notes/a.md', content: '# hello' }, ctx);
    expect(written).toMatchObject({ ok: true, path: 'notes/a.md', size: 7 });

    const read = await toolOf(wsTools, 'workspace_read').execute({ path: 'notes/a.md' }, ctx);
    expect(read).toMatchObject({ ok: true, path: 'notes/a.md', size: 7, binary: false, truncated: false, content: '# hello' });

    const list = await toolOf(wsTools, 'workspace_list').execute({}, ctx);
    expect(list['ok']).toBe(true);
    expect((list['entries'] as Array<Record<string, unknown>>).map((e) => e['path'])).toEqual(['notes']);

    const recursive = await toolOf(wsTools, 'workspace_list').execute({ recursive: true }, ctx);
    expect((recursive['entries'] as Array<Record<string, unknown>>).map((e) => e['path'])).toEqual(['notes', 'notes/a.md']);

    const removed = await toolOf(wsTools, 'workspace_delete').execute({ path: 'notes/a.md' }, ctx);
    expect(removed).toMatchObject({ ok: true, deleted: true });
    // 幂等：再删不报错
    expect(await toolOf(wsTools, 'workspace_delete').execute({ path: 'notes/a.md' }, ctx)).toMatchObject({ ok: true });
    const after = await toolOf(wsTools, 'workspace_list').execute({ recursive: true }, ctx);
    expect((after['entries'] as Array<Record<string, unknown>>).map((e) => e['path'])).not.toContain('notes/a.md');
  });

  it('无 agentId（无会话上下文）→ 四工具统一收敛 {ok:false, no session context}', async () => {
    const ctx = makeCtx({ agentId: undefined });
    const noAgent = await toolOf(wsTools, 'workspace_write').execute({ path: 'x', content: '1' }, ctx);
    expect(noAgent).toMatchObject({ ok: false, error: { code: 'HARNESS-1009', message: 'no session context' } });
    expect(await toolOf(wsTools, 'workspace_read').execute({ path: 'x' }, ctx)).toMatchObject({ ok: false });
    expect(await toolOf(wsTools, 'workspace_list').execute({}, ctx)).toMatchObject({ ok: false });
    expect(await toolOf(wsTools, 'workspace_delete').execute({ path: 'x' }, ctx)).toMatchObject({ ok: false });
    for (const result of [
      await toolOf(wsTools, 'workspace_read').execute({ path: 'x' }, ctx),
      await toolOf(wsTools, 'workspace_list').execute({}, ctx),
      await toolOf(wsTools, 'workspace_delete').execute({ path: 'x' }, ctx),
    ]) {
      expect((result['error'] as Record<string, unknown>)['message']).toBe('no session context');
    }
  });

  it('工作区服务未装配 → HARNESS-9001 结果对象（裸装配不硬失败）', async () => {
    const ctx = makeCtx({ agentId: 'sess-x', workspace: null });
    const result = await toolOf(wsTools, 'workspace_write').execute({ path: 'x', content: '1' }, ctx);
    expect(result).toMatchObject({ ok: false, error: { code: 'HARNESS-9001' } });
  });

  it('workspace_write 超 8MB（字节口径）→ ok:false HARNESS-1005', async () => {
    const ctx = makeCtx({ agentId: 'sess-big' });
    const ascii = 'a'.repeat(WORKSPACE_WRITE_MAX_BYTES + 1);
    const bad = await toolOf(wsTools, 'workspace_write').execute({ path: 'big.txt', content: ascii }, ctx);
    expect(bad['ok']).toBe(false);
    expect(bad['error']).toMatchObject({ code: 'HARNESS-1005' });
  });

  it('workspace_read：超 256KB 文本 → truncated + hint（不回正文）；二进制 → binary + hint', async () => {
    const ctx = makeCtx({ agentId: 'sess-read' });
    await toolOf(wsTools, 'workspace_write').execute(
      { path: 'big.txt', content: 'y'.repeat(WORKSPACE_READ_PREVIEW_MAX_BYTES * 2) },
      ctx,
    );
    const big = await toolOf(wsTools, 'workspace_read').execute({ path: 'big.txt' }, ctx);
    expect(big).toMatchObject({
      ok: true,
      path: 'big.txt',
      size: WORKSPACE_READ_PREVIEW_MAX_BYTES * 2,
      truncated: true,
      binary: false,
      hint: WORKSPACE_READ_HINT,
    });
    expect(big).not.toHaveProperty('content');

    // 二进制（非法 UTF-8 序列）：标记 binary 且不回正文
    const workspace = makeFsWorkspace(dataDir);
    await workspace.write('sess-read', 'blob.bin', Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x80]));
    const binCtx = makeCtx({ agentId: 'sess-read', workspace });
    const bin = await toolOf(wsTools, 'workspace_read').execute({ path: 'blob.bin' }, binCtx);
    expect(bin).toMatchObject({
      ok: true,
      path: 'blob.bin',
      size: 5,
      truncated: false,
      binary: true,
      hint: WORKSPACE_READ_HINT,
    });
    expect(bin).not.toHaveProperty('content');
  });
});

// ---------------------------------------------------------------------------
// report_*（工作区正文 + 扩展索引）
// ---------------------------------------------------------------------------

describe('report_* 工作区正文 + 扩展索引', () => {
  it('report_create：session_id 必填（缺失 → HARNESS-1009）；正文物理落工作区 + 索引可查 + url 形状', async () => {
    const { manager, rows } = makeIndexExtManager();
    const workspace = makeFsWorkspace(dataDir);
    const container = new Map<string, unknown>([
      [WORKSPACE_CONTAINER_KEY, workspace],
      ['ext.manager', manager],
    ]);
    const ctx = {
      kernel: { container: { has: (k: string) => container.has(k), resolve: (k: string) => container.get(k) } },
      agentId: 'sess-report',
      updater: {},
      cronHistory: async () => [],
    } as unknown as SystemToolContext;

    const missing = await toolOf(reportTools, 'report_create').execute({ title: 'x', html: '<p>1</p>' }, ctx);
    expect(missing).toMatchObject({ ok: false, error: { code: 'HARNESS-1009' } });

    const created = (await toolOf(reportTools, 'report_create').execute(
      { title: '周报', html: '<h1>hi</h1>', session_id: 'sess-report' },
      ctx,
    )) as Record<string, unknown>;
    expect(created['ok']).toBe(true);
    expect(String(created['reportId'])).toMatch(UUID_RE);
    expect(created['path']).toBe(`reports/${String(created['reportId'])}.html`);
    expect(created['size']).toBe(Buffer.byteLength('<h1>hi</h1>', 'utf8'));
    expect(created['url']).toBe(
      `/api/v1/agents/sessions/sess-report/workspace/file?path=${encodeURIComponent(`reports/${String(created['reportId'])}.html`)}`,
    );

    // 正文物理存在于工作区（逐字节一致）；扩展索引只有一行且无正文
    const body = await workspace.read('sess-report', `reports/${String(created['reportId'])}.html`);
    expect(body.toString('utf8')).toBe('<h1>hi</h1>');
    expect(rows.size).toBe(1);
    expect(rows.get(String(created['reportId']))).toMatchObject({ sessionId: 'sess-report', path: String(created['path']) });
  });

  it('report_get / report_list：索引元数据 + url，不回正文', async () => {
    const ctx = makeCtx({ agentId: 'sess-rl' });
    const created = (await toolOf(reportTools, 'report_create').execute(
      { title: 'L', html: '<p>body</p>', session_id: 'sess-rl' },
      ctx,
    )) as Record<string, unknown>;
    const reportId = String(created['reportId']);

    const got = await toolOf(reportTools, 'report_get').execute({ reportId }, ctx);
    expect(got['ok']).toBe(true);
    expect(got['title']).toBe('L');
    expect(got).not.toHaveProperty('html');
    expect(got['meta']).toMatchObject({ reportId, sessionId: 'sess-rl', path: `reports/${reportId}.html` });
    expect(got['url']).toBe(
      `/api/v1/agents/sessions/sess-rl/workspace/file?path=${encodeURIComponent(`reports/${reportId}.html`)}`,
    );

    const listed = await toolOf(reportTools, 'report_list').execute({}, ctx);
    expect(listed['ok']).toBe(true);
    const reports = listed['reports'] as Array<Record<string, unknown>>;
    expect(reports.map((r) => r['reportId'])).toContain(reportId);
    expect(reports.find((r) => r['reportId'] === reportId)?.['url']).toBe(got['url']);

    // 索引缺失的正文坐标：list 过滤
    const filtered = await toolOf(reportTools, 'report_list').execute({ session_id: 'sess-other' }, ctx);
    expect(((filtered['reports'] as unknown[]) ?? []).map((r) => (r as Record<string, unknown>)['reportId'])).not.toContain(
      reportId,
    );
  });

  it('report_delete：删索引 + 删工作区正文；正文缺失幂等（不报错）；索引未知 id → ok:false', async () => {
    const workspace = makeFsWorkspace(dataDir);
    const { manager, rows } = makeIndexExtManager();
    const container = new Map<string, unknown>([
      [WORKSPACE_CONTAINER_KEY, workspace],
      ['ext.manager', manager],
    ]);
    const ctx = {
      kernel: { container: { has: (k: string) => container.has(k), resolve: (k: string) => container.get(k) } },
      agentId: 'sess-del',
      updater: {},
      cronHistory: async () => [],
    } as unknown as SystemToolContext;

    const created = (await toolOf(reportTools, 'report_create').execute(
      { title: 'D', html: '<p>d</p>', session_id: 'sess-del' },
      ctx,
    )) as Record<string, unknown>;
    const reportId = String(created['reportId']);
    const relPath = `reports/${reportId}.html`;

    // 正文缺失（外部已清理）→ 删除仍成功（幂等语义）
    await workspace.delete('sess-del', relPath);
    const removed = await toolOf(reportTools, 'report_delete').execute({ reportId }, ctx);
    expect(removed).toMatchObject({ ok: true, reportId, deleted: true });
    expect(rows.has(reportId)).toBe(false);

    // 索引已无此行 → 再删收敛 ok:false（索引面不存在）
    const again = await toolOf(reportTools, 'report_delete').execute({ reportId }, ctx);
    expect(again['ok']).toBe(false);

    // 正常路径：删完正文也没了
    const second = (await toolOf(reportTools, 'report_create').execute(
      { title: 'D2', html: '<p>d2</p>', session_id: 'sess-del' },
      ctx,
    )) as Record<string, unknown>;
    const removed2 = await toolOf(reportTools, 'report_delete').execute({ reportId: String(second['reportId']) }, ctx);
    expect(removed2).toMatchObject({ ok: true });
    await expect(workspace.read('sess-del', `reports/${String(second['reportId'])}.html`)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// browser 截图与 coding 覆写的工作区链路
// ---------------------------------------------------------------------------

describe('三引擎工作区接入（工具链路）', () => {
  it('browser_screenshot（引擎替身）：有会话上下文 → 落工作区 screenshots/ 且 url 为 REST 预览端点形状', async () => {
    const workspace = makeFsWorkspace(dataDir);
    await workspace.resolve('sess-shot');
    const container = new Map<string, unknown>([[WORKSPACE_CONTAINER_KEY, workspace]]);
    const ctx = {
      kernel: { container: { has: (k: string) => container.has(k), resolve: (k: string) => container.get(k) } },
      agentId: 'sess-shot',
      updater: {},
      cronHistory: async () => [],
    } as unknown as SystemToolContext;
    const seen: Array<{ fullPage?: boolean; targetDir?: string }> = [];
    const engine = {
      navigate: async () => ({}),
      snapshot: async () => ({ snapshot: '', truncated: false }),
      click: async () => true,
      type: async () => true,
      pressKey: async () => true,
      screenshot: async (input: { fullPage?: boolean; targetDir?: string }) => {
        seen.push(input);
        // 模拟真实引擎的 targetDir 落盘语义：物理写文件 + 返回工作区相对 path
        if (input.targetDir !== undefined) {
          mkdirSync(input.targetDir, { recursive: true });
          writeFileSync(join(input.targetDir, 'shot.png'), 'png');
        }
        return { path: 'screenshots/shot.png', file: 'shot.png', url: '' };
      },
      close: async () => undefined,
      status: async () => ({ installed: true, running: false, installing: false, lastError: null }),
    };
    const tools = createBrowserTools(() => ({ engine: engine as never }));
    const result = await toolOf(tools, 'browser_screenshot').execute({ fullPage: true }, ctx);
    expect(result).toMatchObject({
      ok: true,
      path: 'screenshots/shot.png',
      url: '/api/v1/agents/sessions/sess-shot/workspace/file?path=screenshots%2Fshot.png',
    });
    expect(seen).toEqual([{ fullPage: true, targetDir: join(dataDir, 'sess-shot', 'screenshots') }]);
    // 物理文件落在工作区 screenshots/
    expect(existsSync(join(dataDir, 'sess-shot', 'screenshots', 'shot.png'))).toBe(true);
  });

  it('coding_*（真实子进程）：ctx.agentId 可解析工作区 → 会话产物直接落对话工作区', async () => {
    if (!hasNode) return; // skipIf 降级
    const engine = new CodingEngine({
      dataDir: join(dataDir, 'coding-data'),
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined } as never,
    });
    const wsRoot = join(dataDir, 'ws-coding');
    mkdirSync(wsRoot, { recursive: true });
    const container = new Map<string, unknown>([
      ['coding.engine', engine],
      [WORKSPACE_CONTAINER_KEY, makeFsWorkspace(dataDir)],
    ]);
    const ctx = {
      kernel: { container: { has: (k: string) => container.has(k), resolve: (k: string) => container.get(k) } },
      agentId: 'ws-coding', // 与 wsRoot 对应的 scope（makeFsWorkspace: <root>/<scopeId>）
      updater: {},
      cronHistory: async () => [],
    } as unknown as SystemToolContext;

    const tools = createCodingTools();
    const exec = await toolOf(tools, 'coding_exec').execute(
      { cmd: 'node', args: ['-e', 'require("node:fs").writeFileSync("out.txt", "workspace-artifact")'] },
      ctx,
    );
    expect(exec).toMatchObject({ ok: true, exitCode: 0 });
    // 会话产物自然落对话工作区（默认 coding-workspaces 下无该会话目录）
    expect(readFileSync(join(wsRoot, 'out.txt'), 'utf8')).toBe('workspace-artifact');
    expect(existsSync(join(dataDir, 'coding-data', 'coding-workspaces', 'default'))).toBe(false);

    // coding_fs_* 读写的就是工作区
    await toolOf(tools, 'coding_fs_write').execute({ path: 'notes/w.md', content: 'cw' }, ctx);
    expect(readFileSync(join(wsRoot, 'notes', 'w.md'), 'utf8')).toBe('cw');
    const read = await toolOf(tools, 'coding_fs_read').execute({ path: 'notes/w.md' }, ctx);
    expect(read).toMatchObject({ ok: true, content: 'cw' });
    const list = await toolOf(tools, 'coding_fs_list').execute({}, ctx);
    expect((list['entries'] as Array<{ name: string }>).map((e) => e.name)).toEqual(
      expect.arrayContaining(['out.txt', 'notes']),
    );
  });
});
