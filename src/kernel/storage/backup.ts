/**
 * 内核备份模块：主库快照（VACUUM INTO）+ uploads/extensions 归档为 tar.gz。
 *
 * 归档布局（manifest.json 永远是包内第一项）：
 * - `manifest.json`  —— { createdAt(epoch ms), kernelVersion, files[] }
 * - `db.sqlite`      —— VACUUM INTO 产出的主库一致性快照
 * - `uploads/**`     —— `<dataDir>/uploads` 递归归档（仅文件；空目录跳过，不存在则整体缺省）
 * - `extensions/**`  —— `<dataDir>/extensions` 递归归档（同上）
 *
 * `files[]` 为包内除 manifest.json 外的全部条目（相对归档根的 POSIX 路径）。
 *
 * ### 恢复流程（本阶段仅约定，实现放在阶段 11 升级模块）
 * 1. **停机**：优雅停止内核，确保无在途数据库写入与上传；
 * 2. **解包 + 校验 manifest**：读取 `manifest.json`，核对 `kernelVersion` 与当前内核兼容、
 *    `files` 列表与包内实际条目一一对应（防篡改/防截断）；
 * 3. **替换 /data**：旧数据目录先整体改名留存，再将 `db.sqlite` 还原为主库文件、
 *    `uploads/`、`extensions/` 就位；
 * 4. **重启**：内核启动后由迁移框架核对 schema，健康检查通过即恢复服务；失败则回滚旧目录。
 */

import { randomBytes } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { createGzip } from 'node:zlib';
import type { Knex } from 'knex';
import { pack, type Pack } from 'tar-stream';
import { z } from 'zod';

import { err, HarnessError } from '../errors/index.js';

/** 备份元信息（path 为 tar.gz 绝对/相对路径，createdAt 为 epoch ms） */
export interface BackupInfo {
  path: string;
  sizeBytes: number;
  createdAt: number;
}

/** manifest.json 结构（包内第一项） */
interface BackupManifest {
  createdAt: number;
  kernelVersion: string;
  files: string[];
}

/** 待归档文件（archiveName 为包内 POSIX 相对路径） */
interface ArchiveFile {
  archiveName: string;
  absPath: string;
  size: number;
  mtime: Date;
}

const MANIFEST_ENTRY = 'manifest.json';
const SNAPSHOT_ENTRY = 'db.sqlite';
const UPLOADS_DIRNAME = 'uploads';
const EXTENSIONS_DIRNAME = 'extensions';
const BACKUPS_DIRNAME = 'backups';

/** 识别备份产物（只认本模块命名，避免把临时快照/杂文件当备份） */
const BACKUP_FILE_RE = /^backup-.+\.tar\.gz$/;

const CfgSchema = z.object({ dataDir: z.string().min(1) });
const KeepSchema = z.number().int().min(0);

/** zod 校验入口：失败规整为 VALIDATION_FAILED（信息含调用点与字段路径） */
function zodParse<T>(schema: z.ZodType<T>, value: unknown, where: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const summary = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw err('VALIDATION_FAILED', {
      message: `${where}: 入参校验失败 — ${summary}`,
      detail: result.error.issues,
      cause: result.error,
    });
  }
  return result.data;
}

/** yyyyMMddHHmmss（UTC，用于备份文件名） */
function utcStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
  );
}

/** 4 位随机后缀，避免同一秒内备份互相覆盖 */
function randToken(): string {
  return randomBytes(2).toString('hex');
}

/** 读取内核版本（package.json version）；不可读时降级为 0.0.0，不阻断备份 */
async function readKernelVersion(): Promise<string> {
  try {
    const pkgPath = fileURLToPath(new URL('../../../package.json', import.meta.url));
    const pkg = JSON.parse(await readFile(pkgPath, 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * 递归收集目录下的文件（跳过目录项与符号链接等其他类型 → 空目录天然不入包）。
 * 目录不存在（ENOENT）视为整体缺省；其余读错误抛 INTERNAL。
 */
async function collectDir(rootDir: string, prefix: string, out: ArchiveFile[]): Promise<void> {
  let dirents: Dirent[];
  try {
    dirents = await readdir(rootDir, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return;
    throw HarnessError.wrap(e, 'INTERNAL');
  }
  const sorted = [...dirents].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const dirent of sorted) {
    const abs = path.join(rootDir, dirent.name);
    if (dirent.isDirectory()) {
      await collectDir(abs, `${prefix}/${dirent.name}`, out);
      continue;
    }
    if (!dirent.isFile()) continue; // symlink / fifo 等：跳过，避免越界与不可解包条目
    const st = await stat(abs);
    out.push({ archiveName: `${prefix}/${dirent.name}`, absPath: abs, size: st.size, mtime: st.mtime });
  }
}

/** 写入单个文件条目（内容一次性缓冲；回调在条目完整落盘后触发） */
function addFileEntry(p: Pack, name: string, content: Buffer, mtime: Date): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      p.entry({ name, size: content.length, mtime, type: 'file' }, content, (e) =>
        e ? reject(e) : resolve(),
      );
    } catch (e) {
      reject(e);
    }
  });
}

