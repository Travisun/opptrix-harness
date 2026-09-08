/**
 * sandbox manager — Docker 工作区沙箱编排（容器生命周期 + 文件 + exec）。
 *
 * 职责边界：
 * - DockerClient 由 deps 注入（duck-type 最小面，见 types.ts / docker.ts）；
 *   client 为 null 或 config.sandboxEnabled=false 时 enabled()=false，
 *   所有操作抛 HARNESS-6001 SANDBOX_DISABLED（start() 仅 warn 一次，优雅降级不抛）；
 * - 登记表 v1 为内存表 + "家目录即事实"：重启后 start() 扫描 `<dataDir>/sandbox/`
 *   恢复为 stopped 记录（containerId=null；旧容器不追溯，重建由用户 create 新工作区承接，
 *   对恢复记录 exec 报 SANDBOX_ERROR 提示重建）；
 * - createWorkspace：家目录 mkdir → createContainer（非 root 用户 1000:1000、家目录 bind、
 *   内存/CPU/PID 上限、CapDrop ALL、no-new-privileges 等加固，NetworkMode 由入参
 *   networkMode 指定（'bridge' | 'none'，缺省 'bridge' 保持现状；net:out 权限联动由
 *   调用方推导传入）并记录进 WorkspaceInfo；
 *   ReadonlyRootfs=false：家目录经 bind 持久化，容器系统层可写但随容器重建丢失——v1 取舍）
 *   → start → 登记 running；
 * - exec：container.exec → hijack 单流（docker 多路复用帧协议）→ parseDockerStream 解帧
 *   → inspectExec 取退出码；超时用 setTimeout 后 container.kill()（docker exec 无独立停止
 *   通道；会波及同工作区其他进程，v1 权衡），timedOut=true 返回部分输出、不抛；
 *   stdout/stderr 各自截断 1MB；
 * - isolated exec：docker exec 无法按次切网络，v1 用一次性容器承载（同镜像/同家目录 bind、
 *   NetworkMode 'none'），结束即删；
 * - 空闲停机：后台 30s 扫描（unref 不阻退出），lastActiveAt 超过 idleStopMs 且 running 的
 *   工作区 container.stop()（保留容器，status=stopped；下次 exec 自动 start）。
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Readable } from 'node:stream';

import { err, HarnessError } from '../errors/index.js';
import type {
  DockerClient,
  DockerContainerInstance,
  DockerCreateContainerOptions,
  DockerExecInspect,
  SandboxExecResult,
  SandboxNetworkMode,
  WorkspaceInfo,
} from './types.js';

// ---------------------------------------------------------------------------
// 常量（默认值导出便于配置对齐与测试注入）
// ---------------------------------------------------------------------------

/** 默认最大工作区数 */
export const DEFAULT_MAX_WORKSPACES = 8;
/** 默认空闲停机阈值：30 分钟 */
export const DEFAULT_IDLE_STOP_MS = 30 * 60 * 1000;
/** 默认 exec 超时：60s */
export const DEFAULT_EXEC_TIMEOUT_MS = 60_000;
/** 空闲扫描周期：30s（unref，不阻进程退出；可调 sweepIdleWorkspaces() 手动触发） */
export const IDLE_SWEEP_INTERVAL_MS = 30_000;
/** stdout/stderr 各自的截断阈值（字节）：1MB */
export const SANDBOX_MAX_STREAM_BYTES = 1024 * 1024;
/** 容器内工作目录（家目录 bind 点） */
export const SANDBOX_WORKDIR = '/home/dev';
/** 单文件 relPath / workdir 的长度上限 */
const MAX_PATH_LENGTH = 1024;
/** 工作区 id 形态约束（同时是家目录名，必须能防目录穿越） */
const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

// ---------------------------------------------------------------------------
// docker exec 多路复用流解帧
// ---------------------------------------------------------------------------
// docker exec（非 Tty）的输出是单条流内嵌多路复用帧：
//   [1B streamType][3B 保留 0][4B payload 长度（大端 uint32）][payload]
// streamType：1=stdout，2=stderr（0=容器 stdin 方向，本模块忽略）。

/** 解帧结果（stdout/stderr 均按 UTF-8 解码，各自封顶 SANDBOX_MAX_STREAM_BYTES） */
export interface ParsedDockerStream {
  stdout: string;
  stderr: string;
}

