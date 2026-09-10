/**
 * coding engine — 沙箱化代码执行会话引擎（受控子进程路径）。
 *
 * 职责：为 LLM 提供 exec / curl / git / npm 语义的代码执行能力，落在
 * `<dataDir>/coding-workspaces/<sessionId>/` 会话目录内（目录即事实，重启无损）。
 *
 * 安全基线（纵深防御，逐层收口）：
 * - **命令白名单门**：cmd 必须命中白名单（{@link DEFAULT_ALLOWLIST}，可配置），且为
 *   裸命令名（禁路径分隔符）——二进制由引擎按宿主 PATH 解析为绝对路径并校验可执行位
 *   后执行，杜绝 `../bin/sh` 形态的命令字段绕过；白名单外一律 FORBIDDEN；
 * - **argv 直传**：`shell:false` 纯 argv 数组执行——反引号 / `$()` / `;` / `&&` 等
 *   shell 元字符按字面量传给目标程序，无 shell 解释层可注入；
 * - **路径钉死**：cwd 与文件参数限定会话目录内相对（绝对路径 / ".." 段 / NUL 拒绝；
 *   realpath 前缀复核防 symlink 出逃）；argv 整体拒绝绝对路径参数与 ".." 段参数
 *   （`rm -rf /`、`cat ../../etc/passwd` 形态直接拒）；
 * - **资源护栏**：超时 kill（SIGTERM → 1s 后 SIGKILL 兜底，POSIX 进程组整树终结）、
 *   stdout/stderr 各自 256KB 截断、stdin 关闭（防挂起等输入）、env 键名白名单合并
 *   （PATH/HOME/TMPDIR 受保护，HOME 钉在会话目录）；
 * - **并发门**：每会话同时至多 1 个进程，占用中再入 → SANDBOX_BUSY（BUSY 信号）。
 *
 * 已知局限（v1 取舍，如实声明）：
 * - 子进程运行在宿主 OS 用户权限下，**不做 OS 级 chroot/网络隔离**——经 argv 间接
 *   引用宿主路径（如 `--config=/etc/...`）或白名单命令自身的网络能力（curl/git）不被
 *   本引擎拦截；强隔离场景应走 Docker 沙箱（SandboxManager，HARNESS_SANDBOX_ENABLED）。
 * - `node/python` 代码经 {@link CodingEngine.runCode} 以临时文件执行（写→执行→清理），
 *   代码内容等价于在会话内运行任意脚本，同样受上述边界约束。
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { err } from '../errors/index.js';
import type {
  CodingEngineDeps,
  CodingExecInput,
  CodingFsEntry,
  CodingFsReadResult,
  CodingFsWriteResult,
  CodingRunCodeInput,
  CodingRunResult,
  CodingSessionInfo,
} from './types.js';

// ---------------------------------------------------------------------------
// 常量（导出便于配置对齐与测试断言）
// ---------------------------------------------------------------------------

/** 默认命令白名单：exec / curl / git / npm 语义的最小常用面（可经 deps.allowlist 覆盖） */
export const DEFAULT_ALLOWLIST: readonly string[] = [
  'node',
  'python3',
  'pip',
  'npm',
  'npx',
  'git',
  'curl',
  'ls',
  'cat',
  'head',
  'tail',
  'grep',
  'find',
  'wc',
  'mkdir',
  'touch',
  'cp',
  'mv',
  'rm',
  'echo',
  'sed',
  'awk',
  'date',
  'env',
];

/** 默认超时：30s */
export const DEFAULT_TIMEOUT_MS = 30_000;
/** 超时上限：120s */
export const MAX_TIMEOUT_MS = 120_000;
/** stdout/stderr 与 fs.read 各自的截断阈值（字节）：256KB */
export const MAX_OUTPUT_BYTES = 256 * 1024;
/** runCode 源码上限（字节）：256KB */
export const MAX_CODE_BYTES = 256 * 1024;
/** fs.write 内容上限（字节）：2MB */
export const MAX_FILE_WRITE_BYTES = 2 * 1024 * 1024;
/** relPath 的长度上限 */
const MAX_PATH_LENGTH = 1024;
/** 会话 id 形态约束（同时是 coding-workspaces 下的目录名，必须能防目录穿越） */
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
/** 引擎内部目录（会话根下；fs.list 刻意跳过，对工具面不可见） */
const INTERNAL_DIR = '.coding';
/** env 合并的键形状与受保护键 */
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PROTECTED_ENV_KEYS: ReadonlySet<string> = new Set(['PATH', 'HOME', 'TMPDIR', 'PWD', 'OLDPWD']);
/** 超时 SIGTERM 后转 SIGKILL 的宽限 */
const KILL_GRACE_MS = 1_000;
/** runCode 临时文件陈旧清理阈值 */
const STALE_TMP_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// 路径与参数校验辅助（纯函数）
// ---------------------------------------------------------------------------

