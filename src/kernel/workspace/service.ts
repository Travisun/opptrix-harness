/**
 * workspace — 会话工作区内核（WorkspaceService）。
 *
 * 模型（架构定案）：每个「一级会话」（根会话）拥有一个工作区目录；子会话/孙子会话不建
 * 目录，经 parent 链解析到根会话的工作区——会话树共享同一份物理文件。物理布局：
 *
 *   `<dataDir>/workspaces/users/{userId||'system'}/{rootSessionId}/<relPath>`
 *
 * resolve 解析链（scopeId → 根会话）：
 * 1. scopeId 命中 agent_sessions → 沿 parent_id 上溯到根（visited 集合防环、深度上限
 *    {@link MAX_CHAIN_DEPTH}，超限/成环抛 VALIDATION_FAILED）；
 * 2. 否则 scopeId 命中 subagents 表 → 沿 parent_id 上溯到根 subagent（parent_id='main'）→
 *    取其 origin_session_id → 继续走会话链；
 * 3. 都未命中 → EXT_NOT_FOUND（404 形状，message 写明 session not found）。
 *
 * 路径安全：relPath 一律会话内相对（拒绝绝对路径与 `..` 段）；写入/删除前做 realpath
 * 前缀复核防 symlink 出逃；scopeId/根会话 id 必须 UUID 形状（防目录穿越）。
 * 单文件上限 {@link MAX_FILE_BYTES}（8MB，与 files 桥一致）；递归列表深度 ≤8、条目 ≤2000。
 *
 * 依赖经 getter 惰性取 store（两个 store 都是惰性建表，boot 后才可用），本服务自身无状态。
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';

import type { Logger } from 'pino';

import type { AgentSessionStore } from '../agents/session-store.js';
import type { SubagentStore } from '../agents/store.js';
import { err } from '../errors/index.js';

/** 目录步行条目（#walk 内部中间形状） */
interface WalkItem {
  name: string;
  abs: string;
  childRel: string;
  st: Stats;
}

/** scopeId / 根会话 id 的 UUID 形状校验（agent_sessions.id 与 subagents.id 均为 randomUUID 产物） */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** userId 目录段的形状校验（来自 auth provider 的任意字符串，防路径注入） */
const USER_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** 单文件上限（字节；与 files 桥 8MB 一致） */
export const MAX_FILE_BYTES = 8 * 1024 * 1024;

/** 解析链深度上限（会话链 + subagent 链合并计步；超限/成环抛 VALIDATION_FAILED） */
export const MAX_CHAIN_DEPTH = 16;

/** 递归列表最大目录深度（相对列表起点） */
export const MAX_LIST_DEPTH = 8;

/** 递归列表最大条目数（超出即截断，防巨目录拖垮列表面） */
export const MAX_LIST_ENTRIES = 2000;

/** relPath 最大字符数 */
export const MAX_REL_PATH_CHARS = 2048;

/** 解析结果（根会话 + 属主 + 工作区绝对路径） */
export interface WorkspaceResolveResult {
  /** 根会话 id（工作区目录名） */
  rootSessionId: string;
  /** 根会话属主（null → 物理布局落 'system' 段） */
  userId: string | null;
  /** 工作区根目录绝对路径（本方法不做 mkdir——write 时才落盘） */
  path: string;
}

/** 工作区条目（list 返回；path 为会话内相对 POSIX 风格，目录排前按名排序） */
export interface WorkspaceEntry {
  name: string;
  path: string;
  type: 'file' | 'dir';
  size: number;
  mtime: number;
}

/** WorkspaceService 依赖集合（stores 经 getter 惰性取——惰性建表，boot 后才可用） */
export interface WorkspaceServiceDeps {
  dataDir: string;
  logger: Logger;
  sessions: () => AgentSessionStore;
  subagents: () => SubagentStore;
}

