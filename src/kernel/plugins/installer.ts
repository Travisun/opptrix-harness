/**
 * installer — 插件包安装（zip 解包 / 目录直装）。
 *
 * 职责：
 * - `installPluginZip(cfg, zipPath, opts?)`：解包 zip 到 `<dataDir>/plugins/<id>/`。
 *   zip 布局两态兼容：单顶层目录（如 `demo/plugin.json`）或直接根布局
 *   （`plugin.json` 在 zip 根）。成员路径先归一化再过闸——绝对路径 / 盘符 /
 *   `..` 段（路径穿越）一律拒绝；`plugin.json` 缺失或非法 → VALIDATION_FAILED。
 * - `installPluginDir(cfg, srcDir)`：目录直装（开发用），语义与 zip 相同
 *   （校验清单 → 校验引用文件 → 拷贝到 staging → 原子 rename 到位）。
 *
 * 安全与一致性：
 * - 安装目录名恒取 `plugin.json` 的 `id`（与 zip 内顶层目录名无关）；
 * - 先解包到 `<dataDir>/plugins/.staging-<uuid>` 再 rename，失败自动清理，
 *   不留半成品（refresh 扫描跳过 `.` 开头目录，双重隔离）；
 * - 已存在同 id 且未给 `overwrite: true` → BAD_REQUEST
 *   （message: 'plugin id already installed, use overwrite'）；
 * - 清单中 `skills[].file` / `scripts[].file` 引用的文件必须在包内真实存在。
 *
 * 持久与升级语义：插件装在 `<dataDir>/plugins/`（数据卷）。内核 A/B 升级只替换
 * releases/slot 目录，**绝不触碰 /data/plugins**；升级后由集成层调用
 * `PluginRegistry.refresh()` 重新聚合。
 */
import { randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import unzipper, { type UnzipEntry } from 'unzipper';

import { err } from '../errors/index.js';
import {
  isSafePluginRelativePath,
  toInstalledPlugin,
  validatePluginManifest,
  type InstalledPlugin,
  type PluginManifest,
} from './types.js';

/** 安装配置（与内核 config.dataDir 同源） */
export interface PluginInstallConfig {
  /** 数据根目录；插件安装在 `<dataDir>/plugins/` 下 */
  dataDir: string;
}

/** installPluginZip 的可选参数 */
export interface PluginInstallOptions {
  /** 目标 id 已存在时是否覆盖安装（先删旧目录再原子落位）。缺省 false */
  overwrite?: boolean;
}

/** `<dataDir>/plugins` 根目录 */
function pluginsRoot(cfg: PluginInstallConfig): string {
  return path.join(cfg.dataDir, 'plugins');
}

/** 插件安装目录：`<dataDir>/plugins/<id>` */
function pluginInstallDir(cfg: PluginInstallConfig, pluginId: string): string {
  return path.join(pluginsRoot(cfg), pluginId);
}

// ---------------------------------------------------------------------------
// zip 成员归一化与布局探测
// ---------------------------------------------------------------------------

/**
 * zip 成员路径归一化：反斜杠 → '/'，随后过相对路径安全闸。
 * 不安全（绝对路径 / 盘符 / `..` 段）返回 null，由调用方统一拒绝。
 */
function normalizeZipMemberPath(raw: string): string | null {
  const normalized = raw.replaceAll('\\', '/');
  return isSafePluginRelativePath(normalized) ? normalized : null;
}

/** 打开 zip 并构建「归一化相对路径 → 条目」清单；穿越成员直接拒绝 */
async function openZipEntries(zipPath: string): Promise<Map<string, UnzipEntry>> {
  let archive;
  try {
    archive = await unzipper.Open.file(zipPath);
  } catch (cause) {
    throw err('VALIDATION_FAILED', {
      message: `unable to open plugin package (is it a valid zip file?): ${zipPath}`,
      cause,
    });
  }
  const files = new Map<string, UnzipEntry>();
  for (const entry of archive.files) {
    if (entry.type !== 'File') continue;
    const normalized = normalizeZipMemberPath(entry.path);
    if (normalized === null) {
      throw err('VALIDATION_FAILED', {
        message: `plugin package contains an unsafe member path and was rejected (absolute path, drive letter, or ".." segment): "${entry.path}"`,
        detail: { member: entry.path },
      });
    }
    files.set(normalized, entry);
  }
  return files;
}

/**
 * zip 布局探测：返回剥离的顶层前缀（'' = 根布局）。
 * 规则：全部文件条目共享同一首段 `S` 且存在 `S/plugin.json` → 单顶层目录布局（剥离 `S/`）；
 * 否则若存在根 `plugin.json` → 根布局；两者皆无 → VALIDATION_FAILED。
 */
function detectZipRoot(files: Map<string, UnzipEntry>): string {
  const paths = [...files.keys()];
  const firstSegments = new Set(paths.map((p) => (p.includes('/') ? p.slice(0, p.indexOf('/')) : p)));
  if (firstSegments.size === 1 && paths.every((p) => p.includes('/'))) {
    const top = [...firstSegments][0] as string;
    if (files.has(`${top}/plugin.json`)) return top;
  }
  if (files.has('plugin.json')) return '';
  throw err('VALIDATION_FAILED', {
    message: 'plugin package is missing plugin.json (expected it at the zip root, or under a single top-level directory)',
    detail: { sampleMembers: paths.slice(0, 5) },
  });
}

// ---------------------------------------------------------------------------
// 清单读取与引用文件校验
// ---------------------------------------------------------------------------

/** 从归一化清单中读出并校验 plugin.json */
async function readManifestFromZip(files: Map<string, UnzipEntry>, root: string): Promise<PluginManifest> {
  const entry = files.get(`${root === '' ? '' : `${root}/`}plugin.json`);
  if (entry === undefined) {
    // detectZipRoot 已保证可达，此为防御分支
    throw err('VALIDATION_FAILED', { message: 'plugin.json is missing from the package' });
  }
  let raw: unknown;
  try {
    raw = JSON.parse((await entry.buffer()).toString('utf8'));
  } catch (cause) {
    throw err('VALIDATION_FAILED', {
      message: 'plugin.json is not valid JSON',
      cause,
    });
  }
  return validatePluginManifest(raw);
}

/** 清单内 file 引用必须真实存在于包内（zip 布局或目录布局统一在剥离前缀后的相对空间核对） */
async function assertReferencedFilesExist(
  manifest: PluginManifest,
  exists: (rel: string) => Promise<boolean>,
): Promise<void> {
  const refs = [
    ...manifest.skills.filter((s) => s.file !== undefined).map((s) => s.file as string),
    ...manifest.scripts.map((s) => s.file),
  ];
  for (const rel of refs) {
    if (!(await exists(rel))) {
      throw err('VALIDATION_FAILED', {
        message: `plugin.json references a file that is not present in the package: "${rel}"`,
        detail: { missingFile: rel, pluginId: manifest.id },
      });
    }
  }
}

// ---------------------------------------------------------------------------
// 落盘（staging → 原子 rename）
// ---------------------------------------------------------------------------

/**
 * 共用落位流程：构建 staging 目录 → populate → 删旧（overwrite）→ rename 到位。
 * staging 固定放在 plugins 根下、以 '.' 开头（refresh 扫描跳过），失败自动清理。
 */
async function finalizeInstall(
  cfg: PluginInstallConfig,
  manifest: PluginManifest,
  populate: (stagingDir: string) => Promise<void>,
  opts?: PluginInstallOptions,
): Promise<InstalledPlugin> {
  const root = pluginsRoot(cfg);
  await mkdir(root, { recursive: true });
  const dest = pluginInstallDir(cfg, manifest.id);
  let destExists = false;
  try {
    await stat(dest);
    destExists = true;
  } catch {
    destExists = false;
  }
  if (destExists && opts?.overwrite !== true) {
    throw err('BAD_REQUEST', { message: 'plugin id already installed, use overwrite' });
  }

  const staging = path.join(root, `.staging-${randomUUID()}`);
  try {
    await mkdir(staging, { recursive: true });
    await populate(staging);
    if (destExists) {
      await rm(dest, { recursive: true, force: true });
    }
    await rename(staging, dest);
  } catch (cause) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    throw cause instanceof Error ? cause : new Error(String(cause));
  }
  return toInstalledPlugin(manifest, new Date().toISOString());
}

