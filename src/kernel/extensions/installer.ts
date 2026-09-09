/**
 * installer — 本地扩展包安装（zip 解包落位到数据卷）。
 *
 * 职责：`installExtensionZip(cfg, zipPath, opts?)` 把扩展 zip 包安装到
 * `<dataDir>/extensions/<manifest.id>/`（与 ExtensionManager 的发现目录一致：
 * 安装后经 cfg.onInstalled 回调接 manager.rescan() 即免重启发现，新扩展 enabled=false）。
 *
 * 流程（对应安全闸次序）：
 * 1. 受信目录保护（fail-closed）：安装目标恒为 `<cfg.dataDir>/extensions/<id>`，与受信
 *    第一方扩展目录 repoRoot/extensions（cfg.extensionsRepoDir）是**不同路径**——前者在
 *    数据卷、后者在代码仓库，正常接线下绝无交集；若错误接线使两者解析后相同（如 dataDir
 *    误指仓库根），直接 BAD_REQUEST 拒绝安装，绝不写入受信目录（否则等于用 zip 覆盖
 *    第一方扩展 / 骗取 builtin 池放置）。
 * 2. 打开 zip：unzipper.Open.file 只读条目清单，**手动逐条目 writeFile 解包**（从不调用
 *    fs.symlink/link，结构上不可能产生链接）；同时逐条目过闸：
 *    · zip-slip 防御——成员路径归一化（反斜杠→'/'）后，绝对路径 / 盘符（`C:`）/ `..` 段
 *      （路径穿越）/ NUL / 空・`.`・末尾段 一律 VALIDATION_FAILED 拒绝；
 *    · symlink 成员防御——unix 归档（versionMadeBy 高字节=3）且 externalFileAttributes
 *      高 16 位为 S_IFLNK 的条目拒绝（unzipper 不暴露 mode，按 central directory 原值判别）。
 * 3. 布局探测：zip 两态兼容（同 src/kernel/plugins/installer.ts 手法）——单顶层目录
 *   （如 `demo-ext/manifest.json`）或根布局（`manifest.json` 在 zip 根）；两者皆无 →
 *   EXT_MANIFEST_INVALID（必须含 manifest.json）。
 * 4. 解包到临时目录 `<dataDir>/.ext-staging-<mkdtemp>`（数据卷内保证 rename 同文件系统；
 *   在 extensions 根**之外**，半成品绝不会被 manager 扫描发现），读出 manifest.json →
 *   validateManifest + checkApiCompat + validatePermissions（复用 manifest.ts，本文件不改其契约：
 *   EXT_MANIFEST_INVALID 400 / EXT_API_INCOMPATIBLE 409）。
 * 5. 落位：目标 `<dataDir>/extensions/<manifest.id>`——已存在且未 overwrite →
 *   BAD_REQUEST（message: 'extension id already installed, use overwrite'）；
 *   overwrite=true → 先 rm 旧目录再 rename（staging → 目标，同卷原子；失败自动清理
 *   staging 不留半成品）。落位成功后调用 cfg.onInstalled(id)（集成方接 rescan）。
 *
 * 注：manifest 自声明 builtin/mount 不在此处裁决——manager 激活期的 SEC-3 受信闸
 * （isTrustedExtDir + authMounts.validateMount）会拒绝非受信目录的此类声明，安装层
 * 不做二次裁剪（保持包内容原样落盘，信任判定以内核激活链为准）。
 */
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import unzipper, { type UnzipEntry } from 'unzipper';

import { err } from '../errors/index.js';
import {
  checkApiCompat,
  validateManifest,
  validatePermissions,
  type ExtensionManifest,
} from './manifest.js';

/** installExtensionZip 的安装配置 */
export interface ExtInstallConfig {
  /**
   * 数据根目录。安装落点恒为 `<dataDir>/extensions/<manifest.id>`（数据卷），
   * 与受信第一方扩展目录（repoRoot/extensions）是不同路径——安装绝不会写入仓库受信目录；
   * 与 extensionsRepoDir 解析后相同时 fail-closed 拒绝（见模块头注释第 1 步）。
   */
  dataDir: string;
  /**
   * 受信第一方扩展目录（repoRoot/extensions）。仅作受信目录保护判定的输入：
   * 与解析后的安装根 `<dataDir>/extensions` 相同 → BAD_REQUEST 拒绝安装。
   */
  extensionsRepoDir?: string;
  /** 安装成功回调（集成方接 manager.rescan() 免重启发现）；仅在落位成功后调用，失败路径不触发 */
  onInstalled?: (id: string) => void | Promise<void>;
}

/** installExtensionZip 的可选参数 */
export interface ExtInstallOptions {
  /** 目标 id 已存在时是否覆盖安装（先删旧目录再原子落位）。缺省 false */
  overwrite?: boolean;
}

