/**
 * FileService — 文件存储内核服务（落盘 + 落库 + hook + 事件）。
 *
 * store 流程（顺序即约束）：
 * 1. 入参规范化：origName 净化路径成分、mime 缺省 `application/octet-stream`、
 *    visibility 缺省 `private`；
 * 2. 大小闸门：`size > maxUploadBytes` → `HARNESS-1005` PAYLOAD_TOO_LARGE；
 * 3. MIME 白名单（缺省为通配全允许）→ 不匹配 `HARNESS-1009` VALIDATION_FAILED；
 * 4. 扩展配额：extId 非空时 `SUM(size) + size > maxExtStorageBytes`（默认 1GB）
 *    → `HARNESS-3010` EXT_DB_QUOTA；
 * 5. `file.beforeStore` hook（HOOK_POINTS.fileBeforeStore，filter 链）：
 *    - handler 抛 `new HookAbort(false)`（或直接返回 false）→ 拒收，
 *      `HARNESS-1008` BAD_REQUEST 'rejected by file.beforeStore hook'；
 *    - handler 返回对象时按字段合并改写入参（data/origName/mime/extId/visibility），
 *      合并后重跑净化与大小闸门（改写不得绕过安全限制）；
 * 6. 落盘（driver.put，relPath = `<yyyy>/<mm>/<uuid><ext>`）→ 落库（files 表；
 *    落库失败回滚删除磁盘文件）→ `emit('file.uploaded', record, { source: 'kernel' })`
 *    → `file.afterStore` hook → 返回记录。
 *
 * read 规则：public 任意调用方可读；private 需 `allowPrivate: true`（REST 层由
 * root/admin 角色门禁决定），否则 `HARNESS-1007` FORBIDDEN。
 */
import { randomUUID } from 'node:crypto';

import type { Knex } from 'knex';

import { err, HarnessError } from '../errors/index.js';
import { HOOK_POINTS } from '../hooks/points.js';
import type { FileDriver, FileRecord } from './types.js';

/** FileService 依赖集合 */
export interface FileServiceDeps {
  /** 存储驱动（本地磁盘用 createLocalDriver 构造） */
  driver: FileDriver;
  /** 内核 knex 实例（files 表，migration 012） */
  db: Knex;
  /** hook 管理器门面（通常为 HookManager 实例） */
  hooks: {
    apply(name: string, value: unknown, ctx?: { meta?: Record<string, unknown> }): Promise<unknown>;
  };
  /** 事件总线门面（通常为 EventBus.emit 绑定） */
  emit(name: string, payload: unknown, opts?: { source?: string }): Promise<unknown> | unknown;
  /** kernel logger（pino）；只记 id/size 等元信息，绝不记文件内容 */
  logger: import('pino').Logger;
  /** 单文件大小上限（字节） */
  maxUploadBytes: number;
  /** MIME 白名单（支持 `image/*` 前缀通配与全通配）；缺省全允许 */
  mimeAllowlist?: string[];
  /** 每扩展存储配额（字节）；缺省 1GB。仅约束 extId 非空的上传 */
  maxExtStorageBytes?: number;
}

/** files 表行形状（snake_case，与 migration 012 对齐） */
interface FileRow {
  id: string;
  ext_id: string | null;
  orig_name: string;
  mime: string;
  size: number;
  path: string;
  visibility: string;
  created_at: number;
}

/** store 的规范化内部入参（hook 可改写的字段集合） */
interface StoreInput {
  data: Buffer;
  origName: string;
  mime: string;
  extId: string | null;
  visibility: 'private' | 'public';
}

/** list 默认与上限 */
const LIST_DEFAULT_LIMIT = 50;
const LIST_MAX_LIMIT = 500;

/** 每扩展配额默认 1GB */
const DEFAULT_MAX_EXT_STORAGE_BYTES = 1024 * 1024 * 1024;

/** 默认 MIME 类型 */
const DEFAULT_MIME = 'application/octet-stream';

