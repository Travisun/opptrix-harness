/**
 * 阶段 11 总装配 E2E（升级 A/B slot + 沙箱工作区）：真实 Kernel + 真实 createHttpServer +
 * 临时 dataDir。覆盖：
 * - 升级 REST：未配 feed → 200 feedOk=false / history 空 / apply 无目标 → 502 HARNESS-8001；
 * - 完整升级演练：本地 http server 假 feed + tar-stream 真发布包（dist/main.js 为监听
 *   /readyz 的小内核脚本，走真实子进程预检）→ apply 202 → slots.json 切换 + history.json
 *   记录 + requestRestart 注入 spy 被调（避免真实 exit）；
 * - settlePendingUpdate：slots 手工置 updateInFlight=true → 重新 boot → 窗口清除 + 版本保持；
 * - 沙箱：默认禁用 → 409 HARNESS-6001；启用（Kernel opts.sandboxClientFactory 注入 stub
 *   Docker client）→ 建工作区 201 → exec 回放 stdout 帧 → 200；列表含家目录；
 * - kernel-handlers sandbox.exec 单元：无 'sandbox' 权限 → FORBIDDEN；启用+stub → 懒创建
 *   'ext-<extId>' 持久工作区并执行；disabled → 透传 SANDBOX_DISABLED；
 * - 自动升级 cron：updateAuto + updateFeed → boot 注册 kernel:auto-update（extId=null 内核级
 *   任务）；runNow 触发 → 注入的 updaterOverride.apply 被调。
 */
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

import pino from 'pino';
import { pack, type Pack } from 'tar-stream';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { KERNEL_TOPICS } from '../src/extension-host/protocol.js';
import { CONTAINER_KEYS, Kernel, type KernelOptions, type UpdaterFacade } from '../src/kernel/Kernel.js';
import { FACADE_CONTAINER_KEYS } from '../src/kernel/Facades.js';
import { Container } from '../src/kernel/Container.js';
import { CronScheduler } from '../src/kernel/cron/scheduler.js';
import { loadConfig, type HarnessConfig } from '../src/kernel/config/index.js';
import { createKernelHandlers } from '../src/kernel/extensions/kernel-handlers.js';
import { SandboxManager } from '../src/kernel/sandbox/manager.js';
import type {
  DockerClient,
  DockerContainerInstance,
  DockerCreateContainerOptions,
  DockerExecCreateOptions,
  DockerExecInspect,
} from '../src/kernel/sandbox/types.js';
import { readSlots, writeSlots } from '../src/kernel/update/slots.js';
import { err } from '../src/kernel/errors/index.js';

// ---------------------------------------------------------------------------
// 环境
// ---------------------------------------------------------------------------

const logger = pino({ level: 'silent' });

/** 每个内核独立的临时 dataDir（afterAll 统一清理） */
const dirs: string[] = [];

async function newDir(tag: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), `opptrix-stage11-${tag}-`));
  dirs.push(dir);
  return dir;
}

/** 测试用 HarnessConfig：静音日志、单工作线程、系统分配端口、不持久化 root token */
function makeConfig(dataDir: string, overrides: Partial<HarnessConfig> = {}): HarnessConfig {
  return {
    ...loadConfig({
      NODE_ENV: 'test',
      HARNESS_LOG_LEVEL: 'error',
      HARNESS_TASK_WORKERS: '1',
      HARNESS_DATA_DIR: dataDir,
      HARNESS_PERSIST_ROOT_TOKEN: '0',
    }),
    port: 0, // loadConfig 校验 port ≥ 1，测试覆写为系统分配
    ...overrides,
  };
}

interface BootedKernel {
  kernel: Kernel;
  app: FastifyInstance;
  auth: { authorization: string };
}

/** boot 真实 Kernel（默认 serverFactory = createHttpServer）并取出 fastify 实例与 root token */
async function bootKernel(
  dataDir: string,
  kernelOpts: Partial<KernelOptions> = {},
  configOverrides: Partial<HarnessConfig> = {},
): Promise<BootedKernel> {
  const kernel = new Kernel({ config: makeConfig(dataDir, configOverrides), ...kernelOpts });
  await kernel.boot();
  const rootToken = kernel.container.resolve<{ token: string }>(CONTAINER_KEYS.authIdentity).token;
  const app = kernel.container.resolve<{ app: FastifyInstance }>(CONTAINER_KEYS.http).app;
  return { kernel, app, auth: { authorization: `Bearer ${rootToken}` } };
}

