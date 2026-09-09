/**
 * MCP 客户端子系统单测（config store + registry + bridge）。
 *
 * registry 用例使用**真实 stdio 子进程** MCP server：测试夹具以官方 SDK 的
 * `Server` + `StdioServerTransport` 写一个最小 echo server（tools/list 返回
 * echo/slow/boom 三个工具、resources/prompts 各一条），由 registry 真实 spawn——
 * 握手、能力缓存、调用、超时、断连（子进程 pid 消亡）全部走真链路。
 */
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import pino from 'pino';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { err, HarnessError } from '../src/kernel/errors/index.js';
import { createMcpBridge } from '../src/kernel/mcp/bridge.js';
import { McpConfigStore } from '../src/kernel/mcp/config-store.js';
import { McpRegistry } from '../src/kernel/mcp/registry.js';
import type { McpServerConfig } from '../src/kernel/mcp/types.js';

// stdio spawn + initialize 握手 + 慢工具超时：放宽单用例预算
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SDK_ESM = path.join(REPO_ROOT, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm');

/** 仓库内 SDK 模块的 file URL（夹具脚本从 tmpdir 运行，裸说明符解析不到 node_modules） */
function sdkUrl(rel: string): string {
  return pathToFileURL(path.join(SDK_ESM, rel)).href;
}

/**
 * 最小 echo MCP server（官方 SDK Server + StdioServerTransport）：
 * - tools: echo（回显 args JSON）/ slow（睡 60s，供超时用例）/ boom（isError:true）
 * - resources: memo://greeting（text）；prompts: greet（渲染一条 user 消息）
 * - 连接就绪后把自身 pid 写入 $MCP_PID_FILE（断连用例验证子进程确被收割）
 */
function echoServerScript(): string {
  return `
const { Server } = await import(${JSON.stringify(sdkUrl(path.join('server', 'index.js')))});
const { StdioServerTransport } = await import(${JSON.stringify(sdkUrl(path.join('server', 'stdio.js')))});
const types = await import(${JSON.stringify(sdkUrl('types.js'))});
const { writeFileSync } = await import('node:fs');

const server = new Server({ name: 'echo-min', version: '1.0.0' }, {
  capabilities: { tools: {}, resources: {}, prompts: {} },
});
server.setRequestHandler(types.ListToolsRequestSchema, async () => ({
  tools: [
    { name: 'echo', description: 'echoes arguments back as JSON text',
      inputSchema: { type: 'object', properties: { message: { type: 'string' } } } },
    { name: 'slow', description: 'sleeps for 60s (timeout testing)', inputSchema: { type: 'object' } },
    { name: 'boom', description: 'returns isError:true', inputSchema: { type: 'object' } },
  ],
}));
server.setRequestHandler(types.CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  const args = request.params.arguments ?? {};
  if (name === 'slow') {
    await new Promise((resolve) => setTimeout(resolve, 60_000));
    return { content: [{ type: 'text', text: 'finally done' }] };
  }
  if (name === 'boom') {
    return { content: [{ type: 'text', text: 'deliberate failure' }], isError: true };
  }
  return { content: [{ type: 'text', text: JSON.stringify({ echo: args }) }] };
});
server.setRequestHandler(types.ListResourcesRequestSchema, async () => ({
  resources: [{ uri: 'memo://greeting', name: 'greeting', description: 'A greeting memo', mimeType: 'text/plain' }],
}));
server.setRequestHandler(types.ReadResourceRequestSchema, async (request) => ({
  contents: [{ uri: request.params.uri, mimeType: 'text/plain', text: 'hello from mcp echo server' }],
}));
server.setRequestHandler(types.ListPromptsRequestSchema, async () => ({
  prompts: [{ name: 'greet', description: 'greets someone',
    arguments: [{ name: 'who', description: 'target', required: false }] }],
}));
server.setRequestHandler(types.GetPromptRequestSchema, async (request) => ({
  messages: [{ role: 'user', content: { type: 'text', text: 'hello ' + (request.params.arguments?.who ?? 'world') } }],
}));
const transport = new StdioServerTransport();
await server.connect(transport);
if (process.env['MCP_PID_FILE']) writeFileSync(process.env['MCP_PID_FILE'], String(process.pid));
`;
}

// ---------------------------------------------------------------------------
// 夹具环境
// ---------------------------------------------------------------------------

let echoDir = '';
let echoScript = '';
let dataDir = '';
/** 每个用例登记的清理动作（断开全部连接，防 echo 子进程泄漏到后续用例） */
let cleanups: Array<() => Promise<void>> = [];

beforeAll(async () => {
  echoDir = await mkdtemp(path.join(tmpdir(), 'mcp-echo-'));
  echoScript = path.join(echoDir, 'echo-server.mjs');
  await writeFile(echoScript, echoServerScript(), 'utf8');
});

afterAll(async () => {
  await rm(echoDir, { recursive: true, force: true });
});

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'mcp-store-'));
  cleanups = [];
});

