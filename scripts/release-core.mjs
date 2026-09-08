/**
 * scripts/release-core.mjs — 发布核心逻辑（可导入、可测试）。
 *
 * scripts/release.mjs 是薄入口（argv 解析 + 输出摘要）；本文件导出纯函数
 * buildRelease(opts)，供入口与 test/release.test.ts 复用。
 *
 * ## 发布产物（写入 <outDir>，默认 <projectRoot>/release）
 * - `opptrix-harness-<version>.tar.gz`      —— 发布包（布局见下）
 * - `opptrix-harness-<version>.tar.gz.sha256` —— sha256sum 格式：`<hex>  <文件名>`
 * - `feed-<channel>.json`                   —— 升级 feed（HARNESS_UPDATE_FEED 消费）：
 *   `{"<channel>":{"channel","version","url","sha256","notes"}}`。
 *   形状对齐 src/kernel/update/updater.ts 的 feedDocSchema：条目必填 channel 字段；
 *   未发布频道**整体缺省**（任务书原案的 `"beta":null` 会被升级器 zod 拒绝——
 *   optional() 不接受 null，故以真实消费方契约为准）。
 *
 * ## 包内布局（与内核 storage/backup.ts 同款约定：manifest.json 永远是包内第一项）
 * - `manifest.json`    —— { createdAt(epoch ms), version, channel, files[] }
 * - `dist/**`          —— tsc 编译产物（入口 dist/main.js）
 * - `node_modules/**`  —— **整个** node_modules 原样复制（含 dev 依赖）。
 *   正确性优先：better-sqlite3 的 install 脚本（prebuild 下载/本地编译）无法在
 *   `npm ci --omit=dev --ignore-scripts` 下安全工作，剔除 dev 依赖子集又极易漏剔；
 *   体积优化留待 T1（如 `npm ci --omit=dev` 到独立目录 + 保留脚本执行）。
 * - `bootstrap.mjs`    —— 仓库根启动器（读取 <dataDir>/releases/slots.json）
 * - `package.json`     —— 元信息（发布不改动源 version；--version 仅命名产物）
 * - `types/**`         —— 扩展作者类型声明
 *
 * ## 幂等
 * outDir 下任一同名产物已存在 → 抛 RELEASE_CONFLICT（`--force` / `force: true` 覆盖）。
 *
 * 【脚本例外说明】本目录为构建/发布脚本，不经过内核 API 边界，故不使用
 * HarnessError（那是 src/kernel 的约束）；错误以 ReleaseError（带 code）抛出，
 * 由入口转为退出码与 process.stderr 输出（禁 console.* 对脚本的注明例外）。
 */

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { valid as semverValid } from 'semver';
import { pack } from 'tar-stream';
import { z } from 'zod';

/** 发布脚本错误（code 供入口映射退出码/文案，测试断言用） */
export class ReleaseError extends Error {
  /** 稳定错误码，如 RELEASE_CONFLICT / RELEASE_INVALID_VERSION */
  code;

  constructor(code, message, options) {
    super(message, options);
    this.name = 'ReleaseError';
    this.code = code;
  }
}

/** buildRelease 入参（zod 校验，与仓库「外部入参必须 zod」规则一致） */
const OptsSchema = z.object({
  /** 项目根（含 package.json/dist/node_modules/bootstrap.mjs/types） */
  projectRoot: z.string().min(1),
  /** 产物命名版本；缺省读 package.json version。不改动源 package.json */
  version: z.string().min(1).optional(),
  /** 产物输出目录；缺省 <projectRoot>/release */
  outDir: z.string().min(1).optional(),
  /** 升级 feed 频道 */
  channel: z.enum(['stable', 'beta']).default('stable'),
  /** 同名产物已存在时覆盖 */
  force: z.boolean().default(false),
  /** 是否执行 `npm run build`（测试用 fixture 已带 dist 时关掉） */
  build: z.boolean().default(true),
  /** feed notes；缺省 `release <version>` */
  notes: z.string().min(1).optional(),
});

/**
 * 包内条目（name 为相对包根的 POSIX 路径）：
 * { name, type: 'file'|'symlink', absPath, size, mtime, linkname? }
 */

/** 待复制的发布输入（相对 projectRoot） */
const COPY_DIRS = ['dist', 'node_modules', 'types'];
const COPY_FILES = ['bootstrap.mjs', 'package.json'];
const MANIFEST_ENTRY = 'manifest.json';
const TAR_PREFIX = 'opptrix-harness-';

/* ---------- 小工具 ---------- */

/** 递归收集条目（目录递归；symlink 保留为 symlink 条目；其余类型跳过）。与 backup.ts 同款排序。 */
async function collectEntries(rootDir, prefix, out) {
  const dirents = await readdir(rootDir, { withFileTypes: true });
  const sorted = [...dirents].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const dirent of sorted) {
    const abs = path.join(rootDir, dirent.name);
    const name = prefix ? `${prefix}/${dirent.name}` : dirent.name;
    if (dirent.isDirectory()) {
      await collectEntries(abs, name, out);
      continue;
    }
    if (dirent.isSymbolicLink()) {
      const st = await lstat(abs);
      out.push({ name, type: 'symlink', absPath: abs, size: 0, mtime: st.mtime, linkname: await readlink(abs) });
      continue;
    }
    if (!dirent.isFile()) continue; // fifo/socket 等：跳过
    const st = await lstat(abs);
    out.push({ name, type: 'file', absPath: abs, size: st.size, mtime: st.mtime });
  }
}