/** 安装结果摘要（REST 层 201 响应与 UI 确认 Dialog 的数据源） */
export interface ExtInstallResult {
  id: string;
  version: string;
  /** 扩展 API 版本（manifest.api） */
  api: number;
  displayName?: string;
  permissions: string[];
  /** 安装落位目录绝对路径（`<dataDir>/extensions/<id>`） */
  dir: string;
}

/** `<dataDir>/extensions` 安装根（与 ExtensionManager 的发现目录约定一致） */
function extensionsRoot(cfg: ExtInstallConfig): string {
  return path.join(cfg.dataDir, 'extensions');
}

// ---------------------------------------------------------------------------
// zip 成员安全闸
// ---------------------------------------------------------------------------

/**
 * zip 成员路径安全闸：反斜杠 → '/' 归一化后，要求"包内相对路径"——
 * 绝对路径 / 盘符（`C:`）/ NUL / 空、`.`、`..` 段（路径穿越）一律拒绝。
 */
function normalizeZipMemberPath(raw: string): string | null {
  if (typeof raw !== 'string' || raw === '') return null;
  const normalized = raw.replaceAll('\\', '/');
  if (normalized.includes('\0')) return null;
  if (normalized.startsWith('/')) return null;
  if (/^[a-zA-Z]:/.test(normalized)) return null;
  for (const seg of normalized.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return null;
  }
  return normalized;
}

/** unix 归档标记（versionMadeBy 高字节 = 3） */
const VERSION_MADE_BY_UNIX = 3;
/** posix file type 掩码与 symlink 位（external attrs 高 16 位为 mode） */
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

/**
 * symlink 成员判别：unzipper 不解析 mode，按 central directory 原始字段判别——
 * unix 归档（versionMadeBy >> 8 === 3）且 externalFileAttributes 高 16 位的 file type
 * 为 S_IFLNK → symlink 条目，拒绝。（非 unix 归档或字段缺失不判 symlink；即便漏判，
 * 本安装器的手动 writeFile 解包在结构上也不可能产生文件系统链接。）
 */
function isSymlinkEntry(entry: UnzipEntry): boolean {
  const raw = entry as unknown as { versionMadeBy?: number; externalFileAttributes?: number };
  if (typeof raw.versionMadeBy !== 'number' || typeof raw.externalFileAttributes !== 'number') {
    return false;
  }
  if (raw.versionMadeBy >> 8 !== VERSION_MADE_BY_UNIX) return false;
  return ((raw.externalFileAttributes >>> 16) & S_IFMT) === S_IFLNK;
}

/**
 * 打开 zip 并构建「归一化相对路径 → 条目」清单。
 * 穿越/绝对路径成员、symlink 成员一律 VALIDATION_FAILED 拒绝；目录条目跳过
 * （解包时按文件条目 mkdir -p 重建层级）。
 */
async function openZipEntries(zipPath: string): Promise<Map<string, UnzipEntry>> {
  let archive;
  try {
    archive = await unzipper.Open.file(zipPath);
  } catch (cause) {
    throw err('VALIDATION_FAILED', {
      message: `unable to open extension package (is it a valid zip file?): ${zipPath}`,
      cause,
    });
  }
  const files = new Map<string, UnzipEntry>();
  for (const entry of archive.files) {
    if (entry.type === 'Directory') continue;
    const normalized = normalizeZipMemberPath(entry.path);
    if (normalized === null) {
      throw err('VALIDATION_FAILED', {
        message:
          'extension package contains an unsafe member path and was rejected ' +
          '(absolute path, drive letter, ".." segment, or empty segment)',
        detail: { member: entry.path },
      });
    }
    if (isSymlinkEntry(entry)) {
      throw err('VALIDATION_FAILED', {
        message: 'extension package contains a symlink member and was rejected',
        detail: { member: entry.path },
      });
    }
    files.set(normalized, entry);
  }
  if (files.size === 0) {
    throw err('VALIDATION_FAILED', { message: 'extension package contains no file entries' });
  }
  return files;
}

/**
 * zip 布局探测：返回剥离的顶层前缀（'' = 根布局）。
 * 全部文件共享同一首段 `S` 且存在 `S/manifest.json` → 单顶层目录布局（剥离 `S/`）；
 * 否则存在根 `manifest.json` → 根布局；两者皆无 → EXT_MANIFEST_INVALID（包必须含 manifest.json）。
 */
function detectZipRoot(files: Map<string, UnzipEntry>): string {
  const paths = [...files.keys()];
  const firstSegments = new Set(paths.map((p) => (p.includes('/') ? p.slice(0, p.indexOf('/')) : p)));
  if (firstSegments.size === 1 && paths.every((p) => p.includes('/'))) {
    const top = [...firstSegments][0] as string;
    if (files.has(`${top}/manifest.json`)) return top;
  }
  if (files.has('manifest.json')) return '';
  throw err('EXT_MANIFEST_INVALID', {
    message: 'extension package is missing manifest.json (expected it at the zip root, or under a single top-level directory)',
    detail: { sampleMembers: paths.slice(0, 5) },
  });
}

