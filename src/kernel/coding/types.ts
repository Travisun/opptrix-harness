/**
 * coding — 沙箱化代码执行（受控子进程会话）类型定义。
 *
 * {@link CodingEngine} 在 `<dataDir>/coding-workspaces/<sessionId>/` 内以受控子进程
 * 执行白名单命令（shell:false 纯 argv），为 LLM 提供 exec / curl / git / npm 语义的
 * 代码执行工具面。安全基线与已知局限见 engine.ts 模块头注释。
 */

/** 单个 coding 会话的登记信息（目录即事实；listSessions 现场扫描产出） */
export interface CodingSessionInfo {
  /** 会话 id（同时是 `coding-workspaces/` 下的目录名，形态受限防穿越） */
  id: string;
  /** 会话工作目录（宿主绝对路径） */
  dir: string;
  /** 创建时间（epoch ms，UTC；取 meta.json，缺失回退目录 mtime） */
  createdAt: number;
}

/** runInSession / runCode 的执行结果（输出各自封顶截断；超时不抛错以 timedOut 标识） */
export interface CodingRunResult {
  /** 退出码；被信号终结（含超时 kill）时无法可靠取回，固定 -1 */
  exitCode: number;
  /** 标准输出（UTF-8；超过 MAX_OUTPUT_BYTES 截断并置 truncated） */
  stdout: string;
  /** 标准错误（UTF-8；同上） */
  stderr: string;
  /** 执行时长（毫秒） */
  durationMs: number;
  /** stdout 或 stderr 任一达到截断阈值即为 true */
  truncated: boolean;
  /** 是否因超时被 kill（SIGTERM → SIGKILL 兜底） */
  timedOut: boolean;
}

/** runInSession 入参（cmd 之后的可选项） */
export interface CodingExecInput {
  /** 命令名（必须在白名单内；禁止路径分隔符——二进制由引擎按 PATH 解析绝对路径） */
  cmd: string;
  /** 参数数组（shell:false 直接 argv 传递；元字符按字面量语义，绝不经 shell 解释） */
  args?: string[];
  /** 会话目录内相对工作目录（缺省会话根；绝对路径 / ".." 段拒绝） */
  cwd?: string;
  /** 超时毫秒（缺省 30s，上限 120s） */
  timeoutMs?: number;
  /** 额外环境变量（键名白名单合并进基线 env；PATH/HOME/TMPDIR 等受保护键拒绝） */
  env?: Record<string, string>;
  /**
   * 会话目录物理覆写（MCP-First 工作区链路）：传入对话工作区路径时，会话根即该目录
   * （internal 目录在工作区根下，HOME/TMPDIR 同步钉在覆写目录）。并发 mutex 仍按
   * sessionId——覆写只改物理位置，不改会话语义。缺省落 `<dataDir>/coding-workspaces/<id>/`。
   */
  rootPath?: string;
}

/** runCode 入参：源码写入会话内临时文件执行，结束后清理 */
export interface CodingRunCodeInput {
  /** 语言（映射白名单解释器：node→node、python→python3） */
  language: 'node' | 'python';
  /** 源码文本（UTF-8，上限 256KB） */
  code: string;
  /** 超时毫秒（语义同 {@link CodingExecInput.timeoutMs}） */
  timeoutMs?: number;
  /** 会话目录物理覆写（语义同 {@link CodingExecInput.rootPath}） */
  rootPath?: string;
}

/** fs.list 的一级目录项（与沙箱 listFiles 同形状） */
export interface CodingFsEntry {
  name: string;
  size: number;
  dir: boolean;
}

/** fs.write 结果 */
export interface CodingFsWriteResult {
  /** 会话内相对路径（规整后） */
  path: string;
  /** 写入字节数（UTF-8） */
  size: number;
}

/** fs.read 结果（内容封顶 MAX_OUTPUT_BYTES，超出截断） */
export interface CodingFsReadResult {
  path: string;
  size: number;
  content: string;
  truncated: boolean;
}

/** CodingEngine 依赖集合（测试可注入临时 dataDir 与收窄白名单） */
export interface CodingEngineDeps {
  /** 内核数据目录（会话根为 `<dataDir>/coding-workspaces/`） */
  dataDir: string;
  /** 内核 pino logger */
  logger: import('pino').Logger;
  /** 命令白名单（缺省 {@link DEFAULT_ALLOWLIST}；覆盖时以传入数组为准） */
  allowlist?: readonly string[];
  /** 默认超时毫秒（缺省 {@link DEFAULT_TIMEOUT_MS}） */
  defaultTimeoutMs?: number;
  /** 超时上限毫秒（缺省 {@link MAX_TIMEOUT_MS}） */
  maxTimeoutMs?: number;
  /** 单流输出截断阈值字节（缺省 {@link MAX_OUTPUT_BYTES}） */
  maxOutputBytes?: number;
}
