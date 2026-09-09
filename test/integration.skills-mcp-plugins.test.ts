/**
 * Skills / MCP / 插件 总装 E2E（真实内核 boot + 真实 fastify + 真实 stdio MCP 子进程）。
 *
 * 与 mcp-e2e / integration.final 的差别：本文件**不注入任何服务**——skills /
 * mcp / plugins 的 registry、REST 路由与扩展桥全部由内核自身总装
 * （providers/core-services.ts），验证的就是生产接线：
 * - skills：POST /api/v1/skills/refresh 聚合 builtin（repoRoot/skills，缺失时本测试
 *   临建并在 afterAll 清理）与 data（<dataDir>/skills）两根 → 列表 / 详情（含正文）；
 * - mcp：真实 stdio echo server（官方 SDK 子进程，夹具同 mcp-e2e.test.ts）→
 *   POST servers 201 → connect → tools 目录 → tools/call 回显；
 * - plugins：multipart zip 安装（plugin.json + 贡献 skill 文件 + mcpServers 声明 +
 *   scripts 声明）→ 贡献同时出现在 skills 列表（source=extension）与 mcp servers 列表
 *   （id 经 ':'→'--' 归一）→ 无 force 卸载 403 → force 卸载后贡献消失；
 * - 门禁：无令牌 401、normal 角色写操作 403（auth 扩展完整 onboarding+强制 2FA 链路）；
 * - 扩展桥 smoke：容器 'ext.bridges' 三桥并表——kernel 端点 RPC_PERMISSION_DENIED、
 *   无权限扩展端点 FORBIDDEN、skills.register 贡献面免权限；createKernelHandlers 的
 *   extraBridges 懒合并后 skills.* 可达；scriptRunner 在沙箱未启用时 NOT_IMPLEMENTED。
 */
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { generate as totpGenerateCode } from 'otplib';

// worker 入口解析在工厂调用期读 env：boot 之前设置即可（与 integration.final 同款）
process.env['HARNESS_WORKER_MODE'] = 'dev';