/**
 * 纯函数：一次性解帧完整缓冲区（便于单测；流式增量场景用 {@link DockerStreamDemuxer}）。
 * 头部残缺 / 半帧（长度声明大于实际字节数）的尾部数据静默丢弃。
 */
export function parseDockerStream(input: Buffer): ParsedDockerStream {
  const demuxer = new DockerStreamDemuxer();
  demuxer.push(input);
  return demuxer.finish();
}

/** 增量解帧器：跨 chunk 缓存半帧，按帧协议切分并分拣 stdout/stderr */
export class DockerStreamDemuxer {
  #pending: Buffer = Buffer.alloc(0);
  readonly #stdout: Buffer[] = [];
  readonly #stderr: Buffer[] = [];
  #stdoutBytes = 0;
  #stderrBytes = 0;

  /** 追加一块原始流数据（可分多次调用，半帧自动续接） */
  push(chunk: Buffer): void {
    this.#pending = this.#pending.length === 0 ? chunk : Buffer.concat([this.#pending, chunk]);
    for (;;) {
      if (this.#pending.length < 8) return; // 头部不完整，等待后续 chunk
      const type = this.#pending[0] as number;
      const payloadLen = this.#pending.readUInt32BE(4);
      if (this.#pending.length < 8 + payloadLen) return; // 半帧，等待后续 chunk
      const payload = this.#pending.subarray(8, 8 + payloadLen);
      if (type === 1) this.#sink('stdout', payload);
      else if (type === 2) this.#sink('stderr', payload);
      // type 0（stdin 方向）与其他未知类型：忽略
      this.#pending = this.#pending.subarray(8 + payloadLen);
    }
  }

  /** 结束收集：按序拼接并解码（此后不再 push） */
  finish(): ParsedDockerStream {
    return {
      stdout: Buffer.concat(this.#stdout).toString('utf8'),
      stderr: Buffer.concat(this.#stderr).toString('utf8'),
    };
  }

  /** 落入对应通道并执行 1MB 截断（超限静默丢弃，防恶意/失控输出撑爆内存） */
  #sink(channel: 'stdout' | 'stderr', payload: Buffer): void {
    const bytes = channel === 'stdout' ? this.#stdoutBytes : this.#stderrBytes;
    const room = SANDBOX_MAX_STREAM_BYTES - bytes;
    if (room <= 0) return;
    const take = payload.length > room ? payload.subarray(0, room) : payload;
    (channel === 'stdout' ? this.#stdout : this.#stderr).push(Buffer.from(take)); // copy：脱离 #pending 底层大缓冲
    if (channel === 'stdout') this.#stdoutBytes += take.length;
    else this.#stderrBytes += take.length;
  }
}

// ---------------------------------------------------------------------------
// SandboxManager
// ---------------------------------------------------------------------------

/** SandboxManager 依赖集合 */
export interface SandboxManagerDeps {
  /**
   * 内核配置（与 HarnessConfig 结构兼容的收窄视图）。
   * taskWorkers 预留：未来并发 exec 池容量，v1 未使用。
   */
  config: { dataDir: string; sandboxEnabled: boolean; sandboxImage: string; taskWorkers?: number };
  /** Docker 客户端（docker.ts createDockerClient 产物；null = Docker 不可用 → disabled） */
  client: DockerClient | null;
  /** 内核 pino logger */
  logger: import('pino').Logger;
  /** 最大工作区数（默认 {@link DEFAULT_MAX_WORKSPACES}） */
  maxWorkspaces?: number;
  /** 空闲停机阈值毫秒（默认 {@link DEFAULT_IDLE_STOP_MS}） */
  idleStopMs?: number;
  /** 默认 exec 超时毫秒（默认 {@link DEFAULT_EXEC_TIMEOUT_MS}；exec.opts.timeoutMs 可覆盖） */
  execTimeoutMs?: number;
}

/** createWorkspace 入参 */
export interface SandboxCreateWorkspaceInput {
  /** 工作区 id；缺省 uuid。形态受限（^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$，防目录穿越） */
  id?: string;
  /** 镜像；缺省 config.sandboxImage */
  image?: string;
  /**
   * 容器网络模式：'bridge'（缺省，默认网桥可出网）| 'none'（无网络）。
   * 调用方（扩展网关）按 manifest 的 net:out* 权限推导传入；isolated 一次性执行
   * 不受此参数影响，恒为 'none'。
   */
  networkMode?: SandboxNetworkMode;
}

/** exec 入参（第二参 cmd 之外的可选项） */
export interface SandboxExecOptions {
  /** 本次执行超时毫秒；缺省 deps.execTimeoutMs */
  timeoutMs?: number;
  /** 容器内工作目录；缺省 /home/dev */
  workdir?: string;
  /** 额外环境变量（以 ENV=k 逐项注入 exec） */
  env?: Record<string, string>;
  /**
   * 网络隔离：true 时用一次性容器承载本次执行（同镜像、同家目录 bind、NetworkMode 'none'，
   * 结束即删）——docker exec 无法按次切换网络，v1 以独立容器实现。
   */
  isolated?: boolean;
}

/**
 * Docker 工作区沙箱编排器：create/remove/get/list/exec/writeFile/readFile/listFiles
 * + start/stop 生命周期（空闲扫描定时器 + 重启恢复扫描）。
 *
 * get()/list() 返回登记记录的浅拷贝（外部改动不影响内部状态）；所有写操作都会刷新
 * lastActiveAt（空闲停机的活跃信号）。
 */
export class SandboxManager {
  readonly #deps: SandboxManagerDeps;
  readonly #maxWorkspaces: number;
  readonly #idleStopMs: number;
  readonly #execTimeoutMs: number;
  /** 内存登记表：workspaceId → 记录（家目录即事实，重启后按目录恢复） */
  readonly #workspaces = new Map<string, WorkspaceInfo>();
  /** workspaceId → 容器句柄缓存（恢复记录无句柄，用时经 client.getContainer 现取） */
  readonly #containers = new Map<string, DockerContainerInstance>();
  #timer: NodeJS.Timeout | null = null;
  #started = false;
  #sweeping = false;
  #warnedNoDocker = false;

  constructor(deps: SandboxManagerDeps) {
    this.#deps = deps;
    this.#maxWorkspaces = deps.maxWorkspaces ?? DEFAULT_MAX_WORKSPACES;
    this.#idleStopMs = deps.idleStopMs ?? DEFAULT_IDLE_STOP_MS;
    this.#execTimeoutMs = deps.execTimeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
  }

  // -------------------------------------------------------------------------
  // 生命周期
  // -------------------------------------------------------------------------

  /**
   * 启动：恢复扫描（家目录即事实）→ 起 30s 空闲扫描定时器（unref）。
   * 无 Docker（client null 或配置禁用）时仅 warn 一次，不抛（优雅降级）。幂等。
   */
  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    this.#recoverWorkspaces();
    const client = this.#deps.client;
    if (client === null || !this.#deps.config.sandboxEnabled) {
      if (!this.#warnedNoDocker) {
        this.#warnedNoDocker = true;
        this.#deps.logger.warn(
          {
            dockerClientAvailable: client !== null,
            sandboxEnabled: this.#deps.config.sandboxEnabled,
          },
          '[sandbox] docker client unavailable or sandbox disabled — running degraded (operations will fail with SANDBOX_DISABLED)',
        );
      }
      return;
    }
    this.#timer = setInterval(() => {
      void this.#sweepSafely();
    }, IDLE_SWEEP_INTERVAL_MS);
    this.#timer.unref();
    this.#deps.logger.info(
      { idleStopMs: this.#idleStopMs, maxWorkspaces: this.#maxWorkspaces, execTimeoutMs: this.#execTimeoutMs },
      '[sandbox] sandbox manager started',
    );
  }