/** 写入单个文件条目（内容一次性缓冲；回调在条目完整落盘后触发）。与 backup.ts 同款。 */
function addFileEntry(p, name, content, mtime) {
  return new Promise((resolve, reject) => {
    try {
      p.entry({ name, size: content.length, mtime, type: 'file' }, content, (e) => (e ? reject(e) : resolve()));
    } catch (e) {
      reject(e);
    }
  });
}

/** 写入 symlink 条目（tar type=symlink + linkname，保证 node_modules/.bin 可用） */
function addSymlinkEntry(p, entry) {
  return new Promise((resolve, reject) => {
    try {
      p.entry({ name: entry.name, type: 'symlink', linkname: entry.linkname, size: 0, mtime: entry.mtime }, (e) =>
        e ? reject(e) : resolve(),
      );
    } catch (e) {
      reject(e);
    }
  });
}

/** 手写打包管线：tar-stream pack → gzip → 落盘（manifest.json 先写）。与 backup.ts 同款。 */
async function writeArchive(archivePath, manifestJson, entries) {
  const p = pack();
  const done = pipeline(Readable.from(p), createGzip(), createWriteStream(archivePath));
  try {
    await addFileEntry(p, MANIFEST_ENTRY, manifestJson, new Date());
    for (const entry of entries) {
      if (entry.type === 'symlink') {
        await addSymlinkEntry(p, entry);
      } else {
        await addFileEntry(p, entry.name, await readFile(entry.absPath), entry.mtime);
      }
    }
    p.finalize();
  } catch (e) {
    p.destroy();
    await done.catch(() => {}); // 吞掉 pipeline 的伴生错误，保留原始异常
    throw new ReleaseError('RELEASE_PACK_FAILED', `打包失败（${archivePath}）: ${e?.message ?? String(e)}`, { cause: e });
  }
  await done;
}

