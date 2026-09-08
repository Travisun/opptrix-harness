/**
 * Opptrix Harness OS — CLI 薄入口（`npm run harness -- <cmd>`）。
 *
 * 只做命令行编排：argv 解析、人类可读输出、exit code（0 成功 / 1 失败）。
 * 全部业务逻辑在 tools/cli-core.ts（可测核心），本文件不做任何校验决策。
 *
 * 命令：
 * - `make:extension <id> [targetDir]` — 在 targetDir（默认 extensions/）生成扩展骨架
 * - `validate <extDir>`               — 校验扩展目录（manifest/权限/api/main/语法）
 * - `help`                            — 用法说明
 *
 * 输出一律 process.stdout.write / process.stderr.write（仓库规则：禁止 console.*）。
 */
import { pathToFileURL } from 'node:url';

import { HarnessError } from '../src/kernel/errors/index.js';
import { makeExtension, validateExtension } from './cli-core.js';

/** 默认扩展根目录：约定优于配置（Laravel 心智），make:extension 不传 targetDir 时使用 */
const DEFAULT_EXTENSIONS_DIR = 'extensions';

const USAGE = `Opptrix Harness CLI

usage:
  npm run harness -- make:extension <id> [targetDir]   scaffold a new extension (default targetDir: ${DEFAULT_EXTENSIONS_DIR})
  npm run harness -- validate <extDir>                 validate an extension directory
  npm run harness -- help                              show this help
`;

/**
 * 执行一条 CLI 命令。
 *
 * @param argv 参数向量（不含 node 与脚本自身，即 process.argv.slice(2)）
 * @returns 进程退出码：0 成功，1 失败（未知命令 / 缺参 / 校验不通过 / 抛错）
 */
export async function run(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;

  if (cmd === undefined || cmd === 'help' || cmd === '-h' || cmd === '--help') {
    process.stdout.write(USAGE);
    return 0;
  }

  if (cmd === 'make:extension') {
    const id = rest[0];
    const targetDir = rest[1] ?? DEFAULT_EXTENSIONS_DIR;
    if (id === undefined) {
      process.stderr.write('error: make:extension requires an <id> argument\n\n' + USAGE);
      return 1;
    }
    try {
      const { files } = await makeExtension(targetDir, id);
      for (const file of files) process.stdout.write(`created ${file}\n`);
      process.stdout.write(`\nnext: npm run harness -- validate ${targetDir}/${id}\n`);
      return 0;
    } catch (e) {
      process.stderr.write(`${formatError(e)}\n`);
      return 1;
    }
  }

  if (cmd === 'validate') {
    const extDir = rest[0];
    if (extDir === undefined) {
      process.stderr.write('error: validate requires an <extDir> argument\n\n' + USAGE);
      return 1;
    }
    try {
      const { ok, errors } = await validateExtension(extDir);
      if (ok) {
        process.stdout.write(`ok ${extDir}\n`);
        return 0;
      }
      process.stderr.write(`invalid ${extDir}\n`);
      for (const message of errors) process.stderr.write(`  - ${message}\n`);
      return 1;
    } catch (e) {
      process.stderr.write(`${formatError(e)}\n`);
      return 1;
    }
  }

  process.stderr.write(`error: unknown command "${cmd}"\n\n` + USAGE);
  return 1;
}

/** 错误格式化：HarnessError 带 HARNESS-xxxx 码，其余原样 message */
function formatError(e: unknown): string {
  if (e instanceof HarnessError) return `error [${e.code}]: ${e.message}`;
  return `error: ${e instanceof Error ? e.message : String(e)}`;
}

// 直接执行判定：被 import（含测试）时不自动运行
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