  /** 停止：清理空闲扫描定时器（容器与家目录保留，重启后按目录恢复）。幂等。 */
  async stop(): Promise<void> {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    this.#started = false;
    // 销毁 docker 客户端连接池：keep-alive socket 会持有事件循环，
    // 阻断优雅停机后进程自然退出（根因见 ARCHITECTURE.md 关停时序）
    this.#deps.client?.destroy?.();
  }

  /** 沙箱是否可用：配置启用 且 Docker 客户端可注入。false 时一切操作抛 SANDBOX_DISABLED */
  enabled(): boolean {
    return this.#deps.config.sandboxEnabled && this.#deps.client !== null;
  }

  // -------------------------------------------------------------------------
  // 工作区生命周期
  // -------------------------------------------------------------------------

  /**
   * 创建工作区：家目录 mkdir → 加固容器创建并启动 → 登记 running。
   *
   * @throws SANDBOX_DISABLED 未启用；BAD_REQUEST id 非法；
   *         SANDBOX_ERROR 已存在 / 超出 maxWorkspaces / Docker 创建或启动失败
   */
  async createWorkspace(input: SandboxCreateWorkspaceInput = {}): Promise<WorkspaceInfo> {
    const client = this.#requireEnabled();
    const id = input.id ?? randomUUID();
    if (!WORKSPACE_ID_PATTERN.test(id)) {
      throw err('BAD_REQUEST', {
        message: `workspace id "${id}" is invalid — must match ^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$ (it doubles as the home directory name)`,
        detail: { id },
      });
    }
    if (this.#workspaces.has(id)) {
      throw err('SANDBOX_ERROR', { message: `workspace "${id}" already exists`, detail: { id } });
    }
    if (input.networkMode !== undefined && input.networkMode !== 'bridge' && input.networkMode !== 'none') {
      // 运行时校验兜底（类型面之外的调用方）：非法值绝不透传给 Docker
      throw err('BAD_REQUEST', {
        message: `networkMode must be "bridge" or "none" (got ${JSON.stringify(input.networkMode)})`,
        detail: { networkMode: input.networkMode },
      });
    }
    if (this.#workspaces.size >= this.#maxWorkspaces) {
      throw err('SANDBOX_ERROR', {
        message: `workspace limit reached (${this.#maxWorkspaces}) — remove an existing workspace first`,
        detail: { max: this.#maxWorkspaces },
      });
    }
    const image = input.image ?? this.#deps.config.sandboxImage;
    const networkMode: SandboxNetworkMode = input.networkMode ?? 'bridge';
    const homeDir = join(this.#deps.config.dataDir, 'sandbox', id);
    const now = Date.now();
    const ws: WorkspaceInfo = {
      id,
      containerId: null,
      image,
      networkMode,
      status: 'creating',
      homeDir,
      createdAt: now,
      lastActiveAt: now,
    };
    this.#workspaces.set(id, ws); // 先登记：并发同 id 创建在此被拦截；失败落 error 可 remove 清理
    try {
      mkdirSync(homeDir, { recursive: true });
      const container = await client.createContainer(
        this.#containerSpec({
          image,
          labels: { 'opptrix.workspace': id },
          binds: [`${homeDir}:${SANDBOX_WORKDIR}`],
          networkMode,
        }),
      );
      await container.start();
      ws.containerId = container.id;
      ws.status = 'running';
      this.#containers.set(id, container);
    } catch (e) {
      ws.status = 'error';
      if (e instanceof HarnessError) throw e;
      throw err('SANDBOX_ERROR', {
        message: `create workspace "${id}" failed: ${e instanceof Error ? e.message : String(e)} — check the image exists and the docker daemon is reachable`,
        cause: e,
      });
    }
    return { ...ws };
  }