import { CONTAINER_KEYS, Kernel } from '../src/kernel/Kernel.js';
import { loadConfig } from '../src/kernel/config/index.js';
import { createKernelHandlers } from '../src/kernel/extensions/kernel-handlers.js';
import { err } from '../src/kernel/errors/index.js';
import type { InstalledPlugin, PluginRegistry } from '../src/kernel/plugins/index.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const execFileAsync = promisify(execFile);

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SDK_ESM = path.join(REPO_ROOT, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm');

function sdkUrl(rel: string): string {
  return pathToFileURL(path.join(SDK_ESM, rel)).href;
}

/** 与 test/mcp-e2e.test.ts 同款最小 echo MCP server（真实 stdio 子进程夹具） */
function echoServerScript(): string {
  return `
const { Server } = await import(${JSON.stringify(sdkUrl(path.join('server', 'index.js')))});
const { StdioServerTransport } = await import(${JSON.stringify(sdkUrl(path.join('server', 'stdio.js')))});
const types = await import(${JSON.stringify(sdkUrl('types.js'))});
const server = new Server({ name: 'echo-smp', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(types.ListToolsRequestSchema, async () => ({
  tools: [{ name: 'echo', description: 'echoes arguments back as JSON text',
    inputSchema: { type: 'object', properties: { message: { type: 'string' } } } }],
}));
server.setRequestHandler(types.CallToolRequestSchema, async (request) => ({
  content: [{ type: 'text', text: JSON.stringify({ echo: request.params.arguments ?? {} }) }],
}));
await server.connect(new StdioServerTransport());
`;
}

// ---------------------------------------------------------------------------
// 夹具常量
// ---------------------------------------------------------------------------

const BUILTIN_SKILL_ID = 'e2e-builtin-skill';
const DATA_SKILL_ID = 'e2e-data-skill';
const PLUGIN_ID = 'e2e-demo';
const PLUGIN_SKILL_ID = 'demo-greet';
/** 插件声明 server 的 MCP 配置面 id（'plugin:e2e-demo:echo' 经 ':'→'--' 归一，见 core-services） */
const PLUGIN_SERVER_ID = 'plugin--e2e-demo--echo';

const DATA_SKILL_BODY = '# data-root fixture\n\n数据域技能正文（集成夹具）。\n';
const PLUGIN_SKILL_BODY = '# plugin contributed\n\n插件贡献技能正文（集成夹具）。\n';

// ---------------------------------------------------------------------------
// 环境
// ---------------------------------------------------------------------------

let dataDir = '';
let echoScript = '';
let workDir = '';
let kernel: Kernel;
let app: FastifyInstance;
let rootToken = '';
/** repo 的 skills/ 是否为本测试临建（afterAll 据此清理，绝不删除既有目录） */
let repoSkillsCreated = false;

const rootAuth = () => ({ authorization: `Bearer ${rootToken}` });

/** 轮询直到 pred 成立或超时（插件贡献注入是 fire-and-forget 适配链，需等待落定） */
async function waitFor(what: string, pred: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await pred()) return;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'opptrix-smp-e2e-'));
  workDir = path.join(dataDir, 'work');
  await mkdir(workDir, { recursive: true });
  echoScript = path.join(workDir, 'echo-server.mjs');
  await writeFile(echoScript, echoServerScript(), 'utf8');

  // data 根技能夹具：<dataDir>/skills/<id>/SKILL.md
  await mkdir(path.join(dataDir, 'skills', DATA_SKILL_ID), { recursive: true });
  await writeFile(
    path.join(dataDir, 'skills', DATA_SKILL_ID, 'SKILL.md'),
    `---\ndescription: data-root fixture skill for integration e2e\nversion: 1.0.0\n---\n${DATA_SKILL_BODY}`,
    'utf8',
  );

  // builtin 根技能夹具：repoRoot/skills 缺失时临建（afterAll 清理；存在则绝不动它）
  const repoSkills = path.join(REPO_ROOT, 'skills');
  repoSkillsCreated = !existsSync(repoSkills);
  await mkdir(path.join(repoSkills, BUILTIN_SKILL_ID), { recursive: true });
  await writeFile(
    path.join(repoSkills, BUILTIN_SKILL_ID, 'SKILL.md'),
    `---\ndescription: builtin fixture skill for integration e2e\n---\n# builtin fixture\n`,
    'utf8',
  );

  kernel = new Kernel({
    config: {
      ...loadConfig({
        NODE_ENV: 'test',
        HARNESS_LOG_LEVEL: 'error',
        HARNESS_TASK_WORKERS: '1',
        HARNESS_DATA_DIR: dataDir,
        HARNESS_PERSIST_ROOT_TOKEN: '0',
        HARNESS_SANDBOX_ENABLED: '0', // runScript 的 NOT_IMPLEMENTED 分支需确定性
      }),
      port: 0,
    },
  });
  await kernel.boot();
  rootToken = kernel.container.resolve<{ token: string }>(CONTAINER_KEYS.authIdentity).token;
  app = kernel.container.resolve<{ app: FastifyInstance }>(CONTAINER_KEYS.http).app;
});