/**
 * 归一会话内相对路径：拒绝绝对路径 / `..` 段 / NUL；剥离空段与 `.` 段；
 * 根目录返回 '.'。与 coding 引擎同款规则（会话内相对、穿越一律拒）。
 */
function normalizeRelPath(input: string): string {
  if (typeof input !== 'string' || input.length === 0 || input.length > MAX_REL_PATH_CHARS) {
    throw err('VALIDATION_FAILED', {
      message: `path must be a non-empty string of at most ${MAX_REL_PATH_CHARS} chars`,
      detail: { field: 'path' },
    });
  }
  if (input.includes('\0')) {
    throw err('VALIDATION_FAILED', { message: 'path contains a NUL byte', detail: { field: 'path' } });
  }
  if (input.startsWith('/') || /^[A-Za-z]:[\\/]/.test(input)) {
    throw err('VALIDATION_FAILED', {
      message: `path must be relative to the session workspace, got absolute path "${input.slice(0, 200)}"`,
      detail: { field: 'path' },
    });
  }
  const segments = input.split(/[\\/]/);
  if (segments.some((s) => s === '..')) {
    throw err('VALIDATION_FAILED', {
      message: `path must not contain ".." segments (path traversal is rejected): "${input.slice(0, 200)}"`,
      detail: { field: 'path' },
    });
  }
  const cleaned = segments.filter((s) => s !== '' && s !== '.').join('/');
  return cleaned === '' ? '.' : cleaned;
}

/**
 * 会话工作区内核（冻结契约，其他工作包按此消费；见模块头注释）。
 * 全部方法先 resolve 出根会话工作区，再在目录内做路径安全复核后的文件操作。
 */
export class WorkspaceService {
  readonly #deps: WorkspaceServiceDeps;

  constructor(deps: WorkspaceServiceDeps) {
    this.#deps = deps;
  }

  // ---------------------------------------------------------------------------
  // 解析链
  // ---------------------------------------------------------------------------

  /**
   * scopeId（agent 会话 id 或 subagent id）→ 根会话工作区（见模块头注释的解析链）。
   *
   * @throws VALIDATION_FAILED scopeId 非 UUID 形状 / 解析链成环或超深 / userId 段非法
   * @throws EXT_NOT_FOUND scopeId 未命中任何会话或子代理（404 形状）
   */
  async resolve(scopeId: string): Promise<WorkspaceResolveResult> {
    if (typeof scopeId !== 'string' || !UUID_PATTERN.test(scopeId)) {
      throw err('VALIDATION_FAILED', {
        message: `scopeId "${String(scopeId).slice(0, 64)}" is not a valid session/subagent id (UUID expected)`,
        detail: { field: 'scopeId' },
      });
    }
    const visited = new Set<string>();
    let currentId: string = scopeId;
    for (let depth = 0; depth < MAX_CHAIN_DEPTH; depth++) {
      if (visited.has(currentId)) {
        throw err('VALIDATION_FAILED', {
          message: `workspace resolution detected a cycle at "${currentId}"`,
          detail: { scopeId, cycleAt: currentId },
        });
      }
      visited.add(currentId);

      const session = await this.#deps.sessions().getSession(currentId);
      if (session !== null) {
        if (session.parentId === null || session.parentId === session.id) {
          return this.#workspaceOf(session.id, session.userId);
        }
        currentId = session.parentId;
        continue;
      }

      const subagent = await this.#deps.subagents().get(currentId);
      if (subagent !== null) {
        if (subagent.parentId === 'main') {
          if (subagent.originSessionId === null) {
            // 非会话发起（如 /mcp 主会话委派）：无根会话可归属
            throw err('EXT_NOT_FOUND', {
              message: `session not found: subagent "${scopeId}" has no origin session`,
              detail: { scopeId, subagentId: subagent.id },
            });
          }
          currentId = subagent.originSessionId;
          continue;
        }
        currentId = subagent.parentId;
        continue;
      }

      throw err('EXT_NOT_FOUND', {
        message: `session not found: "${scopeId}" matches no agent session or subagent`,
        detail: { scopeId },
      });
    }
    throw err('VALIDATION_FAILED', {
      message: `workspace resolution exceeded ${MAX_CHAIN_DEPTH} hops (chain too deep or cyclic)`,
      detail: { scopeId },
    });
  }