  /**
   * 删除工作区：容器 remove（force 可跳过移除失败）→ 家目录 rm → 登记表移除。
   * @returns true=已删除；工作区不存在返回 false（幂等）
   * @throws SANDBOX_DISABLED 未启用；SANDBOX_ERROR 容器移除失败（未 force）
   */
  async removeWorkspace(id: string, opts: { force?: boolean } = {}): Promise<boolean> {
    const client = this.#requireEnabled();
    const ws = this.#workspaces.get(id);
    if (ws === undefined) return false;
    let container: DockerContainerInstance | undefined = this.#containers.get(id);
    if (container === undefined && ws.containerId !== null) {
      try {
        container = client.getContainer(ws.containerId);
      } catch {
        container = undefined; // 句柄构造失败（stub 严格模式）：按无容器处理，仅清目录
      }
    }
    if (container !== undefined) {
      try {
        await container.remove({ force: opts.force === true });
      } catch (e) {
        if (opts.force !== true) {
          throw err('SANDBOX_ERROR', {
            message: `remove container for workspace "${id}" failed — retry with force to drop the record anyway`,
            cause: e,
          });
        }
        this.#deps.logger.warn({ err: e, workspaceId: id }, '[sandbox] forced container removal failed, dropping record anyway');
      }
    }
    this.#containers.delete(id);
    this.#workspaces.delete(id);
    rmSync(ws.homeDir, { recursive: true, force: true });
    this.#deps.logger.info({ workspaceId: id }, '[sandbox] workspace removed');
    return true;
  }