afterAll(async () => {
  await kernel?.shutdown('smp-e2e-afterall');
  if (repoSkillsCreated) {
    await rm(path.join(REPO_ROOT, 'skills'), { recursive: true, force: true });
  }
  if (dataDir !== '') await rm(dataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 造包辅助（zip 用系统 CLI，根布局探测两种皆兼容）
// ---------------------------------------------------------------------------

/** 写插件源目录（单顶层目录布局 zip）→ 返回 { srcDir, zipPath } */
async function buildPluginZip(): Promise<{ srcDir: string; zipPath: string }> {
  const srcName = 'pkg';
  const srcDir = path.join(workDir, srcName);
  await mkdir(path.join(srcDir, 'skills'), { recursive: true });
  await mkdir(path.join(srcDir, 'scripts'), { recursive: true });
  const manifest = {
    id: PLUGIN_ID,
    name: 'E2E Demo Plugin',
    version: '1.0.0',
    description: 'integration fixture plugin',
    author: 'Opptrix',
    skills: [
      {
        id: PLUGIN_SKILL_ID,
        name: PLUGIN_SKILL_ID,
        description: 'plugin contributed skill for integration e2e',
        file: 'skills/demo-greet.md',
      },
    ],
    prompts: [],
    scripts: [{ id: 'hello', file: 'scripts/hello.js' }],
    mcpServers: [
      {
        id: 'echo',
        name: 'Plugin Echo',
        transport: 'stdio',
        command: process.execPath,
        args: [echoScript],
      },
    ],
  };
  await writeFile(path.join(srcDir, 'plugin.json'), JSON.stringify(manifest, null, 2), 'utf8');
  await writeFile(path.join(srcDir, 'skills', 'demo-greet.md'), PLUGIN_SKILL_BODY, 'utf8');
  await writeFile(path.join(srcDir, 'scripts', 'hello.js'), `process.stdout.write('hello');\n`, 'utf8');
  const zipPath = path.join(workDir, 'e2e-demo.zip');
  await execFileAsync('zip', ['-r', '-q', zipPath, srcName], { cwd: workDir });
  return { srcDir, zipPath };
}

/** 手工构造 multipart/form-data 请求体（field 名固定 'file'） */
function multipartBody(filename: string, content: Buffer): { payload: Buffer; headers: Record<string, string> } {
  const boundary = `----opptrixsmp${Math.random().toString(36).slice(2)}`;
  const head =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: application/zip\r\n\r\n`;
  const tail = `\r\n--${boundary}--\r\n`;
  return {
    payload: Buffer.concat([Buffer.from(head, 'utf8'), content, Buffer.from(tail, 'utf8')]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

/** 强制 2FA 全链（onboarding 或 login 起步）：拿 enr 令牌 → 现算 TOTP → enroll → 会话令牌 */
async function enroll(first: { enrollmentRequired?: boolean; enrollToken?: string }): Promise<string> {
  expect(first.enrollmentRequired).toBe(true);
  const setup = await app.inject({
    method: 'GET',
    url: `/api/v1/auth/2fa/setup?enrollToken=${first.enrollToken}`,
  });
  expect(setup.statusCode).toBe(200);
  const { secret } = setup.json() as { secret: string };
  const enrollRes = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/2fa/enroll',
    payload: { enrollToken: first.enrollToken, code: await totpGenerateCode({ secret }) },
  });
  expect(enrollRes.statusCode).toBe(200);
  return (enrollRes.json() as { token: string }).token;
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

describe('skills REST（内核总装面）', () => {
  it('401 门禁：无令牌 GET /api/v1/skills → 401 HARNESS-1006', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/skills' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'HARNESS-1006' });
  });

  it('POST /api/v1/skills/refresh（root）→ 聚合 builtin 与 data 两根 → { total, bySource }', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/skills/refresh', headers: rootAuth() });
    expect(res.statusCode).toBe(200);
    const report = res.json() as { total: number; bySource: Record<string, number> };
    expect(report.total).toBeGreaterThanOrEqual(2);
    expect(report.bySource['builtin']).toBeGreaterThanOrEqual(1);
    expect(report.bySource['data']).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/v1/skills 列表含 builtin 与 data 技能（条目不含正文）；?source= 过滤生效', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/skills', headers: rootAuth() });
    expect(res.statusCode).toBe(200);
    const list = res.json() as Array<{ id: string; source: string; body?: unknown; description: string }>;
    const builtin = list.find((s) => s.id === BUILTIN_SKILL_ID);
    const data = list.find((s) => s.id === DATA_SKILL_ID);
    expect(builtin).toMatchObject({ source: 'builtin' });
    expect(data).toMatchObject({ source: 'data', description: 'data-root fixture skill for integration e2e' });
    for (const entry of list) expect(entry.body).toBeUndefined(); // 列表不含正文

    const onlyData = await app.inject({
      method: 'GET',
      url: '/api/v1/skills?source=data',
      headers: rootAuth(),
    });
    expect(onlyData.statusCode).toBe(200);
    expect((onlyData.json() as Array<{ id: string }>).map((s) => s.id)).toEqual([DATA_SKILL_ID]);
  });

  it('GET /api/v1/skills/:id 详情含正文（frontmatter 已剥离）；未知 id → 404 HARNESS-3004', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/skills/${DATA_SKILL_ID}`, headers: rootAuth() });
    expect(res.statusCode).toBe(200);
    const detail = res.json() as { id: string; body: string };
    expect(detail.id).toBe(DATA_SKILL_ID);
    expect(detail.body).toBe(DATA_SKILL_BODY);

    const ghost = await app.inject({ method: 'GET', url: '/api/v1/skills/no-such-skill', headers: rootAuth() });
    expect(ghost.statusCode).toBe(404);
    expect(ghost.json()).toMatchObject({ code: 'HARNESS-3004' });
  });

  it('403 门禁：normal 角色会话 refresh → 403 HARNESS-1007（读列表放行）', async () => {
    // owner 引导（root 令牌所有权门）→ 强制 2FA → admin 会话
    const onboarding = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/onboarding',
      payload: { rootToken, username: 'owner', password: 'owner-passw0rd' },
    });
    expect(onboarding.statusCode).toBe(200);
    const adminToken = await enroll(onboarding.json());

    // admin 建 normal 用户 → 登录 → 强制 2FA → normal 会话
    const createUser = await app.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { username: 'alice', password: 'alice-passw0rd', role: 'normal' },
    });
    expect(createUser.statusCode).toBe(200);
    const aliceLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'alice', password: 'alice-passw0rd' },
    });
    const aliceToken = await enroll(aliceLogin.json());

    const forbidden = await app.inject({
      method: 'POST',
      url: '/api/v1/skills/refresh',
      headers: { authorization: `Bearer ${aliceToken}` },
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json()).toMatchObject({ code: 'HARNESS-1007' });

    const readOk = await app.inject({
      method: 'GET',
      url: '/api/v1/skills',
      headers: { authorization: `Bearer ${aliceToken}` },
    });
    expect(readOk.statusCode).toBe(200);
  });
});