// ---------------------------------------------------------------------------
// 纯函数辅助
// ---------------------------------------------------------------------------

/**
 * 净化原始文件名：去掉全部路径成分（`/`、`\` 与盘符）、控制字符；
 * 结果为空/`.`/`..` 时回退 'file'。`../../etc/passwd` → `passwd`。
 */
export function sanitizeOrigName(raw: string): string {
  const base = raw.replace(/\\/g, '/').split('/').pop() ?? '';
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (cleaned === '' || cleaned === '.' || cleaned === '..') return 'file';
  return cleaned;
}

/** 取净化后文件名的扩展名（含点，≤15 字符；隐藏文件 `.txt` 不算扩展） */
function extOf(name: string): string {
  const idx = name.lastIndexOf('.');
  if (idx <= 0 || idx >= name.length - 1) return '';
  const ext = name.slice(idx);
  return ext.length <= 16 ? ext : '';
}

/** MIME 是否命中白名单（全通配全允许；`image/*` 前缀通配；其余精确匹配，忽略大小写） */
function mimeAllowed(mime: string, allowlist: string[]): boolean {
  const m = mime.toLowerCase();
  return allowlist.some((raw) => {
    const p = raw.trim().toLowerCase();
    if (p === '*/*' || p === '*') return true;
    if (p.endsWith('/*')) return m.startsWith(p.slice(0, -1));
    return p === m;
  });
}

/** 行 → FileRecord（camelCase 视图） */
function rowToRecord(row: FileRow): FileRecord {
  return {
    id: row.id,
    extId: row.ext_id,
    origName: row.orig_name,
    mime: row.mime,
    size: Number(row.size),
    path: row.path,
    visibility: row.visibility === 'public' ? 'public' : 'private',
    createdAt: Number(row.created_at),
  };
}

/** 应用 file.beforeStore 的返回值：false → 拒收；对象 → 按字段合并改写 */
function applyBeforeStoreResult(base: StoreInput, applied: unknown): StoreInput {
  if (applied === false) {
    throw err('BAD_REQUEST', { message: 'rejected by file.beforeStore hook' });
  }
  if (applied === null || applied === undefined || typeof applied !== 'object') return base;
  if (Buffer.isBuffer(applied) || Array.isArray(applied)) return base;
  const patch = applied as Record<string, unknown>;
  const merged: StoreInput = { ...base };
  if ('data' in patch && Buffer.isBuffer(patch.data)) merged.data = patch.data;
  if (typeof patch.origName === 'string' && patch.origName !== '') merged.origName = patch.origName;
  if (typeof patch.mime === 'string' && patch.mime !== '') merged.mime = patch.mime;
  if ('extId' in patch) {
    merged.extId = typeof patch.extId === 'string' && patch.extId !== '' ? patch.extId : null;
  }
  if (patch.visibility === 'public' || patch.visibility === 'private') merged.visibility = patch.visibility;
  return merged;
}

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

export class FileService {
  readonly #deps: FileServiceDeps;

  constructor(deps: FileServiceDeps) {
    this.#deps = deps;
  }

  /** 允许的 MIME 白名单（已应用缺省） */
  get mimeAllowlist(): string[] {
    return this.#deps.mimeAllowlist ?? ['*/*'];
  }

  /** 每扩展存储配额（字节，已应用缺省 1GB） */
  get maxExtStorageBytes(): number {
    return this.#deps.maxExtStorageBytes ?? DEFAULT_MAX_EXT_STORAGE_BYTES;
  }