  // ---------------------------------------------------------------------------
  // 文件操作（全部先 resolve，再会话内相对路径安全复核）
  // ---------------------------------------------------------------------------

  /**
   * 写文件（mkdir -p 语义；父目录不存在自动创建）。
   *
   * @returns 落盘文件的会话内相对路径与字节数
   * @throws VALIDATION_FAILED relPath 非法
   * @throws PAYLOAD_TOO_LARGE data 超过 {@link MAX_FILE_BYTES}
   * @throws FORBIDDEN realpath 越出工作区（穿越/symlink 出逃）
   */
  async write(scopeId: string, relPath: string, data: Buffer): Promise<{ path: string; size: number }> {
    const rel = normalizeRelPath(relPath);
    if (!Buffer.isBuffer(data)) {
      throw err('VALIDATION_FAILED', { message: 'data must be a Buffer', detail: { field: 'data' } });
    }
    if (data.byteLength > MAX_FILE_BYTES) {
      throw err('PAYLOAD_TOO_LARGE', {
        message: `workspace file is ${data.byteLength} bytes, which exceeds the ${MAX_FILE_BYTES}-byte limit`,
        detail: { bytes: data.byteLength, maxBytes: MAX_FILE_BYTES },
      });
    }
    const wsRoot = await this.#ensureWorkspaceDir(scopeId);
    const target = this.#resolveWithinRoot(wsRoot, rel);
    mkdirSync(dirname(target), { recursive: true });
    // 落盘前终审：mkdir 之后目标父目录已真实存在，realpath 复核防 TOCTOU 窗口内的 symlink 换向
    const realParent = realpathSync(dirname(target));
    const realRoot = realpathSync(wsRoot);
    if (realParent !== realRoot && !realParent.startsWith(realRoot + sep)) {
      throw err('FORBIDDEN', {
        message: 'workspace write resolves outside the workspace directory (traversal or symlink escape is rejected)',
        detail: { path: rel.slice(0, 200) },
      });
    }
    writeFileSync(target, data);
    this.#deps.logger.debug({ scopeId, path: rel, size: data.byteLength }, '[workspace] file written');
    return { path: rel, size: data.byteLength };
  }

  /**
   * 读文件（单文件上限内任意大小；目标不存在 → EXT_NOT_FOUND）。
   *
   * @throws VALIDATION_FAILED relPath 非法
   * @throws EXT_NOT_FOUND 文件（或工作区）不存在
   * @throws FORBIDDEN realpath 越出工作区
   */
  async read(scopeId: string, relPath: string): Promise<Buffer> {
    const rel = normalizeRelPath(relPath);
    const wsRoot = await this.#existingWorkspaceDir(scopeId);
    if (wsRoot === null) {
      throw this.#notFound(rel);
    }
    const target = this.#resolveWithinRoot(wsRoot, rel);
    if (!existsSync(target) || !statSync(target).isFile()) {
      throw this.#notFound(rel);
    }
    return readFileSync(target);
  }

