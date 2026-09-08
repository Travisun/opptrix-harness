/**
 * 内核存储层：SQLite 连接工厂与数据库路径约定。
 *
 * - `openSqlite()`：better-sqlite3 + knex 打开单个 SQLite 文件，套用安全默认 PRAGMA 并逐一回读确认
 * - `kernelDbPath()` / `extDbPath()`：内核库与扩展库的固定路径布局（`<dataDir>/db/…`）
 * - `closeDb()`：优雅关闭；EBUSY 仅记警告不抛（关停路径不因资源忙而失败）
 * - `dbFileSize()`：主库文件字节数（不含 -wal / -shm 附属文件）
 * - `forbidDangerousSql()`：扩展 SQL 防护（多语句 / ATTACH / DETACH / load_extension）
 */
import { mkdirSync } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import knex, { type Knex } from 'knex';

import { HarnessError, err } from '../errors/index.js';

/** 合法扩展 ID：小写字母/数字开头，其后允许小写字母、数字、点、下划线、连字符 */
const EXT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/** busy_timeout 默认值（毫秒）：写冲突时的等待上限 */
const BUSY_TIMEOUT_MS = 5000;

// ---------------------------------------------------------------------------
// 连接工厂
// ---------------------------------------------------------------------------

/**
 * 打开（或创建）一个 SQLite 文件库，并应用安全默认 PRAGMA：
 *
 * - `journal_mode = WAL`：读写并发友好（内存库不支持 WAL，故必须传文件路径）
 * - `foreign_keys = ON`：强制外键约束
 * - `busy_timeout = 5000`：写冲突时等待 5 秒再报忙
 * - `synchronous = NORMAL`：WAL 模式下的推荐持久化档位
 *
 * 每项 PRAGMA 都在设置后回读确认，任何一项不符即视为打开失败（抛
 * `HARNESS-4003` DB_ERROR），并销毁半初始化的连接。
 *
 * @param file SQLite 数据库文件路径；缺失的父目录会自动递归创建
 * @returns 就绪的 knex 实例（调用方负责用 {@link closeDb} 关闭）
 * @throws HarnessError（DB_ERROR）PRAGMA 设置或回读确认失败
 */
export async function openSqlite(file: string): Promise<Knex> {
  await mkdir(dirname(file), { recursive: true });
  const db = knex({
    client: 'better-sqlite3',
    connection: { filename: file },
    useNullAsDefault: true,
    pool: { min: 1, max: 1 },
  });
  try {
    // synchronous 取值：1 = NORMAL（WAL 推荐档）；journal_mode 应回读 'wal'
    await assertPragma(db, 'PRAGMA journal_mode = WAL', 'PRAGMA journal_mode', 'wal');
    await assertPragma(db, 'PRAGMA foreign_keys = ON', 'PRAGMA foreign_keys', 1);
    await assertPragma(db, `PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`, 'PRAGMA busy_timeout', BUSY_TIMEOUT_MS);
    await assertPragma(db, 'PRAGMA synchronous = NORMAL', 'PRAGMA synchronous', 1);
  } catch (e) {
    await db.destroy().catch(() => {
      /* 半初始化连接的兜底关闭：失败也以首个错误为准 */
    });
    throw e;
  }
  return db;
}

/** 取 knex raw 结果（行对象数组）第一行第一个单元格的值；形状不符返回 undefined */
function firstCellValue(result: unknown): unknown {
  if (!Array.isArray(result)) return undefined;
  const row = result[0] as Record<string, unknown> | undefined;
  if (row === null || typeof row !== 'object') return undefined;
  return Object.values(row)[0];
}

/**
 * 设置并回读确认一条 PRAGMA；不符即抛 DB_ERROR。
 * setter 语句与检查语句分开（部分 PRAGMA setter 不返回行，回读是唯一可靠确认方式）。
 */
