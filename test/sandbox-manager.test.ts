/**
 * SandboxManager 单测（内存 DockerClient stub 记录调用，不打真实 Docker）。
 *
 * - parseDockerStream：stdout 帧 / stderr 帧 / 混合多帧（含未知类型与半帧丢弃）；
 * - disabled：配置禁用或 client null → SANDBOX_DISABLED；start() 优雅降级不抛；
 * - createWorkspace：容器加固参数断言（Image/Cmd/User/WorkingDir/Binds/Memory/NanoCpus/
 *   PidsLimit/CapDrop/SecurityOpt/ReadonlyRootfs/NetworkMode=bridge）；id/image 定制；
 *   上限与重复 id 拒绝；
 * - networkMode（net:out 权限联动的容器网络参数面）：缺省 bridge、'none' 传参、
 *   WorkspaceInfo 回显（get/list）、isolated 一次性容器恒为 none、非法值 BAD_REQUEST；
 * - exec：正常输出分拣、exitCode 非零不抛、超时 timedOut=true 且 kill 被调、
 *   env/workdir 透传、stopped 自动重启、isolated 一次性容器（NetworkMode none + 用毕强删）；
 * - idle sweep：短 idleStopMs + 时间推进 → stop 被调（容器保留）；未活跃不足不 stop；
 *   start() 的 30s interval 接线；
 * - 文件：writeFile/readFile/listFiles 的命令拼装 + 路径穿越拒绝；
 * - removeWorkspace（plain/force/幂等）与重启恢复扫描。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DockerStreamDemuxer,
  IDLE_SWEEP_INTERVAL_MS,
  SandboxManager,
  parseDockerStream,
} from '../src/kernel/sandbox/manager.js';
import type {
  DockerClient,
  DockerContainerInstance,
  DockerCreateContainerOptions,
  DockerExecCreateOptions,
  DockerExecInspect,
} from '../src/kernel/sandbox/types.js';

const logger = pino({ level: 'silent' });

/** 构造一段 docker 多路复用帧：[1B type][3B 保留 0][4B len BE][payload] */
function frame(type: number, payload: string): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt8(type, 0);
  head.writeUInt32BE(Buffer.byteLength(payload, 'utf8'), 4);
  return Buffer.concat([head, Buffer.from(payload, 'utf8')]);
}

const tick = (ms = 10): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// 内存 Docker stub（记录调用、回放多路复用帧）
// ---------------------------------------------------------------------------

/** exec 输出：Buffer[] 逐帧回放；'hang' = 永不产出（模拟卡死，测超时） */
type ExecOutput = Buffer[] | 'hang';

let execSeq = 0;

class StubExec {
  readonly id: string;
  constructor(private readonly output: ExecOutput) {
    this.id = `exec-${++execSeq}`;
  }

  async start(): Promise<Readable> {
    if (this.output === 'hang') {
      return new Readable({ read() {} }); // 永不 push/end：卡死流
    }
    return Readable.from(this.output);
  }
}

class StubContainer implements DockerContainerInstance {
  /** 方法调用记录（'start' | 'stop' | 'kill' | 'remove' | 'remove:force'） */
  readonly calls: string[] = [];
  readonly execCreates: DockerExecCreateOptions[] = [];
  running = false;

  constructor(
    readonly id: string,
    /** 回指持有者：exec 输出/退出码在调用时实时读取（用例可在 createWorkspace 之后再设定） */
    private readonly owner: StubClient,
  ) {}

  async start(): Promise<void> {
    this.calls.push('start');
    this.running = true;
  }

  async stop(): Promise<void> {
    this.calls.push('stop');
    this.running = false;
  }

  async kill(): Promise<void> {
    this.calls.push('kill');
    this.running = false;
  }

  async remove(opts?: { force?: boolean }): Promise<void> {
    this.calls.push(opts?.force === true ? 'remove:force' : 'remove');
  }

  async inspect(): Promise<{ State: { Running: boolean } }> {
    return { State: { Running: this.running } };
  }

  async exec(opts: DockerExecCreateOptions): Promise<StubExec> {
    this.execCreates.push(opts);
    return new StubExec(this.owner.execOutput);
  }