  /**
   * 列出工作区条目（path 为会话内相对 POSIX 风格；目录排前按名排序）。
   *
   * @param relPath 列表起点（缺省工作区根；起点是文件时返回单条目）
   * @param recursive 递归列举（缺省 false；true 时深度 ≤{@link MAX_LIST_DEPTH}、
   *   条目 ≤{@link MAX_LIST_ENTRIES}——超出即截断）
   * @throws VALIDATION_FAILED relPath 非法
   * @throws EXT_NOT_FOUND 起点不存在（工作区目录尚不存在视为空 → 空数组）
   * @throws FORBIDDEN realpath 越出工作区
   */
  async list(scopeId: string, relPath?: string, recursive?: boolean): Promise<WorkspaceEntry[]> {
    const rel = normalizeRelPath(relPath ?? '.');
    const wsRoot = await this.#existingWorkspaceDir(scopeId);
    if (wsRoot === null) return [];
    const target = this.#resolveWithinRoot(wsRoot, rel);
    if (!existsSync(target)) {
      if (rel === '.') return [];
      throw this.#notFound(rel);
    }
    const st = statSync(target);
    if (st.isFile()) {
      return [this.#entryOf(target, rel, st)];
    }
    const out: WorkspaceEntry[] = [];
    this.#walk(target, rel, recursive === true, 0, out);
    return out;
  }

  /**
   * 删除文件或**空**目录（非空目录拒绝；工作区根不可删）。
   *
   * @throws VALIDATION_FAILED relPath 非法 / 试图删除工作区根
   * @throws EXT_NOT_FOUND 目标不存在
   * @throws FORBIDDEN realpath 越出工作区
   * @throws BAD_REQUEST 目标是非空目录
   */
  async delete(scopeId: string, relPath: string): Promise<void> {
    const rel = normalizeRelPath(relPath);
    if (rel === '.') {
      throw err('BAD_REQUEST', {
        message: 'refusing to delete the workspace root',
        detail: { field: 'path' },
      });
    }
    const wsRoot = await this.#existingWorkspaceDir(scopeId);
    if (wsRoot === null) throw this.#notFound(rel);
    const target = this.#resolveWithinRoot(wsRoot, rel);
    if (!existsSync(target)) throw this.#notFound(rel);
    const st = statSync(target);
    if (st.isDirectory()) {
      try {
        rmdirSync(target); // 仅空目录可删；非空 ENOTEMPTY → BAD_REQUEST
      } catch (e) {
        if ((e as { code?: string }).code === 'ENOTEMPTY' || (e as { code?: string }).code === 'EEXIST') {
          throw err('BAD_REQUEST', {
            message: `workspace directory "${rel.slice(0, 200)}" is not empty`,
            detail: { path: rel },
          });
        }
        throw e;
      }
      return;
    }
    unlinkSync(target);
    this.#deps.logger.debug({ scopeId, path: rel }, '[workspace] file deleted');
  }

  // ---------------------------------------------------------------------------
  // 内部
  // ---------------------------------------------------------------------------

  /** 根会话 → 工作区描述（布局 `workspaces/users/{userId||'system'}/{rootSessionId}`） */
  #workspaceOf(rootSessionId: string, userId: string | null): WorkspaceResolveResult {
    if (!UUID_PATTERN.test(rootSessionId)) {
      throw err('VALIDATION_FAILED', {
        message: `root session id "${rootSessionId.slice(0, 64)}" is not UUID-shaped (path traversal guard)`,
        detail: { rootSessionId },
      });
    }
    const userSegment = userId ?? 'system';
    if (!USER_SEGMENT_PATTERN.test(userSegment) || userSegment.includes('..')) {
      throw err('VALIDATION_FAILED', {
        message: `session owner id "${userSegment.slice(0, 64)}" is not a safe path segment`,
        detail: { rootSessionId, userId },
      });
    }
    return {
      rootSessionId,
      userId,
      path: join(this.#deps.dataDir, 'workspaces', 'users', userSegment, rootSessionId),
    };
  }

  /** resolve + mkdir -p（写入面前置）；返回工作区根绝对路径 */
  async #ensureWorkspaceDir(scopeId: string): Promise<string> {
    const ws = await this.resolve(scopeId);
    mkdirSync(ws.path, { recursive: true });
    return ws.path;
  }