async function assertPragma(db: Knex, setSql: string, checkSql: string, expected: string | number): Promise<void> {
  await db.raw(setSql);
  const actual = firstCellValue(await db.raw(checkSql));
  const actualText = actual === undefined ? 'undefined' : String(actual);
  const ok =
    typeof expected === 'string' ? actualText.toLowerCase() === expected : Number(actualText) === expected;
  if (!ok) {
    throw err('DB_ERROR', {
      message:
        `sqlite pragma check failed: expected "${checkSql}" to be ${JSON.stringify(expected)}, ` +
        `got "${actualText}". The database file may be corrupted, on an unsupported filesystem, ` +
        'or locked by another process.',
      detail: { pragma: checkSql, expected, actual: actualText },
    });
  }
}

// ---------------------------------------------------------------------------
// 路径约定
// ---------------------------------------------------------------------------

/**
 * 内核主库路径：`<dataDir>/db/kernel.sqlite`。
 *
 * @param cfg 任意含 `dataDir` 的配置（兼容 HarnessConfig 的结构子集）
 */
export function kernelDbPath(cfg: { dataDir: string }): string {
  return join(cfg.dataDir, 'db', 'kernel.sqlite');
}

/**
 * 扩展专属库路径：`<dataDir>/db/ext/<extId>.sqlite`。
 *
 * extId 必须匹配 `/^[a-z0-9][a-z0-9._-]*$/`（小写字母/数字开头，仅含小写字母、
 * 数字、点、下划线、连字符），天然排除路径分隔符与 `..` 前缀注入；不合法即抛
 * `HARNESS-3001` EXT_MANIFEST_INVALID。`db/ext` 目录不存在时会递归创建。
 *
 * @param cfg 任意含 `dataDir` 的配置（兼容 HarnessConfig 的结构子集）
 * @param extId 扩展 ID（manifest 中的 `id` 字段）
 * @returns 该扩展专属 SQLite 文件的绝对路径
 * @throws HarnessError（EXT_MANIFEST_INVALID）extId 不符合命名约束
 */
export function extDbPath(cfg: { dataDir: string }, extId: string): string {
  if (!EXT_ID_PATTERN.test(extId)) {
    throw err('EXT_MANIFEST_INVALID', {
      message:
        `extension id "${extId}" is invalid: must match ${EXT_ID_PATTERN.source} ` +
        '(lowercase alnum first, then lowercase alnum / dot / underscore / hyphen). ' +
        'Fix the "id" field in the extension manifest.',
      detail: { extId, pattern: EXT_ID_PATTERN.source },
    });
  }
  const dir = join(cfg.dataDir, 'db', 'ext');
  mkdirSync(dir, { recursive: true });
  return join(dir, `${extId}.sqlite`);
}

// ---------------------------------------------------------------------------
// 生命周期与运维
// ---------------------------------------------------------------------------

/**
 * 关闭 knex 连接（销毁连接池）。
 *
 * 关停路径不允许因资源忙而失败：销毁时若遇 EBUSY / SQLITE_BUSY，仅通过
 * `process.emitWarning` 记录警告并正常返回；其余错误包装为
 * `HARNESS-4003` DB_ERROR 抛出（保留原始 message 与 cause）。
 *
 * @param db 待关闭的 knex 实例；重复关闭是安全的（knex 会复用首次销毁的 promise）
 * @throws HarnessError（DB_ERROR）销毁失败且不是资源忙
 */
export async function closeDb(db: Knex): Promise<void> {
  try {
    await db.destroy();
  } catch (e) {
    if (isBusyError(e)) {
      const warning = new Error(
        `[storage] closeDb: sqlite connection is busy (EBUSY), destroy skipped: ${errorText(e)}`,
      );
      warning.name = 'EBUSY';
      process.emitWarning(warning);
      return;
    }
    throw HarnessError.wrap(e, 'DB_ERROR');
  }
}