  async inspectExec(): Promise<DockerExecInspect> {
    return { ExitCode: this.owner.exitCode, Running: false };
  }
}

class StubClient implements DockerClient {
  readonly createCalls: DockerCreateContainerOptions[] = [];
  readonly containers = new Map<string, StubContainer>();
  /** 全局 exec 行为（新建容器共享；用例按需在 create 前后覆盖） */
  execOutput: ExecOutput = [];
  exitCode = 0;
  #seq = 0;

  async createContainer(opts: DockerCreateContainerOptions): Promise<StubContainer> {
    this.createCalls.push(opts);
    const container = new StubContainer(`cid-${++this.#seq}`, this);
    this.containers.set(container.id, container);
    return container;
  }

  getContainer(id: string): DockerContainerInstance {
    const container = this.containers.get(id);
    if (container === undefined) throw new Error(`no such container (stub): ${id}`);
    return container;
  }

  async listContainers(): Promise<Array<{ Id: string; Names: string[]; State: string }>> {
    return [...this.containers.values()].map((c) => ({
      Id: c.id,
      Names: [`/${c.id}`],
      State: c.running ? 'running' : 'exited',
    }));
  }
}

// ---------------------------------------------------------------------------
// 装配辅助
// ---------------------------------------------------------------------------

const dirs: string[] = [];

interface Ctx {
  dir: string;
  client: StubClient;
  manager: SandboxManager;
}

function build(opts?: { enabled?: boolean; client?: DockerClient | null; idleStopMs?: number; maxWorkspaces?: number }): Ctx {
  const dir = mkdtempSync(join(tmpdir(), 'opptrix-sandbox-mgr-'));
  dirs.push(dir);
  // client 仅在显式传 null（disabled 用例）时非 StubClient；返回面仍按 StubClient 断言
  const client = (opts?.client === undefined ? new StubClient() : opts.client) as StubClient;
  const manager = new SandboxManager({
    config: { dataDir: dir, sandboxEnabled: opts?.enabled ?? true, sandboxImage: 'test-sandbox:latest' },
    client,
    logger,
    idleStopMs: opts?.idleStopMs,
    maxWorkspaces: opts?.maxWorkspaces,
  });
  return { dir, client, manager };
}

beforeEach(() => {
  execSeq = 0;
});