async function shutdownKernel(kernel: Kernel | undefined): Promise<void> {
  await kernel?.shutdown('e2e-test-done'); // 幂等
}

// ---------------------------------------------------------------------------
// 内存 Docker stub（回放多路复用 stdout 帧；不打真实 Docker）
// ---------------------------------------------------------------------------

/** 构造 docker exec 多路复用帧：[1B type][3B 保留 0][4B len BE][payload] */
function frame(type: number, payload: string): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt8(type, 0);
  head.writeUInt32BE(Buffer.byteLength(payload, 'utf8'), 4);
  return Buffer.concat([head, Buffer.from(payload, 'utf8')]);
}

let execSeq = 0;

class StubExec {
  readonly id: string;
  constructor(private readonly output: Buffer[]) {
    this.id = `exec-${++execSeq}`;
  }
  async start(): Promise<Readable> {
    return Readable.from(this.output);
  }
}

class StubContainer implements DockerContainerInstance {
  readonly calls: string[] = [];
  readonly execCreates: DockerExecCreateOptions[] = [];
  constructor(readonly id: string) {}
  async start(): Promise<void> {
    this.calls.push('start');
  }
  async stop(): Promise<void> {
    this.calls.push('stop');
  }
  async kill(): Promise<void> {
    this.calls.push('kill');
  }
  async remove(): Promise<void> {
    this.calls.push('remove');
  }
  async inspect(): Promise<{ State: { Running: boolean } }> {
    return { State: { Running: true } };
  }
  async exec(opts: DockerExecCreateOptions): Promise<StubExec> {
    this.execCreates.push(opts);
    return new StubExec(this.ownerOutput);
  }
  async inspectExec(): Promise<DockerExecInspect> {
    return { ExitCode: this.ownerExitCode, Running: false };
  }
  /** 用例在 create 之后注入的 exec 输出帧 / 退出码（构造期未知，故用公开字段回指） */
  ownerOutput: Buffer[] = [];
  ownerExitCode = 0;
}

class StubClient implements DockerClient {
  readonly createCalls: DockerCreateContainerOptions[] = [];
  readonly containers = new Map<string, StubContainer>();
  #seq = 0;
  /** 新建容器的 exec 输出/退出码（用例在 createWorkspace 后设定，exec 期实时读取） */
  execOutput: Buffer[] = [];
  exitCode = 0;

  async createContainer(opts: DockerCreateContainerOptions): Promise<StubContainer> {
    this.createCalls.push(opts);
    const container = new StubContainer(`cid-${++this.#seq}`);
    container.ownerOutput = this.execOutput;
    container.ownerExitCode = this.exitCode;
    this.containers.set(container.id, container);
    return container;
  }

  getContainer(id: string): DockerContainerInstance {
    const container = this.containers.get(id);
    if (container === undefined) throw new Error(`no such container (stub): ${id}`);
    return container;
  }

  async listContainers(): Promise<Array<{ Id: string; Names: string[]; State: string }>> {
    return [...this.containers.values()].map((c) => ({ Id: c.id, Names: [`/${c.id}`], State: 'running' }));
  }
}

// ---------------------------------------------------------------------------
// tar.gz 构造 + 本地 http server（假发布源）
// ---------------------------------------------------------------------------

interface TarEntrySpec {
  name: string;
  content?: string;
  type?: 'file' | 'directory';
}

function addEntry(p: Pack, spec: TarEntrySpec): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = (e?: Error | null) => (e ? reject(e) : resolve());
    if (spec.type === 'directory') {
      p.entry({ name: spec.name, type: 'directory' }, done);
      return;
    }
    const buf = Buffer.from(spec.content ?? '', 'utf8');
    p.entry({ name: spec.name, type: 'file', size: buf.length }, buf, done);
  });
}