  /** resolve + 存在性探测；工作区目录尚不存在返回 null（读面按空/缺失处理） */
  async #existingWorkspaceDir(scopeId: string): Promise<string | null> {
    const ws = await this.resolve(scopeId);
    const real = this.#realpathOrNull(ws.path);
    return real === null ? null : ws.path;
  }

  /** 读/删面的统一 404（EXT_NOT_FOUND 形状，message 写明 workspace file not found） */
  #notFound(rel: string): Error {
    return err('EXT_NOT_FOUND', {
      message: `workspace file not found: "${rel.slice(0, 200)}"`,
      detail: { path: rel },
    });
  }

  /** realpath 容错（目标不存在返回 null） */
  #realpathOrNull(p: string): string | null {
    try {
      return realpathSync(p);
    } catch {
      return null;
    }
  }

  /**
   * 会话内相对路径 → 工作区内绝对路径，并做 realpath 前缀复核（symlink 出逃防线）：
   * 目标存在 → 直接 realpath；不存在 → 对最深存在祖先 realpath 后拼接剩余段。
   * @throws FORBIDDEN 解析结果越出工作区根（穿越/symlink 出逃）
   */
  #resolveWithinRoot(wsRoot: string, rel: string): string {
    const rootReal = realpathSync(wsRoot);
    const target = rel === '.' ? wsRoot : join(wsRoot, rel);
    const suffix: string[] = [];
    let probe = target;
    while (!existsSync(probe)) {
      const parent = dirname(probe);
      if (parent === probe) break; // 文件系统根（工作区根必存在，理论不可达）
      suffix.unshift(basename(probe));
      probe = parent;
    }
    const real = suffix.length === 0 ? realpathSync(probe) : join(realpathSync(probe), ...suffix);
    if (real !== rootReal && !real.startsWith(rootReal + sep)) {
      throw err('FORBIDDEN', {
        message: 'path resolves outside the workspace directory (traversal or symlink escape is rejected)',
        detail: { path: rel.slice(0, 200) },
      });
    }
    return real;
  }

  /** 目录条目 → WorkspaceEntry（path 为会话内相对 POSIX 风格） */
  #entryOf(abs: string, rel: string, st: Stats): WorkspaceEntry {
    return {
      name: basename(abs),
      path: rel,
      type: st.isDirectory() ? 'dir' : 'file',
      size: st.isFile() ? st.size : 0,
      mtime: st.mtimeMs,
    };
  }

  /**
   * 目录步行（DFS；每层目录排前按名排序）。recursive=false 只列一层；
   * recursive=true 时深度 ≤ MAX_LIST_DEPTH、累计条目 ≤ MAX_LIST_ENTRIES（超出即截断）。
   */
  #walk(dirAbs: string, rel: string, recursive: boolean, depth: number, out: WorkspaceEntry[]): void {
    if (out.length >= MAX_LIST_ENTRIES) return;
    let names: string[];
    try {
      names = readdirSync(dirAbs);
    } catch {
      return; // 权限/竞态：跳过该层，不拖垮整体列表
    }
    const items: WalkItem[] = [];
    for (const name of names) {
      const abs = join(dirAbs, name);
      const childRel = rel === '.' ? name : `${rel}/${name}`;
      const st = this.#statOrNull(abs);
      if (st !== null) items.push({ name, abs, childRel, st });
    }
    items.sort((a, b) => {
      const aDir = a.st.isDirectory() ? 0 : 1;
      const bDir = b.st.isDirectory() ? 0 : 1;
      return aDir !== bDir ? aDir - bDir : a.name.localeCompare(b.name);
    });
    for (const e of items) {
      if (out.length >= MAX_LIST_ENTRIES) return;
      out.push(this.#entryOf(e.abs, e.childRel, e.st));
      if (recursive && e.st.isDirectory() && depth + 1 < MAX_LIST_DEPTH) {
        this.#walk(e.abs, e.childRel, recursive, depth + 1, out);
      }
    }
  }

  /** statSync 容错（悬空 symlink / 竞态删除返回 null，列表面跳过） */
  #statOrNull(p: string): Stats | null {
    try {
      return statSync(p);
    } catch {
      return null;
    }
  }
}