/** 手写打包管线：tar-stream pack → gzip → 落盘（manifest.json 先写） */
async function writeArchive(
  archivePath: string,
  manifestJson: Buffer,
  files: ArchiveFile[],
): Promise<void> {
  const p = pack();
  const done = pipeline(Readable.from(p), createGzip(), createWriteStream(archivePath));
  try {
    await addFileEntry(p, MANIFEST_ENTRY, manifestJson, new Date());
    for (const file of files) {
      await addFileEntry(p, file.archiveName, await readFile(file.absPath), file.mtime);
    }
    p.finalize();
  } catch (e) {
    p.destroy();
    await done.catch(() => {}); // 吞掉 pipeline 的伴生错误，保留原始异常
    throw HarnessError.wrap(e, 'INTERNAL');
  }
  await done;
}

/**
 * 创建备份：`VACUUM INTO` 快照主库 → 与 uploads/extensions 一并打包为
 * `<dataDir>/backups/backup-<yyyyMMddHHmmss>-<rand4>.tar.gz`。
 *
 * @param cfg `{ dataDir }`（backups 目录不存在会自动创建）
 * @param db  主库 knex 实例（better-sqlite3）
 * @returns 备份文件信息；VACUUM 失败抛 `DB_ERROR`（HARNESS-403）且临时快照被清理，
 *          其余失败抛 `INTERNAL`，半成品归档同样清理。
 */
export async function createBackup(cfg: { dataDir: string }, db: Knex): Promise<BackupInfo> {
  const { dataDir } = zodParse(CfgSchema, cfg, 'createBackup');
  const backupsDir = path.join(dataDir, BACKUPS_DIRNAME);

  const now = new Date();
  const createdAt = now.getTime();
  const snapshotPath = path.join(backupsDir, `.snapshot-${utcStamp(now)}-${randToken()}.sqlite.tmp`);
  const archivePath = path.join(backupsDir, `backup-${utcStamp(now)}-${randToken()}.tar.gz`);

  try {
    await mkdir(backupsDir, { recursive: true });

    // 1) 主库一致性快照（路径内联进 SQL，单引号按 SQL 规则翻倍转义）
    try {
      await db.raw(`VACUUM INTO '${snapshotPath.replaceAll("'", "''")}'`);
    } catch (e) {
      throw err('DB_ERROR', {
        message: `createBackup: VACUUM INTO 快照失败（目标 ${snapshotPath}）— ${
          e instanceof Error ? e.message : String(e)
        }`,
        detail: { snapshotPath },
        cause: e,
      });
    }

    // 2) 收集归档清单：db 快照 + uploads + extensions
    const files: ArchiveFile[] = [];
    const snapStat = await stat(snapshotPath);
    files.push({ archiveName: SNAPSHOT_ENTRY, absPath: snapshotPath, size: snapStat.size, mtime: now });
    await collectDir(path.join(dataDir, UPLOADS_DIRNAME), UPLOADS_DIRNAME, files);
    await collectDir(path.join(dataDir, EXTENSIONS_DIRNAME), EXTENSIONS_DIRNAME, files);

    const manifest: BackupManifest = {
      createdAt,
      kernelVersion: await readKernelVersion(),
      files: files.map((f) => f.archiveName),
    };

    // 3) 打包（manifest.json 先写）并度量
    await writeArchive(
      archivePath,
      Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'),
      files,
    );
    const archiveStat = await stat(archivePath);
    return { path: archivePath, sizeBytes: archiveStat.size, createdAt };
  } catch (e) {
    await rm(archivePath, { force: true }).catch(() => {}); // 清理半成品归档
    throw HarnessError.wrap(e, 'INTERNAL');
  } finally {
    await rm(snapshotPath, { force: true }).catch(() => {}); // 临时快照必清
  }
}

/**
 * 列出 `<dataDir>/backups` 下的备份，按 createdAt 降序。
 * 目录不存在视为无备份（返回 []）；createdAt 取文件 mtime（epoch ms，UTC 存储）。
 */
export async function listBackups(cfg: { dataDir: string }): Promise<BackupInfo[]> {
  const { dataDir } = zodParse(CfgSchema, cfg, 'listBackups');
  const backupsDir = path.join(dataDir, BACKUPS_DIRNAME);

  let names: string[];
  try {
    names = await readdir(backupsDir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    throw HarnessError.wrap(e, 'INTERNAL');
  }

  const infos: BackupInfo[] = [];
  for (const name of names.filter((n) => BACKUP_FILE_RE.test(n)).sort()) {
    const full = path.join(backupsDir, name);
    try {
      const st = await stat(full);
      if (!st.isFile()) continue;
      infos.push({ path: full, sizeBytes: st.size, createdAt: st.mtimeMs });
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') continue; // 并发被删：跳过
      throw HarnessError.wrap(e, 'INTERNAL');
    }
  }
  return infos.sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * 保留最新 keep 份备份，其余删除。
 * @returns 实际删除的份数；`keep: 0` 表示清空全部。
 */
export async function pruneBackups(cfg: { dataDir: string }, keep: number): Promise<number> {
  const { dataDir } = zodParse(CfgSchema, cfg, 'pruneBackups');
  const keepCount = zodParse(KeepSchema, keep, 'pruneBackups');

  const backups = await listBackups({ dataDir });
  const doomed = backups.slice(keepCount);
  for (const backup of doomed) {
    try {
      await rm(backup.path, { force: true });
    } catch (e) {
      throw HarnessError.wrap(e, 'INTERNAL');
    }
  }
  return doomed.length;
}