/** 内存构造真 tar.gz，返回 buffer 与 sha256 */
async function buildTarGz(entries: TarEntrySpec[]): Promise<{ buffer: Buffer; sha256: string }> {
  const p = pack();
  const chunks: Buffer[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _enc, cb) {
      chunks.push(chunk);
      cb();
    },
  });
  const done = pipeline(Readable.from(p), createGzip(), sink);
  for (const spec of entries) await addEntry(p, spec);
  p.finalize();
  await done;
  const buffer = Buffer.concat(chunks);
  return { buffer, sha256: createHash('sha256').update(buffer).digest('hex') };
}

interface ReleaseServer {
  baseUrl: string;
  releaseUrl: string;
  sha256: string;
  close(): Promise<void>;
}

/** 起本地 http server 提供 /release.tgz（真实流式下载通道） */
function startReleaseServer(tarball: Buffer): Promise<ReleaseServer> {
  const routes: Record<string, { body: Buffer; contentType: string }> = {
    '/release.tgz': { body: tarball, contentType: 'application/gzip' },
  };
  const server: Server = createServer((req: IncomingMessage, res) => {
    const route = routes[req.url ?? ''];
    if (route === undefined) {
      res.writeHead(404);
      res.end('{}');
      return;
    }
    res.writeHead(200, { 'content-type': route.contentType });
    res.end(route.body);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr === null || typeof addr === 'string') throw new Error('no address');
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        releaseUrl: `http://127.0.0.1:${addr.port}/release.tgz`,
        sha256: createHash('sha256').update(tarball).digest('hex'),
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

/** 预检通过的最小内核脚本：监听 HARNESS_PORT 并对 /readyz 返回 200（真实子进程预检通道） */
const MAIN_JS_READYZ = [
  "const http = require('node:http');",
  'const port = Number(process.env.HARNESS_PORT);',
  'const server = http.createServer((req, res) => {',
  "  if (req.url === '/readyz') {",
  "    res.writeHead(200, { 'content-type': 'application/json' });",
  "    res.end(JSON.stringify({ ok: true }));",
  '    return;',
  '  }',
  '  res.writeHead(404);',
  '  res.end();',
  '});',
  "server.listen(port, '127.0.0.1');",
].join('\n');

// ---------------------------------------------------------------------------
// kernel-handlers 裸装配辅助（不 boot 完整内核，stub 容器按需提供 sandbox/extManager）
// ---------------------------------------------------------------------------

function makeHandlers(
  manager: SandboxManager,
  permissionsFor: (extId: string) => string[],
  configDir: string,
): Record<string, (payload: unknown, from: string) => Promise<unknown>> {
  const container = new Container();
  container.instance(CONTAINER_KEYS.sandbox, manager);
  container.instance(CONTAINER_KEYS.extManager, {
    getManifest: (extId: string) => ({ permissions: permissionsFor(extId) }),
  });
  const kernelLike = {
    config: loadConfig({ NODE_ENV: 'test', HARNESS_DATA_DIR: configDir }),
    logger,
    state: () => 'ready',
    isReady: () => true,
    container,
  };
  return createKernelHandlers({ kernel: kernelLike as unknown as Kernel });
}

/** 建一个可用的 SandboxManager（stub client 回放 stdout 帧） */
async function makeManager(dir: string, opts?: { enabled?: boolean; client?: DockerClient | null }): Promise<SandboxManager> {
  const client = opts?.client === undefined ? new StubClient() : opts.client;
  if (client instanceof StubClient) {
    client.execOutput = [frame(1, 'stub-stdout\n')];
    client.exitCode = 0;
  }
  const manager = new SandboxManager({
    config: { dataDir: dir, sandboxEnabled: opts?.enabled ?? true, sandboxImage: 'test-sandbox:latest' },
    client,
    logger,
  });
  await manager.start();
  return manager;
}

// ---------------------------------------------------------------------------
// 测试体
// ---------------------------------------------------------------------------

describe('阶段 11 总装配 E2E：升级 REST（未配 feed 基线）', () => {
  let dir = '';
  let booted: BootedKernel;

  beforeAll(async () => {
    dir = await newDir('baseline');
    booted = await bootKernel(dir);
  });

  afterAll(async () => {
    await shutdownKernel(booted?.kernel);
  });

  it('GET /api/v1/system/update（admin）→ 200 且 feedOk=false（未配 feed 不抛错）', async () => {
    const res = await booted.app.inject({ method: 'GET', url: '/api/v1/system/update', headers: booted.auth });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { feedOk: boolean; available: unknown; currentVersion: unknown; error?: string };
    expect(body.feedOk).toBe(false);
    expect(body.available).toBeNull();
    expect(body.currentVersion).toBeNull();
    expect(body.error).toContain('not configured');
  });

  it('GET /api/v1/system/update/history → 200 []（首装无发布记录）', async () => {
    const res = await booted.app.inject({ method: 'GET', url: '/api/v1/system/update/history', headers: booted.auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it('POST /api/v1/system/update/apply 无 feed 无目标 → 502 HARNESS-8001（UPDATE_CHECK_FAILED 形状）', async () => {
    const res = await booted.app.inject({
      method: 'POST',
      url: '/api/v1/system/update/apply',
      headers: booted.auth,
      payload: {},
    });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ code: 'HARNESS-8001' });
  });

  it('sandbox 默认禁用：POST /api/v1/sandbox/workspaces → 409 HARNESS-6001', async () => {
    const res = await booted.app.inject({
      method: 'POST',
      url: '/api/v1/sandbox/workspaces',
      headers: booted.auth,
      payload: { id: 'ws-1' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'HARNESS-6001' });
  });

  it('sandbox 默认禁用：GET 列表同样 409；container "sandbox" 已登记且 enabled()=false', async () => {
    const res = await booted.app.inject({
      method: 'GET',
      url: '/api/v1/sandbox/workspaces',
      headers: booted.auth,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'HARNESS-6001' });
    const manager = booted.kernel.container.resolve<SandboxManager>(CONTAINER_KEYS.sandbox);
    expect(manager.enabled()).toBe(false);
  });
});

describe('阶段 11 总装配 E2E：完整升级演练', () => {
  it('真实 feed 包 + 真实预检 → apply 202 → slots 切换 slot-b + history 记录 + requestRestart spy', async () => {
    const dir = await newDir('drill');
    // 发布包：dist/main.js = 监听 /readyz 的小内核脚本（Updater 会真实 spawn 子进程预检）
    const tarball = await buildTarGz([
      { name: 'dist', type: 'directory' },
      { name: 'dist/main.js', content: MAIN_JS_READYZ },
      { name: 'node_modules', type: 'directory' },
      { name: 'node_modules/.keep', content: '' },
      { name: 'README.md', content: 'skipped by extractor' },
    ]);
    const release = await startReleaseServer(tarball.buffer);
    const restarts: string[] = [];
    let booted: BootedKernel | undefined;
    try {
      booted = await bootKernel(
        dir,
        {
          // 注入 requestRestart spy：升级提交后不真实 shutdown+exit 测试进程
          requestRestart: async () => {
            restarts.push('restart');
          },
        },
        { updateChannel: 'stable' },
      );

      const res = await booted.app.inject({
        method: 'POST',
        url: '/api/v1/system/update/apply',
        headers: booted.auth,
        payload: { version: '2.0.0', url: release.releaseUrl, sha256: release.sha256 },
      });
      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ accepted: true, slot: 'slot-b', version: '2.0.0' });

      // slots.json：原子提交 + 更新窗口（等待重启 settle）
      const slotsCfg = { dataDir: dir };
      const state = await readSlots(slotsCfg);
      expect(state).toMatchObject({
        current: 'slot-b',
        previous: 'slot-a',
        version: '2.0.0',
        previousVersion: null,
        updateInFlight: true,
      });

      // 文件落位（发布内容 dist/**、node_modules/**；README.md 被跳过）
      expect(existsSync(path.join(dir, 'releases', 'slot-b', 'dist', 'main.js'))).toBe(true);
      expect(existsSync(path.join(dir, 'releases', 'slot-b', 'node_modules', '.keep'))).toBe(true);
      expect(existsSync(path.join(dir, 'releases', 'slot-b', 'README.md'))).toBe(false);

      // history.json 追加 + REST 可读
      const historyRaw = JSON.parse(
        await readFile(path.join(dir, 'releases', 'history.json'), 'utf8'),
      ) as Array<{ version: string; ok: boolean }>;
      expect(historyRaw).toEqual([expect.objectContaining({ version: '2.0.0', ok: true })]);
      const historyRes = await booted.app.inject({
        method: 'GET',
        url: '/api/v1/system/update/history',
        headers: booted.auth,
      });
      expect(historyRes.statusCode).toBe(200);
      expect(historyRes.json()).toEqual([expect.objectContaining({ version: '2.0.0', ok: true })]);

      // requestRestart 注入 spy 恰被调用一次（缺省实现会 shutdown + exit，测试必须注入）
      expect(restarts).toEqual(['restart']);
    } finally {
      // 先关内核再关发布源：同一 dataDir 随后的 settle 用例要重新 boot（sqlite 不能双连）
      await shutdownKernel(booted?.kernel);
      await release.close();
    }
  }, 60_000);
});

describe('阶段 11 总装配 E2E：settlePendingUpdate', () => {
  it('slots 手工置 updateInFlight=true → 重新 boot → 窗口清除且版本保持', async () => {
    const dir = dirs.find((d) => d.includes('drill'));
    if (dir === undefined) throw new Error('drill dataDir not found');
    const slotsCfg = { dataDir: dir };
    // 模拟上一进程 commit 后崩溃前的在途状态
    await writeSlots(slotsCfg, { ...(await readSlots(slotsCfg)), updateInFlight: true });

    // 同一 dataDir 重新 boot：settle 在 core.start() 之后执行（能启动即自检通过）
    const booted = await bootKernel(dir);
    try {
      const state = await readSlots(slotsCfg);
      expect(state.updateInFlight).toBe(false);
      expect(state.current).toBe('slot-b');
      expect(state.version).toBe('2.0.0');
    } finally {
      await shutdownKernel(booted.kernel);
    }
  }, 30_000);
});

describe('阶段 11 总装配 E2E：沙箱启用（stub Docker client）', () => {
  it('POST workspaces 201 → exec 回放 stdout 帧 200 → GET 列表含工作区与家目录', async () => {
    const dir = await newDir('sandbox');
    const client = new StubClient();
    client.execOutput = [frame(1, 'hi\n')]; // stdout 帧
    client.exitCode = 0;
    const booted = await bootKernel(
      dir,
      { sandboxClientFactory: () => client },
      { sandboxEnabled: true, sandboxImage: 'test-sandbox:latest' },
    );
    try {
      const manager = booted.kernel.container.resolve<SandboxManager>(CONTAINER_KEYS.sandbox);
      expect(manager.enabled()).toBe(true);

      // 创建工作区 → 201
      const created = await booted.app.inject({
        method: 'POST',
        url: '/api/v1/sandbox/workspaces',
        headers: booted.auth,
        payload: { id: 'ws-1' },
      });
      expect(created.statusCode).toBe(201);
      const ws = created.json() as { id: string; status: string; homeDir: string; containerId: string | null };
      expect(ws.id).toBe('ws-1');
      expect(ws.status).toBe('running');
      expect(ws.containerId).not.toBeNull();
      expect(ws.homeDir).toBe(path.join(dir, 'sandbox', 'ws-1'));
      // 加固容器规格经 stub client 落到 createContainer
      expect(client.createCalls[0]?.Image).toBe('test-sandbox:latest');
      expect(client.createCalls[0]?.HostConfig?.NetworkMode).toBe('bridge');

      // exec {cmd:['echo','hi']} → stub 回放 stdout 帧 → 200 结果
      const exec = await booted.app.inject({
        method: 'POST',
        url: '/api/v1/sandbox/workspaces/ws-1/exec',
        headers: booted.auth,
        payload: { cmd: ['echo', 'hi'] },
      });
      expect(exec.statusCode).toBe(200);
      expect(exec.json()).toMatchObject({ exitCode: 0, stdout: 'hi\n', stderr: '', timedOut: false });

      // GET 列表含 ws-1
      const list = await booted.app.inject({
        method: 'GET',
        url: '/api/v1/sandbox/workspaces',
        headers: booted.auth,
      });
      expect(list.statusCode).toBe(200);
      expect((list.json() as Array<{ id: string }>).map((w) => w.id)).toContain('ws-1');
    } finally {
      await shutdownKernel(booted.kernel);
    }
  }, 30_000);
});

describe('kernel-handlers sandbox.exec（阶段 11 接管）', () => {
  it("无 'sandbox' 权限的扩展 → FORBIDDEN（沿用 getManifest 权限检查模式）", async () => {
    const dir = await newDir('handler-forbidden');
    const manager = await makeManager(dir);
    const handlers = makeHandlers(manager, () => ['rpc:call'], dir);
    await expect(
      handlers[KERNEL_TOPICS.sandboxExec]({ cmd: ['echo', 'hi'] }, 'ext-a'),
    ).rejects.toMatchObject({ code: err('FORBIDDEN').code });
    // 权限闸在懒创建之前：未产生任何工作区
    expect(manager.list()).toEqual([]);
  });

  it("有 'sandbox' 权限 + stub：懒创建 'ext-x' 持久工作区并 exec；再次调用复用同一工作区", async () => {
    const dir = await newDir('handler-lazy');
    const client = new StubClient();
    const manager = await makeManager(dir, { client });
    client.execOutput = [frame(1, 'yo\n')]; // makeManager 的默认帧之后覆盖（exec 期实时读取）
    client.exitCode = 0;
    const handlers = makeHandlers(manager, () => ['sandbox'], dir);

    // workspaceId 缺省 → 'ext-' + extId（扩展的持久工作区家目录语义），首次懒创建
    const first = (await handlers[KERNEL_TOPICS.sandboxExec]({ cmd: ['echo', 'yo'] }, 'x')) as {
      exitCode: number;
      stdout: string;
    };
    expect(first).toMatchObject({ exitCode: 0, stdout: 'yo\n' });
    const home = manager.get('ext-x');
    expect(home).not.toBeNull();
    expect(home?.homeDir).toBe(path.join(dir, 'sandbox', 'ext-x'));

    // 第二次调用不再创建（复用）：createContainer 只发生一次
    await handlers[KERNEL_TOPICS.sandboxExec]({ cmd: ['echo', 'again'] }, 'x');
    expect(client.createCalls).toHaveLength(1);
    expect(manager.list().map((w) => w.id)).toEqual(['ext-x']);
  });

  it('payload.workspaceId 被忽略：工作区强制 ext-<extId>（SEC-4 归属）；manager 禁用 → 透传 SANDBOX_DISABLED', async () => {
    const dir = await newDir('handler-mixed');
    const manager = await makeManager(dir);
    const handlers = makeHandlers(manager, () => ['sandbox'], dir);
    // SEC-4：调用方自带的 workspaceId（'custom-ws'）被刻意忽略——扩展不能指定他人工作区
    await handlers[KERNEL_TOPICS.sandboxExec]({ cmd: ['ls'], workspaceId: 'custom-ws' }, 'y');
    expect(manager.get('ext-y')).not.toBeNull();
    expect(manager.get('custom-ws')).toBeNull();

    // 禁用（client null + 配置关）：SANDBOX_DISABLED 原样透传
    const disabledDir = await newDir('handler-disabled');
    const disabled = await makeManager(disabledDir, { enabled: false, client: null });
    const disabledHandlers = makeHandlers(disabled, () => ['sandbox'], disabledDir);
    await expect(
      disabledHandlers[KERNEL_TOPICS.sandboxExec]({ cmd: ['ls'] }, 'z'),
    ).rejects.toMatchObject({ code: 'HARNESS-6001' });

    // payload 非法（cmd 空）→ VALIDATION_FAILED
    await expect(handlers[KERNEL_TOPICS.sandboxExec]({ cmd: [] }, 'y')).rejects.toMatchObject({
      code: err('VALIDATION_FAILED').code,
    });
  });
});

describe('自动升级 cron（kernel:auto-update）', () => {
  it('updateAuto + updateFeed → boot 注册 extId=null 的 kernel:auto-update（REST 可见）', async () => {
    const dir = await newDir('auto-update');
    const booted = await bootKernel(
      dir,
      {
        updaterOverride: {
          check: vi.fn(async () => ({ currentVersion: null, available: null, feedOk: false })),
          apply: vi.fn(async () => ({ ok: true, slot: 'slot-b' as const, version: '9.9.9' })),
          history: vi.fn(async () => []),
        },
      },
      {
        updateAuto: true,
        updateFeed: 'http://127.0.0.1:9/feed.json', // 非空即可注册；测试不真实拉取
        updateWindow: '* * * * *',
      },
    );
    try {
      // 调度器内存表 + REST 列表均含内核级任务（extId=null 即 cron_jobs.ext_id IS NULL 约定）
      const cron = booted.kernel.container.resolve<CronScheduler>(FACADE_CONTAINER_KEYS.cronScheduler);
      const job = cron.list().find((j) => j.name === 'kernel:auto-update');
      expect(job).toBeDefined();
      expect(job?.extId).toBeNull();
      expect(job?.expr).toBe('* * * * *');

      const res = await booted.app.inject({ method: 'GET', url: '/api/v1/cron', headers: booted.auth });
      expect(res.statusCode).toBe(200);
      expect((res.json() as Array<{ name: string }>).map((j) => j.name)).toContain('kernel:auto-update');
    } finally {
      await shutdownKernel(booted.kernel);
    }
  }, 30_000);

  it('runNow 触发 kernel:auto-update → #onCronFire 调 updater.apply（注入替身被调）', async () => {
    const dir = await newDir('auto-update-fire');
    const apply = vi.fn(async () => ({ ok: true, slot: 'slot-b' as const, version: '9.9.9' }));
    const booted = await bootKernel(
      dir,
      {
        updaterOverride: {
          check: vi.fn(async () => ({ currentVersion: null, available: null, feedOk: false })),
          apply,
          history: vi.fn(async () => []),
        },
      },
      { updateAuto: true, updateFeed: 'http://127.0.0.1:9/feed.json', updateWindow: '0 4 * * *' },
    );
    try {
      const cron = booted.kernel.container.resolve<CronScheduler>(FACADE_CONTAINER_KEYS.cronScheduler);
      const job = cron.list().find((j) => j.name === 'kernel:auto-update');
      expect(job).toBeDefined();
      await cron.runNow(job?.id ?? '');
      // apply 在 onCronFire 内刻意不等待（下载/预检耗时长），轮询至被调
      await vi.waitFor(() => {
        expect(apply).toHaveBeenCalledTimes(1);
      });
    } finally {
      await shutdownKernel(booted.kernel);
    }
  }, 30_000);

  it('REL-4：同一 dataDir 连续两次 boot → kernel:auto-update 恰 1 行（先摘旧再重排）', async () => {
    const dir = await newDir('auto-update-reboot');
    const overrides = {
      updaterOverride: {
        check: vi.fn(async () => ({ currentVersion: null, available: null, feedOk: false })),
        apply: vi.fn(async () => ({ ok: true, slot: 'slot-b' as const, version: '9.9.9' })),
        history: vi.fn(async () => []),
      },
    };
    const configOverrides = {
      updateAuto: true,
      updateFeed: 'http://127.0.0.1:9/feed.json',
      updateWindow: '0 4 * * *',
    };
    const first = await bootKernel(dir, overrides, configOverrides);
    try {
      const cron1 = first.kernel.container.resolve<CronScheduler>(FACADE_CONTAINER_KEYS.cronScheduler);
      expect(cron1.list().filter((j) => j.name === 'kernel:auto-update')).toHaveLength(1);
    } finally {
      await shutdownKernel(first.kernel);
    }

    // 第二次 boot（同 dataDir）：REL-4 先摘旧行再重排，表内不重复
    const second = await bootKernel(dir, overrides, configOverrides);
    try {
      const cron2 = second.kernel.container.resolve<CronScheduler>(FACADE_CONTAINER_KEYS.cronScheduler);
      const jobs = cron2.list().filter((j) => j.name === 'kernel:auto-update');
      expect(jobs).toHaveLength(1);
    } finally {
      await shutdownKernel(second.kernel);
    }
  }, 60_000);
});

afterAll(async () => {
  for (const dir of dirs) {
    await rm(dir, { recursive: true, force: true });
  }
});