/** 流式 sha256（发布包可能数百 MB，不整读内存） */
async function sha256File(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

/** 在 projectRoot 执行 `npm run build`（失败抛 RELEASE_BUILD_FAILED，带 stderr 尾部） */
function runNpmBuild(projectRoot) {
  return new Promise((resolve, reject) => {
    const bin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const child = spawn(bin, ['run', 'build'], { cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (d) => {
      stderr += String(d);
      if (stderr.length > 8000) stderr = stderr.slice(-8000); // 只留尾部，防长日志爆内存
    });
    child.on('error', (e) => reject(new ReleaseError('RELEASE_BUILD_FAILED', `无法启动 npm run build: ${e.message}`, { cause: e })));
    child.on('close', (code) => {
      if (code === 0) return resolve();
      reject(
        new ReleaseError(
          'RELEASE_BUILD_FAILED',
          `npm run build 退出码 ${code}。stderr 尾部:\n${stderr.trim() || '(空)'}`,
        ),
      );
    });
  });
}

/** 读取源 package.json（projectRoot 下），返回 { version, raw } */
async function readPackageJson(projectRoot) {
  const pkgPath = path.join(projectRoot, 'package.json');
  let raw;
  try {
    raw = await readFile(pkgPath, 'utf8');
  } catch (e) {
    throw new ReleaseError('RELEASE_MISSING_INPUT', `读不到 ${pkgPath}: ${e?.message ?? String(e)}`, { cause: e });
  }
  try {
    return { pkg: JSON.parse(raw), pkgPath };
  } catch (e) {
    throw new ReleaseError('RELEASE_INVALID_PACKAGE', `package.json 不是合法 JSON: ${e?.message ?? String(e)}`, { cause: e });
  }
}

/** 断言发布输入齐全（dist/node_modules/types/bootstrap.mjs/package.json） */
async function assertInputs(projectRoot) {
  const missing = [];
  for (const dir of COPY_DIRS) {
    try {
      if (!(await stat(path.join(projectRoot, dir))).isDirectory()) missing.push(dir);
    } catch {
      missing.push(dir);
    }
  }
  for (const file of COPY_FILES) {
    try {
      if (!(await stat(path.join(projectRoot, file))).isFile()) missing.push(file);
    } catch {
      missing.push(file);
    }
  }
  if (missing.length > 0) {
    throw new ReleaseError(
      'RELEASE_MISSING_INPUT',
      `发布输入缺失: ${missing.join(', ')}。先跑构建（npm run build）并确认仓库结构完整。`,
    );
  }
}

/* ---------- 主流程 ---------- */

/**
 * 执行发布：build（可选）→ 组装 staging → tar.gz → sha256 → feed json。
 *
 * @returns 发布摘要（产物绝对路径、sha256、feed 对象、包内文件数与包体积）。
 *   staging 临时目录无论成败都会清理；打包/哈希失败时半成品归档同样清理。
 */
export async function buildRelease(rawOpts) {
  const opts = OptsSchema.parse(rawOpts ?? {});
  const projectRoot = path.resolve(opts.projectRoot);

  // 1) 版本：--version 仅命名产物；不改动源 package.json
  const { pkg } = await readPackageJson(projectRoot);
  const version = opts.version ?? (typeof pkg.version === 'string' ? pkg.version : '');
  if (!semverValid(version)) {
    throw new ReleaseError(
      'RELEASE_INVALID_VERSION',
      `非法版本号 "${version}"（需严格 semver，如 1.2.3）。--version 只命名产物，不改源 package.json。`,
    );
  }

  // 2) 构建（可跳过：测试 fixture 自带假 dist）
  if (opts.build) await runNpmBuild(projectRoot);
  await assertInputs(projectRoot);

  // 3) outDir 与幂等检查：任一同名产物存在即冲突（--force 覆盖）
  const outDir = path.resolve(opts.outDir ?? path.join(projectRoot, 'release'));
  const tarName = `${TAR_PREFIX}${version}.tar.gz`;
  const shaName = `${tarName}.sha256`;
  const feedName = `feed-${opts.channel}.json`;
  const tarPath = path.join(outDir, tarName);
  const shaPath = path.join(outDir, shaName);
  const feedPath = path.join(outDir, feedName);

  await mkdir(outDir, { recursive: true });
  const existing = [];
  for (const p of [tarPath, shaPath, feedPath]) {
    try {
      await stat(p);
      existing.push(p);
    } catch {
      /* 不存在：好 */
    }
  }
  if (existing.length > 0 && !opts.force) {
    throw new ReleaseError(
      'RELEASE_CONFLICT',
      `产物已存在（${existing.join(', ')}）。换 --version/--out，或加 --force 覆盖。`,
      { detail: existing },
    );
  }

  // 4) 组装 staging（临时目录，finally 必清）
  let staging;
  try {
    staging = await mkdtemp(path.join(outDir, `.staging-${version}-`));
    for (const dir of COPY_DIRS) {
      // verbatimSymlinks: true —— 保留 symlink 目标原样（node_modules/.bin 多为相对链接；
      // 默认 false 会被改写成指向 staging 的绝对路径，包解开即悬空）
      await cp(path.join(projectRoot, dir), path.join(staging, dir), { recursive: true, verbatimSymlinks: true });
    }
    for (const file of COPY_FILES) {
      await cp(path.join(projectRoot, file), path.join(staging, file));
    }

    // 5) manifest（包内第一项；files 为除 manifest 外全部条目，与 backup.ts 约定一致）
    const entries = [];
    await collectEntries(staging, '', entries);
    const fileNames = entries.map((e) => e.name).filter((n) => n !== MANIFEST_ENTRY);
    const manifest = {
      createdAt: Date.now(),
      version,
      channel: opts.channel,
      files: fileNames,
    };
    await writeFile(
      path.join(staging, MANIFEST_ENTRY),
      Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'),
    );

    // 6) 打包 + sha256（半成品先落 .part，完成后原子改名，避免 --force 覆盖中途失败留坏包）
    const tarPart = `${tarPath}.part`;
    try {
      await writeArchive(tarPart, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'), entries);
      await rm(tarPath, { force: true });
      await rename(tarPart, tarPath);
    } catch (e) {
      await rm(tarPart, { force: true }).catch(() => {});
      if (e instanceof ReleaseError) throw e;
      throw new ReleaseError('RELEASE_PACK_FAILED', `写发布包失败: ${e?.message ?? String(e)}`, { cause: e });
    }
    const sha256 = await sha256File(tarPath);
    await rm(shaPath, { force: true });
    await writeFile(shaPath, `${sha256}  ${tarName}\n`, 'utf8');

    // 7) 升级 feed：对齐 updater feedDocSchema（条目带 channel；另一频道整体缺省，
    //    不能写 null——zod .optional() 会拒绝 null）
    const feedEntry = {
      channel: opts.channel,
      version,
      url: tarPath,
      sha256,
      notes: opts.notes ?? `release ${version}`,
    };
    const feed = { [opts.channel]: feedEntry };
    await rm(feedPath, { force: true });
    await writeFile(feedPath, `${JSON.stringify(feed, null, 2)}\n`, 'utf8');

    const sizeBytes = (await stat(tarPath)).size;
    return {
      version,
      channel: opts.channel,
      tarPath,
      sha256Path: shaPath,
      sha256,
      feedPath,
      feed,
      fileCount: fileNames.length,
      sizeBytes,
    };
  } catch (e) {
    // 失败清理半成品三件套（--force 场景下旧产物已被删，不残留坏文件）
    await rm(tarPath, { force: true }).catch(() => {});
    await rm(shaPath, { force: true }).catch(() => {});
    await rm(feedPath, { force: true }).catch(() => {});
    if (e instanceof ReleaseError) throw e;
    throw new ReleaseError('RELEASE_INTERNAL', `发布失败: ${e?.message ?? String(e)}`, { cause: e });
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}
