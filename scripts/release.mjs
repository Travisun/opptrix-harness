#!/usr/bin/env node
/**
 * scripts/release.mjs — 发布入口（薄壳：argv 解析 + 调 buildRelease + 输出摘要）。
 *
 * 用法：
 *   npm run release                              # 用 package.json version，产出到 release/
 *   npm run release -- --version 1.2.3           # 仅命名产物（不改源 package.json）
 *   npm run release -- --out /tmp/dist           # 自定义输出目录
 *   npm run release -- --channel beta            # feed 频道（stable|beta，默认 stable）
 *   npm run release -- --force                   # 同名产物已存在时覆盖
 *   npm run release -- --skip-build              # 跳过 npm run build（调试用，dist 需已存在）
 *   npm run release -- --help
 *
 * 流程与产物布局见 scripts/release-core.mjs 头注释。
 *
 * 【console 例外说明】CLI 脚本不经内核 logger（pino 属内核约束），统一用
 * process.stdout / process.stderr 输出（禁 console.* 规则对 scripts/ 的注明例外）。
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { buildRelease, ReleaseError } from './release-core.mjs';

const USAGE = `\
用法: npm run release -- [选项]
  --version <x.y.z>   产物命名版本（严格 semver；不修改源 package.json）
  --out <dir>         输出目录（默认 <repo>/release）
  --channel <name>    feed 频道: stable | beta（默认 stable）
  --force             同名产物已存在时覆盖
  --skip-build        跳过 npm run build（dist 需已存在）
  --notes <text>      feed notes（默认 "release <version>"）
  --help              本帮助
`;

/** 解析 argv（无第三方依赖；支持 --k v 与 --k=v 两种形式） */
function parseArgv(argv) {
  const opts = {};
  const take = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv.splice(i, 2)[1] : undefined;
  };
  for (let i = argv.length - 1; i >= 0; i--) {
    const arg = argv[i];
    if (arg.startsWith('--') && arg.includes('=')) {
      const [k, ...rest] = arg.slice(2).split('=');
      argv.splice(i, 1, `--${k}`, rest.join('='));
    }
  }
  const version = take('--version');
  const out = take('--out');
  const channel = take('--channel');
  const notes = take('--notes');
  if (version !== undefined) opts.version = version;
  if (out !== undefined) opts.outDir = out;
  if (channel !== undefined) opts.channel = channel;
  if (notes !== undefined) opts.notes = notes;
  if (argv.includes('--force')) opts.force = true;
  if (argv.includes('--skip-build')) opts.build = false;
  return opts;
}

function fmtBytes(n) {
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  return `${(n / 1024).toFixed(1)} KB`;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(USAGE);
    return;
  }

  let opts;
  try {
    opts = parseArgv(argv);
  } catch (e) {
    process.stderr.write(`release: 参数错误: ${e?.message ?? String(e)}\n\n${USAGE}`);
    process.exit(2);
  }

  // 仓库根 = scripts/ 的上一级
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

  try {
    const result = await buildRelease({ projectRoot: repoRoot, ...opts });
    process.stdout.write(
      [
        `== Opptrix Harness 发布完成 ==`,
        `version : ${result.version} (channel: ${result.channel})`,
        `tar     : ${result.tarPath} (${fmtBytes(result.sizeBytes)}, ${result.fileCount} files)`,
        `sha256  : ${result.sha256Path}`,
        `          ${result.sha256}`,
        `feed    : ${result.feedPath}`,
        ``,
      ].join('\n'),
    );
  } catch (e) {
    if (e instanceof ReleaseError) {
      process.stderr.write(`release failed [${e.code}]: ${e.message}\n`);
      process.exit(1);
    }
    process.stderr.write(`release failed: ${e?.stack ?? String(e)}\n`);
    process.exit(1);
  }
}

main().catch((e) => {
  process.stderr.write(`release failed: ${e?.stack ?? String(e)}\n`);
  process.exit(1);
});
