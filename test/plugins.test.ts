/**
 * 插件包（Plugin Package）机制测试：installer / registry / bridge / REST 全链。
 *
 * 覆盖：plugin.json 校验矩阵（id 规范/semver/数量上限/二选一字段/mcp 形状）、
 * zip 安装全链（单顶层目录 + 根布局两态）、路径穿越成员拒绝（手工构造 stored zip
 * ——系统 zip CLI 会直接拒绝 '../' 成员，故穿越样例用 craftStoredZip 造）、
 * 引用文件缺失、重复安装与 overwrite、目录直装、refresh 聚合与坏包跳过、
 * skills→registerContributed / mcpServers→addServer 注入断言（桩）、
 * remove 摘贡献再删目录（无 force 有贡献 → FORBIDDEN）、runScript 未注入 →
 * NOT_IMPLEMENTED（HARNESS-9004）、bridge 形状、REST 门禁与全链
 * （fastify.inject + 真 registry + 真 zip 上传，zip 造包用系统 /usr/bin/zip 的
 * execFile('zip','-r')，简单可靠——见报告）。
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { crc32 } from 'node:zlib';

import pino from 'pino';
import type { Logger } from 'pino';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installPluginDir, installPluginZip, PluginRegistry } from '../src/kernel/plugins/index.js';
import {
  createPluginsBridge,
  PLUGIN_BRIDGE_TOPICS,
  type McpRegistryLike,
  type PluginContributedSkill,
  type ScriptRunnerLike,
  type SkillsRegistryLike,
} from '../src/kernel/plugins/registry.js';
import { validatePluginManifest, type InstalledPlugin } from '../src/kernel/plugins/types.js';
import { err } from '../src/kernel/errors/HarnessError.js';
import { HarnessError } from '../src/kernel/errors/index.js';
import { createHttpServer } from '../src/kernel/http/server.js';
import { loadConfig } from '../src/kernel/config/index.js';
import { registerPluginRoutes } from '../src/api/plugins.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// 测试环境
// ---------------------------------------------------------------------------

let workDir = '';

beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), 'opptrix-plugins-'));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

afterAll(async () => {
  await rm(path.join(tmpdir(), 'opptrix-plugins-'), { recursive: true, force: true }).catch(() => {});
});

const silentLogger = (): Logger => pino({ level: 'silent' });

/** 可断言 warn 的 logger 桩 */
function spyLogger(): { logger: Logger; warn: ReturnType<typeof vi.fn> } {
  const warn = vi.fn();
  return {
    warn: warn as unknown as Logger['warn'],
    logger: { info: () => {}, error: () => {}, debug: () => {}, warn, child: () => silentLogger() } as unknown as Logger,
  };
}

// ---------------------------------------------------------------------------
// 造包辅助
// ---------------------------------------------------------------------------

/** 合法最小清单（覆盖用可深合并） */
function makeManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'demo-plugin',
    name: 'Demo Plugin',
    version: '1.0.0',
    description: 'demo plugin for tests',
    author: 'Opptrix',
    ...overrides,
  };
}

/** 在 base 下写一个插件源目录（manifest + 附加文件），返回目录路径 */
async function writePluginSource(
  base: string,
  manifest: Record<string, unknown>,
  files: Record<string, string> = {},
  dirName = 'src',
): Promise<string> {
  const dir = path.join(base, dirName);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'plugin.json'), JSON.stringify(manifest, null, 2));
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(dir, rel);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return dir;
}

/** 用系统 zip CLI 打 zip（cwd=srcDir → 根布局；cwd=srcDir 的父目录 → 单顶层目录布局） */
async function zipDir(cwd: string, srcName: string, outZip: string): Promise<void> {
  await execFileAsync('zip', ['-r', '-q', outZip, srcName], { cwd });
}

/**
 * 手工构造 stored（不压缩）zip——用于路径穿越等 zip CLI 拒绝构造的成员。
 * Local File Header + Central Directory + EOCD，CRC 用 node:zlib.crc32。
 */