// ---------------------------------------------------------------------------
// 公开 API
// ---------------------------------------------------------------------------

/**
 * 安装插件 zip 包到 `<dataDir>/plugins/<id>/`。
 *
 * @param cfg 安装配置（dataDir）
 * @param zipPath zip 文件路径
 * @param opts.overwrite 目标已存在时是否覆盖（缺省 false，重复安装 → BAD_REQUEST）
 * @returns InstalledPlugin 摘要
 * @throws VALIDATION_FAILED 非法 zip / 穿越成员 / plugin.json 缺失或非法 / 引用文件缺失；
 *          BAD_REQUEST 同 id 已安装且未 overwrite
 */
export async function installPluginZip(
  cfg: PluginInstallConfig,
  zipPath: string,
  opts?: PluginInstallOptions,
): Promise<InstalledPlugin> {
  const files = await openZipEntries(zipPath);
  const root = detectZipRoot(files);
  const manifest = await readManifestFromZip(files, root);
  await assertReferencedFilesExist(manifest, async (rel) =>
    files.has(`${root === '' ? '' : `${root}/`}${rel}`),
  );

  return finalizeInstall(cfg, manifest, async (staging) => {
    for (const [rel, entry] of files) {
      const targetRel = root === '' ? rel : rel.slice(root.length + 1);
      const target = path.join(staging, targetRel);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, await entry.buffer());
    }
  }, opts);
}

/**
 * 目录直装（开发用）：校验 `<srcDir>/plugin.json` 与引用文件后整目录拷贝到
 * `<dataDir>/plugins/<id>/`。语义与 `installPluginZip` 一致（含 overwrite）。
 */
export async function installPluginDir(
  cfg: PluginInstallConfig,
  srcDir: string,
  opts?: PluginInstallOptions,
): Promise<InstalledPlugin> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path.join(srcDir, 'plugin.json'), 'utf8'));
  } catch (cause) {
    throw err('VALIDATION_FAILED', {
      message: `unable to read plugin.json from "${srcDir}" (missing or not valid JSON)`,
      cause,
    });
  }
  const manifest = validatePluginManifest(raw);
  await assertReferencedFilesExist(manifest, async (rel) => {
    try {
      const st = await stat(path.join(srcDir, rel));
      return st.isFile();
    } catch {
      return false;
    }
  });

  return finalizeInstall(cfg, manifest, async (staging) => {
    await cp(srcDir, staging, { recursive: true });
  }, opts);
}
