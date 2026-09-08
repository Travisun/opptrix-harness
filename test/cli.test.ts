/**
 * CLI（tools/cli.ts + tools/cli-core.ts）单测。
 *
 * 覆盖：makeExtension 脚手架（文件齐全/清单可过 validateManifest/重复生成抛错/非法 id）、
 * validateExtension（hello-world 与生成扩展通过；manifest 缺失/坏 JSON/非法权限/
 * main 缺失/路径越界/语法错误失败；非 .js main 跳过语法检查）、
 * 以及 CLI 端到端（spawn `npx tsx tools/cli.ts …`，30s 超时）。
 */
import { spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { makeExtension, validateExtension } from '../tools/cli-core.js';
// 并行包（扩展子系统）：manifest 校验器；本测试用它复核脚手架产物的合法性
import { validateManifest } from '../src/kernel/extensions/manifest.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const HELLO_WORLD_DIR = path.join(REPO_ROOT, 'extensions', 'hello-world');

/** 临时目录集合（测试结束统一清理） */
const tmpDirs: string[] = [];

async function makeTmpDir(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'opptrix-cli-'));
  tmpDirs.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(tmpDirs.map((dir) => fsp.rm(dir, { recursive: true, force: true })));
});

/** 并行包 validateManifest 抛错式契约的布尔化包装：不抛即合法 */
function manifestPasses(raw: unknown): boolean {
  try {
    validateManifest(raw);
    return true;
  } catch {
    return false;
  }
}

/** 写一个最小合法 manifest（可逐字段覆盖） */
async function writeManifest(extDir: string, overrides: Record<string, unknown> = {}): Promise<void> {
  await fsp.mkdir(extDir, { recursive: true });
  const manifest = {
    id: path.basename(extDir),
    api: 1,
    version: '0.1.0',
    main: 'index.js',
    permissions: ['http'],
    displayName: path.basename(extDir),
    ...overrides,
  };
  await fsp.writeFile(path.join(extDir, 'manifest.json'), JSON.stringify(manifest), 'utf8');
}

// ---------------------------------------------------------------------------
// makeExtension
// ---------------------------------------------------------------------------