afterEach(async () => {
  for (const cleanup of cleanups.reverse()) {
    await cleanup();
  }
  await rm(dataDir, { recursive: true, force: true });
});

function makeStore(): McpConfigStore {
  return new McpConfigStore({ dataDir });
}

function makeRegistry(store: McpConfigStore): McpRegistry {
  const registry = new McpRegistry({ configStore: store, logger: pino({ level: 'silent' }) });
  cleanups.push(async () => {
    for (const cfg of await store.load()) {
      await registry.disconnect(cfg.id);
    }
  });
  return registry;
}

async function addEchoServer(
  store: McpConfigStore,
  id: string,
  overrides: Partial<McpServerConfig> = {},
): Promise<void> {
  await store.add({
    id,
    name: `echo ${id}`,
    transport: 'stdio',
    command: process.execPath,
    args: [echoScript],
    env: { MCP_PID_FILE: path.join(echoDir, `${id}.pid`) },
    enabled: true,
    ...overrides,
  });
}

/** 读取夹具写入的子进程 pid（连接就绪后短暂重试，规避父侧先到竞态） */
async function readChildPid(id: string): Promise<number> {
  const file = path.join(echoDir, `${id}.pid`);
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      const pid = Number(await readFile(file, 'utf8'));
      if (Number.isInteger(pid) && pid > 0) return pid;
    } catch {
      // pid 尚未写入，继续等
    }
    if (Date.now() > deadline) throw new Error(`echo server "${id}" never wrote its pid file`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** 子进程确已消亡（kill(pid,0) 报 ESRCH） */
async function waitPidGone(pid: number, timeoutMs = 8_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** 断言 fn 抛出指定 HARNESS 错误码的 HarnessError */
async function expectHarnessError(fn: () => Promise<unknown>, code: string): Promise<HarnessError> {
  try {
    await fn();
  } catch (e) {
    expect(e).toBeInstanceOf(HarnessError);
    const harnessError = e as HarnessError;
    expect(harnessError.code).toBe(code);
    return harnessError;
  }
  throw new Error(`expected HarnessError ${code}, but the call succeeded`);
}

// ---------------------------------------------------------------------------
// McpConfigStore（持久化/校验/原子写）
// ---------------------------------------------------------------------------

describe('McpConfigStore', () => {
  it('load(): 配置文件不存在时返回空表（首次启动常态）', async () => {
    const store = makeStore();
    expect(await store.load()).toEqual([]);
  });

  it('add(): 校验归一后落盘——文件 0600、新实例可完整读回（原子写回路）', async () => {
    const store = makeStore();
    const added = await store.add({
      id: 'echo-1',
      name: 'Echo One',
      transport: 'stdio',
      command: '/bin/echo',
      args: ['hi'],
      env: { FOO: 'bar' },
      enabled: true,
    });
    expect(added.id).toBe('echo-1');
    const fileStat = await stat(store.file);
    expect(fileStat.mode & 0o777).toBe(0o600); // env 可含凭据：整文件 0600
    const reread = await makeStore().load();
    expect(reread).toHaveLength(1);
    expect(reread[0]).toMatchObject({ id: 'echo-1', transport: 'stdio', command: '/bin/echo', enabled: true });
  });

  it('add(): 非法形状 fail-fast——坏 id / stdio 缺 command / 坏 transport / 非 http url', async () => {
    const store = makeStore();
    await expectHarnessError(
      () => store.add({ id: 'Bad_Id', name: 'x', transport: 'stdio', command: 'a', enabled: true }),
      'HARNESS-1009',
    );
    await expectHarnessError(
      () => store.add({ id: 'okid', name: 'x', transport: 'stdio', enabled: true }),
      'HARNESS-1009',
    );
    await expectHarnessError(
      () => store.add({ id: 'okid', name: 'x', transport: 'carrier-pigeon', command: 'a', enabled: true }),
      'HARNESS-1009',
    );
    await expectHarnessError(
      () => store.add({ id: 'okid', name: 'x', transport: 'sse', url: 'ftp://example.com', enabled: true }),
      'HARNESS-1009',
    );
  });

  it('add(): 重复 id 拒绝（指名道姓的 400，非静默覆盖）', async () => {
    const store = makeStore();
    await store.add({ id: 'dup', name: 'first', transport: 'stdio', command: 'a', enabled: true });
    const e = await expectHarnessError(
      () => store.add({ id: 'dup', name: 'second', transport: 'stdio', command: 'b', enabled: true }),
      'HARNESS-1009',
    );
    expect(e.message).toContain('"dup" already exists');
  });

  it('setEnabled()/update(): 局部变更持久化；id/transport 等身份字段保持不变', async () => {
    const store = makeStore();
    await store.add({
      id: 'svc',
      name: 'Svc',
      transport: 'streamable-http',
      url: 'https://mcp.example.com/mcp',
      headers: { authorization: 'Bearer old' },
      enabled: true,
    });
    await store.setEnabled('svc', false);
    const patched = await store.update('svc', { name: 'Renamed', headers: { authorization: 'Bearer new' } });
    expect(patched).toMatchObject({ id: 'svc', name: 'Renamed', enabled: false, transport: 'streamable-http' });
    expect(patched.headers?.['authorization']).toBe('Bearer new');
    expect(patched.url).toBe('https://mcp.example.com/mcp');
    const reread = await makeStore().load();
    expect(reread[0]).toMatchObject({ enabled: false, name: 'Renamed' });
  });

  it('update()/get(): 未知 id → EXT_NOT_FOUND（404 语义）；remove() 未知 id 返回 false', async () => {
    const store = makeStore();
    await expect(store.get('ghost')).resolves.toBeUndefined();
    await expectHarnessError(() => store.update('ghost', { enabled: false }), 'HARNESS-3004');
    expect(await store.remove('ghost')).toBe(false);
  });

  it('remove(): 删除已有配置并持久化（读回为空）', async () => {
    const store = makeStore();
    await store.add({ id: 'gone', name: 'x', transport: 'stdio', command: 'a', enabled: true });
    expect(await store.remove('gone')).toBe(true);
    expect(await store.load()).toEqual([]);
  });

  it('load(): 损坏 JSON fail-fast（INTERNAL，message 给出修复动作）', async () => {
    await mkdirMcpDir();
    await writeFile(path.join(dataDir, 'mcp', 'config.json'), '{ not json', 'utf8');
    const e = await expectHarnessError(() => makeStore().load(), 'HARNESS-9003');
    expect(e.message).toContain('not valid JSON');
    expect(e.message).toContain('Fix the file manually');
  });

  it('save(): 整表入口拒绝重复 id 与非法条目（整文件护栏）', async () => {
    const store = makeStore();
    await expectHarnessError(
      () =>
        store.save([
          { id: 'a', name: 'x', transport: 'stdio', command: 'a', enabled: true },
          { id: 'a', name: 'y', transport: 'stdio', command: 'b', enabled: true },
        ]),
      'HARNESS-1009',
    );
    await expectHarnessError(
      () => store.save([{ id: 'UPPER', name: 'x', transport: 'stdio', command: 'a', enabled: true }]),
      'HARNESS-1009',
    );
  });

  it('constructor: 空 dataDir fail-fast（VALIDATION_FAILED）', () => {
    expect(() => new McpConfigStore({ dataDir: '' })).toThrowError(HarnessError);
  });
});

/** 预创建 <dataDir>/mcp/ 目录（损坏文件用例需要先有目录才写得进去） */
async function mkdirMcpDir(): Promise<void> {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(path.join(dataDir, 'mcp'), { recursive: true });
}

// ---------------------------------------------------------------------------
// McpRegistry（真实 stdio 子进程）
// ---------------------------------------------------------------------------

describe('McpRegistry（真实 stdio echo server）', () => {
  it('connect(): 真实握手 + 能力缓存 → status connected、toolCount=3', async () => {
    const store = makeStore();
    const registry = makeRegistry(store);
    await addEchoServer(store, 'conn-1');
    const status = await registry.connect('conn-1');
    expect(status).toMatchObject({ id: 'conn-1', state: 'connected', toolCount: 3 });
    expect(status.error).toBeUndefined();
  });

  it('listTools(): 缓存工具携带 serverId；serverId 过滤生效；未知 serverId → EXT_NOT_FOUND', async () => {
    const store = makeStore();
    const registry = makeRegistry(store);
    await addEchoServer(store, 'tools-1');
    await registry.connect('tools-1');
    const tools = await registry.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['boom', 'echo', 'slow']);
    expect(new Set(tools.map((t) => t.serverId))).toEqual(new Set(['tools-1']));
    expect((await registry.listTools({ serverId: 'tools-1' }))[0]?.serverId).toBe('tools-1');
    await expectHarnessError(() => registry.listTools({ serverId: 'ghost' }), 'HARNESS-3004');
  });

  it('callTool(echo): 参数经真实子进程回显，归一为 { content:[{type:"text",text}] }', async () => {
    const store = makeStore();
    const registry = makeRegistry(store);
    await addEchoServer(store, 'call-1');
    await registry.connect('call-1');
    const result = await registry.callTool('call-1', 'echo', { message: 'hello harness' });
    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify({ echo: { message: 'hello harness' } }) }]);
  });

  it('callTool(boom): server 侧 isError:true 原样透传（不在传输层吞掉）', async () => {
    const store = makeStore();
    const registry = makeRegistry(store);
    await addEchoServer(store, 'boom-1');
    await registry.connect('boom-1');
    const result = await registry.callTool('boom-1', 'boom', {});
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ type: 'text' });
  });

  it('callTool 超时: slow 工具 + 短预算 → RPC_TIMEOUT，detail 含 serverId/toolName', async () => {
    const store = makeStore();
    const registry = makeRegistry(store);
    await addEchoServer(store, 'slow-1');
    await registry.connect('slow-1');
    const e = await expectHarnessError(
      () => registry.callTool('slow-1', 'slow', {}, 500),
      'HARNESS-2001',
    );
    expect(e.detail).toMatchObject({ serverId: 'slow-1', toolName: 'slow' });
    // 超时不毁连接：后续 echo 调用照常工作
    const after = await registry.callTool('slow-1', 'echo', { ok: true });
    expect(after.content[0]).toMatchObject({ type: 'text' });
  });

  it('未连接先调用 → INTERNAL（"not connected" 文案指明修复动作）；connect 后同调用成功', async () => {
    const store = makeStore();
    const registry = makeRegistry(store);
    await addEchoServer(store, 'late-1');
    const e = await expectHarnessError(() => registry.callTool('late-1', 'echo', {}), 'HARNESS-9003');
    expect(e.message).toContain('mcp server "late-1" not connected');
    await registry.connect('late-1');
    const result = await registry.callTool('late-1', 'echo', { n: 1 });
    expect(result.content).toHaveLength(1);
  });

  it('resources: 目录来自连接期缓存；readResource 实时读取文本内容', async () => {
    const store = makeStore();
    const registry = makeRegistry(store);
    await addEchoServer(store, 'res-1');
    await expectHarnessError(() => registry.listResources('res-1'), 'HARNESS-9003'); // 未连接
    await registry.connect('res-1');
    const resources = await registry.listResources('res-1');
    expect(resources).toEqual([
      { uri: 'memo://greeting', name: 'greeting', description: 'A greeting memo', mimeType: 'text/plain' },
    ]);
    const contents = await registry.readResource('res-1', 'memo://greeting');
    expect(contents[0]).toMatchObject({ uri: 'memo://greeting', mimeType: 'text/plain', text: 'hello from mcp echo server' });
  });

  it('prompts: 目录缓存 + getPrompt 实时渲染消息', async () => {
    const store = makeStore();
    const registry = makeRegistry(store);
    await addEchoServer(store, 'pr-1');
    await registry.connect('pr-1');
    expect(await registry.listPrompts('pr-1')).toHaveLength(1);
    const prompt = await registry.getPrompt('pr-1', 'greet', { who: 'harness' });
    expect(prompt.messages).toHaveLength(1);
    expect(JSON.stringify(prompt.messages)).toContain('hello harness');
  });

  it('disabled 不连接: connect() → VALIDATION_FAILED；refreshAll() 跳过；status() = disabled', async () => {
    const store = makeStore();
    const registry = makeRegistry(store);
    await addEchoServer(store, 'off-1', { enabled: false });
    const e = await expectHarnessError(() => registry.connect('off-1'), 'HARNESS-1009');
    expect(e.message).toContain('disabled');
    const refreshed = await registry.refreshAll();
    expect(refreshed.connected).toEqual([]);
    expect(await registry.status('off-1')).toMatchObject({ id: 'off-1', state: 'disabled', toolCount: 0 });
    expect(await registry.listTools()).toEqual([]); // 目录不产生任何工具
  });

  it('连接失败（命令不存在）→ INTERNAL；status() = error 带原因；refreshAll() 不抛且逐条上报', async () => {
    const store = makeStore();
    const registry = makeRegistry(store);
    await store.add({
      id: 'bad-1',
      name: 'bad',
      transport: 'stdio',
      command: 'definitely-not-a-real-binary-xyz',
      enabled: true,
    });
    await addEchoServer(store, 'good-1');
    const e = await expectHarnessError(() => registry.connect('bad-1'), 'HARNESS-9003');
    expect(e.message).toContain('failed to connect to mcp server "bad-1"');
    expect(await registry.status('bad-1')).toMatchObject({ state: 'error', toolCount: 0 });
    const refreshed = await registry.refreshAll();
    expect(refreshed.connected).toEqual(['good-1']);
    expect(refreshed.failed.map((f) => f.id)).toEqual(['bad-1']);
  });

  it('remove 断连: 配置删除 + disconnect 后子进程确被收割（pid 消亡），目录不再含该 server', async () => {
    const store = makeStore();
    const registry = makeRegistry(store);
    await addEchoServer(store, 'kill-1');
    await registry.connect('kill-1');
    const pid = await readChildPid('kill-1');
    expect(await store.remove('kill-1')).toBe(true);
    await registry.disconnect('kill-1');
    expect(await waitPidGone(pid)).toBe(true); // 真实证据：stdio 子进程已退出
    // 配置已删：callTool 先命中 EXT_NOT_FOUND（404 语义）；连接摘除由 pid 消亡与目录佐证
    const e = await expectHarnessError(() => registry.callTool('kill-1', 'echo', {}), 'HARNESS-3004');
    expect(e.message).toContain('not configured');
    expect((await registry.listTools()).find((t) => t.serverId === 'kill-1')).toBeUndefined();
    await expect(registry.disconnect('kill-1')).resolves.toBeUndefined(); // 幂等
  });

  it('list(): 配置 + 运行态合并（connected / never / disabled 三态齐全）', async () => {
    const store = makeStore();
    const registry = makeRegistry(store);
    await addEchoServer(store, 'live-1');
    await addEchoServer(store, 'cold-1', { enabled: false });
    await addEchoServer(store, 'warm-1');
    await registry.connect('live-1');
    const summaries = await registry.list();
    expect(summaries.map((s) => [s.id, s.state, s.toolCount])).toEqual([
      ['live-1', 'connected', 3],
      ['cold-1', 'disabled', 0],
      ['warm-1', 'never', 0],
    ]);
  });

  it('connect(): 未知 server id → EXT_NOT_FOUND（404 语义）', async () => {
    const registry = makeRegistry(makeStore());
    await expectHarnessError(() => registry.connect('ghost'), 'HARNESS-3004');
  });

  it('出口冒烟: 桶文件再导出核心构件与 schema（import 面契约）', async () => {
    const barrel = await import('../src/kernel/mcp/index.js');
    expect(barrel.McpConfigStore).toBe(McpConfigStore);
    expect(barrel.McpRegistry).toBe(McpRegistry);
    expect(barrel.createMcpBridge).toBe(createMcpBridge);
    expect(barrel.MCP_CLIENT_PERMISSION).toBe('mcp:client');
    expect(barrel.DEFAULT_MCP_TIMEOUT_MS).toBe(30_000);
    expect(barrel.mcpServerConfigSchema.safeParse({
      id: 'x', name: 'n', transport: 'stdio', command: 'a', enabled: true,
    }).success).toBe(true);
    expect(typeof barrel.validateMcpServerConfig).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// createMcpBridge（扩展桥）
// ---------------------------------------------------------------------------

describe('createMcpBridge（扩展桥 h.mcp.*）', () => {
  it('mcp.servers.list: 需 mcp:client 权限；返回裁剪后的安全投影（无 env/headers/command）', async () => {
    const store = makeStore();
    const registry = makeRegistry(store);
    await addEchoServer(store, 'brg-1');
    const checked: Array<[string, string, string]> = [];
    const bridge = createMcpBridge({
      registry,
      requirePermission: (extId, topic, permission) => {
        checked.push([extId, topic, permission]);
      },
    });
    const servers = (await bridge['mcp.servers.list']!({}, 'ext:my-ext')) as Array<Record<string, unknown>>;
    expect(servers).toEqual([{ id: 'brg-1', name: 'echo brg-1', transport: 'stdio', enabled: true, state: 'never', toolCount: 0 }]);
    expect(checked).toEqual([['my-ext', 'mcp.servers.list', 'mcp:client']]);
  });

  it('权限闸 fail-closed: 内核端点拒绝（RPC_PERMISSION_DENIED）+ 扩展无权限拒绝（FORBIDDEN）', async () => {
    const registry = makeRegistry(makeStore());
    const bridge = createMcpBridge({ registry, requirePermission: () => {} });
    await expect(bridge['mcp.servers.list']!({}, 'kernel')).rejects.toMatchObject({ code: 'HARNESS-2003' });
    const denied = createMcpBridge({
      registry,
      requirePermission: (_extId, topic, _perm) => {
        throw err('FORBIDDEN', { message: `no ${topic}` });
      },
    });
    await expect(denied['mcp.tools.list']!({}, 'ext:nope')).rejects.toMatchObject({ code: 'HARNESS-1007' });
  });

  it('mcp.tools.list/call: 线格式校验 + 委托 registry（真实 stdio 调用）', async () => {
    const store = makeStore();
    const registry = makeRegistry(store);
    await addEchoServer(store, 'brg-call');
    await registry.connect('brg-call');
    const bridge = createMcpBridge({ registry, requirePermission: () => {} });
    const tools = (await bridge['mcp.tools.list']!({ serverId: 'brg-call' }, 'ext:e')) as Array<{ name: string }>;
    expect(tools.map((t) => t.name)).toContain('echo');
    await expect(bridge['mcp.tools.list']!({ serverId: 42 }, 'ext:e')).rejects.toMatchObject({ code: 'HARNESS-1009' });
    const result = (await bridge['mcp.tools.call']!(
      { serverId: 'brg-call', toolName: 'echo', args: { via: 'bridge' } },
      'ext:e',
    )) as { content: Array<{ text: string }> };
    expect(JSON.parse(result.content[0]!.text)).toEqual({ echo: { via: 'bridge' } });
    await expect(bridge['mcp.tools.call']!({ toolName: 'echo' }, 'ext:e')).rejects.toMatchObject({ code: 'HARNESS-1009' });
  });
});