/**
 * 会话内相对路径校验与规整：拒绝绝对路径 / ".." 段（穿越）/ NUL / 空串；
 * 容忍 "./"、重复与结尾的 "/"。返回规整相对路径（空等价 "."）。
 * @throws BAD_REQUEST
 */
function normalizeRelPath(input: string, kind: string): string {
  if (typeof input !== 'string' || input.length === 0 || input.length > MAX_PATH_LENGTH) {
    throw err('BAD_REQUEST', {
      message: `${kind} must be a non-empty string of at most ${MAX_PATH_LENGTH} chars`,
      detail: { kind },
    });
  }
  if (input.includes('\0')) {
    throw err('BAD_REQUEST', { message: `${kind} contains a NUL byte`, detail: { kind } });
  }
  if (input.startsWith('/') || /^[A-Za-z]:[\\/]/.test(input)) {
    throw err('BAD_REQUEST', {
      message: `${kind} must be relative to the session directory, got absolute path "${input.slice(0, 200)}"`,
      detail: { kind },
    });
  }
  const segments = input.split('/');
  if (segments.some((s) => s === '..')) {
    throw err('BAD_REQUEST', {
      message: `${kind} must not contain ".." segments (path traversal is rejected): "${input.slice(0, 200)}"`,
      detail: { kind },
    });
  }
  const cleaned = segments.filter((s) => s !== '' && s !== '.').join('/');
  return cleaned === '' ? '.' : cleaned;
}

/** argv 参数是否携带绝对路径形态（POSIX 以 / 开头；Windows 盘符形态一并拒绝） */
function looksLikeAbsoluteArg(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value);
}

/** argv 参数是否携带 ".." 路径段（含 `..`、`a/../b`、`a/..` 等形态；`a..b` 不算） */
function hasTraversalSegment(value: string): boolean {
  return /(^|\/)\.\.(\/|$)/.test(value);
}

// ---------------------------------------------------------------------------
// CodingEngine
// ---------------------------------------------------------------------------

/** coding 会话引擎：ensureSession / listSessions / resetSession / deleteSession /
 * runInSession / runCode / fsWrite / fsRead / fsList（目录即事实，无持久登记表）。 */
export class CodingEngine {
  readonly #deps: CodingEngineDeps;
  readonly #allowlist: ReadonlySet<string>;
  readonly #defaultTimeoutMs: number;
  readonly #maxTimeoutMs: number;
  readonly #maxOutputBytes: number;
  /** 命令名 → 解析后的绝对路径缓存（未安装的命令不缓存，装包后可重试） */
  readonly #resolvedCmds = new Map<string, string>();
  /** 每会话并发门：占用中的会话 id 集合 */
  readonly #busy = new Set<string>();

  constructor(deps: CodingEngineDeps) {
    this.#deps = deps;
    this.#allowlist = new Set(deps.allowlist ?? DEFAULT_ALLOWLIST);
    this.#defaultTimeoutMs = deps.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxTimeoutMs = deps.maxTimeoutMs ?? MAX_TIMEOUT_MS;
    this.#maxOutputBytes = deps.maxOutputBytes ?? MAX_OUTPUT_BYTES;
  }

  /** `<dataDir>/coding-workspaces` 会话根（访问时即建，幂等） */
  #root(): string {
    const root = join(this.#deps.dataDir, 'coding-workspaces');
    mkdirSync(root, { recursive: true });
    return root;
  }

