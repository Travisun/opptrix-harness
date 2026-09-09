/**
 * system-mcp-server — 系统操作 MCP Server E2E（真实内核 boot + 官方 SDK Client）。
 *
 * 覆盖面（见 src/kernel/mcp/system-server.ts / system-tools.ts / bridge.ts）：
 * - /mcp 门禁：无凭据 401（HARNESS-1006）、normal 角色 403（HARNESS-1007）、
 *   无状态模式的 GET/DELETE → 405（HARNESS-1010）；
 * - 官方 SDK StreamableHTTPClientTransport（Bearer root token）全链：initialize →
 *   tools/list（≥30 工具且含 skills_create/cron_create/extensions_disable/mcp_server_add/
 *   logs_list）→ tools/call 实际执行系统操作；
 * - 系统操作落盘可见性：cron_create 后 cron_list 可见、skills_create 后 REST
 *   GET /api/v1/skills 可见、files_write→files_read base64 往返、extensions_disable 对
 *   builtin 返回 ok:false 'builtin locked'（不抛错）；
 * - 其余域 smoke：notifications / mcp server 增删（stdio 假命令 → 连接失败如实上报、
 *   配置保留） / plugins / logs / update / system_info / system_doctor；
 * - 桥合并：createMcpBridge 的 mcp.tools.list 追加 serverId='system' 目录、
 *   mcp.tools.call 对 serverId='system' 路由到目录执行器（admin 身份）。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FastifyInstance } from 'fastify';
import { generate as totpGenerateCode } from 'otplib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// worker 入口解析在工厂调用期读 env：boot 之前设置即可（与 integration.* 同款）
process.env['HARNESS_WORKER_MODE'] = 'dev';

import { KERNEL_TOPICS } from '../src/extension-host/protocol.js';
import { SUBAGENT_MANAGER_CONTAINER_KEYS, createSystemTools, type SystemToolContext } from '../src/kernel/mcp/system-tools.js';
import { HarnessError } from '../src/kernel/errors/HarnessError.js';
import { CONTAINER_KEYS, Kernel } from '../src/kernel/Kernel.js';
import { loadConfig } from '../src/kernel/config/index.js';
import { createMcpBridge } from '../src/kernel/mcp/bridge.js';
import { currentSystemRuntime } from '../src/kernel/mcp/system-server.js';
import { SYSTEM_TOOLS_CONTAINER_KEY } from '../src/kernel/mcp/system-tools.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

// ---------------------------------------------------------------------------
// 环境
// ---------------------------------------------------------------------------

let dataDir = '';
let kernel: Kernel;
let app: FastifyInstance;
let rootToken = '';
let port = 0;
let baseUrl = '';

const rootAuth = () => ({ authorization: `Bearer ${rootToken}` });

/** 轮询直到 pred 成立或超时（cron fire 历史落库为异步管线，需等待落定） */
async function waitFor(what: string, pred: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await pred()) return;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** 手工 JSON-RPC 帧 */
function rpc(method: string, params: Record<string, unknown>, id: number): Record<string, unknown> {
  return { jsonrpc: '2.0', id, method, params };
}

/** 构建一个连到 /mcp 的官方 SDK Client（Bearer token 随请求发送；调用方负责 close） */
async function connectClient(token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'system-mcp-e2e', version: '0.0.0' });
  await client.connect(transport);
  return client;
}

/** tools/call 的结果文本 → JSON（目录工具恒返回单 text 块 JSON 序列化结果对象） */
async function callSystem(client: Client, name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const result = (await client.callTool({ name, arguments: args })) as {
    content: Array<{ type: string; text?: string }>;
  };
  expect(Array.isArray(result.content)).toBe(true);
  const text = result.content[0]?.text ?? '';
  return JSON.parse(text) as Record<string, unknown>;
}