describe('MCP REST 全链（真实 stdio 子进程）', () => {
  it('POST servers 201 → connect 200（state=connected, toolCount=1）', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/mcp/servers',
      headers: rootAuth(),
      payload: {
        id: 'echo-1',
        name: 'Echo Server',
        transport: 'stdio',
        command: process.execPath,
        args: [echoScript],
        enabled: true,
      },
    });
    expect(create.statusCode).toBe(201);

    const connect = await app.inject({
      method: 'POST',
      url: '/api/v1/mcp/servers/echo-1/connect',
      headers: rootAuth(),
    });
    expect(connect.statusCode).toBe(200);
    expect(connect.json()).toMatchObject({ id: 'echo-1', state: 'connected', toolCount: 1 });
  });

  it('GET tools 含 echo → POST tools/call 回显 200', async () => {
    const tools = await app.inject({
      method: 'GET',
      url: '/api/v1/mcp/tools?serverId=echo-1',
      headers: rootAuth(),
    });
    expect(tools.statusCode).toBe(200);
    expect(tools.json()).toEqual([expect.objectContaining({ serverId: 'echo-1', name: 'echo' })]);

    const call = await app.inject({
      method: 'POST',
      url: '/api/v1/mcp/tools/call',
      headers: rootAuth(),
      payload: { serverId: 'echo-1', toolName: 'echo', args: { message: 'smp-e2e' } },
    });
    expect(call.statusCode).toBe(200);
    const result = call.json() as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify({ echo: { message: 'smp-e2e' } }) }]);
  });
});