/** 判断错误是否为 sqlite/文件系统"资源忙"类错误（EBUSY / SQLITE_BUSY，看 code 或 message） */
function isBusyError(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException | null | undefined)?.code;
  if (code === 'EBUSY' || code === 'SQLITE_BUSY') return true;
  return /\bEBUSY\b|\bSQLITE_BUSY\b/.test(errorText(e));
}

/** 任意错误的文本形式（Error 取 message，其余 String() 化） */
function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * 主库文件大小（字节）。
 *
 * 只统计主文件本身，不含 `-wal` / `-shm` 附属文件；文件不存在返回 0，
 * 其余 stat 错误包装为 `HARNESS-4003` DB_ERROR 抛出。
 *
 * @param file 主库文件路径
 * @throws HarnessError（DB_ERROR）stat 失败且不是"文件不存在"
 */
export async function dbFileSize(file: string): Promise<number> {
  try {
    return (await stat(file)).size;
  } catch (e) {
    if ((e as NodeJS.ErrnoException | null | undefined)?.code === 'ENOENT') return 0;
    throw HarnessError.wrap(e, 'DB_ERROR');
  }
}

// ---------------------------------------------------------------------------
// SQL 防护
// ---------------------------------------------------------------------------

/**
 * SQLite 字面量（字符串 / 双引号标识符 / 反引号标识符 / [方括号标识符]）。
 * 单双引号支持 `''` / `""` 转义；未闭合的字面量不匹配（其中的分号会被计数，fail-closed）。
 */
const SQL_LITERAL_PATTERN = /'(?:[^']|'')*'|"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]/g;

/** 禁止的关键词（大小写不敏感、词边界）：ATTACH / DETACH / load_extension */
const FORBIDDEN_KEYWORD_PATTERN = /\b(?:attach|detach|load_extension)\b/i;

/**
 * 扩展 SQL 单语句防护（供 `h.db.raw` 等入口在执行前调用）。
 *
 * 规则（先剥离字符串/标识符字面量，再校验，避免字面量内容误伤）：
 * 1. 多语句：剥离字面量后按分号计数，多于 1 个即拒绝（允许单个结尾分号）
 * 2. 危险关键词：ATTACH / DETACH / load_extension，大小写不敏感、要求词边界
 *
 * 注意：校验是保守的——出现在 SQL 注释中的关键词同样会被拒绝（fail-closed）；
 * 多语句中"仅 1 个分号且末尾还有内容"的写法由 better-sqlite3 自身的
 * 单语句 prepare 检查兜底拒绝。
 *
 * @param sql 待校验的原始 SQL 文本
 * @throws HarnessError（DB_STATEMENT_FORBIDDEN）多语句或包含危险关键词
 */
export function forbidDangerousSql(sql: string): void {
  const stripped = sql.replace(SQL_LITERAL_PATTERN, ' ');

  const semicolonCount = stripped.split(';').length - 1;
  if (semicolonCount > 1) {
    throw err('DB_STATEMENT_FORBIDDEN', {
      message:
        'sql rejected: multiple statements are not allowed. ' +
        'Execute one statement per call and drop the extra semicolons.',
      detail: { reason: 'multi-statement', semicolonCount, excerpt: excerpt(stripped) },
    });
  }

  const keyword = FORBIDDEN_KEYWORD_PATTERN.exec(stripped)?.[0];
  if (keyword !== undefined) {
    throw err('DB_STATEMENT_FORBIDDEN', {
      message:
        `sql rejected: "${keyword}" is not allowed. ` +
        'ATTACH/DETACH/load_extension can escape the per-extension database sandbox.',
      detail: { reason: 'forbidden-keyword', keyword, excerpt: excerpt(stripped) },
    });
  }
}

/** 错误详情用的 SQL 摘录（字面量已剥离，截断到 120 字符，避免详情里泄露数据） */
function excerpt(strippedSql: string): string {
  const oneLine = strippedSql.replace(/\s+/g, ' ').trim();
  return oneLine.length <= 120 ? oneLine : `${oneLine.slice(0, 117)}...`;
}