  /** 按 id 读取登记记录（浅拷贝）；不存在返回 null。未启用抛 SANDBOX_DISABLED */
  get(id: string): WorkspaceInfo | null {
    this.#requireEnabled();
    const ws = this.#workspaces.get(id);
    return ws === undefined ? null : { ...ws };
  }

  /** 列出全部登记记录（浅拷贝，按 createdAt 升序）。未启用抛 SANDBOX_DISABLED */
  list(): WorkspaceInfo[] {
    this.#requireEnabled();
    return [...this.#workspaces.values()].sort((a, b) => a.createdAt - b.createdAt).map((ws) => ({ ...ws }));
  }

  // -------------------------------------------------------------------------
  // exec 与文件
  // -------------------------------------------------------------------------

  /**
   * 在工作区内执行命令。stopped 工作区自动 start（空闲停机后的透明恢复）。
   * 超时：kill 容器终结进程树并返回 timedOut=true 的部分结果（不抛）。
   *
   * @throws SANDBOX_DISABLED 未启用；BAD_REQUEST cmd/timeoutMs 非法；
   *         SANDBOX_NOT_FOUND 工作区不存在；SANDBOX_ERROR 容器缺失/不可运行/inspect 失败
   */
  async exec(id: string, cmd: string[], opts: SandboxExecOptions = {}): Promise<SandboxExecResult> {
    const client = this.#requireEnabled();
    if (!Array.isArray(cmd) || cmd.length === 0 || cmd.some((c) => typeof c !== 'string')) {
      throw err('BAD_REQUEST', { message: 'exec cmd must be a non-empty array of strings', detail: { cmd } });
    }
    const timeoutMs = opts.timeoutMs ?? this.#execTimeoutMs;
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      throw err('BAD_REQUEST', {
        message: `exec timeoutMs must be a positive integer (got ${String(opts.timeoutMs)})`,
        detail: { timeoutMs: opts.timeoutMs },
      });
    }
    const ws = this.#requireWorkspace(id);
    if (ws.containerId === null) {
      throw err('SANDBOX_ERROR', {
        message: `workspace "${id}" has no container (restored from disk after restart) — create a new workspace to run commands`,
        detail: { id },
      });
    }
    if (ws.status === 'creating' || ws.status === 'error') {
      throw err('SANDBOX_ERROR', {
        message: `workspace "${id}" is not runnable (status: ${ws.status})`,
        detail: { id, status: ws.status },
      });
    }
    ws.lastActiveAt = Date.now();
    const run = { timeoutMs, workdir: opts.workdir, env: opts.env };
    // isolated：一次性容器承载（NetworkMode 'none'，结束即删）；主容器无需先行恢复
    if (opts.isolated === true) {
      const ephemeral = await client.createContainer(
        this.#containerSpec({
          image: ws.image,
          labels: { 'opptrix.workspace': id, 'opptrix.ephemeral': 'true' },
          binds: [`${ws.homeDir}:${SANDBOX_WORKDIR}`],
          networkMode: 'none',
        }),
      );
      try {
        await ephemeral.start();
        return await this.#runExec(ephemeral, id, cmd, run);
      } finally {
        try {
          await ephemeral.remove({ force: true });
        } catch (e) {
          this.#deps.logger.warn({ err: e, workspaceId: id }, '[sandbox] ephemeral container cleanup failed');
        }
      }
    }
    const container = this.#containers.get(id) ?? client.getContainer(ws.containerId);
    if (ws.status === 'stopped') {
      try {
        await container.start();
        ws.status = 'running';
      } catch (e) {
        throw err('SANDBOX_ERROR', { message: `restart stopped workspace "${id}" failed`, cause: e });
      }
    }
    return this.#runExec(container, id, cmd, run);
  }

  /**
   * 写文件（base64 内容）：exec `sh -c "mkdir -p <dir> && printf '%s' <b64> | base64 -d > <path>"`
   * 实现（路径经校验拒绝穿越 + 单引号转义防注入）。
   *
   * @throws SANDBOX_DISABLED / BAD_REQUEST（relPath 或 base64 非法）/ SANDBOX_NOT_FOUND（工作区不存在）
   *         / SANDBOX_ERROR（写入命令非零退出）
   */
  async writeFile(id: string, relPath: string, contentBase64: string): Promise<void> {
    const p = normalizeRelPath(relPath, 'relPath');
    const compact = contentBase64.replace(/\s+/g, '');
    if (compact.length === 0 || compact.length % 4 !== 0 || /^[A-Za-z0-9+/]+={0,2}$/.test(compact) === false) {
      throw err('BAD_REQUEST', { message: 'contentBase64 must be non-empty valid base64', detail: { length: compact.length } });
    }
    const { dir } = splitRelPath(p);
    // 目录段缺省（直接写家目录根）时无需 mkdir，减少一次进程创建
    const mkdirPart = dir === '.' ? '' : `mkdir -p ${shellQuote(dir)} && `;
    const script = `${mkdirPart}printf '%s' ${shellQuote(compact)} | base64 -d > ${shellQuote(p)}`;
    const result = await this.exec(id, ['sh', '-c', script]);
    if (result.exitCode !== 0) {
      throw err('SANDBOX_ERROR', {
        message: `write file "${relPath}" failed (exit ${result.exitCode}): ${result.stderr.slice(0, 200)}`,
        detail: { relPath, exitCode: result.exitCode },
      });
    }
  }

  /**
   * 读文件（返回 base64）：exec `base64 <path>`，去除输出中的换行回车。
   * @throws SANDBOX_NOT_FOUND 文件不存在；其余同 {@link writeFile}
   */
  async readFile(id: string, relPath: string): Promise<string> {
    const p = normalizeRelPath(relPath, 'relPath');
    const result = await this.exec(id, ['sh', '-c', `base64 ${shellQuote(p)}`]);
    if (result.exitCode !== 0) {
      if (/no such|not found/i.test(result.stderr)) {
        throw err('SANDBOX_NOT_FOUND', { message: `file not found in workspace: "${relPath}"`, detail: { relPath } });
      }
      throw err('SANDBOX_ERROR', {
        message: `read file "${relPath}" failed (exit ${result.exitCode}): ${result.stderr.slice(0, 200)}`,
        detail: { relPath, exitCode: result.exitCode },
      });
    }
    return result.stdout.replace(/\s+/g, '');
  }

  /**
   * 列出家目录（或 relPath 子目录）一级内容：exec 一段 POSIX sh 循环输出
   * `f <size> <name>` / `d 0 <name>` 行，管理器解析为结构化列表（T1：后续可换 tar/du 方案）。
   *
   * @throws SANDBOX_DISABLED / SANDBOX_NOT_FOUND（工作区不存在或目录不存在）/ BAD_REQUEST（relPath 非法）
   */
  async listFiles(id: string, relPath?: string): Promise<Array<{ name: string; size: number; dir: boolean }>> {
    const dir = relPath === undefined ? '.' : normalizeRelPath(relPath, 'relPath');
    // busybox/alpine 兼容：不用 find -printf / stat -c，纯 sh + wc -c 实现
    const script =
      `cd ${shellQuote(dir)} || exit 1; ` +
      'for f in * .*; do ' +
      'case "$f" in .|..) continue;; esac; ' +
      '[ -e "$f" ] || continue; ' +
      'if [ -d "$f" ]; then echo "d 0 $f"; else echo "f $(wc -c < "$f") $f"; fi; ' +
      'done';
    const result = await this.exec(id, ['sh', '-c', script]);
    if (result.exitCode !== 0) {
      throw err('SANDBOX_ERROR', {
        message: `list files under "${dir}" failed (exit ${result.exitCode}): ${result.stderr.slice(0, 200)}`,
        detail: { relPath: dir, exitCode: result.exitCode },
      });
    }
    const entries: Array<{ name: string; size: number; dir: boolean }> = [];
    for (const line of result.stdout.split('\n')) {
      const m = /^([df]) (\d+) (.+)$/.exec(line);
      if (m === null) continue; // 防御：跳过畸形行（含名字带换行的极端文件名，v1 不支持）
      entries.push({ name: m[3] as string, size: Number(m[2]), dir: m[1] === 'd' });
    }
    return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /**
   * 空闲停机扫描（公开方法，后台定时器每 30s 自动调用，也可手动触发/测试注入）：
   * running 且 now - lastActiveAt ≥ idleStopMs 的工作区 container.stop()——保留容器，
   * status 转 stopped，下次 exec 自动 start。
   * @returns 本次停机的工作区数
   */
  async sweepIdleWorkspaces(): Promise<number> {
    const now = Date.now();
    let stopped = 0;
    for (const ws of this.#workspaces.values()) {
      if (ws.status !== 'running') continue;
      if (now - ws.lastActiveAt < this.#idleStopMs) continue;
      const container = this.#containers.get(ws.id);
      if (container !== undefined) {
        try {
          await container.stop({ t: 5 }); // 优雅停机宽限 5s
        } catch (e) {
          this.#deps.logger.warn({ err: e, workspaceId: ws.id }, '[sandbox] idle stop failed, keeping workspace running');
          continue;
        }
      }
      ws.status = 'stopped';
      stopped += 1;
      this.#deps.logger.info({ workspaceId: ws.id, idleStopMs: this.#idleStopMs }, '[sandbox] idle workspace stopped (container kept for reuse)');
    }
    return stopped;
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  /** enabled 门禁：未启用抛 SANDBOX_DISABLED，启用则返回收窄后的客户端 */
  #requireEnabled(): DockerClient {
    const client = this.#deps.client;
    if (!this.#deps.config.sandboxEnabled || client === null) {
      throw err('SANDBOX_DISABLED', {
        detail: { sandboxEnabled: this.#deps.config.sandboxEnabled, dockerClientAvailable: client !== null },
      });
    }
    return client;
  }

  /** 工作区存在性门禁 */
  #requireWorkspace(id: string): WorkspaceInfo {
    const ws = this.#workspaces.get(id);
    if (ws === undefined) {
      throw err('SANDBOX_NOT_FOUND', { message: `sandbox workspace "${id}" not found`, detail: { id } });
    }
    return ws;
  }

  /** `<dataDir>/sandbox` 根目录 */
  #sandboxRoot(): string {
    return join(this.#deps.config.dataDir, 'sandbox');
  }

  /** 重启恢复：扫描 `<dataDir>/sandbox/` 下的合法 id 目录，登记为 stopped 记录（containerId=null） */
  #recoverWorkspaces(): void {
    let entries: string[];
    try {
      entries = readdirSync(this.#sandboxRoot());
    } catch {
      return; // 目录不存在：无历史
    }
    for (const name of entries) {
      if (this.#workspaces.has(name) || !WORKSPACE_ID_PATTERN.test(name)) continue;
      const homeDir = join(this.#sandboxRoot(), name);
      let mtimeMs: number;
      try {
        mtimeMs = statSync(homeDir).mtimeMs;
      } catch {
        continue;
      }
      // 镜像/网络模式无法从目录还原，用当前配置镜像与 'bridge' 占位（重建由用户 create 承接，仅作列表展示）
      this.#workspaces.set(name, {
        id: name,
        containerId: null,
        image: this.#deps.config.sandboxImage,
        networkMode: 'bridge',
        status: 'stopped',
        homeDir,
        createdAt: mtimeMs,
        lastActiveAt: mtimeMs,
      });
    }
  }

  /** 统一的容器创建规格（主容器与 isolated 一次性容器共用同一套加固基线） */
  #containerSpec(input: {
    image: string;
    labels: Record<string, string>;
    binds: string[];
    networkMode: SandboxNetworkMode;
    cmd?: string[];
  }): DockerCreateContainerOptions {
    return {
      Image: input.image,
      Cmd: input.cmd ?? ['sleep', 'infinity'],
      User: '1000:1000',
      WorkingDir: SANDBOX_WORKDIR,
      Labels: input.labels,
      HostConfig: {
        Binds: input.binds,
        Memory: 512 * 1024 * 1024,
        NanoCpus: 1_000_000_000,
        PidsLimit: 128,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
        // ReadonlyRootfs=false：家目录经 bind 持久化；容器系统层可写但随容器重建丢失（v1 取舍）
        ReadonlyRootfs: false,
        NetworkMode: input.networkMode,
      },
    };
  }

  /**
   * exec 核心执行：container.exec 创建 → hijack 流收集（增量解帧）→ 超时 kill →
   * inspectExec 取退出码 → SandboxExecResult。
   */
  async #runExec(
    container: DockerContainerInstance,
    workspaceId: string,
    cmd: string[],
    run: { timeoutMs: number; workdir?: string; env?: Record<string, string> },
  ): Promise<SandboxExecResult> {
    const startedAt = Date.now();
    const exec = await container.exec({
      Cmd: cmd,
      WorkingDir: run.workdir ?? SANDBOX_WORKDIR,
      Env: Object.entries(run.env ?? {}).map(([key, value]) => `${key}=${value}`),
      User: '1000:1000',
      AttachStdout: true,
      AttachStderr: true,
    });
    let stream: Readable;
    try {
      stream = await exec.start({ hijack: true, stdin: false });
    } catch (e) {
      throw err('SANDBOX_ERROR', { message: `exec start failed in workspace "${workspaceId}"`, cause: e });
    }
    const demuxer = new DockerStreamDemuxer();
    let timedOut = false;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        timedOut = true;
        // docker exec 无独立停止通道：kill 容器终结整棵进程树（波及同工作区其他进程，v1 权衡）
        void container.kill().catch((e: unknown) => {
          this.#deps.logger.warn({ err: e, workspaceId }, '[sandbox] kill on exec timeout failed');
        });
        finish();
      }, run.timeoutMs);
      timer.unref();
      stream.on('data', (chunk: Buffer) => demuxer.push(chunk));
      stream.on('error', (e: Error) => {
        this.#deps.logger.warn({ err: e, workspaceId }, '[sandbox] exec stream error');
        finish();
      });
      stream.on('end', finish);
      stream.on('close', finish);
    });
    if (timedOut) {
      stream.destroy?.(); // 尽力丢弃残余流（部分 stub 可能未实现 destroy）
    }
    let exitCode: number;
    if (timedOut) {
      exitCode = -1; // 被 kill 的 exec 无法可靠取回退出码，固定 -1（timedOut=true 标识）
    } else {
      let info: DockerExecInspect;
      try {
        info = await container.inspectExec(exec.id);
      } catch (e) {
        throw err('SANDBOX_ERROR', { message: `inspect exec failed in workspace "${workspaceId}"`, cause: e });
      }
      exitCode = typeof info.ExitCode === 'number' ? info.ExitCode : 0;
    }
    return { exitCode, ...demuxer.finish(), timedOut, durationMs: Date.now() - startedAt };
  }

  /** 定时扫描入口：防重入 + 异常隔离（interval 回调不允许抛） */
  #sweepSafely(): void {
    if (this.#sweeping) return;
    this.#sweeping = true;
    this.sweepIdleWorkspaces()
      .catch((e: unknown) => {
        this.#deps.logger.error({ err: e }, '[sandbox] idle sweep failed');
      })
      .finally(() => {
        this.#sweeping = false;
      });
  }
}