describe('插件包全链（安装 → 贡献 → 卸载）', () => {
  let pluginZipPath = '';

  beforeAll(async () => {
    ({ zipPath: pluginZipPath } = await buildPluginZip());
  });

  it('POST /api/v1/plugins/install（multipart zip）→ 201；GET list 可见', async () => {
    const zipData = await readFile(pluginZipPath);
    const { payload, headers } = multipartBody('e2e-demo.zip', zipData);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/plugins/install',
      headers: { ...rootAuth(), ...headers },
      payload,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ id: PLUGIN_ID, skills: 1, mcpServers: 1, scripts: 1 });

    const list = await app.inject({ method: 'GET', url: '/api/v1/plugins', headers: rootAuth() });
    expect(list.statusCode).toBe(200);
    expect((list.json() as InstalledPlugin[]).map((p) => p.id)).toContain(PLUGIN_ID);
  });

  it('插件贡献可见：skills 列表含 source=extension 技能；mcp servers 含插件声明 server（异步注入落定后 connected）', async () => {
    const skills = await app.inject({ method: 'GET', url: '/api/v1/skills', headers: rootAuth() });
    expect(skills.statusCode).toBe(200);
    const contributed = (skills.json() as Array<{ id: string; source: string }>).find(
      (s) => s.id === PLUGIN_SKILL_ID,
    );
    expect(contributed).toMatchObject({ source: 'extension' });

    // mcp 注入走 fire-and-forget 适配链（落配置 → connect），轮询到 connected 为止
    await waitFor('plugin mcp server connected', async () => {
      const servers = await app.inject({ method: 'GET', url: '/api/v1/mcp/servers', headers: rootAuth() });
      const found = (servers.json() as Array<{ id: string; state: string; name: string }>).find(
        (s) => s.id === PLUGIN_SERVER_ID,
      );
      return found !== undefined && found.state === 'connected' && found.name === 'Plugin Echo';
    });

    // 插件声明 server 的工具亦可调用（经归一 id）
    const call = await app.inject({
      method: 'POST',
      url: '/api/v1/mcp/tools/call',
      headers: rootAuth(),
      payload: { serverId: PLUGIN_SERVER_ID, toolName: 'echo', args: { message: 'via-plugin' } },
    });
    expect(call.statusCode).toBe(200);
    const result = call.json() as { content: Array<{ type: string; text: string }> };
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify({ echo: { message: 'via-plugin' } }) }]);
  });

  it('runScript：沙箱未启用 → NOT_IMPLEMENTED（HARNESS-9004，脚本绝不在宿主进程执行）', async () => {
    const pluginsRegistry = kernel.container.resolve<PluginRegistry>(CONTAINER_KEYS.pluginsRegistry);
    await expect(pluginsRegistry.runScript(PLUGIN_ID, 'hello', { a: 1 })).rejects.toMatchObject({
      code: err('NOT_IMPLEMENTED').code,
    });
  });

  it('DELETE 无 force 有贡献 → 403 HARNESS-1007；force 后贡献消失（skills 与 mcp 双面摘除）', async () => {
    const noForce = await app.inject({ method: 'DELETE', url: `/api/v1/plugins/${PLUGIN_ID}`, headers: rootAuth() });
    expect(noForce.statusCode).toBe(403);
    expect(noForce.json()).toMatchObject({ code: 'HARNESS-1007' });

    const forced = await app.inject({
      method: 'DELETE',
      url: `/api/v1/plugins/${PLUGIN_ID}?force=1`,
      headers: rootAuth(),
    });
    expect(forced.statusCode).toBe(200);
    expect(forced.json()).toEqual({ deleted: true });

    // skills 面：贡献技能摘除（同步）
    const skills = await app.inject({ method: 'GET', url: '/api/v1/skills', headers: rootAuth() });
    expect((skills.json() as Array<{ id: string }>).map((s) => s.id)).not.toContain(PLUGIN_SKILL_ID);

    // plugins 面：列表无该插件
    const plugins = await app.inject({ method: 'GET', url: '/api/v1/plugins', headers: rootAuth() });
    expect((plugins.json() as InstalledPlugin[]).map((p) => p.id)).not.toContain(PLUGIN_ID);

    // mcp 面：配置与连接摘除（fire-and-forget 适配链，轮询确认）
    await waitFor('plugin mcp server removed', async () => {
      const servers = await app.inject({ method: 'GET', url: '/api/v1/mcp/servers', headers: rootAuth() });
      return !(servers.json() as Array<{ id: string }>).some((s) => s.id === PLUGIN_SERVER_ID);
    });
  });
});