afterEach(async () => {
  vi.useRealTimers();
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// parseDockerStream（纯函数 3 用例 + demuxer 边界）
// ---------------------------------------------------------------------------

describe('parseDockerStream — docker exec 多路复用帧解帧', () => {
  it('纯 stdout 帧 → stdout 收齐、stderr 为空', () => {
    const parsed = parseDockerStream(frame(1, 'hello world'));
    expect(parsed).toEqual({ stdout: 'hello world', stderr: '' });
  });

  it('纯 stderr 帧 → stderr 收齐、stdout 为空（UTF-8 多字节安全）', () => {
    const parsed = parseDockerStream(frame(2, '错误信息 é'));
    expect(parsed).toEqual({ stdout: '', stderr: '错误信息 é' });
  });

  it('混合多帧（stdout/stderr 交错 + 未知类型忽略 + 尾部半帧丢弃）', () => {
    const buf = Buffer.concat([
      frame(1, 'out-1\n'),
      frame(2, 'err-1\n'),
      frame(7, 'ignored'), // 未知 streamType：忽略
      frame(1, 'out-2'),
      Buffer.from([1, 0, 0, 0, 0, 0, 0, 9, 0x68]), // 声明 9 字节实际只有 1 字节：半帧丢弃
    ]);
    const parsed = parseDockerStream(buf);
    expect(parsed.stdout).toBe('out-1\nout-2');
    expect(parsed.stderr).toBe('err-1\n');
  });

  it('DockerStreamDemuxer 增量 push：跨 chunk 的半帧自动续接', () => {
    const demuxer = new DockerStreamDemuxer();
    const whole = frame(1, 'split-across-chunks');
    demuxer.push(whole.subarray(0, 5)); // 掐在头部中间
    demuxer.push(whole.subarray(5, 14)); // 掐在 payload 中间
    demuxer.push(whole.subarray(14));
    expect(demuxer.finish()).toEqual({ stdout: 'split-across-chunks', stderr: '' });
  });

  it('超 1MB 截断：超出部分丢弃', () => {
    const demuxer = new DockerStreamDemuxer();
    demuxer.push(frame(1, 'x'.repeat(1024 * 1024 + 100)));
    const parsed = demuxer.finish();
    expect(parsed.stdout).toHaveLength(1024 * 1024);
  });
});

// ---------------------------------------------------------------------------
// disabled 语义
// ---------------------------------------------------------------------------

describe('SandboxManager — disabled 语义与优雅降级', () => {
  it('sandboxEnabled=false → enabled() false，createWorkspace/exec/get/list 全部 SANDBOX_DISABLED', async () => {
    const { manager } = build({ enabled: false });
    await expect(manager.createWorkspace({})).rejects.toMatchObject({ code: 'HARNESS-6001' });
    await expect(manager.exec('ws', ['ls'])).rejects.toMatchObject({ code: 'HARNESS-6001' });
    await expect(manager.readFile('ws', 'a.txt')).rejects.toMatchObject({ code: 'HARNESS-6001' });
    await expect(manager.removeWorkspace('ws')).rejects.toMatchObject({ code: 'HARNESS-6001' });
    expect(() => manager.get('ws')).toThrow(expect.objectContaining({ code: 'HARNESS-6001' }));
    expect(() => manager.list()).toThrow(expect.objectContaining({ code: 'HARNESS-6001' }));
    expect(manager.enabled()).toBe(false);
  });

  it('client=null（Docker 不可用）→ SANDBOX_DISABLED；start() warn 一次且不抛', async () => {
    const { manager } = build({ client: null });
    await expect(manager.createWorkspace({})).rejects.toMatchObject({ code: 'HARNESS-6001' });
    await expect(manager.start()).resolves.toBeUndefined(); // 优雅降级不抛
    await expect(manager.start()).resolves.toBeUndefined(); // 幂等
    expect(manager.enabled()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createWorkspace
// ---------------------------------------------------------------------------

describe('SandboxManager — createWorkspace 容器参数与登记', () => {
  it('缺省 id/image：uuid、默认镜像；容器加固参数全量断言；家目录创建、status running', async () => {
    const { dir, client, manager } = build();
    await manager.start();
    const ws = await manager.createWorkspace({});

    expect(ws.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(ws.image).toBe('test-sandbox:latest');
    expect(ws.status).toBe('running');
    expect(ws.containerId).toMatch(/^cid-/);
    expect(ws.homeDir).toBe(join(dir, 'sandbox', ws.id));
    expect(existsSync(ws.homeDir)).toBe(true);

    expect(client.createCalls).toHaveLength(1);
    const opts = client.createCalls[0] as DockerCreateContainerOptions;
    expect(opts.Image).toBe('test-sandbox:latest');
    expect(opts.Cmd).toEqual(['sleep', 'infinity']);
    expect(opts.User).toBe('1000:1000');
    expect(opts.WorkingDir).toBe('/home/dev');
    expect(opts.Labels).toMatchObject({ 'opptrix.workspace': ws.id });
    expect(opts.HostConfig?.Binds).toEqual([`${join(dir, 'sandbox', ws.id)}:/home/dev`]);
    expect(opts.HostConfig?.Memory).toBe(512 * 1024 * 1024);
    expect(opts.HostConfig?.NanoCpus).toBe(1_000_000_000);
    expect(opts.HostConfig?.PidsLimit).toBe(128);
    expect(opts.HostConfig?.CapDrop).toEqual(['ALL']);
    expect(opts.HostConfig?.SecurityOpt).toEqual(['no-new-privileges']);
    expect(opts.HostConfig?.ReadonlyRootfs).toBe(false);
    expect(opts.HostConfig?.NetworkMode).toBe('bridge');

    const container = client.containers.get(ws.containerId as string);
    expect(container?.calls).toContain('start');
    expect(manager.get(ws.id)?.status).toBe('running');
    expect(manager.list()).toHaveLength(1);
  });

  it('自定义 id + image 透传；get()/list() 反映记录', async () => {
    const { manager } = build();
    await manager.start();
    const ws = await manager.createWorkspace({ id: 'custom-ws', image: 'alpine:3.20' });
    expect(ws.id).toBe('custom-ws');
    expect(ws.image).toBe('alpine:3.20');
    expect(manager.get('custom-ws')?.image).toBe('alpine:3.20');
    expect(manager.list().map((w) => w.id)).toEqual(['custom-ws']);
  });

  it('超出 maxWorkspaces → SANDBOX_ERROR；重复 id → SANDBOX_ERROR；非法 id（穿越形态）→ 拒绝', async () => {
    const { manager } = build({ maxWorkspaces: 1 });
    await manager.start();
    await manager.createWorkspace({ id: 'ws-a' });
    await expect(manager.createWorkspace({ id: 'ws-b' })).rejects.toMatchObject({ code: 'HARNESS-6003' });
    await expect(manager.createWorkspace({ id: 'ws-a' })).rejects.toMatchObject({ code: 'HARNESS-6003' });
    await expect(manager.createWorkspace({ id: '../evil' })).rejects.toMatchObject({ code: 'HARNESS-1008' });
  });
});

// ---------------------------------------------------------------------------
// networkMode（net:out 权限联动的容器网络参数面）
// ---------------------------------------------------------------------------

describe('SandboxManager — createWorkspace networkMode', () => {
  it('缺省 networkMode → 容器 NetworkMode bridge（现状保持）+ 登记 networkMode bridge', async () => {
    const { client, manager } = build();
    await manager.start();
    const ws = await manager.createWorkspace({});

    const opts = client.createCalls[0] as DockerCreateContainerOptions;
    expect(opts.HostConfig?.NetworkMode).toBe('bridge');
    expect(ws.networkMode).toBe('bridge');
    expect(manager.get(ws.id)?.networkMode).toBe('bridge');
  });

  it('networkMode "none" 传参 → createContainer HostConfig.NetworkMode none + WorkspaceInfo 回显', async () => {
    const { client, manager } = build();
    await manager.start();
    const ws = await manager.createWorkspace({ id: 'air-gapped', networkMode: 'none' });

    expect(client.createCalls).toHaveLength(1);
    const opts = client.createCalls[0] as DockerCreateContainerOptions;
    expect(opts.HostConfig?.NetworkMode).toBe('none');
    expect(ws.networkMode).toBe('none');
    expect(manager.get('air-gapped')?.networkMode).toBe('none');
    // list() 同样回显（net:out 联动在 list 视图可见）
    const listed = manager.list().find((w) => w.id === 'air-gapped');
    expect(listed?.networkMode).toBe('none');
  });

  it('bridge 与 none 工作区并存：list() 各自回显互不串扰', async () => {
    const { client, manager } = build();
    await manager.start();
    await manager.createWorkspace({ id: 'with-net' });
    await manager.createWorkspace({ id: 'no-net', networkMode: 'none' });

    expect(client.createCalls).toHaveLength(2);
    expect((client.createCalls[0] as DockerCreateContainerOptions).HostConfig?.NetworkMode).toBe('bridge');
    expect((client.createCalls[1] as DockerCreateContainerOptions).HostConfig?.NetworkMode).toBe('none');
    expect(manager.list().map((w) => ({ id: w.id, networkMode: w.networkMode }))).toEqual([
      { id: 'with-net', networkMode: 'bridge' },
      { id: 'no-net', networkMode: 'none' },
    ]);
  });

  it('isolated 一次性执行恒为 none（即便工作区为 bridge）；none 工作区 exec 不新建容器', async () => {
    const { client, manager } = build();
    await manager.start();
    // bridge 工作区 + isolated：一次性容器仍强制 none（任务级隔离不受工作区参数影响）
    const bridged = await manager.createWorkspace({ id: 'bridged-ws' });
    expect(bridged.networkMode).toBe('bridge');
    client.execOutput = [frame(1, 'iso')];
    await manager.exec('bridged-ws', ['echo', 'iso'], { isolated: true });
    const ephemeralOpts = client.createCalls[1] as DockerCreateContainerOptions;
    expect(ephemeralOpts.HostConfig?.NetworkMode).toBe('none');

    // none 工作区 + isolated：同样 none，加固基线一致
    await manager.createWorkspace({ id: 'none-ws', networkMode: 'none' });
    await manager.exec('none-ws', ['echo', 'iso'], { isolated: true });
    const ephemeralOpts2 = client.createCalls[2] as DockerCreateContainerOptions;
    expect(ephemeralOpts2.HostConfig?.NetworkMode).toBe('none');

    // none 工作区的普通 exec 复用主容器（NetworkMode none），不新建
    const callsBefore = client.createCalls.length;
    await manager.exec('none-ws', ['true']);
    expect(client.createCalls).toHaveLength(callsBefore);
  });

  it('非法 networkMode → BAD_REQUEST（fail-closed，未触达 Docker）', async () => {
    const { client, manager } = build();
    await manager.start();
    const evil = { id: 'evil-ws', networkMode: 'host' } as unknown as { id: string; networkMode: 'bridge' | 'none' };
    await expect(manager.createWorkspace(evil)).rejects.toMatchObject({ code: 'HARNESS-1008' });
    expect(client.createCalls).toHaveLength(0);
    expect(manager.list()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// exec
// ---------------------------------------------------------------------------

describe('SandboxManager — exec', () => {
  it('正常执行：stdout/stderr 分拣、exitCode 透传、timedOut=false、lastActiveAt 刷新', async () => {
    const { client, manager } = build();
    await manager.start();
    const ws = await manager.createWorkspace({});
    await tick(5);
    const before = ws.lastActiveAt;

    client.exitCode = 7;
    client.execOutput = [frame(1, 'hello\n'), frame(2, 'oops\n')];
    const result = await manager.exec(ws.id, ['sh', '-c', 'echo hello; echo oops >&2']);

    expect(result).toMatchObject({ exitCode: 7, stdout: 'hello\n', stderr: 'oops\n', timedOut: false });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(manager.get(ws.id)?.lastActiveAt).toBeGreaterThan(before);
  });

  it('超时：timedOut=true、container.kill 被调、部分输出返回不抛、exitCode=-1', async () => {
    const { client, manager } = build();
    await manager.start();
    const ws = await manager.createWorkspace({});
    client.execOutput = 'hang';
    const result = await manager.exec(ws.id, ['sleep', '1000'], { timeoutMs: 40 });

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(-1);
    expect(result.durationMs).toBeGreaterThanOrEqual(30);
    const container = client.containers.get(ws.containerId as string);
    expect(container?.calls).toContain('kill');
  });

  it('exitCode 非零不抛（透传给调用方）', async () => {
    const { client, manager } = build();
    await manager.start();
    const ws = await manager.createWorkspace({});
    client.exitCode = 3;
    const result = await manager.exec(ws.id, ['false']);
    expect(result.exitCode).toBe(3);
    expect(result.timedOut).toBe(false);
  });

  it('env/workdir 透传为 exec 创建参数（Env 条目 + WorkingDir）', async () => {
    const { client, manager } = build();
    await manager.start();
    const ws = await manager.createWorkspace({});
    await manager.exec(ws.id, ['env'], { env: { FOO: 'bar', BAZ: 'qux=1' }, workdir: '/tmp' });
    const container = client.containers.get(ws.containerId as string);
    const created = container?.execCreates[0];
    expect(created?.Env).toEqual(['FOO=bar', 'BAZ=qux=1']);
    expect(created?.WorkingDir).toBe('/tmp');
    expect(created?.User).toBe('1000:1000');
  });

  it('未知工作区 → SANDBOX_NOT_FOUND；空 cmd / 非法 timeoutMs → BAD_REQUEST', async () => {
    const { manager } = build();
    await manager.start();
    await expect(manager.exec('ghost', ['ls'])).rejects.toMatchObject({ code: 'HARNESS-6004' });
    const ws = await manager.createWorkspace({});
    await expect(manager.exec(ws.id, [])).rejects.toMatchObject({ code: 'HARNESS-1008' });
    await expect(manager.exec(ws.id, ['ls'], { timeoutMs: 0 })).rejects.toMatchObject({ code: 'HARNESS-1008' });
    await expect(manager.exec(ws.id, ['ls'], { timeoutMs: -5 })).rejects.toMatchObject({ code: 'HARNESS-1008' });
  });

  it('stopped 工作区 exec 自动重启容器（status 回 running）', async () => {
    const { client, manager } = build({ idleStopMs: 1000 });
    await manager.start();
    const ws = await manager.createWorkspace({});
    const container = client.containers.get(ws.containerId as string);
    container?.calls.splice(0); // 清掉 create 期的 start 记录，只看本次 exec 的行为

    // 经 idle sweep 置为 stopped（容器保留，见 idle sweep 用例）；假时钟推进需覆盖 sweep 判定
    vi.useFakeTimers();
    vi.advanceTimersByTime(1001);
    await manager.sweepIdleWorkspaces();
    vi.useRealTimers();
    expect(manager.get(ws.id)?.status).toBe('stopped');

    client.execOutput = [frame(1, 'revived')];
    const result = await manager.exec(ws.id, ['echo', 'revived']);
    expect(result.stdout).toBe('revived');
    expect(container?.calls.filter((c) => c === 'start')).toHaveLength(1); // 自动重启一次
    expect(manager.get(ws.id)?.status).toBe('running');
  });

  it('isolated exec：一次性容器（NetworkMode none、同家目录 bind）承载，结束即 force remove', async () => {
    const { dir, client, manager } = build();
    await manager.start();
    const ws = await manager.createWorkspace({});
    client.execOutput = [frame(1, 'iso-out')];

    const result = await manager.exec(ws.id, ['echo', 'iso'], { isolated: true });

    expect(result.stdout).toBe('iso-out');
    expect(client.createCalls).toHaveLength(2);
    const ephemeralOpts = client.createCalls[1] as DockerCreateContainerOptions;
    expect(ephemeralOpts.HostConfig?.NetworkMode).toBe('none');
    expect(ephemeralOpts.HostConfig?.Binds).toEqual([`${join(dir, 'sandbox', ws.id)}:/home/dev`]);
    expect(ephemeralOpts.Cmd).toEqual(['sleep', 'infinity']);
    const ephemeral = [...client.containers.values()][1];
    expect(ephemeral?.calls).toContain('remove:force');
    // 主容器未被波及
    expect(client.containers.get(ws.containerId as string)?.calls).not.toContain('remove:force');
  });

  it('恢复记录（containerId=null）exec → SANDBOX_ERROR 提示重建', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'opptrix-sandbox-rec-'));
    dirs.push(dir);
    mkdirSync(join(dir, 'sandbox', 'restored'), { recursive: true });
    const client = new StubClient();
    const manager = new SandboxManager({
      config: { dataDir: dir, sandboxEnabled: true, sandboxImage: 'test-sandbox:latest' },
      client,
      logger,
    });
    await manager.start();
    await expect(manager.exec('restored', ['ls'])).rejects.toMatchObject({ code: 'HARNESS-6003' });
  });
});

// ---------------------------------------------------------------------------
// idle sweep
// ---------------------------------------------------------------------------

describe('SandboxManager — idle 停机扫描', () => {
  it('注入短 idleStopMs：时间推进后 sweep → stop 被调、status stopped（容器保留）、再 sweep 幂等', async () => {
    vi.useFakeTimers();
    const { client, manager } = build({ idleStopMs: 1000 });
    await manager.start();
    const ws = await manager.createWorkspace({});
    const container = client.containers.get(ws.containerId as string);

    vi.advanceTimersByTime(1001); // 活跃超时
    const stopped = await manager.sweepIdleWorkspaces();
    expect(stopped).toBe(1);
    expect(container?.calls).toContain('stop');
    expect(manager.get(ws.id)?.status).toBe('stopped');

    expect(await manager.sweepIdleWorkspaces()).toBe(0); // 已 stopped：幂等
  });

  it('未超 idleStopMs 不 stop；fresh 记录（lastActiveAt 刚刷新）保持 running', async () => {
    vi.useFakeTimers();
    const { client, manager } = build({ idleStopMs: 1000 });
    await manager.start();
    const ws = await manager.createWorkspace({});
    vi.advanceTimersByTime(500);
    expect(await manager.sweepIdleWorkspaces()).toBe(0);
    const container = client.containers.get(ws.containerId as string);
    expect(container?.calls).not.toContain('stop');
    expect(manager.get(ws.id)?.status).toBe('running');
  });

  it('start() 的 30s 后台 interval（unref）触发 sweep：推进 30s 后 stop 被调', async () => {
    vi.useFakeTimers();
    const { client, manager } = build({ idleStopMs: 1000 });
    await manager.start();
    const ws = await manager.createWorkspace({});
    const container = client.containers.get(ws.containerId as string);

    await vi.advanceTimersByTimeAsync(IDLE_SWEEP_INTERVAL_MS + 1);
    expect(container?.calls).toContain('stop');
    expect(manager.get(ws.id)?.status).toBe('stopped');

    await manager.stop(); // 清理定时器（afterEach 亦兜底）
  });
});

// ---------------------------------------------------------------------------
// 文件操作（命令拼装 + 路径穿越拒绝）
// ---------------------------------------------------------------------------

describe('SandboxManager — writeFile / readFile / listFiles', () => {
  it('writeFile：命令拼装（子目录带 mkdir -p；base64 经单引号包裹）', async () => {
    const { client, manager } = build();
    await manager.start();
    const ws = await manager.createWorkspace({});
    const container = client.containers.get(ws.containerId as string);

    await manager.writeFile(ws.id, 'sub/a.txt', 'aGk=');
    const created = container?.execCreates.at(-1);
    expect(created?.Cmd).toEqual(['sh', '-c', "mkdir -p 'sub' && printf '%s' 'aGk=' | base64 -d > 'sub/a.txt'"]);

    await manager.writeFile(ws.id, 'root.txt', 'eg=='); // 家目录根：无 mkdir 段
    const created2 = container?.execCreates.at(-1);
    expect((created2?.Cmd as string[])[2]).toBe("printf '%s' 'eg==' | base64 -d > 'root.txt'");
  });

  it('writeFile 路径穿越 / 绝对路径 / 非法 base64 → BAD_REQUEST（未触达容器）', async () => {
    const { client, manager } = build();
    await manager.start();
    const ws = await manager.createWorkspace({});
    const container = client.containers.get(ws.containerId as string);

    await expect(manager.writeFile(ws.id, '../escape.txt', 'aGk=')).rejects.toMatchObject({ code: 'HARNESS-1008' });
    await expect(manager.writeFile(ws.id, 'a/../../b.txt', 'aGk=')).rejects.toMatchObject({ code: 'HARNESS-1008' });
    await expect(manager.writeFile(ws.id, '/etc/passwd', 'aGk=')).rejects.toMatchObject({ code: 'HARNESS-1008' });
    await expect(manager.writeFile(ws.id, 'ok.txt', 'not-base64!!')).rejects.toMatchObject({ code: 'HARNESS-1008' });
    expect(container?.execCreates).toHaveLength(0); // 校验前置，未发起任何 exec
  });

  it('readFile：`base64 <path>` 命令 + 输出去空白；文件不存在（stderr no such）→ SANDBOX_NOT_FOUND', async () => {
    const { client, manager } = build();
    await manager.start();
    const ws = await manager.createWorkspace({});
    const container = client.containers.get(ws.containerId as string);

    client.execOutput = [frame(1, 'aGk=\n'), frame(1, 'Zm9v')]; // busybox 按 76 列折行
    await expect(manager.readFile(ws.id, 'a b.txt')).resolves.toBe('aGk=Zm9v');
    expect(container?.execCreates.at(-1)?.Cmd).toEqual(['sh', '-c', "base64 'a b.txt'"]);

    client.execOutput = [frame(2, "base64: can't open 'nope.txt': No such file or directory")];
    client.exitCode = 1;
    await expect(manager.readFile(ws.id, 'nope.txt')).rejects.toMatchObject({ code: 'HARNESS-6004' });
    client.exitCode = 0;
  });

  it('listFiles：解析 `f <size> <name>` / `d 0 <name>` 行并按名排序；穿越路径拒绝', async () => {
    const { client, manager } = build();
    await manager.start();
    const ws = await manager.createWorkspace({});
    const container = client.containers.get(ws.containerId as string);

    client.execOutput = [frame(1, 'f 3 a.txt\nd 0 sub\nf 0 .hidden\n')];
    await expect(manager.listFiles(ws.id)).resolves.toEqual([
      { name: '.hidden', size: 0, dir: false },
      { name: 'a.txt', size: 3, dir: false },
      { name: 'sub', size: 0, dir: true },
    ]);
    const script = (container?.execCreates.at(-1)?.Cmd as string[])[2] as string;
    expect(script).toContain("cd '.'");
    expect(script).toContain('wc -c');

    await expect(manager.listFiles(ws.id, 'sub/../../etc')).rejects.toMatchObject({ code: 'HARNESS-1008' });
  });
});

// ---------------------------------------------------------------------------
// removeWorkspace 与恢复扫描
// ---------------------------------------------------------------------------

describe('SandboxManager — removeWorkspace 与重启恢复', () => {
  it('removeWorkspace：容器 remove + 家目录删除 + 记录移除；再删返回 false', async () => {
    const { manager } = build();
    await manager.start();
    const ws = await manager.createWorkspace({});
    expect(existsSync(ws.homeDir)).toBe(true);

    await expect(manager.removeWorkspace(ws.id)).resolves.toBe(true);
    expect(existsSync(ws.homeDir)).toBe(false);
    expect(manager.get(ws.id)).toBeNull();
    await expect(manager.removeWorkspace(ws.id)).resolves.toBe(false); // 幂等
    await expect(manager.removeWorkspace('ghost')).resolves.toBe(false);
  });

  it('force 移除：容器 remove 带 force（容器移除失败也落记录删除）', async () => {
    const { client, manager } = build();
    await manager.start();
    const ws = await manager.createWorkspace({});
    const container = client.containers.get(ws.containerId as string);
    expect(container).toBeDefined();
    const target = container as StubContainer;
    // 让容器 remove 抛错：stub 替换 remove 行为
    target.remove = async (opts?: { force?: boolean }) => {
      target.calls.push(opts?.force === true ? 'remove:force' : 'remove');
      throw new Error('device or resource busy');
    };
    await expect(manager.removeWorkspace(ws.id)).rejects.toMatchObject({ code: 'HARNESS-6003' });
    expect(manager.get(ws.id)).not.toBeNull(); // 未 force：记录保留
    await expect(manager.removeWorkspace(ws.id, { force: true })).resolves.toBe(true);
    expect(target.calls).toContain('remove:force');
    expect(manager.get(ws.id)).toBeNull();
  });

  it('重启恢复扫描：`<dataDir>/sandbox/` 下目录恢复为 stopped 记录（containerId=null、非法名跳过）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'opptrix-sandbox-boot-'));
    dirs.push(dir);
    mkdirSync(join(dir, 'sandbox', 'kept-ws'), { recursive: true });
    writeFileSync(join(dir, 'sandbox', 'kept-ws', 'keep.txt'), 'data');
    mkdirSync(join(dir, 'sandbox', 'not a valid id!'), { recursive: true }); // 非法名跳过
    writeFileSync(join(dir, 'sandbox', 'a-file.txt'), 'not-a-dir'); // 文件跳过

    const client = new StubClient();
    const manager = new SandboxManager({
      config: { dataDir: dir, sandboxEnabled: true, sandboxImage: 'test-sandbox:latest' },
      client,
      logger,
    });
    await manager.start();

    const list = manager.list();
    expect(list.map((w) => w.id)).toEqual(['kept-ws']);
    expect(list[0]).toMatchObject({
      status: 'stopped',
      containerId: null,
      image: 'test-sandbox:latest',
      homeDir: join(dir, 'sandbox', 'kept-ws'),
    });
    expect(client.createCalls).toHaveLength(0); // 恢复不重建容器（v1：重建由用户 create 承接）
  });
});