function craftStoredZip(entries: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const crc = crc32(entry.data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method: store
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0x21, 12); // mod date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, entry.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10); // method: store
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42); // local header offset
    centrals.push(Buffer.concat([central, nameBuf]));
    offset += 30 + nameBuf.length + entry.data.length;
  }
  const cdStart = offset;
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(cdStart, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

/** 写手工 zip 到磁盘 */
async function writeCraftedZip(entries: { name: string; data: Buffer }[]): Promise<string> {
  const zipPath = path.join(workDir, `crafted-${Math.random().toString(36).slice(2)}.zip`);
  await writeFile(zipPath, craftStoredZip(entries));
  return zipPath;
}

/** 全功能 demo 插件源（skills 2 / prompts 1 / mcpServers 1 / scripts 1） */
async function writeFullDemoSource(dirName = 'full-demo'): Promise<string> {
  return writePluginSource(
    workDir,
    makeManifest({
      skills: [
        { id: 'greet', name: 'Greet Skill', description: 'says hello', file: 'skills/greet.md' },
        { id: 'inline', body: '# Inline Skill\nDo things inline.' },
      ],
      prompts: [{ id: 'review', name: 'Code Review', description: 'review code', body: 'Review the following code:' }],
      mcpServers: [
        { id: 'main', name: 'Demo MCP', transport: 'stdio', command: 'node', args: ['scripts/server.mjs'] },
      ],
      scripts: [{ id: 'tool', file: 'scripts/tool.mjs' }],
    }),
    {
      'skills/greet.md': '# Greet\nSay hello warmly.',
      'scripts/tool.mjs': 'console.log("sandbox only");\n',
      'scripts/server.mjs': '// stdio mcp server stub\n',
    },
    dirName,
  );
}

/** 期望 HarnessError 的辅助 */
async function expectHarnessError(fn: () => Promise<unknown>, code: string, messageIncludes?: string): Promise<HarnessError> {
  try {
    await fn();
  } catch (e) {
    expect(e).toBeInstanceOf(HarnessError);
    const he = e as HarnessError;
    expect(he.code).toBe(code);
    if (messageIncludes !== undefined) {
      expect(he.message).toContain(messageIncludes);
    }
    return he;
  }
  throw new Error(`expected HarnessError(${code}) but nothing was thrown`);
}

// ---------------------------------------------------------------------------
// installer — installPluginZip / installPluginDir
// ---------------------------------------------------------------------------

describe('installer — installPluginZip', () => {
  it('单顶层目录布局：安装全链 → 摘要正确、文件落到 <dataDir>/plugins/<id>/', async () => {
    const src = await writeFullDemoSource();
    const zipPath = path.join(workDir, 'demo.zip');
    await zipDir(workDir, path.basename(src), zipPath); // cwd=workDir，单顶层目录布局

    const cfg = { dataDir: workDir };
    const installed = await installPluginZip(cfg, zipPath);

    expect(installed).toEqual({
      id: 'demo-plugin',
      name: 'Demo Plugin',
      version: '1.0.0',
      description: 'demo plugin for tests',
      skills: 2,
      prompts: 1,
      mcpServers: 1,
      scripts: 1,
      installedAt: expect.any(String),
    });
    expect(new Date(installed.installedAt).toISOString()).toBe(installed.installedAt); // UTC ISO

    const pluginDir = path.join(workDir, 'plugins', 'demo-plugin');
    expect(existsSync(path.join(pluginDir, 'plugin.json'))).toBe(true);
    expect((await readFile(path.join(pluginDir, 'skills', 'greet.md'), 'utf8'))).toContain('Say hello warmly.');
    expect(existsSync(path.join(pluginDir, 'scripts', 'tool.mjs'))).toBe(true);
    // staging 不残留
    expect(existsSync(path.join(workDir, 'plugins', '.staging-'))).toBe(false);
  });

  it('根布局 zip（plugin.json 在 zip 根）亦可安装', async () => {
    const src = await writePluginSource(workDir, makeManifest({ id: 'rootly' }), { 'skills/a.md': 'A' }, 'rootly-src');
    const zipPath = path.join(workDir, 'rootly.zip');
    await zipDir(src, '.', zipPath); // cwd=src → 根布局

    const installed = await installPluginZip({ dataDir: workDir }, zipPath);
    expect(installed.id).toBe('rootly');
    expect(existsSync(path.join(workDir, 'plugins', 'rootly', 'skills', 'a.md'))).toBe(true);
  });

  it.each([
    ['缺 plugin.json', [{ name: 'README.md', data: Buffer.from('no manifest') }]],
    [
      'plugin.json 非 JSON',
      [{ name: 'plugin.json', data: Buffer.from('{not json') }],
    ],
    [
      '清单非法（缺 name）',
      [{ name: 'plugin.json', data: Buffer.from(JSON.stringify({ id: 'x1', version: '1.0.0' })) }],
    ],
  ])('%s → VALIDATION_FAILED', async (_label, entries) => {
    const zipPath = await writeCraftedZip(entries as { name: string; data: Buffer }[]);
    await expectHarnessError(() => installPluginZip({ dataDir: workDir }, zipPath), 'HARNESS-1009');
  });

  it('路径穿越成员（../）被拒绝且不落盘；绝对路径成员同样拒绝', async () => {
    const evil = path.join(workDir, 'pwned.txt');
    const zipPath = await writeCraftedZip([
      { name: 'evil/../../pwned.txt', data: Buffer.from('pwned') },
      { name: 'pkg/plugin.json', data: Buffer.from(JSON.stringify(makeManifest({ id: 'evilpkg' }))) },
    ]);
    await expectHarnessError(
      () => installPluginZip({ dataDir: workDir }, zipPath),
      'HARNESS-1009',
      'unsafe member path',
    );
    expect(existsSync(evil)).toBe(false);
    expect(existsSync(path.join(workDir, 'plugins', 'evilpkg'))).toBe(false);

    const absZip = await writeCraftedZip([
      { name: '/abs.txt', data: Buffer.from('abs') },
      { name: 'plugin.json', data: Buffer.from(JSON.stringify(makeManifest({ id: 'abspkg' }))) },
    ]);
    await expectHarnessError(
      () => installPluginZip({ dataDir: workDir }, absZip),
      'HARNESS-1009',
      'unsafe member path',
    );
  });

  it('引用的 skills/scripts 文件不在包内 → VALIDATION_FAILED', async () => {
    const src = await writePluginSource(
      workDir,
      makeManifest({ skills: [{ id: 's', file: 'skills/missing.md' }] }),
      {},
      'missing-ref',
    );
    const zipPath = path.join(workDir, 'missing-ref.zip');
    await zipDir(workDir, path.basename(src), zipPath);
    await expectHarnessError(
      () => installPluginZip({ dataDir: workDir }, zipPath),
      'HARNESS-1009',
      'not present in the package',
    );
  });

  it('重复安装 → BAD_REQUEST（plugin id already installed, use overwrite）；overwrite:true 覆盖', async () => {
    const src1 = await writePluginSource(workDir, makeManifest({ version: '1.0.0' }), {}, 'dup-v1');
    const src2 = await writePluginSource(workDir, makeManifest({ version: '2.0.0' }), {}, 'dup-v2');
    const zip1 = path.join(workDir, 'dup-v1.zip');
    const zip2 = path.join(workDir, 'dup-v2.zip');
    await zipDir(workDir, 'dup-v1', zip1);
    await zipDir(workDir, 'dup-v2', zip2);
    const cfg = { dataDir: workDir };

    await installPluginZip(cfg, zip1);
    await expectHarnessError(
      () => installPluginZip(cfg, zip2),
      'HARNESS-1008',
      'plugin id already installed, use overwrite',
    );

    const overwritten = await installPluginZip(cfg, zip2, { overwrite: true });
    expect(overwritten.version).toBe('2.0.0');
    const onDisk = JSON.parse(await readFile(path.join(workDir, 'plugins', 'demo-plugin', 'plugin.json'), 'utf8')) as {
      version: string;
    };
    expect(onDisk.version).toBe('2.0.0');
  });
});

describe('installer — installPluginDir', () => {
  it('目录直装（开发用）→ 与 zip 同语义', async () => {
    const src = await writeFullDemoSource('dir-demo');
    const installed = await installPluginDir({ dataDir: workDir }, src);
    expect(installed.id).toBe('demo-plugin');
    expect(existsSync(path.join(workDir, 'plugins', 'demo-plugin', 'skills', 'greet.md'))).toBe(true);
  });

  it('目录直装：引用文件缺失 → VALIDATION_FAILED；坏清单 → VALIDATION_FAILED', async () => {
    const src = await writePluginSource(
      workDir,
      makeManifest({ id: 'dirmiss', scripts: [{ id: 's', file: 'scripts/nope.mjs' }] }),
      {},
      'dir-miss',
    );
    await expectHarnessError(
      () => installPluginDir({ dataDir: workDir }, src),
      'HARNESS-1009',
      'not present in the package',
    );
    const badDir = path.join(workDir, 'dir-bad');
    await mkdir(badDir, { recursive: true });
    await writeFile(path.join(badDir, 'plugin.json'), 'nope');
    await expectHarnessError(() => installPluginDir({ dataDir: workDir }, badDir), 'HARNESS-1009');
  });
});

// ---------------------------------------------------------------------------
// plugin.json 校验矩阵（zod）
// ---------------------------------------------------------------------------

describe('plugin.json 校验矩阵', () => {
  const base = makeManifest();
  const cases: [string, Record<string, unknown>][] = [
    ['id 大写', makeManifest({ id: 'Bad-ID' })],
    ['id 以 "-" 开头', makeManifest({ id: '-bad' })],
    ['id 含 "/"', makeManifest({ id: 'a/b' })],
    ['version 非 semver', makeManifest({ version: '1.0' })],
    [`skills 超上限(33)`, makeManifest({ skills: Array.from({ length: 33 }, (_, i) => ({ id: `s${i}`, body: 'b' })) })],
    [
      `prompts 超上限(65)`,
      makeManifest({ prompts: Array.from({ length: 65 }, (_, i) => ({ id: `p${i}`, name: 'n', body: 'b' })) }),
    ],
    [
      `scripts 超上限(17)`,
      makeManifest({ scripts: Array.from({ length: 17 }, (_, i) => ({ id: `c${i}`, file: `scripts/${i}.mjs` })) }),
    ],
    [
      `mcpServers 超上限(9)`,
      makeManifest({
        mcpServers: Array.from({ length: 9 }, (_, i) => ({ id: `m${i}`, name: 'n', transport: 'stdio', command: 'x' })),
      }),
    ],
    ['skill 缺 body 且缺 file', makeManifest({ skills: [{ id: 's1' }] })],
    ['skill 同时带 body 与 file', makeManifest({ skills: [{ id: 's1', body: 'b', file: 'skills/a.md' }] })],
    ['skill file 不在 skills/ 下', makeManifest({ skills: [{ id: 's1', file: 'prompts/a.md' }] })],
    ['skill file 含 ".."', makeManifest({ skills: [{ id: 's1', file: 'skills/../x.md' }] })],
    ['script file 不在 scripts/ 下', makeManifest({ scripts: [{ id: 'c1', file: 'lib/run.mjs' }] })],
    ['stdio server 缺 command', makeManifest({ mcpServers: [{ id: 'm1', name: 'n', transport: 'stdio' }] })],
    [
      'http server 缺 url',
      makeManifest({ mcpServers: [{ id: 'm1', name: 'n', transport: 'streamable-http' }] }),
    ],
    ['sse server url 非 http(s)', makeManifest({ mcpServers: [{ id: 'm1', name: 'n', transport: 'sse', url: 'ftp://x' }] })],
  ];

  it.each(cases)('%s → VALIDATION_FAILED', (_label, manifest) => {
    expectHarnessErrorSync(() => validatePluginManifest(manifest));
  });

  it('合法清单通过（含缺省段补全为空数组）', () => {
    const m = validatePluginManifest(base);
    expect(m.skills).toEqual([]);
    expect(m.prompts).toEqual([]);
    expect(m.scripts).toEqual([]);
    expect(m.mcpServers).toEqual([]);
  });

  function expectHarnessErrorSync(fn: () => unknown): void {
    try {
      fn();
    } catch (e) {
      expect((e as HarnessError).code).toBe('HARNESS-1009');
      return;
    }
    throw new Error('expected VALIDATION_FAILED');
  }
});

// ---------------------------------------------------------------------------
// PluginRegistry
// ---------------------------------------------------------------------------

/** 可断言的 skillsRegistry 桩（Map 语义：注入/摘除可观察） */
function stubSkillsRegistry(): SkillsRegistryLike & { store: Map<string, PluginContributedSkill[]>; register: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> } {
  const store = new Map<string, PluginContributedSkill[]>();
  const register = vi.fn((extId: string, skills: PluginContributedSkill[]) => {
    store.set(extId, skills);
    return skills.length;
  });
  const remove = vi.fn((extId: string) => {
    store.delete(extId);
  });
  return { store, register, removeContributed: remove, registerContributed: register } as never;
}

/** 可断言的 mcpRegistry 桩 */
function stubMcpRegistry(): McpRegistryLike & { servers: Map<string, unknown>; add: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> } {
  const servers = new Map<string, unknown>();
  const add = vi.fn((cfg: { id: string }) => {
    servers.set(cfg.id, cfg);
    return cfg;
  });
  const remove = vi.fn((id: string) => servers.delete(id));
  return { servers, add, addServer: add, removeServer: remove, remove } as never;
}

describe('PluginRegistry — refresh 聚合与注入', () => {
  it('refresh 聚合：list/get 计数正确、按 id 排序；坏包跳过 + warn', async () => {
    await writeFullDemoSource('a-pkg');
    await installPluginDir({ dataDir: workDir }, path.join(workDir, 'a-pkg'));
    await writePluginSource(workDir, makeManifest({ id: 'b-lite' }), {}, 'b-src');
    await installPluginDir({ dataDir: workDir }, path.join(workDir, 'b-src'));
    // 坏包：直接写坏清单（不经 installer）——必须位于 <dataDir>/plugins/ 内才会被扫描
    await writePluginSource(path.join(workDir, 'plugins'), { id: 'BAD!', nope: true }, {}, 'bad-pkg');
    // 目录名 '.' 开头 → 跳过（staging 语义）
    await writePluginSource(path.join(workDir, 'plugins'), makeManifest({ id: 'hidden' }), {}, '.staging-x');

    const { logger, warn } = spyLogger();
    const registry = new PluginRegistry({ dataDir: workDir, logger });
    const plugins = await registry.refresh();

    expect(plugins.map((p) => p.id)).toEqual(['b-lite', 'demo-plugin']);
    expect(warn).toHaveBeenCalled();
    expect(registry.get('b-lite')).toMatchObject({ id: 'b-lite', skills: 0 });
    expect(registry.get('demo-plugin')).toMatchObject({ skills: 2, prompts: 1, mcpServers: 1, scripts: 1 });
    expect(registry.get('BAD!')).toBeUndefined();
  });

  it('skills → skillsRegistry.registerContributed("plugin:<id>", skills)，file 引用读为 body', async () => {
    await installPluginDir({ dataDir: workDir }, await writeFullDemoSource('sk-pkg'));
    const skills = stubSkillsRegistry();
    const registry = new PluginRegistry({ dataDir: workDir, logger: silentLogger(), skillsRegistry: skills });
    await registry.refresh();

    expect(skills.register).toHaveBeenCalledTimes(1);
    expect(skills.register.mock.calls[0]?.[0]).toBe('plugin:demo-plugin');
    const contributed = skills.register.mock.calls[0]?.[1] as PluginContributedSkill[];
    expect(contributed).toHaveLength(2);
    expect(contributed[0]).toEqual({ id: 'greet', name: 'Greet Skill', description: 'says hello', body: '# Greet\nSay hello warmly.' });
    expect(contributed[1]).toEqual({ id: 'inline', name: 'inline', description: '', body: '# Inline Skill\nDo things inline.' });
  });

  it('mcpServers → mcpRegistry.addServer，id 冠 "plugin:<pid>:<sid>" 前缀', async () => {
    await installPluginDir({ dataDir: workDir }, await writeFullDemoSource('mcp-pkg'));
    const mcp = stubMcpRegistry();
    const registry = new PluginRegistry({ dataDir: workDir, logger: silentLogger(), mcpRegistry: mcp });
    await registry.refresh();

    expect(mcp.add).toHaveBeenCalledTimes(1);
    expect(mcp.addServer).toHaveBeenCalledWith({
      id: 'plugin:demo-plugin:main',
      name: 'Demo MCP',
      transport: 'stdio',
      command: 'node',
      args: ['scripts/server.mjs'],
    });
    expect(mcp.servers.has('plugin:demo-plugin:main')).toBe(true);
  });

  it('refresh 幂等：teardown（removeContributed/removeServer）后重建，不重复注入', async () => {
    await installPluginDir({ dataDir: workDir }, await writeFullDemoSource('idem-pkg'));
    const skills = stubSkillsRegistry();
    const mcp = stubMcpRegistry();
    const registry = new PluginRegistry({ dataDir: workDir, logger: silentLogger(), skillsRegistry: skills, mcpRegistry: mcp });

    await registry.refresh();
    await registry.refresh();

    expect(skills.store.get('plugin:demo-plugin')).toHaveLength(2); // 仍是单份
    expect(mcp.servers.size).toBe(1);
    expect(skills.removeContributed).toHaveBeenCalledWith('plugin:demo-plugin'); // 第二轮先摘
    expect(mcp.removeServer).toHaveBeenCalledWith('plugin:demo-plugin:main');
  });

  it('skill 文件在安装后丢失 → refresh 跳过该包并 warn（不中断聚合）', async () => {
    const src = await writeFullDemoSource('gone-pkg');
    await installPluginDir({ dataDir: workDir }, src);
    await rm(path.join(workDir, 'plugins', 'demo-plugin', 'skills', 'greet.md'));
    const { logger, warn } = spyLogger();
    const registry = new PluginRegistry({ dataDir: workDir, logger });
    const plugins = await registry.refresh();
    expect(plugins).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });
});

describe('PluginRegistry — remove / runScript', () => {
  it('remove：无 force 且有贡献在用 → FORBIDDEN；force → 摘贡献再删目录', async () => {
    await installPluginDir({ dataDir: workDir }, await writeFullDemoSource('rm-pkg'));
    const skills = stubSkillsRegistry();
    const mcp = stubMcpRegistry();
    const registry = new PluginRegistry({ dataDir: workDir, logger: silentLogger(), skillsRegistry: skills, mcpRegistry: mcp });
    await registry.refresh();
    const pluginDir = path.join(workDir, 'plugins', 'demo-plugin');

    await expectHarnessError(() => registry.remove('demo-plugin'), 'HARNESS-1007');
    expect(existsSync(pluginDir)).toBe(true); // 目录未删
    expect(skills.store.has('plugin:demo-plugin')).toBe(true); // 贡献仍在

    await registry.remove('demo-plugin', { force: true });
    expect(skills.removeContributed).toHaveBeenCalledWith('plugin:demo-plugin');
    expect(mcp.removeServer).toHaveBeenCalledWith('plugin:demo-plugin:main');
    expect(skills.store.has('plugin:demo-plugin')).toBe(false);
    expect(mcp.servers.has('plugin:demo-plugin:main')).toBe(false);
    expect(existsSync(pluginDir)).toBe(false);
    expect(registry.list()).toEqual([]);
  });

  it('remove：无贡献插件直接删；未知 id → EXT_NOT_FOUND（HARNESS-3004）', async () => {
    await writePluginSource(workDir, makeManifest({ id: 'plain', prompts: [{ id: 'p', name: 'P', body: 'x' }] }), {}, 'plain-src');
    await installPluginDir({ dataDir: workDir }, path.join(workDir, 'plain-src'));
    const registry = new PluginRegistry({ dataDir: workDir, logger: silentLogger() });
    await registry.refresh();

    await registry.remove('plain');
    expect(existsSync(path.join(workDir, 'plugins', 'plain'))).toBe(false);
    await expectHarnessError(() => registry.remove('plain'), 'HARNESS-3004');
  });

  it('runScript：未注入 scriptRunner → NOT_IMPLEMENTED（HARNESS-9004）', async () => {
    const registry = new PluginRegistry({ dataDir: workDir, logger: silentLogger() });
    await expectHarnessError(() => registry.runScript('demo-plugin', 'tool', {}), 'HARNESS-9004');
  });

  it('runScript：注入 runner → 委托执行；未知插件/脚本 → EXT_NOT_FOUND', async () => {
    await installPluginDir({ dataDir: workDir }, await writeFullDemoSource('run-pkg'));
    const run = vi.fn(async () => ({ ok: true, result: { answer: 42 } }));
    const runner: ScriptRunnerLike = { run };
    const registry = new PluginRegistry({ dataDir: workDir, logger: silentLogger(), scriptRunner: runner });
    await registry.refresh();

    const out = await registry.runScript('demo-plugin', 'tool', { q: 'life' });
    expect(out).toEqual({ ok: true, result: { answer: 42 } });
    expect(run).toHaveBeenCalledWith('demo-plugin', 'tool', { q: 'life' });

    await expectHarnessError(() => registry.runScript('ghost', 'tool', {}), 'HARNESS-3004');
    await expectHarnessError(() => registry.runScript('demo-plugin', 'ghost', {}), 'HARNESS-3004');
  });
});

// ---------------------------------------------------------------------------
// createPluginsBridge
// ---------------------------------------------------------------------------

describe('createPluginsBridge', () => {
  it('plugins.list → { plugins }；其余 plugin topics → NOT_IMPLEMENTED 形状 HARNESS-9004', async () => {
    await installPluginDir({ dataDir: workDir }, await writeFullDemoSource('bridge-pkg'));
    const registry = new PluginRegistry({ dataDir: workDir, logger: silentLogger() });
    await registry.refresh();
    const bridge = createPluginsBridge({ registry });

    const listed = (await bridge[PLUGIN_BRIDGE_TOPICS.list]({}, 'ext:caller')) as { plugins: InstalledPlugin[] };
    expect(listed.plugins.map((p) => p.id)).toEqual(['demo-plugin']);

    for (const topic of [
      PLUGIN_BRIDGE_TOPICS.get,
      PLUGIN_BRIDGE_TOPICS.refresh,
      PLUGIN_BRIDGE_TOPICS.install,
      PLUGIN_BRIDGE_TOPICS.remove,
      PLUGIN_BRIDGE_TOPICS.runScript,
    ]) {
      const handler = bridge[topic];
      expect(handler).toBeTypeOf('function');
      const shape = (await handler({}, 'ext:caller')) as { code: string };
      expect(shape.code).toBe('HARNESS-9004');
    }
  });
});

// ---------------------------------------------------------------------------
// REST /api/v1/plugins（fastify.inject + 真 registry + 真 zip 上传）
// ---------------------------------------------------------------------------

const ADMIN_TOKEN = 'token-admin';
const ROOT_TOKEN = 'token-root';
const NORMAL_TOKEN = 'token-normal';
const AUTH_ADMIN = { authorization: `Bearer ${ADMIN_TOKEN}` };
const AUTH_ROOT = { authorization: `Bearer ${ROOT_TOKEN}` };
const AUTH_NORMAL = { authorization: `Bearer ${NORMAL_TOKEN}` };

/** 手工构造 multipart/form-data 请求体（field 名固定 'file'） */
function multipartBody(filename: string, content: Buffer): { payload: Buffer; headers: Record<string, string> } {
  const boundary = `----opptrixplugb${Math.random().toString(36).slice(2)}`;
  const head =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: application/zip\r\n\r\n`;
  const tail = `\r\n--${boundary}--\r\n`;
  return {
    payload: Buffer.concat([Buffer.from(head, 'utf8'), content, Buffer.from(tail, 'utf8')]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

async function buildServer(opts: { installerZip?: 'raw' | 'bound'; maxZipBytes?: number } = {}): Promise<FastifyInstance> {
  const registry = new PluginRegistry({ dataDir: workDir, logger: silentLogger() });
  const installer = opts.installerZip === 'bound' ? (zipPath: string) => installPluginZip({ dataDir: workDir }, zipPath) : installPluginZip;
  const config = loadConfig({ NODE_ENV: 'test', HARNESS_LOG_LEVEL: 'error', HARNESS_DATA_DIR: workDir });
  const { app } = createHttpServer({
    config,
    logger: pino({ level: 'silent' }),
    isReady: () => true,
    state: () => 'ready',
    registerExtra: (a) => {
      registerPluginRoutes(a, {
        checker: async ({ token }) => {
          if (token === ADMIN_TOKEN) return { userId: 'admin-1', role: 'admin', scopes: [] };
          if (token === ROOT_TOKEN) return { userId: 'root', role: 'root', scopes: ['*'] };
          if (token === NORMAL_TOKEN) return { userId: 'user-1', role: 'normal', scopes: [] };
          throw err('UNAUTHORIZED', { detail: 'token rejected by all auth providers' });
        },
        registry,
        installerZip: installer,
        ...(opts.maxZipBytes !== undefined ? { maxZipBytes: opts.maxZipBytes } : {}),
      });
    },
  });
  return app;
}

describe('REST /api/v1/plugins — 门禁', () => {
  it.each([
    ['GET', '/api/v1/plugins'],
    ['POST', '/api/v1/plugins/install'],
    ['GET', '/api/v1/plugins/demo-plugin'],
    ['DELETE', '/api/v1/plugins/demo-plugin'],
    ['POST', '/api/v1/plugins/refresh'],
  ])('%s %s 无 token → 401 HARNESS-1006', async (method, url) => {
    const app = await buildServer();
    const res = await app.inject({ method: method as 'GET', url });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('HARNESS-1006');
  });

  it('normal 角色 → 403 HARNESS-1007（admin/root 放行）', async () => {
    const app = await buildServer();
    const denied = await app.inject({ method: 'GET', url: '/api/v1/plugins', headers: AUTH_NORMAL });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().code).toBe('HARNESS-1007');

    const adminOk = await app.inject({ method: 'GET', url: '/api/v1/plugins', headers: AUTH_ADMIN });
    expect(adminOk.statusCode).toBe(200);
    const rootOk = await app.inject({ method: 'GET', url: '/api/v1/plugins', headers: AUTH_ROOT });
    expect(rootOk.statusCode).toBe(200);
  });
});

describe('REST /api/v1/plugins — 全链', () => {
  it('POST install（multipart zip）→ 201 + 自动聚合注入；GET 列表/详情可见（原始 installPluginZip 形态）', async () => {
    const src = await writeFullDemoSource('rest-pkg');
    const zipPath = path.join(workDir, 'rest.zip');
    await zipDir(workDir, path.basename(src), zipPath);
    const zipData = await readFile(zipPath);

    const app = await buildServer({ installerZip: 'raw' });
    const { payload, headers } = multipartBody('demo.zip', zipData);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/plugins/install',
      headers: { ...AUTH_ADMIN, ...headers },
      payload,
    });
    expect(res.statusCode).toBe(201);
    const installed = res.json() as InstalledPlugin;
    expect(installed).toMatchObject({ id: 'demo-plugin', skills: 2, mcpServers: 1 });

    const list = await app.inject({ method: 'GET', url: '/api/v1/plugins', headers: AUTH_ADMIN });
    expect(list.statusCode).toBe(200);
    expect((list.json() as InstalledPlugin[]).map((p) => p.id)).toEqual(['demo-plugin']);

    const detail = await app.inject({ method: 'GET', url: '/api/v1/plugins/demo-plugin', headers: AUTH_ADMIN });
    expect(detail.statusCode).toBe(200);
    expect((detail.json() as InstalledPlugin).version).toBe('1.0.0');

    // 安装目录真实落盘
    expect(existsSync(path.join(workDir, 'plugins', 'demo-plugin', 'plugin.json'))).toBe(true);
  });

  it('单参绑定形态 installerZip 亦可安装；重复安装 → 引导性 400（overwrite 仅原始形态支持）', async () => {
    const app = await buildServer({ installerZip: 'bound' });
    const src1 = await writePluginSource(workDir, makeManifest({ version: '1.0.0' }), {}, 'bound-v1');
    const zip1 = path.join(workDir, 'bound-v1.zip');
    await zipDir(workDir, path.basename(src1), zip1);
    const up1 = multipartBody('b.zip', await readFile(zip1));
    const res1 = await app.inject({
      method: 'POST', url: '/api/v1/plugins/install', headers: { ...AUTH_ADMIN, ...up1.headers }, payload: up1.payload,
    });
    expect(res1.statusCode).toBe(201);

    const src2 = await writePluginSource(workDir, makeManifest({ version: '2.0.0' }), {}, 'bound-v2');
    const zip2 = path.join(workDir, 'bound-v2.zip');
    await zipDir(workDir, path.basename(src2), zip2);
    const up2 = multipartBody('b.zip', await readFile(zip2));
    const dup = await app.inject({
      method: 'POST', url: '/api/v1/plugins/install', headers: { ...AUTH_ADMIN, ...up2.headers }, payload: up2.payload,
    });
    expect(dup.statusCode).toBe(400);
    expect(dup.json().message).toBe('plugin id already installed, use overwrite');

    const over = await app.inject({
      method: 'POST', url: '/api/v1/plugins/install?overwrite=1', headers: { ...AUTH_ADMIN, ...up2.headers }, payload: up2.payload,
    });
    // 绑定形态丢弃 opts → 依旧 400（需要 overwrite 全语义时请传原始 installPluginZip）
    expect(over.statusCode).toBe(400);
  });

  it('非 multipart → 400；非 .zip 文件名 → 400 HARNESS-1009；超限 → 413 HARNESS-1005', async () => {
    const app = await buildServer({ maxZipBytes: 256 });
    const json = await app.inject({
      method: 'POST', url: '/api/v1/plugins/install', headers: { ...AUTH_ADMIN, 'content-type': 'application/json' }, payload: {},
    });
    expect(json.statusCode).toBe(400);
    expect(json.json().code).toBe('HARNESS-1008');

    const notZip = multipartBody('plugin.tar', Buffer.from('not a zip'));
    const bad = await app.inject({
      method: 'POST', url: '/api/v1/plugins/install', headers: { ...AUTH_ADMIN, ...notZip.headers }, payload: notZip.payload,
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().code).toBe('HARNESS-1009');

    const big = multipartBody('big.zip', Buffer.alloc(1024, 1));
    const tooBig = await app.inject({
      method: 'POST', url: '/api/v1/plugins/install', headers: { ...AUTH_ADMIN, ...big.headers }, payload: big.payload,
    });
    expect(tooBig.statusCode).toBe(413);
    expect(tooBig.json().code).toBe('HARNESS-1005');
  });

  it('GET 未知 id → 404 HARNESS-3004；POST refresh → { plugins }；DELETE ?force=1 全链', async () => {
    const app = await buildServer();
    const ghost = await app.inject({ method: 'GET', url: '/api/v1/plugins/ghost', headers: AUTH_ADMIN });
    expect(ghost.statusCode).toBe(404);
    expect(ghost.json().code).toBe('HARNESS-3004');

    // 直装一个有贡献的插件（skills + mcp）后 refresh
    await installPluginDir({ dataDir: workDir }, await writeFullDemoSource('life-pkg'));
    const refresh = await app.inject({ method: 'POST', url: '/api/v1/plugins/refresh', headers: AUTH_ADMIN });
    expect(refresh.statusCode).toBe(200);
    expect((refresh.json() as { plugins: InstalledPlugin[] }).plugins.map((p) => p.id)).toEqual(['demo-plugin']);

    // 无 force → 403
    const denied = await app.inject({ method: 'DELETE', url: '/api/v1/plugins/demo-plugin', headers: AUTH_ADMIN });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().code).toBe('HARNESS-1007');

    // force=1 → 200 {deleted:true}，目录删除、列表清空
    const forced = await app.inject({ method: 'DELETE', url: '/api/v1/plugins/demo-plugin?force=1', headers: AUTH_ADMIN });
    expect(forced.statusCode).toBe(200);
    expect(forced.json()).toEqual({ deleted: true });
    expect(existsSync(path.join(workDir, 'plugins', 'demo-plugin'))).toBe(false);
    const after = await app.inject({ method: 'GET', url: '/api/v1/plugins', headers: AUTH_ADMIN });
    expect(after.json()).toEqual([]);
  });
});