// ---------------------------------------------------------------------------
// 路径与 shell 辅助
// ---------------------------------------------------------------------------

/**
 * relPath 校验与规整：拒绝绝对路径 / ".." 段（目录穿越）/ NUL；容忍 "./"、
 * 重复与结尾的 "/"。返回相对 /home/dev 的规整路径（空等价 "."）。
 * @throws BAD_REQUEST
 */
function normalizeRelPath(input: string, kind: string): string {
  if (typeof input !== 'string' || input.length === 0 || input.length > MAX_PATH_LENGTH) {
    throw err('BAD_REQUEST', {
      message: `${kind} must be a non-empty string of at most ${MAX_PATH_LENGTH} chars (got ${input.length})`,
      detail: { kind },
    });
  }
  if (input.includes('\0')) {
    throw err('BAD_REQUEST', { message: `${kind} contains a NUL byte`, detail: { kind } });
  }
  if (input.startsWith('/')) {
    throw err('BAD_REQUEST', {
      message: `${kind} must be relative to /home/dev, got absolute path "${input}"`,
      detail: { kind },
    });
  }
  const segments = input.split('/');
  if (segments.some((s) => s === '..')) {
    throw err('BAD_REQUEST', {
      message: `${kind} must not contain ".." segments (path traversal is rejected): "${input}"`,
      detail: { kind },
    });
  }
  const cleaned = segments.filter((s) => s !== '' && s !== '.').join('/');
  return cleaned === '' ? '.' : cleaned;
}

/** 拆出目录段与文件名（"a.txt" → dir "."） */
function splitRelPath(p: string): { dir: string; name: string } {
  const idx = p.lastIndexOf('/');
  if (idx === -1) return { dir: '.', name: p };
  return { dir: p.slice(0, idx) || '.', name: p.slice(idx + 1) };
}

/** POSIX 单引号转义（防 shell 注入；base64 与校验过的路径都不含引号，防御性兜底） */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
