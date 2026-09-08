/**
 * sandbox — dockerode 适配器：构造真实 {@link DockerClient}（可注入的最小 duck-type 面）。
 *
 * - `createDockerClient()`：解析 dockerHost（unix://、npipe://、tcp/http/https/ssh://，
 *   空串回落 DOCKER_HOST 环境变量）→ new Dockerode(options)。任何解析/构造失败都返回
 *   null（优雅降级：调用方按 sandbox disabled 处理，启动期不抛）。
 * - 包一层薄适配把 dockerode 的宽接口收窄为 types.ts 的 duck-type 面，
 *   使 SandboxManager 与测试完全不感知 dockerode 类型。
 */
import Dockerode from 'dockerode';
import type { Readable } from 'node:stream';

import type {
  DockerClient,
  DockerContainerInstance,
  DockerCreateContainerOptions,
  DockerExecCreateOptions,
  DockerExecStartOptions,
  DockerListContainersOptions,
} from './types.js';

/** DOCKER_HOST 解析结果（dockerode 构造参数的收窄面） */
interface ParsedDockerHost {
  socketPath?: string;
  host?: string;
  port?: number;
  protocol?: 'http' | 'https' | 'ssh';
}

/**
 * 解析 DOCKER_HOST 形态为 dockerode 构造参数。
 * - ''            → 回落 DOCKER_HOST 环境变量；也为空则交给 docker-modem 默认（本地 socket）
 * - unix:///path  → { socketPath }
 * - npipe://name  → { socketPath }（Windows 命名管道；跨平台兼容写法）
 * - tcp|http://host[:port] → { host, port?, protocol: 'http' }
 * - https|ssh://  → 同上，默认端口 2376 / 22
 * 无法识别的形态抛错（由 createDockerClient 兜底为 null）。
 */
export function parseDockerHost(raw: string): ParsedDockerHost {
  const value = raw.trim();
  if (value === '') {
    const env = (process.env.DOCKER_HOST ?? '').trim();
    return env === '' ? {} : parseDockerHost(env);
  }
  if (value.startsWith('unix://')) {
    return { socketPath: value.slice('unix://'.length) };
  }
  if (value.startsWith('npipe://')) {
    return { socketPath: value.slice('npipe://'.length) };
  }
  if (/^(tcp|http|https|ssh):\/\//.test(value)) {
    const url = new URL(value);
    const proto = url.protocol.replace(':', '') as 'tcp' | 'http' | 'https' | 'ssh';
    const protocol = proto === 'tcp' ? 'http' : proto;
    const defaultPort = protocol === 'https' ? 2376 : protocol === 'ssh' ? 22 : 2375;
    const port = url.port !== '' ? Number(url.port) : defaultPort;
    return { host: url.hostname, port, protocol };
  }
  throw new Error(`unsupported DOCKER_HOST "${raw}" — use unix:///path/to/docker.sock or (tcp|http|https|ssh)://host[:port]`);
}

/**
 * 构造真实 DockerClient。
 * @returns 可用的客户端；dockerode 不可用 / dockerHost 非法导致构造失败时返回 null
 *          （调用方按 disabled 优雅降级，start() 期 warn 一次，不抛）。
 */
export function createDockerClient(cfg: { dockerHost: string }): DockerClient | null {
  try {
    const options = parseDockerHost(cfg.dockerHost);
    const inner = new Dockerode(options);
    return wrapDockerode(inner);
  } catch {
    // 解析失败 / 构造异常 → 优雅降级（无日志依赖，由 SandboxManager.start() 统一 warn）
    return null;
  }
}

// ---------------------------------------------------------------------------
// dockerode → duck-type 适配
// ---------------------------------------------------------------------------

function wrapDockerode(inner: Dockerode): DockerClient {
  return {
    // 关闭 keep-alive socket：不销毁会持有事件循环，阻止进程在优雅停机后自然退出
    destroy() {
      try {
        (inner as unknown as { modem?: { destroy?: () => void } }).modem?.destroy?.();
      } catch {
        /* 已关闭则忽略 */
      }
    },
    async createContainer(opts: DockerCreateContainerOptions) {
      const container = await inner.createContainer(opts as Dockerode.ContainerCreateOptions);
      return wrapContainer(inner, container);
    },
    getContainer(id: string): DockerContainerInstance {
      return wrapContainer(inner, inner.getContainer(id));
    },
    async listContainers(opts?: DockerListContainersOptions) {
      const list = await inner.listContainers({ all: true, ...opts });
      return list.map((info) => ({ Id: info.Id, Names: info.Names, State: info.State }));
    },
  };
}

function wrapContainer(inner: Dockerode, container: Dockerode.Container): DockerContainerInstance {
  return {
    id: container.id,
    start: async () => {
      await container.start();
    },
    stop: async (opts?: { t?: number }) => {
      await container.stop(opts);
    },
    kill: async () => {
      await container.kill();
    },
    remove: async (opts?: { force?: boolean }) => {
      await container.remove(opts);
    },
    inspect: async () => {
      const info = await container.inspect();
      return { State: { Running: info.State?.Running === true } };
    },
    exec: async (opts: DockerExecCreateOptions) => {
      const exec = await container.exec(opts as Dockerode.ExecCreateOptions);
      return {
        id: exec.id,
        start: async (startOpts?: DockerExecStartOptions): Promise<Readable> => {
          // exec 输出恒走 hijack 单流（多路复用帧），由 manager 的 parseDockerStream 解帧
          return (await exec.start({ hijack: true, stdin: false, ...startOpts })) as Readable;
        },
      };
    },
    inspectExec: async (execId: string) => {
      const info = await inner.getExec(execId).inspect();
      // dockerode 的 ExitCode 类型为 number | null：归一为 undefined（duck-type 收窄面）
      return { ExitCode: info.ExitCode ?? undefined, Running: info.Running };
    },
  };
}