  /** 会话 id 门禁：非法形态一律拒绝（目录名即 id，穿越防线第一层） */
  #checkSessionId(sessionId: string): string {
    if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) {
      throw err('BAD_REQUEST', {
        message: `sessionId "${String(sessionId).slice(0, 64)}" is invalid — must match ^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`,
        detail: { sessionId },
      });
    }
    return sessionId;
  }

  /** 会话目录绝对路径 */
  #sessionDir(sessionId: string): string {
    return join(this.#root(), sessionId);
  }

  /** 引擎内部目录（runCode 临时文件 + meta）；不存在则创建 */
  #internalDir(sessionDir: string): string {
    const dir = join(sessionDir, INTERNAL_DIR);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** 读取会话 createdAt（meta.json 优先，缺失/损坏回退目录 mtime） */
  #readCreatedAt(dir: string): number {
    try {
      const raw = JSON.parse(readFileSync(join(dir, INTERNAL_DIR, 'meta.json'), 'utf8')) as {
        createdAt?: unknown;
      };
      if (typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt)) return raw.createdAt;
    } catch {
      // 无 meta / 损坏：回退 mtime
    }
    return statSync(dir).mtimeMs;
  }

  /**
   * 将会话内相对路径解析为宿主绝对路径，并做 realpath 前缀复核（symlink 出逃防线）：
   * 目标存在 → 直接 realpath；不存在 → 对最深存在祖先 realpath 后拼接剩余段。
   * @throws BAD_REQUEST 路径非法；FORBIDDEN realpath 越出会话目录（穿越/symlink 出逃）
   */
  #resolveWithinSession(sessionId: string, relPath: string, kind: string): string {
    const rel = normalizeRelPath(relPath, kind);
    const sessionDir = this.#sessionDir(sessionId);
    const rootReal = realpathSync(sessionDir);
    const target = rel === '.' ? sessionDir : join(sessionDir, rel);
    const suffix: string[] = [];
    let probe = target;
    while (!existsSync(probe)) {
      const parent = dirname(probe);
      if (parent === probe) break; // 文件系统根（会话根必存在，理论不可达）
      suffix.unshift(basename(probe));
      probe = parent;
    }
    const real = suffix.length === 0 ? realpathSync(probe) : join(realpathSync(probe), ...suffix);
    if (real !== rootReal && !real.startsWith(rootReal + '/')) {
      throw err('FORBIDDEN', {
        message: `${kind} resolves outside the session directory (traversal or symlink escape is rejected)`,
        detail: { [kind]: relPath.slice(0, 200), sessionId },
      });
    }
    return real;
  }

  // -------------------------------------------------------------------------
  // 会话生命周期
  // -------------------------------------------------------------------------

  /** 创建/复用会话目录（幂等）：mkdir + meta.json 写入 + 陈旧临时文件清理 */
  ensureSession(sessionId: string): CodingSessionInfo {
    const id = this.#checkSessionId(sessionId);
    const dir = this.#sessionDir(id);
    mkdirSync(dir, { recursive: true });
    const internal = this.#internalDir(dir);
    const metaPath = join(internal, 'meta.json');
    const existing = existsSync(metaPath) ? this.#readCreatedAt(dir) : Date.now();
    try {
      writeFileSync(metaPath, JSON.stringify({ createdAt: existing, id }), 'utf8');
    } catch (e) {
      this.#deps.logger.warn({ err: e, sessionId: id }, '[coding] session meta write failed');
    }
    this.#sweepStaleTmp(internal);
    return { id, dir, createdAt: existing };
  }

  /** 列出全部会话（现场扫描 coding-workspaces/，按 createdAt 升序） */
  listSessions(): CodingSessionInfo[] {
    const root = this.#root();
    let names: string[];
    try {
      names = readdirSync(root);
    } catch {
      return [];
    }
    const sessions: CodingSessionInfo[] = [];
    for (const name of names) {
      if (!SESSION_ID_PATTERN.test(name)) continue;
      const dir = join(root, name);
      let st;
      try {
        st = statSync(dir);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      sessions.push({ id: name, dir, createdAt: this.#readCreatedAt(dir) });
    }
    return sessions.sort((a, b) => a.createdAt - b.createdAt);
  }

  /** 读取单个会话信息；不存在返回 null */
  getSession(sessionId: string): CodingSessionInfo | null {
    const id = this.#checkSessionId(sessionId);
    const dir = this.#sessionDir(id);
    if (!existsSync(dir)) return null;
    return { id, dir, createdAt: this.#readCreatedAt(dir) };
  }

  /** 会话占用门：忙时抛 SANDBOX_BUSY（BUSY 信号；reset/delete/run 共用同一门） */
  #requireIdle(sessionId: string): void {
    if (this.#busy.has(sessionId)) {
      throw err('SANDBOX_BUSY', {
        message: `coding session "${sessionId}" is busy — one process per session; retry after the current command finishes`,
        detail: { sessionId },
      });
    }
  }

  /** 重置会话：清空目录并复用（幂等；忙时拒绝）。返回重置后的会话信息 */
  resetSession(sessionId: string): CodingSessionInfo {
    const id = this.#checkSessionId(sessionId);
    this.#requireIdle(id);
    rmSync(this.#sessionDir(id), { recursive: true, force: true });
    return this.ensureSession(id);
  }

  /** 删除会话：整目录移除（忙时拒绝）；不存在返回 false（幂等） */
  deleteSession(sessionId: string): boolean {
    const id = this.#checkSessionId(sessionId);
    const dir = this.#sessionDir(id);
    if (!existsSync(dir)) return false;
    this.#requireIdle(id);
    rmSync(dir, { recursive: true, force: true });
    return true;
  }

  // -------------------------------------------------------------------------
  // 执行
  // -------------------------------------------------------------------------

  /**
   * 在会话目录内执行白名单命令（每会话并发 1 进程）。
   * 超时不抛错：kill 进程树并返回 timedOut=true 的部分输出（exitCode=-1）。
   *
   * @throws BAD_REQUEST（cmd/args/cwd/env/timeout 非法）/ FORBIDDEN（白名单外命令、
   *         绝对路径或 ".." 参数、realpath 出逃）/ SANDBOX_BUSY（会话占用中）/
   *         SANDBOX_NOT_FOUND（白名单命令未安装）
   */
  async runInSession(sessionId: string, input: CodingExecInput): Promise<CodingRunResult> {
    const id = this.#checkSessionId(sessionId);
    const cmd = this.#checkCmd(input?.cmd);
    const args = this.#checkArgs(input?.args ?? []);
    const timeoutMs = this.#checkTimeout(input?.timeoutMs);
    const extraEnv = this.#checkEnv(input?.env);
    this.ensureSession(id);
    const cwdReal = this.#resolveCwd(id, input?.cwd);
    this.#requireIdle(id);
    this.#busy.add(id);
    try {
      return await this.#spawnRun({ sessionId: id, cmd, args, cwd: cwdReal, timeoutMs, extraEnv });
    } finally {
      this.#busy.delete(id);
    }
  }

  /**
   * 快捷语义：源码写入会话内临时文件 → 白名单解释器执行 → 清理临时文件。
   * 与 runInSession 共用白名单 / 超时 / 截断 / BUSY 门；node→node、python→python3。
   */
  async runCode(sessionId: string, input: CodingRunCodeInput): Promise<CodingRunResult> {
    const id = this.#checkSessionId(sessionId);
    const language = input?.language;
    if (language !== 'node' && language !== 'python') {
      throw err('BAD_REQUEST', {
        message: `runCode language must be "node" or "python" (got ${String(language)})`,
        detail: { language },
      });
    }
    const code = input?.code;
    if (typeof code !== 'string' || code.length === 0) {
      throw err('BAD_REQUEST', { message: 'runCode code must be a non-empty string' });
    }
    const codeBytes = Buffer.byteLength(code, 'utf8');
    if (codeBytes > MAX_CODE_BYTES) {
      throw err('BAD_REQUEST', {
        message: `runCode code exceeds ${MAX_CODE_BYTES} bytes`,
        detail: { bytes: codeBytes, max: MAX_CODE_BYTES },
      });
    }
    const timeoutMs = this.#checkTimeout(input?.timeoutMs);
    this.ensureSession(id);
    const tmpDir = join(this.#internalDir(this.#sessionDir(id)), 'tmp');
    mkdirSync(tmpDir, { recursive: true });
    const file = join(tmpDir, `code-${randomUUID()}.${language === 'node' ? 'mjs' : 'py'}`);
    writeFileSync(file, code, 'utf8');
    try {
      // 临时文件路径为会话内相对段（.coding/tmp/…），天然通过 argv 路径闸
      return await this.runInSession(id, {
        cmd: language === 'node' ? 'node' : 'python3',
        args: [join(INTERNAL_DIR, 'tmp', basename(file))],
        timeoutMs,
      });
    } finally {
      rmSync(file, { force: true });
    }
  }

  // -------------------------------------------------------------------------
  // 会话文件面（fs.write / fs.read / fs.list）
  // -------------------------------------------------------------------------

  /** 写文件（UTF-8 文本；父目录自动创建；路径限会话内相对 + realpath 前缀复核） */
  fsWrite(sessionId: string, relPath: string, content: string): CodingFsWriteResult {
    const id = this.#checkSessionId(sessionId);
    this.ensureSession(id);
    if (typeof content !== 'string') {
      throw err('BAD_REQUEST', { message: 'content must be a string' });
    }
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > MAX_FILE_WRITE_BYTES) {
      throw err('BAD_REQUEST', {
        message: `content exceeds ${MAX_FILE_WRITE_BYTES} bytes`,
        detail: { bytes, max: MAX_FILE_WRITE_BYTES },
      });
    }
    const rel = normalizeRelPath(relPath, 'path');
    const real = this.#resolveWithinSession(id, relPath, 'path');
    mkdirSync(dirname(real), { recursive: true });
    writeFileSync(real, content, 'utf8');
    return { path: rel, size: bytes };
  }

  /** 读文件（文本；封顶 256KB 截断）。不存在 → SANDBOX_NOT_FOUND */
  fsRead(sessionId: string, relPath: string): CodingFsReadResult {
    const id = this.#checkSessionId(sessionId);
    this.ensureSession(id);
    const real = this.#resolveWithinSession(id, relPath, 'path');
    let st;
    try {
      st = statSync(real);
    } catch {
      throw err('SANDBOX_NOT_FOUND', {
        message: `file not found in session "${id}": "${relPath.slice(0, 200)}"`,
        detail: { path: relPath, sessionId: id },
      });
    }
    if (!st.isFile()) {
      throw err('BAD_REQUEST', { message: `path "${relPath.slice(0, 200)}" is not a regular file` });
    }
    const buf = readFileSync(real);
    const truncated = buf.byteLength > this.#maxOutputBytes;
    const slice = truncated ? buf.subarray(0, this.#maxOutputBytes) : buf;
    return {
      path: normalizeRelPath(relPath, 'path'),
      size: buf.byteLength,
      content: slice.toString('utf8'),
      truncated,
    };
  }

  /** 列目录（一级；引擎内部目录 `.coding` 刻意不可见）。不存在 → SANDBOX_NOT_FOUND */
  fsList(sessionId: string, relPath?: string): CodingFsEntry[] {
    const id = this.#checkSessionId(sessionId);
    this.ensureSession(id);
    const real = this.#resolveWithinSession(id, relPath ?? '.', 'path');
    let names: string[];
    try {
      names = readdirSync(real);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOTDIR') {
        throw err('BAD_REQUEST', { message: `path "${String(relPath).slice(0, 200)}" is not a directory` });
      }
      throw err('SANDBOX_NOT_FOUND', {
        message: `directory not found in session "${id}": "${String(relPath ?? '.').slice(0, 200)}"`,
        detail: { path: relPath ?? '.', sessionId: id },
      });
    }
    const entries: CodingFsEntry[] = [];
    for (const name of names) {
      if (name === INTERNAL_DIR) continue; // 引擎内部目录对工具面不可见
      let st;
      try {
        st = statSync(join(real, name));
      } catch {
        continue; // 竞态删除：跳过
      }
      entries.push({ name, size: st.size, dir: st.isDirectory() });
    }
    return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  // -------------------------------------------------------------------------
  // 内部：校验与子进程
  // -------------------------------------------------------------------------

  /** cmd 门：白名单 + 裸命令名（禁路径分隔符）。返回规整命令名 */
  #checkCmd(cmd: unknown): string {
    if (typeof cmd !== 'string' || cmd.length === 0 || cmd.length > 128) {
      throw err('BAD_REQUEST', { message: 'cmd must be a non-empty string of at most 128 chars' });
    }
    if (cmd.includes('/') || cmd.includes('\\') || cmd.includes('\0')) {
      throw err('BAD_REQUEST', {
        message: `cmd must be a bare command name (got "${cmd.slice(0, 64)}") — path separators are rejected`,
        detail: { cmd },
      });
    }
    if (!this.#allowlist.has(cmd)) {
      throw err('FORBIDDEN', {
        message: `command "${cmd}" is not in the coding allowlist`,
        detail: { cmd, allowlist: [...this.#allowlist] },
      });
    }
    return cmd;
  }

  /** args 门：全为字符串 + 拒绝绝对路径形态与 ".." 段参数 */
  #checkArgs(args: unknown): string[] {
    if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) {
      throw err('BAD_REQUEST', { message: 'args must be an array of strings' });
    }
    for (const a of args as string[]) {
      if (a.length > 64 * 1024) {
        throw err('BAD_REQUEST', { message: 'single argv element exceeds 64KB' });
      }
      if (looksLikeAbsoluteArg(a)) {
        throw err('FORBIDDEN', {
          message: `argv element looks like an absolute path (rejected): "${a.slice(0, 200)}"`,
          detail: { arg: a.slice(0, 200) },
        });
      }
      if (hasTraversalSegment(a)) {
        throw err('FORBIDDEN', {
          message: `argv element contains a ".." path segment (rejected): "${a.slice(0, 200)}"`,
          detail: { arg: a.slice(0, 200) },
        });
      }
    }
    return args as string[];
  }

  /** timeout 门：正整数；缺省 defaultTimeoutMs；超上限收敛到 max（不抛，防滥用语义） */
  #checkTimeout(timeoutMs: unknown): number {
    if (timeoutMs === undefined || timeoutMs === null) return this.#defaultTimeoutMs;
    if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      throw err('BAD_REQUEST', {
        message: `timeoutMs must be a positive integer (got ${String(timeoutMs)})`,
        detail: { timeoutMs },
      });
    }
    return Math.min(timeoutMs, this.#maxTimeoutMs);
  }

  /** env 门：键形状白名单 + 受保护键拒绝；返回规整后的额外 env */
  #checkEnv(env: unknown): Record<string, string> {
    if (env === undefined || env === null) return {};
    if (typeof env !== 'object' || Array.isArray(env)) {
      throw err('BAD_REQUEST', { message: 'env must be an object of string values' });
    }
    const entries = Object.entries(env as Record<string, unknown>);
    if (entries.length > 32) {
      throw err('BAD_REQUEST', { message: 'env accepts at most 32 keys' });
    }
    const out: Record<string, string> = {};
    for (const [key, value] of entries) {
      if (!ENV_KEY_PATTERN.test(key) || key.length > 64) {
        throw err('BAD_REQUEST', { message: `env key "${key.slice(0, 64)}" is invalid` });
      }
      if (PROTECTED_ENV_KEYS.has(key)) {
        throw err('FORBIDDEN', {
          message: `env key "${key}" is protected (PATH/HOME/TMPDIR are engine-managed)`,
          detail: { key },
        });
      }
      if (typeof value !== 'string' || value.length > 8192) {
        throw err('BAD_REQUEST', {
          message: `env value for "${key}" must be a string of at most 8192 chars`,
        });
      }
      out[key] = value;
    }
    return out;
  }

  /** cwd 解析：缺省会话根；必须为会话内已存在的目录（realpath + 前缀复核） */
  #resolveCwd(sessionId: string, cwd: unknown): string {
    if (cwd === undefined || cwd === null || cwd === '') {
      return realpathSync(this.#sessionDir(sessionId));
    }
    if (typeof cwd !== 'string') {
      throw err('BAD_REQUEST', { message: 'cwd must be a session-relative string' });
    }
    const real = this.#resolveWithinSession(sessionId, cwd, 'cwd');
    let st;
    try {
      st = statSync(real);
    } catch {
      throw err('BAD_REQUEST', {
        message: `cwd "${cwd.slice(0, 200)}" does not exist in session "${sessionId}"`,
        detail: { cwd, sessionId },
      });
    }
    if (!st.isDirectory()) {
      throw err('BAD_REQUEST', {
        message: `cwd "${cwd.slice(0, 200)}" is not a directory`,
        detail: { cwd, sessionId },
      });
    }
    return real;
  }

  /** 按宿主 PATH 解析白名单命令为绝对路径（可执行位校验；结果缓存；未安装抛 SANDBOX_NOT_FOUND） */
  #resolveCmdPath(cmd: string): string {
    const cached = this.#resolvedCmds.get(cmd);
    if (cached !== undefined) return cached;
    const pathEnv = process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin';
    for (const dir of pathEnv.split(':')) {
      if (dir === '') continue;
      const candidate = join(dir, cmd);
      let st;
      try {
        st = statSync(candidate);
        if (!st.isFile() || (st.mode & 0o111) === 0) continue;
        accessSync(candidate, fsConstants.X_OK); // 真实 uid 的可执行权限复核
      } catch {
        continue;
      }
      this.#resolvedCmds.set(cmd, candidate);
      return candidate;
    }
    throw err('SANDBOX_NOT_FOUND', {
      message: `command "${cmd}" is allowlisted but not installed on this host (not found on PATH)`,
      detail: { cmd },
    });
  }

  /** 子进程执行核心：spawn（shell:false、POSIX 进程组）→ 输出收集（截断）→ 超时 kill 树 */
  #spawnRun(run: {
    sessionId: string;
    cmd: string;
    args: string[];
    cwd: string;
    timeoutMs: number;
    extraEnv: Record<string, string>;
  }): Promise<CodingRunResult> {
    const binPath = this.#resolveCmdPath(run.cmd);
    const sessionDir = this.#sessionDir(run.sessionId);
    const env: Record<string, string> = {
      PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
      HOME: sessionDir,
      TMPDIR: join(sessionDir, INTERNAL_DIR, 'tmp'),
      ...(typeof process.env['LANG'] === 'string' ? { LANG: process.env['LANG'] as string } : {}),
      ...run.extraEnv,
    };
    mkdirSync(env['TMPDIR'] as string, { recursive: true });
    const startedAt = Date.now();
    return new Promise<CodingRunResult>((resolve, reject) => {
      // detached（POSIX）：子进程自成进程组，超时可整树 kill（npm→子进程等孙进程一并终结）
      let child: import('node:child_process').ChildProcess;
      try {
        child = spawn(binPath, run.args, {
          cwd: run.cwd,
          env,
          shell: false,
          detached: process.platform !== 'win32',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (e) {
        reject(err('SANDBOX_ERROR', { message: `spawn "${run.cmd}" failed`, cause: e }));
        return;
      }
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let truncated = false;
      let timedOut = false;
      let settled = false;
      let killTimer: NodeJS.Timeout | undefined;

      /** 落入通道并执行截断（超限丢弃并置 truncated） */
      const collect = (sink: Buffer[], isStdout: boolean, chunk: Buffer): void => {
        const used = isStdout ? stdoutBytes : stderrBytes;
        const room = this.#maxOutputBytes - used;
        if (room <= 0) {
          if (chunk.length > 0) truncated = true;
          return;
        }
        const take = chunk.length > room ? chunk.subarray(0, room) : chunk;
        if (take.length < chunk.length) truncated = true;
        sink.push(Buffer.from(take)); // copy：脱离流内部大缓冲
        if (isStdout) stdoutBytes += take.length;
        else stderrBytes += take.length;
      };

      /** 进程组整树 kill（POSIX）；组 kill 失败回退单进程 kill */
      const killTree = (signal: NodeJS.Signals): void => {
        const pid = child.pid;
        try {
          if (pid !== undefined && process.platform !== 'win32') process.kill(-pid, signal);
          else child.kill(signal);
        } catch {
          try {
            child.kill(signal);
          } catch {
            // 进程已退出：忽略
          }
        }
      };

      const timeoutTimer = setTimeout(() => {
        timedOut = true;
        killTree('SIGTERM');
        killTimer = setTimeout(() => killTree('SIGKILL'), KILL_GRACE_MS);
        if (killTimer !== undefined) killTimer.unref();
      }, run.timeoutMs);
      timeoutTimer.unref();

      child.stdout?.on('data', (chunk: Buffer) => collect(stdout, true, chunk));
      child.stderr?.on('data', (chunk: Buffer) => collect(stderr, false, chunk));
      child.on('error', (e: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutTimer);
        if (killTimer !== undefined) clearTimeout(killTimer);
        reject(err('SANDBOX_ERROR', { message: `command "${run.cmd}" failed to run`, cause: e }));
      });
      child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutTimer);
        if (killTimer !== undefined) clearTimeout(killTimer);
        resolve({
          exitCode: signal !== null || code === null ? -1 : code,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
          durationMs: Date.now() - startedAt,
          truncated,
          timedOut,
        });
      });
    });
  }

  /** 陈旧临时文件清理（>24h；进程崩溃残留的兜底） */
  #sweepStaleTmp(internalDir: string): void {
    const tmpDir = join(internalDir, 'tmp');
    let names: string[];
    try {
      names = readdirSync(tmpDir);
    } catch {
      return;
    }
    const now = Date.now();
    for (const name of names) {
      try {
        const st = statSync(join(tmpDir, name));
        if (now - st.mtimeMs > STALE_TMP_MS) rmSync(join(tmpDir, name), { force: true });
      } catch {
        // 竞态：跳过
      }
    }
  }
}
