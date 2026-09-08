/**
 * sandbox — Docker 工作区沙箱类型定义。
 *
 * {@link DockerClient} 是 dockerode 实例的最小 duck-type 面（真实适配见 docker.ts）：
 * 刻意收窄到 SandboxManager 实际用到的子集，测试注入内存 stub、不打真实 Docker。
 */
import type { Readable } from 'node:stream';

/** 工作区登记记录：一个容器 + 一个持久化家目录 */
export interface WorkspaceInfo {
  /** 工作区 id（缺省 uuid）；同时是 `<dataDir>/sandbox/` 下的家目录名，故形态受限 */
  id: string;
  /** Docker 容器 id；重启后由恢复扫描还原的记录为 null（容器需用户重建） */
  containerId: string | null;
  /** 容器镜像 */
  image: string;
  /**
   * 生命周期状态：
   * - creating：createWorkspace 过程中的瞬时态（成功即 running，失败落 error）
   * - running：容器运行中
   * - stopped：空闲停机（容器保留，下次 exec 自动 start）或重启后恢复的记录
   * - error：创建失败（家目录保留，可 removeWorkspace 清理）
   */
  status: 'creating' | 'running' | 'stopped' | 'error';
  /** 持久化家目录（宿主绝对路径，bind 到容器 /home/dev；家目录即事实来源） */
  homeDir: string;
  /** 创建时间（epoch ms，UTC） */
  createdAt: number;
  /** 最近活跃时间（epoch ms）；超过 idleStopMs 未活跃由后台扫描停机（保留容器） */
  lastActiveAt: number;
}

/** exec 执行结果；超时不抛错，以 timedOut=true 返回已收集的部分输出 */
export interface SandboxExecResult {
  /** 退出码；exec 超时被 kill 后无法可靠取回，固定 -1 */
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// DockerClient duck-type（最小面）
// ---------------------------------------------------------------------------

/** exec.start 的启动参数（收窄面；hijack/stdin 由 docker-modem 使用） */
export interface DockerExecStartOptions {
  hijack?: boolean;
  stdin?: boolean;
  Detach?: boolean;
  Tty?: boolean;
}

/** container.exec() 创建出的执行实例 */
export interface DockerExecInstance {
  readonly id: string;
  /**
   * 启动 exec。恒走 hijack 单流：docker 非交互 exec 的输出是单条流内嵌多路复用帧
   * （[8 字节头][payload]，见 manager.parseDockerStream），由 manager 侧解帧。
   */
  start(opts?: DockerExecStartOptions): Promise<Readable>;
}

/** container.exec() 的创建参数（收窄面） */
export interface DockerExecCreateOptions {
  Cmd?: string[];
  WorkingDir?: string;
  Env?: string[];
  User?: string;
  AttachStdout?: boolean;
  AttachStderr?: boolean;
  Tty?: boolean;
}

/** exec inspect 结果（收窄面） */
export interface DockerExecInspect {
  ExitCode?: number;
  Running?: boolean;
}

/** container.inspect() 结果（收窄面） */
export interface DockerContainerInspect {
  State: { Running: boolean };
}

/** 容器实例（收窄面；SandboxManager 只用这些方法） */
export interface DockerContainerInstance {
  readonly id: string;
  start(): Promise<void>;
  stop(opts?: { t?: number }): Promise<void>;
  kill(): Promise<void>;
  remove(opts?: { force?: boolean }): Promise<void>;
  inspect(): Promise<DockerContainerInspect>;
  exec(opts: DockerExecCreateOptions): Promise<DockerExecInstance>;
  /** 按 exec id 查询退出码（dockerode 适配层走顶层 getExec().inspect()） */
  inspectExec(execId: string): Promise<DockerExecInspect>;
}

/** createContainer 参数（收窄面） */
export interface DockerCreateContainerOptions {
  Image: string;
  Cmd?: string[];
  User?: string;
  WorkingDir?: string;
  Labels?: Record<string, string>;
  HostConfig?: {
    Binds?: string[];
    Memory?: number;
    NanoCpus?: number;
    PidsLimit?: number;
    CapDrop?: string[];
    SecurityOpt?: string[];
    ReadonlyRootfs?: boolean;
    NetworkMode?: string;
  };
}

/** listContainers 返回的容器摘要（收窄面） */
export interface DockerContainerSummary {
  Id: string;
  Names?: string[];
  State?: string;
}

/** listContainers 查询参数（收窄面） */
export interface DockerListContainersOptions {
  all?: boolean;
}

/**
 * dockerode 实例的最小 duck-type 接口。
 * - 真实适配：docker.ts `createDockerClient()`（DOCKER_HOST 解析 + 构造失败返回 null）；
 * - 测试：注入内存 stub，记录调用、回放多路复用帧，绝不打真实 Docker。
 * getContainer 语义与 dockerode 一致：返回惰性句柄，不发起网络请求（远端不存在时
 * 后续操作才报错）。
 */
export interface DockerClient {
  /** 关闭底层连接池（优雅停机时调用；保持事件循环可空 */
  destroy?(): void;
  createContainer(opts: DockerCreateContainerOptions): Promise<DockerContainerInstance>;
  getContainer(id: string): DockerContainerInstance;
  listContainers(opts?: DockerListContainersOptions): Promise<DockerContainerSummary[]>;
}
