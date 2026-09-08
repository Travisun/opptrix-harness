/**
 * MCP 客户端子系统 E2E（真实内核 boot + 真实 fastify HTTP + 真实 stdio 子进程）。
 *
 * 链路：内核 boot（临时 dataDir，auth 内置扩展激活）→ MCP REST 路由由内核总装
 * （providers/core-services.ts 原生挂载 registerMcpRoutes；registry/configStore 从
 * 容器 'mcp.registry' / 'mcp.config' 解析，与生产接线完全一致）
 * → REST 增删改查配置（原子落盘）→ connect 真实 stdio echo server（官方 SDK Server
 * + StdioServerTransport 子进程）→ tools 目录与调用 → resources/prompts →
 * 401（缺令牌）/ 403（normal 角色会话，经 auth 扩展完整 onboarding+强制 2FA 链路签发）门禁。
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { generate as totpGenerateCode } from 'otplib';

// worker 入口解析在工厂调用期读 env：boot 之前设置即可（与 integration.final 同款）
process.env['HARNESS_WORKER_MODE'] = 'dev';

import { CONTAINER_KEYS, Kernel } from '../src/kernel/Kernel.js';
import { loadConfig } from '../src/kernel/config/index.js';
import type { McpConfigStore } from '../src/kernel/mcp/config-store.js';
import type { McpRegistry } from '../src/kernel/mcp/registry.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SDK_ESM = path.join(REPO_ROOT, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm');

function sdkUrl(rel: string): string {
  return pathToFileURL(path.join(SDK_ESM, rel)).href;
}

/** 与 test/mcp-registry.test.ts 同款最小 echo MCP server（真实 stdio 子进程夹具） */
function echoServerScript(): string {
  return `
const { Server } = await import(${JSON.stringify(sdkUrl(path.join('server', 'index.js')))});
const { StdioServerTransport } = await import(${JSON.stringify(sdkUrl(path.join('server', 'stdio.js')))});
const types = await import(${JSON.stringify(sdkUrl('types.js'))});
const server = new Server({ name: 'echo-min', version: '1.0.0' }, { capabilities: { tools: {} } });
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
// 环境
// ---------------------------------------------------------------------------

let dataDir = '';
let echoScript = '';
let kernel: Kernel;
let app: FastifyInstance;
let rootToken = '';
let registry: McpRegistry;
let configStore: McpConfigStore;

const ADMIN_PASSWORD = 'owner-passw0rd';
const ALICE_PASSWORD = 'alice-passw0rd';

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'opptrix-mcp-e2e-'));
  echoScript = path.join(dataDir, 'echo-server.mjs');
  await writeFile(echoScript, echoServerScript(), 'utf8');

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
  // MCP registry/configStore 由内核总装登记（core-services），此处从容器解析使用
  registry = kernel.container.resolve<McpRegistry>(CONTAINER_KEYS.mcpRegistry);
  configStore = kernel.container.resolve<McpConfigStore>(CONTAINER_KEYS.mcpConfig);
  rootToken = kernel.container.resolve<{ token: string }>(CONTAINER_KEYS.authIdentity).token;
  app = kernel.container.resolve<{ app: FastifyInstance }>(CONTAINER_KEYS.http).app;
});

afterAll(async () => {
  if (configStore !== undefined) {
    for (const cfg of await configStore.load()) {
      await registry.disconnect(cfg.id);
    }
  }
  await kernel?.shutdown('mcp-e2e-afterall');
  if (dataDir !== '') await rm(dataDir, { recursive: true, force: true });
});

const rootAuth = () => ({ authorization: `Bearer ${rootToken}` });

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

describe('MCP REST E2E（真实内核 boot）', () => {
  it('401 门禁: 无令牌访问 MCP API → 401 HARNESS-1006（内核统一鉴权，路由前即拦截）', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/mcp/servers' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'HARNESS-1006' });
  });

  it('POST /servers: admin 建配置 → 201 + 0600 文件落盘；GET /servers 显示 state=never', async () => {
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
    expect(create.json()).toMatchObject({ id: 'echo-1', transport: 'stdio', enabled: true });

    const { stat } = await import('node:fs/promises');
    expect((await stat(path.join(dataDir, 'mcp', 'config.json'))).mode & 0o777).toBe(0o600);

    const list = await app.inject({ method: 'GET', url: '/api/v1/mcp/servers', headers: rootAuth() });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual([expect.objectContaining({ id: 'echo-1', state: 'never', toolCount: 0 })]);
  });

  it('POST /servers: 非法 body（stdio 缺 command / 坏 id）→ 400 HARNESS-1009', async () => {
    const noCommand = await app.inject({
      method: 'POST',
      url: '/api/v1/mcp/servers',
      headers: rootAuth(),
      payload: { id: 'bad-1', name: 'x', transport: 'stdio', enabled: true },
    });
    expect(noCommand.statusCode).toBe(400);
    expect(noCommand.json().code).toBe('HARNESS-1009');
    const badId = await app.inject({
      method: 'POST',
      url: '/api/v1/mcp/servers',
      headers: rootAuth(),
      payload: { id: 'Not Ok', name: 'x', transport: 'sse', url: 'https://mcp.example.com/sse', enabled: true },
    });
    expect(badId.statusCode).toBe(400);
    expect(JSON.stringify(badId.json().detail)).toContain('id must match');
  });

  it('connect → tools 目录 → tools/call: 真实 stdio echo server 全链', async () => {
    const connect = await app.inject({ method: 'POST', url: '/api/v1/mcp/servers/echo-1/connect', headers: rootAuth() });
    expect(connect.statusCode).toBe(200);
    expect(connect.json()).toMatchObject({ id: 'echo-1', state: 'connected', toolCount: 1 });

    const tools = await app.inject({ method: 'GET', url: '/api/v1/mcp/tools?serverId=echo-1', headers: rootAuth() });
    expect(tools.statusCode).toBe(200);
    expect(tools.json()).toEqual([expect.objectContaining({ serverId: 'echo-1', name: 'echo' })]);

    const call = await app.inject({
      method: 'POST',
      url: '/api/v1/mcp/tools/call',
      headers: rootAuth(),
      payload: { serverId: 'echo-1', toolName: 'echo', args: { message: 'e2e hello' } },
    });
    expect(call.statusCode).toBe(200);
    const result = call.json() as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify({ echo: { message: 'e2e hello' } }) }]);

    // 未知 serverId：404 EXT_NOT_FOUND（配置面 404 语义，先于连接判定）
    const ghostCall = await app.inject({
      method: 'POST',
      url: '/api/v1/mcp/tools/call',
      headers: rootAuth(),
      payload: { serverId: 'ghost', toolName: 'echo' },
    });
    expect(ghostCall.statusCode).toBe(404);
    expect(ghostCall.json().code).toBe('HARNESS-3004');
  });

  it('PATCH: enabled=false 立即断连（state=disabled、工具目录回落空）；改回 true 可重连', async () => {
    const patch = await app.inject({
      method: 'PATCH',
      url: '/api/v1/mcp/servers/echo-1',
      headers: rootAuth(),
      payload: { enabled: false, name: 'Echo (paused)' },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json()).toMatchObject({ id: 'echo-1', enabled: false, name: 'Echo (paused)' });

    const status = await app.inject({ method: 'GET', url: '/api/v1/mcp/servers', headers: rootAuth() });
    expect(status.json()[0]).toMatchObject({ state: 'disabled', toolCount: 0 });
    const emptyTools = await app.inject({ method: 'GET', url: '/api/v1/mcp/tools', headers: rootAuth() });
    expect(emptyTools.statusCode).toBe(200);
    expect(emptyTools.json()).toEqual([]);

    await app.inject({
      method: 'PATCH',
      url: '/api/v1/mcp/servers/echo-1',
      headers: rootAuth(),
      payload: { enabled: true },
    });
    const reconnect = await app.inject({ method: 'POST', url: '/api/v1/mcp/servers/echo-1/connect', headers: rootAuth() });
    expect(reconnect.json()).toMatchObject({ state: 'connected' });
  });

  it('GET /:id/resources 与 /:id/prompts: 目录端点（echo server 未声明 → 空目录不炸）', async () => {
    const resources = await app.inject({ method: 'GET', url: '/api/v1/mcp/echo-1/resources', headers: rootAuth() });
    expect(resources.statusCode).toBe(200);
    expect(resources.json()).toEqual([]);
    const prompts = await app.inject({ method: 'GET', url: '/api/v1/mcp/echo-1/prompts', headers: rootAuth() });
    expect(prompts.statusCode).toBe(200);
    expect(prompts.json()).toEqual([]);
    const ghost = await app.inject({ method: 'GET', url: '/api/v1/mcp/ghost/resources', headers: rootAuth() });
    expect(ghost.statusCode).toBe(404);
    expect(ghost.json().code).toBe('HARNESS-3004');
  });

  it('DELETE: 删配置并断连；重复删除 → 404', async () => {
    const del = await app.inject({ method: 'DELETE', url: '/api/v1/mcp/servers/echo-1', headers: rootAuth() });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ deleted: true, id: 'echo-1' });
    const again = await app.inject({ method: 'DELETE', url: '/api/v1/mcp/servers/echo-1', headers: rootAuth() });
    expect(again.statusCode).toBe(404);
    const list = await app.inject({ method: 'GET', url: '/api/v1/mcp/servers', headers: rootAuth() });
    expect(list.json()).toEqual([]);
  });

  it('403 门禁: normal 角色会话（auth 扩展完整 onboarding+强制 2FA 链路签发）→ 403 HARNESS-1007', async () => {
    // owner 引导（root 令牌所有权门）→ 强制 2FA enrollment → admin 会话
    const onboarding = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/onboarding',
      payload: { rootToken, username: 'owner', password: ADMIN_PASSWORD },
    });
    expect(onboarding.statusCode).toBe(200);
    const adminToken = await enroll(onboarding.json());

    // admin 建 normal 用户 → 用户登录 → 同样强制 2FA → normal 会话
    const createUser = await app.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { username: 'alice', password: ALICE_PASSWORD, role: 'normal' },
    });
    expect(createUser.statusCode).toBe(200);
    const aliceLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'alice', password: ALICE_PASSWORD },
    });
    expect(aliceLogin.json()).toMatchObject({ enrollmentRequired: true });
    const aliceToken = await enroll(aliceLogin.json());

    // normal 角色：401 过了、但角色不过 → 403
    const forbidden = await app.inject({
      method: 'GET',
      url: '/api/v1/mcp/servers',
      headers: { authorization: `Bearer ${aliceToken}` },
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json()).toMatchObject({ code: 'HARNESS-1007' });
    const forbiddenCall = await app.inject({
      method: 'POST',
      url: '/api/v1/mcp/tools/call',
      headers: { authorization: `Bearer ${aliceToken}` },
      payload: { serverId: 'echo-1', toolName: 'echo' },
    });
    expect(forbiddenCall.statusCode).toBe(403);
    // 坏令牌仍是 401（角色门之前先过认证门）
    const badToken = await app.inject({
      method: 'GET',
      url: '/api/v1/mcp/servers',
      headers: { authorization: 'Bearer not-a-token' },
    });
    expect(badToken.statusCode).toBe(401);
  });
});