  /**
   * 存储一个文件：校验 → hook → 落盘 → 落库 → 事件 → afterStore hook。
   *
   * @returns 落库后的完整记录（path 为相对 driver root 的 relPath）
   * @throws HarnessError
   *   - VALIDATION_FAILED：data 非 Buffer / origName 非字符串 / mime 不在白名单
   *   - PAYLOAD_TOO_LARGE：size 超过 maxUploadBytes（含 hook 改写后复核）
   *   - EXT_DB_QUOTA：extId 非空且超每扩展配额
   *   - BAD_REQUEST：file.beforeStore hook 拒收
   */
  async store(input: {
    data: Buffer;
    origName: string;
    mime?: string;
    extId?: string | null;
    visibility?: 'private' | 'public';
  }): Promise<FileRecord> {
    if (!Buffer.isBuffer(input.data)) {
      throw err('VALIDATION_FAILED', { message: 'store(): data must be a Buffer', detail: { got: typeof input.data } });
    }
    if (typeof input.origName !== 'string' || input.origName === '') {
      throw err('VALIDATION_FAILED', { message: 'store(): origName must be a non-empty string' });
    }

    // 1. 规范化 + 安全校验（hook 前）
    let current: StoreInput = {
      data: input.data,
      origName: sanitizeOrigName(input.origName),
      mime: input.mime ?? DEFAULT_MIME,
      extId: input.extId ?? null,
      visibility: input.visibility ?? 'private',
    };
    this.#assertSize(current.data, current.origName);
    this.#assertMime(current.mime);

    // 2. 扩展配额（仅 extId 非空）
    if (current.extId !== null) {
      const used = await this.usedBytes(current.extId);
      if (used + current.data.byteLength > this.maxExtStorageBytes) {
        throw err('EXT_DB_QUOTA', {
          message:
            `extension "${current.extId}" storage quota exceeded: used ${used} bytes, ` +
            `incoming ${current.data.byteLength} bytes, limit ${this.maxExtStorageBytes} bytes. ` +
            'Delete unused files or raise maxExtStorageBytes.',
          detail: { extId: current.extId, used, incoming: current.data.byteLength, limit: this.maxExtStorageBytes },
        });
      }
    }

    // 3. file.beforeStore hook（可拒收 / 可改写；改写后重跑安全闸门）
    const applied = await this.#deps.hooks.apply(HOOK_POINTS.fileBeforeStore, { ...current }, {
      meta: { extId: current.extId },
    });
    current = applyBeforeStoreResult(current, applied);
    current = { ...current, origName: sanitizeOrigName(current.origName) };
    this.#assertSize(current.data, current.origName);
    this.#assertMime(current.mime);

    // 4. 生成标识与存储路径：<yyyy>/<mm>/<uuid><ext>（UTC）
    const id = randomUUID();
    const createdAt = Date.now();
    const at = new Date(createdAt);
    const relPath =
      `${at.getUTCFullYear()}/${String(at.getUTCMonth() + 1).padStart(2, '0')}/${id}${extOf(current.origName)}`;

    // 5. 落盘 → 落库（落库失败回滚磁盘文件，不留孤儿）
    await this.#deps.driver.put(relPath, current.data);
    const row: FileRow = {
      id,
      ext_id: current.extId,
      orig_name: current.origName,
      mime: current.mime,
      size: current.data.byteLength,
      path: relPath,
      visibility: current.visibility,
      created_at: createdAt,
    };
    try {
      await this.#deps.db('files').insert(row);
    } catch (e) {
      await this.#deps.driver.delete(relPath).catch(() => {});
      throw HarnessError.wrap(e, 'DB_ERROR');
    }

    const record = rowToRecord(row);
    this.#deps.logger.debug(
      { fileId: record.id, size: record.size, extId: record.extId, visibility: record.visibility },
      '[files] stored',
    );

    // 6. 事件与 afterStore hook（不改变返回值）
    await this.#deps.emit('file.uploaded', record, { source: 'kernel' });
    await this.#deps.hooks.apply(HOOK_POINTS.fileAfterStore, record, { meta: { extId: record.extId } });
    return record;
  }

  /**
   * 按 ID 读取记录；不存在抛 `HARNESS-3004` EXT_NOT_FOUND。
   */
  async get(id: string): Promise<FileRecord> {
    const row = (await this.#deps.db('files').where({ id }).first()) as FileRow | undefined;
    if (row === undefined) {
      throw err('EXT_NOT_FOUND', { message: `file "${id}" not found`, detail: { id } });
    }
    return rowToRecord(row);
  }

  /**
   * 读取文件记录与内容。
   *
   * @param opts.allowPrivate true 时允许读取 private 文件（REST 层由 root/admin 角色判定后传入）；
   *   private 且未放行 → `HARNESS-1007` FORBIDDEN
   */
  async read(id: string, opts?: { allowPrivate?: boolean }): Promise<{ record: FileRecord; data: Buffer }> {
    const record = await this.get(id);
    if (record.visibility === 'private' && opts?.allowPrivate !== true) {
      throw err('FORBIDDEN', {
        message: `file "${id}" is private (readable by admin/root only)`,
        detail: { id, visibility: record.visibility },
      });
    }
    const data = await this.#deps.driver.read(record.path);
    return { record, data };
  }

  /**
   * 删除文件（磁盘 + 行）并发布 `file.deleted` 事件；不存在抛 EXT_NOT_FOUND。
   * @returns 被删记录（事件负载同此对象）
   */
  async remove(id: string): Promise<FileRecord> {
    const record = await this.get(id);
    const gone = await this.#deps.driver.delete(record.path);
    if (!gone) {
      this.#deps.logger.warn({ fileId: record.id, path: record.path }, '[files] disk file already missing at delete');
    }
    await this.#deps.db('files').where({ id }).del();
    this.#deps.logger.debug({ fileId: record.id, extId: record.extId }, '[files] removed');
    await this.#deps.emit('file.deleted', record, { source: 'kernel' });
    return record;
  }

  /**
   * 列出文件（created_at 降序）。
   * @param opts.extId 按扩展过滤；null = 仅内核级（ext_id IS NULL）；undefined = 不过滤
   * @param opts.limit 1..500，缺省 50
   */
  async list(opts?: { extId?: string | null; limit?: number }): Promise<FileRecord[]> {
    const limit = opts?.limit ?? LIST_DEFAULT_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > LIST_MAX_LIMIT) {
      throw err('VALIDATION_FAILED', {
        message: `list(): limit must be an integer in [1, ${LIST_MAX_LIMIT}], got ${limit}`,
        detail: { limit },
      });
    }
    let q = this.#deps.db('files').select();
    if (opts?.extId !== undefined) {
      q = opts.extId === null ? q.whereNull('ext_id') : q.where({ ext_id: opts.extId });
    }
    const rows = (await q.orderBy('created_at', 'desc').limit(limit)) as FileRow[];
    return rows.map(rowToRecord);
  }

  /** 指定扩展已用存储字节数（SUM(size)；无记录为 0） */
  async usedBytes(extId: string): Promise<number> {
    const row = (await this.#deps.db('files').where({ ext_id: extId }).sum({ total: 'size' }).first()) as
      | { total: number | string | null }
      | undefined;
    return Number(row?.total ?? 0);
  }

  // ---- 内部闸门 ----

  #assertSize(data: Buffer, label: string): void {
    if (data.byteLength > this.#deps.maxUploadBytes) {
      throw err('PAYLOAD_TOO_LARGE', {
        message:
          `file "${label}" is ${data.byteLength} bytes, which exceeds maxUploadBytes ` +
          `${this.#deps.maxUploadBytes}. Reduce the file size or raise HARNESS_MAX_UPLOAD_BYTES.`,
        detail: { size: data.byteLength, limit: this.#deps.maxUploadBytes },
      });
    }
  }

  #assertMime(mime: string): void {
    if (!mimeAllowed(mime, this.mimeAllowlist)) {
      throw err('VALIDATION_FAILED', {
        message: `mime "${mime}" is not allowed by the configured allowlist [${this.mimeAllowlist.join(', ')}]. ` +
          'Send a file whose Content-Type matches, or extend mimeAllowlist.',
        detail: { mime, allowlist: this.mimeAllowlist },
      });
    }
  }
}