// ---------------------------------------------------------------------------
// manifest 读取与校验（复用 manifest.ts，契约不改）
// ---------------------------------------------------------------------------

/** 从落位后的 staging 目录读出并校验 manifest.json */
async function readManifestFromStaging(stagingDir: string): Promise<ExtensionManifest> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path.join(stagingDir, 'manifest.json'), 'utf8'));
  } catch (cause) {
    throw err('EXT_MANIFEST_INVALID', {
      message: 'manifest.json is missing from the package or is not valid JSON',
      cause,
    });
  }
  const manifest = validateManifest(raw); // 非法形状 → EXT_MANIFEST_INVALID（detail 携带 zod issues）
  checkApiCompat(manifest); // api 版本不兼容 → EXT_API_INCOMPATIBLE
  validatePermissions(manifest); // 白名单外权限 → EXT_MANIFEST_INVALID（激活前 fail-fast）
  return manifest;
}

// ---------------------------------------------------------------------------
// 公开 API
// ---------------------------------------------------------------------------

/**
 * 安装扩展 zip 包到 `<dataDir>/extensions/<manifest.id>/`。
 *
 * @param cfg 安装配置（dataDir / extensionsRepoDir 保护判定 / onInstalled 回调）
 * @param zipPath zip 文件路径
 * @param opts.overwrite 目标已存在时是否覆盖（缺省 false；重复安装 → BAD_REQUEST
 *        'extension id already installed, use overwrite'）
 * @returns 安装摘要（id / api / version / displayName / permissions / dir）
 * @throws BAD_REQUEST 受信目录重叠或同 id 已安装且未 overwrite；
 *         VALIDATION_FAILED 非法 zip / 穿越・绝对路径・symlink 成员；
 *         EXT_MANIFEST_INVALID 缺 manifest.json / 清单非法 / 未知权限；
 *         EXT_API_INCOMPATIBLE manifest.api 不受当前内核支持
 */
export async function installExtensionZip(
  cfg: ExtInstallConfig,
  zipPath: string,
  opts?: ExtInstallOptions,
): Promise<ExtInstallResult> {
  // 1. 受信目录保护（fail-closed）：安装根与受信第一方目录解析后相同 → 拒绝。
  //    正常接线（dataDir=数据卷）下两者是不同路径，安装目标绝不可能是 repoRoot/extensions。
  const root = extensionsRoot(cfg);
  if (cfg.extensionsRepoDir !== undefined && path.resolve(root) === path.resolve(cfg.extensionsRepoDir)) {
    throw err('BAD_REQUEST', {
      message:
        'extension install target resolves to the trusted first-party extensions directory; refusing to install',
      detail: { targetRoot: path.resolve(root), trustedDir: path.resolve(cfg.extensionsRepoDir) },
    });
  }

  // 2. 打开 zip + 成员安全闸（zip-slip / symlink）
  const files = await openZipEntries(zipPath);

  // 3. 布局探测（必须含 manifest.json）
  const zipRoot = detectZipRoot(files);

  // 4. 解包到临时目录（数据卷内、extensions 根之外 → 半成品不可被发现；同卷 rename 原子）
  const staging = await mkdtemp(path.join(cfg.dataDir, '.ext-staging-'));
  try {
    for (const [rel, entry] of files) {
      const targetRel = zipRoot === '' ? rel : rel.slice(zipRoot.length + 1);
      const target = path.join(staging, targetRel);
      // 防御复核：目标必须仍在 staging 内（normalizeZipMemberPath 已保证，双保险）
      const inside = path.relative(staging, target);
      if (inside === '' || inside.startsWith('..') || path.isAbsolute(inside)) {
        throw err('VALIDATION_FAILED', {
          message: 'extension package member escapes the staging directory and was rejected',
          detail: { member: entry.path },
        });
      }
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, await entry.buffer());
    }

    // 5. manifest 校验（必须含 manifest.json → validateManifest + checkApiCompat + validatePermissions）
    const manifest = await readManifestFromStaging(staging);

    // 6. 落位：重复闸 →（overwrite）删旧 → rename 原子落位
    const dest = path.join(root, manifest.id);
    let destExists = false;
    try {
      await stat(dest);
      destExists = true;
    } catch {
      destExists = false;
    }
    if (destExists && opts?.overwrite !== true) {
      throw err('BAD_REQUEST', { message: 'extension id already installed, use overwrite' });
    }
    await mkdir(root, { recursive: true });
    if (destExists) {
      await rm(dest, { recursive: true, force: true });
    }
    await rename(staging, dest);

    // 7. 安装成功回调（集成方接 rescan；失败路径不触发）
    await cfg.onInstalled?.(manifest.id);

    return {
      id: manifest.id,
      version: manifest.version,
      api: manifest.api,
      ...(manifest.displayName !== undefined ? { displayName: manifest.displayName } : {}),
      permissions: [...manifest.permissions],
      dir: dest,
    };
  } finally {
    // 成功时 staging 已 rename 走（force 兜底空路径）；失败时清掉半成品
    await rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}