/** 强制 2FA 全链：拿 enr 令牌 → 现算 TOTP → enroll → 会话令牌（与 integration.* 同款） */
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

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'opptrix-system-mcp-'));
  kernel = new Kernel({
    config: {
      ...loadConfig({
        NODE_ENV: 'test',
        HARNESS_LOG_LEVEL: 'error',
        HARNESS_TASK_WORKERS: '1',
        HARNESS_DATA_DIR: dataDir,
        HARNESS_PERSIST_ROOT_TOKEN: '0',
        HARNESS_SANDBOX_ENABLED: '0',
      }),
      port: 0,
    },
  });
  await kernel.boot();
  rootToken = kernel.container.resolve<{ token: string }>(CONTAINER_KEYS.authIdentity).token;
  app = kernel.container.resolve<{ app: FastifyInstance }>(CONTAINER_KEYS.http).app;
  const address = app.server.address();
  port = address !== null && typeof address === 'object' ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await kernel?.shutdown('system-mcp-e2e-afterall');
  if (dataDir !== '') await rm(dataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

describe('/mcp 门禁与无状态协议选择', () => {
  it('无凭据 POST /mcp（initialize）→ 401 HARNESS-1006 HarnessError JSON', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } }, 1)),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: 'HARNESS-1006' });
  });

  it('无凭据 GET /mcp → 401（鉴权前置于方法闸）', async () => {
    const res = await fetch(`${baseUrl}/mcp`, { method: 'GET' });
    expect(res.status).toBe(401);
  });

  it('normal 角色 + 受限 scope API Key → 403 HARNESS-1007（root|admin 或 mcp:call scope 门禁）', async () => {
    // onboarding → admin 会话 → 建 normal 用户 → 登录 + 2FA → normal 会话
    const onboarding = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/onboarding',
      payload: { rootToken, username: 'owner', password: 'owner-passw0rd' },
    });
    expect(onboarding.statusCode).toBe(200);
    const adminToken = await enroll(onboarding.json());

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

    // normal 会话令牌 scopes=['*']（合法通过）——403 语义用受限 scope 的 API Key 验证
    const aliceSession = await connectClient(aliceToken);
    const listed = await aliceSession.listTools();
    expect(listed.tools.length).toBeGreaterThanOrEqual(30);
    await aliceSession.close();

    const key = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/api-keys',
      headers: { authorization: `Bearer ${aliceToken}` },
      payload: { name: 'limited', scopes: ['chat:send'] },
    });
    expect(key.statusCode).toBe(200);
    const limitedToken = (key.json() as { token: string }).token;

    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${limitedToken}`,
      },
      body: JSON.stringify(rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } }, 1)),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'HARNESS-1007' });
  });

  it('无状态模式：GET /mcp → 405 HARNESS-1010（DELETE 同款；无会话流可订阅/关闭）', async () => {
    const getRes = await fetch(`${baseUrl}/mcp`, { method: 'GET', headers: rootAuth() });
    expect(getRes.status).toBe(405);
    expect(await getRes.json()).toMatchObject({ code: 'HARNESS-1010' });
    const delRes = await fetch(`${baseUrl}/mcp`, { method: 'DELETE', headers: rootAuth() });
    expect(delRes.status).toBe(405);
  });
});

describe('SDK Client 全链：tools/list 目录', () => {
  it('initialize → tools/list：≥30 工具且含五个代表域工具；未知工具/参数缺失 → JSON-RPC error', async () => {
    const client = await connectClient(rootToken);
    try {
      const listed = await client.listTools();
      expect(listed.tools.length).toBeGreaterThanOrEqual(30);
      const names = new Set(listed.tools.map((t) => t.name));
      for (const required of ['skills_create', 'cron_create', 'extensions_disable', 'mcp_server_add', 'logs_list']) {
        expect(names.has(required)).toBe(true);
      }
      // 每个工具都有非空中文描述与 object 型 JSON Schema
      const withSchema = listed.tools.filter((t) => (t.inputSchema as { type?: string } | undefined)?.type === 'object');
      expect(withSchema.length).toBe(listed.tools.length);
      expect(listed.tools.every((t) => typeof t.description === 'string' && t.description.length > 0)).toBe(true);

      // 参数不符 schema / 未知工具 → SDK 归一为 isError 结果（JSON-RPC error 帧由 server 产生）
      const badArgs = (await client.callTool({ name: 'cron_create', arguments: {} })) as { isError?: boolean };
      expect(badArgs.isError).toBe(true);
      const unknownTool = (await client.callTool({ name: 'system_nonexistent', arguments: {} })) as { isError?: boolean };
      expect(unknownTool.isError).toBe(true);
    } finally {
      await client.close();
    }
  });
});

describe('skills / cron / extensions 工具执行与落盘可见性', () => {
  it('callTool skills_create → GET /api/v1/skills 可见；skills_get 返回正文；重复创建 ok:false', async () => {
    const client = await connectClient(rootToken);
    try {
      const body = '# 系统工具创建的技能\n\n由 skills_create 写入 dataDir/skills。\n';
      const created = await callSystem(client, 'skills_create', {
        id: 'sys-mcp-skill',
        name: 'sys-mcp-skill',
        description: 'created via the system mcp tools',
        body,
      });
      expect(created['ok']).toBe(true);

      // 落盘可见性：REST 面（同一 SkillRegistry）立即可见
      const rest = await app.inject({ method: 'GET', url: '/api/v1/skills', headers: rootAuth() });
      expect(rest.statusCode).toBe(200);
      const ids = (rest.json() as Array<{ id: string }>).map((s) => s.id);
      expect(ids).toContain('sys-mcp-skill');

      const got = await callSystem(client, 'skills_get', { id: 'sys-mcp-skill' });
      expect(got['ok']).toBe(true);
      expect((got['skill'] as Record<string, unknown>)['body']).toBe(body);

      const dup = await callSystem(client, 'skills_create', {
        id: 'sys-mcp-skill',
        name: 'sys-mcp-skill',
        description: 'dup',
        body: 'x',
      });
      expect(dup['ok']).toBe(false);
      expect(String((dup['error'] as Record<string, unknown>)['message'])).toContain('already exists');
    } finally {
      await client.close();
    }
  });

  it('callTool cron_create → cron_list 可见 → cron_update 停用 → cron_run → cron_history 有记录 → cron_delete', async () => {
    const client = await connectClient(rootToken);
    try {
      const created = await callSystem(client, 'cron_create', {
        name: 'sys-mcp-job',
        expr: '* * * * *',
        payload: { kind: 'sys-mcp-test' },
      });
      expect(created['ok']).toBe(true);
      const jobId = (created['job'] as Record<string, unknown>)['id'] as string;

      const listed = await callSystem(client, 'cron_list', {});
      expect(listed['ok']).toBe(true);
      expect((listed['jobs'] as Array<Record<string, unknown>>).some((j) => j['id'] === jobId)).toBe(true);

      const updated = await callSystem(client, 'cron_update', { id: jobId, enabled: false });
      expect(updated['ok']).toBe(true);
      expect((updated['job'] as Record<string, unknown>)['enabled']).toBe(false);
      await callSystem(client, 'cron_update', { id: jobId, enabled: true });

      const run = await callSystem(client, 'cron_run', { id: jobId });
      expect(run['ok']).toBe(true);
      expect(run['started']).toBe(true);
      await waitFor('cron run history', async () => {
        const history = await callSystem(client, 'cron_history', { id: jobId, limit: 10 });
        return ((history['history'] as unknown[]) ?? []).length > 0;
      });

      const deleted = await callSystem(client, 'cron_delete', { id: jobId });
      expect(deleted['ok']).toBe(true);
      const after = await callSystem(client, 'cron_list', {});
      expect((after['jobs'] as Array<Record<string, unknown>>).some((j) => j['id'] === jobId)).toBe(false);

      const missing = await callSystem(client, 'cron_run', { id: 'no-such-job' });
      expect(missing['ok']).toBe(false);
    } finally {
      await client.close();
    }
  });

  it('callTool extensions_disable {id:"auth"} → ok:false builtin locked（不抛错）；extensions_list 含 auth', async () => {
    const client = await connectClient(rootToken);
    try {
      const listed = await callSystem(client, 'extensions_list', {});
      expect(listed['ok']).toBe(true);
      const extensions = listed['extensions'] as Array<Record<string, unknown>>;
      expect(extensions.some((e) => e['id'] === 'auth' && e['builtin'] === true)).toBe(true);

      const disabled = await callSystem(client, 'extensions_disable', { id: 'auth' });
      expect(disabled['ok']).toBe(false);
      expect((disabled['error'] as Record<string, unknown>)['message']).toBe('builtin locked');

      // REST 面复核：auth 仍然 enabled
      const rest = await app.inject({ method: 'GET', url: '/api/v1/extensions', headers: rootAuth() });
      expect(rest.statusCode).toBe(200);
      expect((rest.json() as Array<Record<string, unknown>>).some((e) => e['id'] === 'auth' && e['enabled'] === true)).toBe(true);

      const rescan = await callSystem(client, 'extensions_rescan', {});
      expect(rescan['ok']).toBe(true);
      const reloadNoop = await callSystem(client, 'extensions_reload', { id: 'no-such-ext' });
      expect(reloadNoop['ok']).toBe(true);
    } finally {
      await client.close();
    }
  });
});

describe('files / notifications 工具往返', () => {
  it('files_write → files_read base64 往返一致 → files_delete 后读取 ok:false', async () => {
    const client = await connectClient(rootToken);
    try {
      const payload = Buffer.from('system-mcp files roundtrip ✓', 'utf8').toString('base64');
      const written = await callSystem(client, 'files_write', {
        origName: 'hello.txt',
        contentBase64: payload,
        mime: 'text/plain',
      });
      expect(written['ok']).toBe(true);
      const fileId = (written['file'] as Record<string, unknown>)['id'] as string;

      const read = await callSystem(client, 'files_read', { id: fileId });
      expect(read['ok']).toBe(true);
      expect(read['origName']).toBe('hello.txt');
      expect(read['mime']).toBe('text/plain');
      expect(read['contentBase64']).toBe(payload);

      const listed = await callSystem(client, 'files_list', {});
      expect((listed['files'] as Array<Record<string, unknown>>).some((f) => f['id'] === fileId)).toBe(true);

      const removed = await callSystem(client, 'files_delete', { id: fileId });
      expect(removed['ok']).toBe(true);
      const gone = await callSystem(client, 'files_read', { id: fileId });
      expect(gone['ok']).toBe(false);
    } finally {
      await client.close();
    }
  });

  it('notifications_send → notifications_list 未读 +1 → mark_read → mark_all_read 清零', async () => {
    const client = await connectClient(rootToken);
    try {
      const sent = await callSystem(client, 'notifications_send', {
        title: 'system mcp 通知',
        body: 'via tools/call',
        level: 'warn',
      });
      expect(sent['ok']).toBe(true);

      const listed = await callSystem(client, 'notifications_list', { limit: 10, unreadOnly: true });
      expect(listed['ok']).toBe(true);
      const items = listed['items'] as Array<Record<string, unknown>>;
      const sentId = items.find((n) => n['title'] === 'system mcp 通知')?.['id'] as string;
      expect(sentId).toBeTruthy();

      const marked = await callSystem(client, 'notifications_mark_read', { id: sentId });
      expect(marked['ok']).toBe(true);
      const badMark = await callSystem(client, 'notifications_mark_read', { id: 'no-such' });
      expect(badMark['ok']).toBe(false);

      const all = await callSystem(client, 'notifications_mark_all_read', {});
      expect(all['ok']).toBe(true);
      const after = await callSystem(client, 'notifications_list', { unreadOnly: true });
      expect((after['items'] as unknown[]).length).toBe(0);
    } finally {
      await client.close();
    }
  });
});

describe('mcp / plugins / logs / update / system 域 smoke', () => {
  it('mcp_server_add（stdio 假命令）→ 连接失败如实上报且配置保留 → mcp_servers_list 可见（凭据裁剪）→ mcp_server_remove', async () => {
    const client = await connectClient(rootToken);
    try {
      const added = await callSystem(client, 'mcp_server_add', {
        name: 'System MCP Bogus Echo',
        transport: 'stdio',
        command: 'definitely-not-a-real-binary-sysmcp',
      });
      // 加好即用语义：初始 connect 失败 → ok:false，但配置已持久化（可修复后重连）
      expect(added['ok']).toBe(false);
      const message = String((added['error'] as Record<string, unknown>)['message']);
      expect(message).toContain('initial connect failed');
      const serverId = added['detail'] !== undefined
        ? ((added['detail'] as Record<string, unknown>)['id'] as string)
        : 'system-mcp-bogus-echo';

      const listed = await callSystem(client, 'mcp_servers_list', {});
      expect(listed['ok']).toBe(true);
      const servers = listed['servers'] as Array<Record<string, unknown>>;
      const entry = servers.find((s) => s['id'] === serverId);
      expect(entry).toBeDefined();
      // 凭据裁剪：env/headers 永不出工具目录
      expect(entry).not.toHaveProperty('env');
      expect(entry).not.toHaveProperty('headers');

      const removed = await callSystem(client, 'mcp_server_remove', { id: serverId });
      expect(removed['ok']).toBe(true);
      const after = await callSystem(client, 'mcp_servers_list', {});
      expect((after['servers'] as Array<Record<string, unknown>>).some((s) => s['id'] === serverId)).toBe(false);

      const tools = await callSystem(client, 'mcp_tools_list', {});
      expect(tools['ok']).toBe(true);
      const missing = await callSystem(client, 'mcp_server_remove', { id: 'no-such-server' });
      expect(missing['ok']).toBe(false);
    } finally {
      await client.close();
    }
  });

  it('plugins_list / logs_list / update_check / update_history / system_info / system_doctor 均为 ok:true', async () => {
    const client = await connectClient(rootToken);
    try {
      const plugins = await callSystem(client, 'plugins_list', {});
      expect(plugins['ok']).toBe(true);
      expect(Array.isArray(plugins['plugins'])).toBe(true);

      const logs = await callSystem(client, 'logs_list', { limit: 5 });
      expect(logs['ok']).toBe(true);
      expect(Array.isArray(logs['logs'])).toBe(true);
      expect((logs['logs'] as unknown[]).length).toBeLessThanOrEqual(5);

      const check = await callSystem(client, 'update_check', {});
      expect(check['ok']).toBe(true);
      expect((check['check'] as Record<string, unknown>)['feedOk']).toBe(false); // 未配置 feed → 无更新可拉

      const history = await callSystem(client, 'update_history', {});
      expect(history['ok']).toBe(true);
      expect(Array.isArray(history['history'])).toBe(true);

      const info = await callSystem(client, 'system_info', {});
      expect(info['ok']).toBe(true);
      const infoBody = info['info'] as Record<string, unknown>;
      expect(infoBody['name']).toBe('opptrix-harness');
      expect(infoBody['state']).toBe('ready');

      const doctor = await callSystem(client, 'system_doctor', {});
      expect(doctor['ok']).toBe(true);
      expect((doctor['report'] as { checks: unknown[] }).checks.length).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  });
});

describe('h.mcp 桥合并：serverId=system 的目录合并与路由', () => {
  it('mcp.tools.list 追加 system 目录（描述标注「系统操作」）；mcp.tools.call 路由到执行器（admin 身份执行）', async () => {
    const registry = kernel.container.resolve<ConstructorParameters<typeof createMcpBridge>[0]['registry']>(
      CONTAINER_KEYS.mcpRegistry,
    );
    const handlers = createMcpBridge({ registry, requirePermission: () => {} });
    const list = (await handlers[KERNEL_TOPICS.mcpToolsList]({}, 'ext:demo-bridge')) as Array<{
      serverId: string;
      name: string;
      description: string;
    }>;
    const systemEntries = list.filter((t) => t.serverId === 'system');
    expect(systemEntries.length).toBeGreaterThanOrEqual(30);
    expect(systemEntries.every((t) => t.description.includes('系统操作'))).toBe(true);

    const filtered = (await handlers[KERNEL_TOPICS.mcpToolsList](
      { serverId: 'system' },
      'ext:demo-bridge',
    )) as Array<{ serverId: string }>;
    expect(filtered.length).toBe(systemEntries.length);
    expect(filtered.every((t) => t.serverId === 'system')).toBe(true);

    const called = (await handlers[KERNEL_TOPICS.mcpToolsCall](
      { serverId: 'system', toolName: 'system_info' },
      'ext:demo-bridge',
    )) as Record<string, unknown>;
    expect(called['ok']).toBe(true);

    const badArgs = (await handlers[KERNEL_TOPICS.mcpToolsCall](
      { serverId: 'system', toolName: 'cron_create', args: {} },
      'ext:demo-bridge',
    )) as Record<string, unknown>;
    expect(badArgs['ok']).toBe(false); // 校验失败 → 结果对象，不抛

    const unknownTool = (await handlers[KERNEL_TOPICS.mcpToolsCall](
      { serverId: 'system', toolName: 'nope' },
      'ext:demo-bridge',
    )) as Record<string, unknown>;
    expect(unknownTool['ok']).toBe(false);
  });

  it('容器与进程槽：SYSTEM_TOOLS_CONTAINER_KEY 已登记运行时且目录数量一致', () => {
    const runtime = kernel.container.resolve<{ size: number; listTools(): unknown[] }>(SYSTEM_TOOLS_CONTAINER_KEY);
    expect(runtime.size).toBeGreaterThanOrEqual(30);
    expect(runtime.listTools().length).toBe(runtime.size);
    expect(currentSystemRuntime()?.size).toBe(runtime.size);
  });
});

// ---------------------------------------------------------------------------
// subagent_* 系统工具（追加域；桩 SubagentManager 验证委派/等待/树断言语义）
// ---------------------------------------------------------------------------

describe('subagent_* 系统工具（桩 SubagentManager：容错延迟绑定）', () => {
  /** 结构对齐 src/kernel/agents/manager.ts 契约面的桩记录（SubagentRecord 形状） */
  type StubRecord = {
    id: string;
    parentId: string;
    depth: number;
    status: string;
    result: string | null;
    error: string | null;
    usageIn: number | null;
    usageOut: number | null;
    transcript: unknown[] | null;
  };

  const doneRecord: StubRecord = {
    id: 'sa-stub-1',
    parentId: 'main',
    depth: 1,
    status: 'done',
    result: 'sub-agent final answer',
    error: null,
    usageIn: 11,
    usageOut: 7,
    transcript: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'sub-agent final answer' }],
  };

  /** 桩管理器：每个用例按需重写 mock 实现（beforeAll 登记进容器，容错延迟绑定键） */
  const subagentStub = {
    spawn: vi.fn(async (input: Record<string, unknown>) => ({
      id: 'sa-stub-1',
      parentId: input['parentId'],
      depth: 1,
      status: 'running',
      prompt: input['prompt'],
      model: input['model'] ?? null,
      result: null,
      error: null,
      usageIn: null,
      usageOut: null,
      transcript: null,
    })),
    cancel: vi.fn(async (_id: string) => true),
    get: vi.fn(async (id: string): Promise<StubRecord | null> =>
      id === 'sa-stub-1' ? doneRecord : id === 'sa-stub-running' ? { ...doneRecord, id, status: 'running', result: null } : null,
    ),
    list: vi.fn(async (filter?: { parentId?: string; status?: string }) =>
      [doneRecord, { ...doneRecord, id: 'sa-child-2', parentId: 'sa-stub-1', depth: 2, status: 'running' }].filter(
        (r) =>
          (filter?.parentId === undefined || r.parentId === filter.parentId) &&
          (filter?.status === undefined || r.status === filter.status),
      ),
    ),
    assertDirectParent: vi.fn(async (_childId: string, _callerId: string) => {}),
    waitFor: vi.fn(async (id: string, timeoutMs?: number): Promise<StubRecord> => {
      const rec = await subagentStub.get(id);
      if (rec === null) {
        throw new HarnessError('EXT_NOT_FOUND', { message: `subagent "${id}" not found` });
      }
      if (!['done', 'failed', 'cancelled'].includes(rec.status)) {
        throw new HarnessError('RPC_TIMEOUT', {
          message: `waitFor: subagent "${id}" did not reach a terminal state within ${timeoutMs}ms`,
          detail: { id, timeoutMs, status: rec.status },
        });
      }
      return rec;
    }),
  };

  beforeAll(() => {
    // 容错延迟绑定：桩登记在首选键上（真实 Kernel 接线后同键注册会被此处覆盖，仅影响本文件用例）
    kernel.container.instance(SUBAGENT_MANAGER_CONTAINER_KEYS[0], subagentStub);
  });

  it('容错延迟绑定：管理器未登记 → ok:false HARNESS-9001（目录单元面，不硬失败）', async () => {
    const tool = createSystemTools().find((t) => t.name === 'subagent_spawn');
    expect(tool).toBeDefined();
    const result = await tool!.execute(
      { prompt: 'p' },
      { kernel: { container: { has: () => false, resolve: () => undefined } } } as unknown as SystemToolContext,
    );
    expect(result['ok']).toBe(false);
    expect((result['error'] as Record<string, unknown>)['code']).toBe('HARNESS-9001');
  });

  it('tools/list：含全部 6 个 subagent_* 工具（≥5，含非空中文描述与 object schema）', async () => {
    const client = await connectClient(rootToken);
    try {
      const listed = await client.listTools();
      const names = new Set(listed.tools.map((t) => t.name));
      for (const required of [
        'subagent_spawn',
        'subagent_status',
        'subagent_result',
        'subagent_list',
        'subagent_cancel',
        'subagent_transcript',
      ]) {
        expect(names.has(required)).toBe(true);
      }
      const subTools = listed.tools.filter((t) => t.name.startsWith('subagent_'));
      expect(subTools.length).toBeGreaterThanOrEqual(5);
      expect(subTools.every((t) => typeof t.description === 'string' && t.description.length > 0)).toBe(true);
      expect(subTools.every((t) => (t.inputSchema as { type?: string }).type === 'object')).toBe(true);
    } finally {
      await client.close();
    }
  });

  it('subagent_spawn：桩收到 parentId=main（depth=1 委派语义）与可选参透传 → {agentId,status}', async () => {
    const client = await connectClient(rootToken);
    try {
      subagentStub.spawn.mockClear();
      const spawned = await callSystem(client, 'subagent_spawn', {
        prompt: '调研子代理树形委派机制',
        systemPrompt: 'be concise',
        model: 'stub-model-x',
        toolNames: ['skills_list', 'files_list'],
        maxIterations: 5,
      });
      expect(spawned['ok']).toBe(true);
      expect(spawned['agentId']).toBe('sa-stub-1');
      expect(spawned['status']).toBe('running');
      expect(spawned['depth']).toBe(1);
      // MCP 层视为主会话：parentId 恒 'main'（depth=1）；可选参原样透传给管理器
      expect(subagentStub.spawn).toHaveBeenCalledTimes(1);
      expect(subagentStub.spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          parentId: 'main',
          prompt: '调研子代理树形委派机制',
          systemPrompt: 'be concise',
          model: 'stub-model-x',
          toolNames: ['skills_list', 'files_list'],
          maxIterations: 5,
        }),
      );
    } finally {
      await client.close();
    }
  });

  it('subagent_spawn：prompt 超 64KB（字节口径）→ HARNESS-1005；缺 prompt → schema 拒绝 isError', async () => {
    const client = await connectClient(rootToken);
    try {
      // 40000 个多字节字符 = 120000 UTF-8 字节 > 65536（zod 字符上限 65536 之内，命中字节精确校验）
      const tooBig = await callSystem(client, 'subagent_spawn', { prompt: '好'.repeat(40_000) });
      expect(tooBig['ok']).toBe(false);
      expect((tooBig['error'] as Record<string, unknown>)['code']).toBe('HARNESS-1005');

      const missing = (await client.callTool({ name: 'subagent_spawn', arguments: {} })) as { isError?: boolean };
      expect(missing.isError).toBe(true);
    } finally {
      await client.close();
    }
  });

  it('subagent_status：树断言以 (agentId, main) 调用并归一透传字段；缺 agent → HARNESS-3004', async () => {
    const client = await connectClient(rootToken);
    try {
      subagentStub.assertDirectParent.mockClear();
      const status = await callSystem(client, 'subagent_status', { agentId: 'sa-stub-1' });
      expect(status['ok']).toBe(true);
      expect(status['status']).toBe('done');
      expect(status['result']).toBe('sub-agent final answer');
      expect(status['usage']).toEqual({ in: 11, out: 7 });
      // 树断言调用形状：childId 在前、caller（主会话恒 'main'）在后
      expect(subagentStub.assertDirectParent).toHaveBeenCalledWith('sa-stub-1', 'main');

      const missing = await callSystem(client, 'subagent_status', { agentId: 'sa-nope' });
      expect(missing['ok']).toBe(false);
      expect((missing['error'] as Record<string, unknown>)['code']).toBe('HARNESS-3004');
    } finally {
      await client.close();
    }
  });

  it('subagent_result：wait=false 立即返回快照（running 无 result）；wait=true 委托 waitFor 至终态', async () => {
    const client = await connectClient(rootToken);
    try {
      const snapshot = await callSystem(client, 'subagent_result', { agentId: 'sa-stub-running' });
      expect(snapshot['ok']).toBe(true);
      expect(snapshot['status']).toBe('running');
      expect(snapshot).not.toHaveProperty('result');

      subagentStub.waitFor.mockClear();
      const final = await callSystem(client, 'subagent_result', { agentId: 'sa-stub-1', wait: true, timeoutMs: 5_000 });
      expect(final['ok']).toBe(true);
      expect(final['status']).toBe('done');
      expect(final['result']).toBe('sub-agent final answer');
      expect(subagentStub.waitFor).toHaveBeenCalledWith('sa-stub-1', 5_000);
    } finally {
      await client.close();
    }
  });

  it('subagent_result：wait=true 超时未达终态 → ok:false HARNESS-2001（透传管理器 RPC_TIMEOUT）', async () => {
    const client = await connectClient(rootToken);
    try {
      const timedOut = await callSystem(client, 'subagent_result', {
        agentId: 'sa-stub-running',
        wait: true,
        timeoutMs: 300,
      });
      expect(timedOut['ok']).toBe(false);
      expect((timedOut['error'] as Record<string, unknown>)['code']).toBe('HARNESS-2001');
    } finally {
      await client.close();
    }
  });

  it('跨代/兄弟读取拒绝：树断言抛 FORBIDDEN → status/result/transcript 三面透传 HARNESS-1007', async () => {
    const client = await connectClient(rootToken);
    try {
      subagentStub.assertDirectParent.mockImplementationOnce(async () => {
        throw new HarnessError('FORBIDDEN', {
          message: 'cross-generation or sibling access is not allowed (strict parent-child tree)',
          detail: { childId: 'sa-child-2', callerId: 'main' },
        });
      });
      subagentStub.assertDirectParent.mockImplementationOnce(async () => {
        throw new HarnessError('FORBIDDEN', { message: 'forbidden' });
      });
      subagentStub.assertDirectParent.mockImplementationOnce(async () => {
        throw new HarnessError('FORBIDDEN', { message: 'forbidden' });
      });

      for (const tool of ['subagent_status', 'subagent_result', 'subagent_transcript']) {
        const denied = await callSystem(client, tool, { agentId: 'sa-child-2' });
        expect(denied['ok']).toBe(false);
        expect((denied['error'] as Record<string, unknown>)['code']).toBe('HARNESS-1007');
      }
      // 工具层不绕过树断言：拒绝发生时管理器读取面零调用
      expect(subagentStub.get).not.toHaveBeenCalledWith('sa-child-2');
    } finally {
      await client.close();
    }
  });

  it('subagent_list 过滤透传 / subagent_cancel 幂等返回 / subagent_transcript 审计读取', async () => {
    const client = await connectClient(rootToken);
    try {
      subagentStub.list.mockClear();
      const listed = await callSystem(client, 'subagent_list', { parentId: 'main', status: 'done' });
      expect(listed['ok']).toBe(true);
      expect(subagentStub.list).toHaveBeenCalledWith({ parentId: 'main', status: 'done' });
      expect(listed['total']).toBe(1);
      expect((listed['agents'] as Array<Record<string, unknown>>)[0]['id']).toBe('sa-stub-1');

      subagentStub.cancel.mockReset().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      const cancelled = await callSystem(client, 'subagent_cancel', { agentId: 'sa-stub-running' });
      expect(cancelled['ok']).toBe(true);
      expect(cancelled['cancelled']).toBe(true);
      const idempotent = await callSystem(client, 'subagent_cancel', { agentId: 'sa-stub-running' });
      expect(idempotent['ok']).toBe(true);
      expect(idempotent['cancelled']).toBe(false); // 终态幂等：确无取消发生

      const traced = await callSystem(client, 'subagent_transcript', { agentId: 'sa-stub-1' });
      expect(traced['ok']).toBe(true);
      expect(Array.isArray(traced['transcript'])).toBe(true);
      expect((traced['transcript'] as unknown[]).length).toBe(2);
    } finally {
      await client.close();
    }
  });

  it('容错面补充：桩缺 waitFor → 本层回退轮询至终态；桩提供 transcript 方法 → 优先方法读取', async () => {
    const client = await connectClient(rootToken);
    try {
      // 摘除 waitFor（模拟结构视图缺省的延迟绑定实现）：get 先 running 后 done，
      // 覆盖 subagent_result 的本层轮询回退（与 manager.waitFor 同语义）
      const withoutWait: Partial<typeof subagentStub> = { ...subagentStub };
      delete withoutWait.waitFor;
      kernel.container.instance(SUBAGENT_MANAGER_CONTAINER_KEYS[0], withoutWait);
      let polls = 0;
      subagentStub.get.mockImplementation(async (id: string) => {
        polls += 1;
        return polls === 1
          ? { ...doneRecord, id, status: 'running', result: null }
          : { ...doneRecord, id };
      });
      const polled = await callSystem(client, 'subagent_result', { agentId: 'sa-stub-1', wait: true, timeoutMs: 2_000 });
      expect(polled['ok']).toBe(true);
      expect(polled['status']).toBe('done');
      expect(polled['result']).toBe('sub-agent final answer');
      expect(polls).toBeGreaterThanOrEqual(2);

      // transcript 可选方法面：管理器实现提供 transcript(id) 时优先走方法（而非记录字段）
      (withoutWait as Record<string, unknown>)['transcript'] = async (id: string) => [{ role: 'user', content: id }];
      const traced = await callSystem(client, 'subagent_transcript', { agentId: 'sa-stub-1' });
      expect(traced['ok']).toBe(true);
      expect(traced['transcript']).toEqual([{ role: 'user', content: 'sa-stub-1' }]);
    } finally {
      // 还原完整桩与 get 基线实现（mock 实现跨用例存续）
      subagentStub.get.mockImplementation(async (id: string) =>
        id === 'sa-stub-1' ? doneRecord : id === 'sa-stub-running' ? { ...doneRecord, id, status: 'running', result: null } : null,
      );
      kernel.container.instance(SUBAGENT_MANAGER_CONTAINER_KEYS[0], subagentStub);
      await client.close();
    }
  });
});