describe('makeExtension', () => {
  it('生成 manifest.json / index.js / README.md 三件套，且 manifest 经 validateManifest 通过', async () => {
    const tmp = await makeTmpDir();
    const { files } = await makeExtension(tmp, 'demo-ext');

    expect(files).toHaveLength(3);
    expect(files.map((f) => path.basename(f)).sort()).toEqual(['README.md', 'index.js', 'manifest.json']);
    for (const file of files) {
      await expect(fsp.stat(file)).resolves.toBeTruthy();
    }

    const manifest = JSON.parse(await fsp.readFile(path.join(tmp, 'demo-ext', 'manifest.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(manifest).toMatchObject({ id: 'demo-ext', api: 1, version: '0.1.0', main: 'index.js' });
    expect(manifest.permissions).toEqual(['http', 'events', 'cron', 'storage', 'ui']);
    expect(manifest.displayName).toBe('demo-ext');
    expect(manifestPasses(manifest)).toBe(true);
  });

  it('index.js 为 defineExtension 风格（route /hello + 注释掉的 cron 示例），README 含 API 速览', async () => {
    const tmp = await makeTmpDir();
    const { files } = await makeExtension(tmp, 'demo-ext');
    const extDir = path.dirname(files[0] as string);

    const indexJs = await fsp.readFile(path.join(extDir, 'index.js'), 'utf8');
    expect(indexJs).toContain('defineExtension');
    expect(indexJs).toContain("h.route('GET', '/hello'");
    expect(indexJs).toContain("{ hello: 'world' }");
    expect(indexJs).toContain('// h.cron(');

    const readme = await fsp.readFile(path.join(extDir, 'README.md'), 'utf8');
    expect(readme).toContain('h.* API');
    expect(readme).toContain('如何启用');
  });

  it('重复生成同一 id：抛错且不覆盖既有文件', async () => {
    const tmp = await makeTmpDir();
    await makeExtension(tmp, 'demo-ext');
    const indexPath = path.join(tmp, 'demo-ext', 'index.js');
    await fsp.writeFile(indexPath, '// tampered', 'utf8');

    await expect(makeExtension(tmp, 'demo-ext')).rejects.toThrow(/already exists/);
    // 原文件未被覆盖
    expect(await fsp.readFile(indexPath, 'utf8')).toBe('// tampered');
  });

  it('非法 id（大写/路径注入/空串）一律拒绝，且不创建任何目录', async () => {
    const tmp = await makeTmpDir();
    for (const bad of ['Hello-World', '../evil', 'a b', '', 'a/b']) {
      await expect(makeExtension(tmp, bad)).rejects.toThrow();
    }
    expect(await fsp.readdir(tmp)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// validateExtension
// ---------------------------------------------------------------------------

describe('validateExtension', () => {
  it('仓库示例扩展 extensions/hello-world：ok true 且 errors 为空', async () => {
    const result = await validateExtension(HELLO_WORLD_DIR);
    expect(result).toEqual({ ok: true, errors: [] });
  });

  it('makeExtension 生成的扩展：走完整链路（含 node --check）ok true', async () => {
    const tmp = await makeTmpDir();
    await makeExtension(tmp, 'demo-ext');

    const result = await validateExtension(path.join(tmp, 'demo-ext'));
    expect(result).toEqual({ ok: true, errors: [] });
  });

  it('manifest.json 缺失：ok false，errors 指明缺失与补救方式', async () => {
    const tmp = await makeTmpDir();
    const extDir = path.join(tmp, 'no-manifest');
    await fsp.mkdir(extDir, { recursive: true });

    const result = await validateExtension(extDir);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain('manifest.json not found');
  });

  it('manifest.json 非法 JSON：ok false 并给出语法错误', async () => {
    const tmp = await makeTmpDir();
    const extDir = path.join(tmp, 'bad-json');
    await fsp.mkdir(extDir, { recursive: true });
    await fsp.writeFile(path.join(extDir, 'manifest.json'), '{ not json !', 'utf8');

    const result = await validateExtension(extDir);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain('not valid JSON');
  });

  it('非法权限声明：ok false 且 errors 非空', async () => {
    const tmp = await makeTmpDir();
    const extDir = path.join(tmp, 'perm-ext');
    await writeManifest(extDir, { permissions: ['not-a-real-permission'] });
    await fsp.writeFile(path.join(extDir, 'index.js'), "'use strict';\n", 'utf8');

    const result = await validateExtension(extDir);
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e) => /unknown permission/i.test(e))).toBe(true);
  });

  it('main 文件缺失：ok false 且错误指到 main 字段与期望路径', async () => {
    const tmp = await makeTmpDir();
    const extDir = path.join(tmp, 'missing-main');
    await writeManifest(extDir, { main: 'index.js' }); // 不创建 index.js

    const result = await validateExtension(extDir);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('main') && e.includes('not found'))).toBe(true);
  });

  it('main 路径越出扩展目录：拒绝（防路径注入）', async () => {
    const tmp = await makeTmpDir();
    const extDir = path.join(tmp, 'escaping-main');
    await writeManifest(extDir, { main: '../evil.js' });
    await fsp.writeFile(path.join(tmp, 'evil.js'), "'use strict';\n", 'utf8');

    const result = await validateExtension(extDir);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('escapes the extension directory'))).toBe(true);
  });

  it('index.js 语法错误（node --check）：ok false 并带语法检查错误', async () => {
    const tmp = await makeTmpDir();
    const extDir = path.join(tmp, 'broken-syntax');
    await writeManifest(extDir);
    await fsp.writeFile(path.join(extDir, 'index.js'), 'function broken( { return;;', 'utf8');

    const result = await validateExtension(extDir);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.startsWith('syntax check failed for "index.js"'))).toBe(true);
  });

  it('main 非 .js（如 main.py）：只检查存在性，不做 node --check', async () => {
    const tmp = await makeTmpDir();
    const extDir = path.join(tmp, 'py-main');
    await writeManifest(extDir, { main: 'main.py' });
    await fsp.writeFile(path.join(extDir, 'main.py'), 'print("hi")\n', 'utf8');

    const result = await validateExtension(extDir);
    expect(result).toEqual({ ok: true, errors: [] });
  });
});

// ---------------------------------------------------------------------------
// CLI 端到端（真实子进程）
// ---------------------------------------------------------------------------

/** 运行仓库 CLI（npx tsx tools/cli.ts …），30s 超时保护 */
async function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['tsx', 'tools/cli.ts', ...args], {
      cwd: REPO_ROOT,
      env: process.env,
      timeout: 30_000,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('cli 端到端（npx tsx tools/cli.ts）', () => {
  it(
    'validate extensions/hello-world：exit 0，stdout 报告 ok',
    async () => {
      const { code, stdout, stderr } = await runCli(['validate', 'extensions/hello-world']);
      expect(stderr).toBe('');
      expect(code).toBe(0);
      expect(stdout).toContain('ok extensions/hello-world');
    },
    40_000,
  );

  it(
    'help：exit 0 并输出用法',
    async () => {
      const { code, stdout } = await runCli(['help']);
      expect(code).toBe(0);
      expect(stdout).toContain('make:extension');
      expect(stdout).toContain('validate');
    },
    40_000,
  );

  it(
    'validate 不存在的目录：exit 1，stderr 含 manifest 缺失说明',
    async () => {
      const { code, stderr } = await runCli(['validate', 'extensions/does-not-exist']);
      expect(code).toBe(1);
      expect(stderr).toContain('manifest.json not found');
    },
    40_000,
  );
});