describe('扩展桥（skills/mcp/plugins 三桥并表）门禁 smoke', () => {
  /** 容器 'ext.bridges' 的并表（REST 与内核桥共用的同一批 registry） */
  const bridges = (): Record<string, (payload: unknown, from: string) => Promise<unknown>> =>
    kernel.container.resolve(CONTAINER_KEYS.extBridges);

  it('三桥 topic 全部可达（skills×4 / mcp×3 / plugins.list）', () => {
    for (const topic of [
      'skills.list',
      'skills.get',
      'skills.refresh',
      'skills.register',
      'mcp.servers.list',
      'mcp.tools.list',
      'mcp.tools.call',
      'plugins.list',
    ]) {
      expect(bridges()[topic], topic).toBeTypeOf('function');
    }
  });

  it('kernel 端点 → RPC_PERMISSION_DENIED；未声明权限的扩展端点 → FORBIDDEN', async () => {
    await expect(bridges()['skills.list']({}, 'kernel')).rejects.toMatchObject({
      code: err('RPC_PERMISSION_DENIED').code,
    });
    // 'ext:ghost' 无已注册 manifest → permissions 为空 → 一律 FORBIDDEN（fail-closed）
    await expect(bridges()['skills.list']({}, 'ext:ghost')).rejects.toMatchObject({ code: err('FORBIDDEN').code });
    await expect(bridges()['skills.get']({ id: DATA_SKILL_ID }, 'ext:ghost')).rejects.toMatchObject({
      code: err('FORBIDDEN').code,
    });
    await expect(bridges()['skills.refresh']({}, 'ext:ghost')).rejects.toMatchObject({ code: err('FORBIDDEN').code });
    await expect(
      bridges()['mcp.tools.call']({ serverId: 'echo-1', toolName: 'echo' }, 'ext:ghost'),
    ).rejects.toMatchObject({ code: err('FORBIDDEN').code });
    await expect(bridges()['plugins.list']({}, 'ext:ghost')).rejects.toMatchObject({ code: err('FORBIDDEN').code });
  });

  it('skills.register 贡献面免权限：任意扩展端点可按自身 extId 记贡献，随后可摘除', async () => {
    const registered = (await bridges()['skills.register'](
      {
        skills: [
          { id: 'ext-smoke-skill', name: 'ext-smoke-skill', description: 'bridge smoke contribution', body: '# hi' },
        ],
      },
      'ext:smoke-ext',
    )) as { ok: boolean; registered: number };
    expect(registered).toEqual({ ok: true, registered: 1 });

    // 贡献立即可见（来源 extension），再由内核侧摘除（disable 联动同款 API）
    const skills = await app.inject({ method: 'GET', url: '/api/v1/skills?source=extension', headers: rootAuth() });
    expect((skills.json() as Array<{ id: string }>).map((s) => s.id)).toContain('ext-smoke-skill');
    kernel.container
      .resolve<{ removeContributed(extId: string): void }>(CONTAINER_KEYS.skillsRegistry)
      .removeContributed('smoke-ext');
    const after = await app.inject({ method: 'GET', url: '/api/v1/skills', headers: rootAuth() });
    expect((after.json() as Array<{ id: string }>).map((s) => s.id)).not.toContain('ext-smoke-skill');
  });

  it('createKernelHandlers 的 extraBridges 懒合并：skills.* 等 topic 在并表后可达，内核 topic 不受影响', () => {
    const handlers = createKernelHandlers({
      kernel,
      extraBridges: kernel.container.resolve(CONTAINER_KEYS.extBridges),
    });
    for (const topic of ['log', 'storage.get', 'system.info', 'skills.list', 'mcp.tools.list', 'plugins.list']) {
      expect(handlers[topic], topic).toBeTypeOf('function');
    }
  });
});
