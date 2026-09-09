/**
 * 本地扩展包安装测试：installer 单元 + REST（POST /api/v1/extensions/install）+ UI 契约面。
 *
 * - installer 单元（/tmp 造 zip）：合法包两态布局（单顶层目录 / 根）、缺 manifest.json、
 *   非法 manifest（semver）、api 不兼容、未知权限、路径穿越 / 绝对路径 / 盘符成员、
 *   symlink 成员（手工 stored zip 构造 unix external attrs——zip CLI 会拒绝此类成员）、
 *   重复安装与 overwrite、受信目录保护（fail-closed）、onInstalled 回调时序；
 * - REST（fastify.inject + 真实 installExtensionZip）：无 token 401 / normal 403 且不落盘、
 *   root 放行、admin 201（manifest 摘要 + enabled:false + onInstalled 触发）、重复 400 文案、
 *   ?overwrite=1 覆盖 201、413（maxZipBytes 收紧）、非 .zip 文件名 400、
 *   非 multipart 400、?overwrite=abc 400；
 * - UI（webui 测试手法——源码契约断言）：分类 Tabs（全部/内置扩展/本地扩展）、「本地扩展」
 *   徽标文案、拖拽 + 安装按钮 + 32MB 客户端预检、POST install + FormData、二次确认 Dialog
 *   的信任提示文案、确认后 rescan 刷新、重复安装引导文案、移动端断行（break-all）与
 *   无 console.*。
 */
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { crc32 } from 'node:zlib';

import type { FastifyInstance } from 'fastify';
import pino from 'pino';
import type { Logger } from 'pino';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { registerExtensionRoutes, type ExtensionsApiDeps } from '../src/api/extensions.js';
import { loadConfig } from '../src/kernel/config/index.js';
import { err } from '../src/kernel/errors/HarnessError.js';
import { installExtensionZip } from '../src/kernel/extensions/installer.js';
import { createHttpServer } from '../src/kernel/http/server.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// 测试环境（全部落 /tmp）
// ---------------------------------------------------------------------------

let workDir = '';
let repoExtDir = '';
let dataDir = '';

beforeAll(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), 'opptrix-ext-install-'));
  dataDir = path.join(workDir, 'data');
  repoExtDir = path.join(workDir, 'repo-extensions');
  await mkdir(dataDir, { recursive: true });
  await mkdir(repoExtDir, { recursive: true });
  // 受信目录哨兵：全部用例结束后必须原样存在（安装绝不触碰受信目录）
  await writeFile(path.join(repoExtDir, 'auth-manifest.json'), '{"id":"auth"}');
});

afterEach(async () => {
  // 清掉安装产物，保持用例独立；任何用例都不应留下 staging 半成品
  await rm(path.join(dataDir, 'extensions'), { recursive: true, force: true }).catch(() => {});
  const leftovers = readdirSync(dataDir).filter((n) => n.startsWith('.ext-staging-'));
  expect(leftovers).toEqual([]);
});

afterAll(async () => {
  // 受信目录保护的总断言：repo-extensions 全程未被写入
  expect(readdirSync(repoExtDir).sort()).toEqual(['auth-manifest.json']);
  await rm(workDir, { recursive: true, force: true }).catch(() => {});
});

// ---------------------------------------------------------------------------
// 造包辅助
// ---------------------------------------------------------------------------

/** 合法最小扩展 manifest（覆盖用可深合并） */
function makeManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'demo-ext',
    api: 1,
    version: '1.0.0',
    main: 'index.js',
    displayName: 'Demo Ext',
    permissions: ['events'],
    ...overrides,
  };
}

/** 在 base 下写一个扩展源目录（manifest + 附加文件），返回目录路径 */
async function writeExtSource(
  base: string,
  manifest: Record<string, unknown>,
  files: Record<string, string> = {},
  dirName = 'src',
): Promise<string> {
  const dir = path.join(base, dirName);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(dir, rel);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return dir;
}

/** 用系统 zip CLI 打 zip（cwd=srcDir 的父目录 → 单顶层目录布局） */
async function zipDir(cwd: string, srcName: string, outZip: string): Promise<void> {
  await execFileAsync('zip', ['-r', '-q', outZip, srcName], { cwd });
}

/** 造合法 zip（单顶层目录 <dirName>/）并返回路径 */
async function makeValidZip(dirName: string, indexContent = 'export const version = "v1";\n'): Promise<string> {
  const src = await writeExtSource(workDir, makeManifest({ id: dirName }), { 'index.js': indexContent }, dirName);
  const zipPath = path.join(workDir, `${dirName}.zip`);
  await zipDir(path.dirname(src), path.basename(src), zipPath);
  return zipPath;
}

interface CraftEntry {
  name: string;
  data: Buffer | string;
  /** central directory 的 version made by（2 字节；默认 20，高字节 3 = unix） */
  madeBy?: number;
  /** central directory 的 external file attributes（4 字节；unix 模式在高 16 位） */
  externalAttrs?: number;
}

/**
 * 手工构造 stored（不压缩）zip——用于路径穿越 / 绝对路径 / symlink 等 zip CLI 拒绝
 * 构造的成员。Local File Header + Central Directory + EOCD，CRC 用 node:zlib.crc32。
 */
function craftStoredZip(entries: CraftEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const crc = crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method: store
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0x21, 12); // mod date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(entry.madeBy ?? 20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10); // method: store
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(entry.externalAttrs ?? 0, 38); // external attrs
    central.writeUInt32LE(offset, 42); // local header offset
    centrals.push(Buffer.concat([central, nameBuf]));
    offset += 30 + nameBuf.length + data.length;
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
async function writeCraftedZip(entries: CraftEntry[]): Promise<string> {
  const zipPath = path.join(workDir, `crafted-${Math.random().toString(36).slice(2)}.zip`);
  await writeFile(zipPath, craftStoredZip(entries));
  return zipPath;
}

/** 合法 manifest 条目的便捷造法（根布局单条目） */
function manifestEntry(id: string, overrides: Record<string, unknown> = {}): CraftEntry {
  return { name: 'manifest.json', data: JSON.stringify(makeManifest({ id, ...overrides })) };
}

// ############################################################################
// A. installer 单元
// ############################################################################

describe('installer — installExtensionZip', () => {
  it('1. 合法 zip（单顶层目录布局）→ 落位 <dataDir>/extensions/<id>，返回摘要，无 staging 残留', async () => {
    const zipPath = await makeValidZip('demo-ext');
    const result = await installExtensionZip({ dataDir, extensionsRepoDir: repoExtDir }, zipPath);
    expect(result).toMatchObject({
      id: 'demo-ext',
      version: '1.0.0',
      api: 1,
      displayName: 'Demo Ext',
      permissions: ['events'],
    });
    expect(result.dir).toBe(path.join(dataDir, 'extensions', 'demo-ext'));
    // 磁盘内容与包内一致
    expect(existsSync(path.join(result.dir, 'manifest.json'))).toBe(true);
    expect(readFileSync(path.join(result.dir, 'index.js'), 'utf8')).toContain('v1');
    // dataDir 只应有 extensions 根（staging 已清理）
    expect(readdirSync(dataDir).sort()).toEqual(['extensions']);
  });

  it('2. 合法 zip（根布局）→ manifest 在 zip 根可识别，嵌套文件一并落盘', async () => {
    const zipPath = await writeCraftedZip([
      manifestEntry('root-ext'),
      { name: 'index.js', data: 'export = 1;' },
      { name: 'lib/util.js', data: 'export const u = 2;' },
    ]);
    const result = await installExtensionZip({ dataDir }, zipPath);
    expect(result.id).toBe('root-ext');
    expect(existsSync(path.join(result.dir, 'lib', 'util.js'))).toBe(true);
  });

  it('3. 缺 manifest.json → EXT_MANIFEST_INVALID（HARNESS-3001）且目标目录不创建', async () => {
    const zipPath = await writeCraftedZip([{ name: 'index.js', data: 'x' }]);
    await expect(installExtensionZip({ dataDir }, zipPath)).rejects.toMatchObject({
      code: 'HARNESS-3001',
      status: 400,
    });
    expect(existsSync(path.join(dataDir, 'extensions'))).toBe(false);
  });

  it('4. manifest 非法（version 非 semver）→ EXT_MANIFEST_INVALID（HARNESS-3001）', async () => {
    const zipPath = await writeCraftedZip([
      manifestEntry('bad-ext', { version: 'not-semver' }),
      { name: 'index.js', data: 'x' },
    ]);
    await expect(installExtensionZip({ dataDir }, zipPath)).rejects.toMatchObject({ code: 'HARNESS-3001' });
    expect(existsSync(path.join(dataDir, 'extensions', 'bad-ext'))).toBe(false);
  });

  it('5. manifest.api 不受支持（api: 99）→ EXT_API_INCOMPATIBLE（HARNESS-3011, 409）', async () => {
    const zipPath = await writeCraftedZip([manifestEntry('future-ext', { api: 99 })]);
    await expect(installExtensionZip({ dataDir }, zipPath)).rejects.toMatchObject({
      code: 'HARNESS-3011',
      status: 409,
    });
  });

  it('6. 未知权限 → EXT_MANIFEST_INVALID（validatePermissions 安装期 fail-fast）', async () => {
    const zipPath = await writeCraftedZip([manifestEntry('perm-ext', { permissions: ['sudo'] })]);
    await expect(installExtensionZip({ dataDir }, zipPath)).rejects.toMatchObject({ code: 'HARNESS-3001' });
  });

  it.each([
    [
      '路径穿越（..）',
      () => [
        { name: 'demo-ext/manifest.json', data: JSON.stringify(makeManifest()) },
        { name: '../evil.txt', data: 'x' },
      ],
    ],
    [
      '绝对路径',
      () => [
        { name: 'demo-ext/manifest.json', data: JSON.stringify(makeManifest()) },
        { name: '/etc/evil.txt', data: 'x' },
      ],
    ],
    [
      '盘符',
      () => [
        { name: 'demo-ext/manifest.json', data: JSON.stringify(makeManifest()) },
        { name: 'C:\\evil.txt', data: 'x' },
      ],
    ],
  ])('7. %s 成员 → VALIDATION_FAILED（HARNESS-1009）且不落盘', async (_label, makeEntries) => {
    const zipPath = await writeCraftedZip(makeEntries() as CraftEntry[]);
    await expect(installExtensionZip({ dataDir }, zipPath)).rejects.toMatchObject({
      code: 'HARNESS-1009',
      status: 400,
    });
    // 逃生文件绝不存在（数据卷内 / 目标目录内）
    expect(existsSync(path.join(workDir, 'evil.txt'))).toBe(false);
    expect(existsSync(path.join(dataDir, 'evil.txt'))).toBe(false);
    expect(existsSync(path.join(dataDir, 'extensions'))).toBe(false);
  });

  it('8. symlink 成员（unix external attrs = S_IFLNK）→ VALIDATION_FAILED 拒绝', async () => {
    const zipPath = await writeCraftedZip([
      { name: 'demo-ext/manifest.json', data: JSON.stringify(makeManifest()) },
      {
        name: 'demo-ext/link',
        data: '/etc/passwd',
        madeBy: (3 << 8) | 20, // unix
        externalAttrs: ((0o120777 << 16) >>> 0), // S_IFLNK | 0777（>>>0 归一为 uint32）
      },
    ]);
    await expect(installExtensionZip({ dataDir }, zipPath)).rejects.toMatchObject({ code: 'HARNESS-1009' });
    expect(existsSync(path.join(dataDir, 'extensions'))).toBe(false);
  });

  it('9. 重复安装未 overwrite → BAD_REQUEST 引导文案；overwrite=true 先删旧再原子落位', async () => {
    const onInstalled = vi.fn();
    const cfg = { dataDir, extensionsRepoDir: repoExtDir, onInstalled };
    const zipV1 = await writeCraftedZip([
      manifestEntry('dup-ext'),
      { name: 'index.js', data: 'v1-content' },
      { name: 'old.txt', data: 'stale' },
    ]);
    const first = await installExtensionZip(cfg, zipV1);
    expect(first.id).toBe('dup-ext');
    expect(onInstalled).toHaveBeenCalledTimes(1);
    expect(onInstalled).toHaveBeenCalledWith('dup-ext');

    // 重复安装（未 overwrite）→ BAD_REQUEST + 引导文案；旧目录原样、失败路径不触发回调
    await expect(installExtensionZip(cfg, zipV1)).rejects.toMatchObject({
      code: 'HARNESS-1008',
      status: 400,
      message: 'extension id already installed, use overwrite',
    });
    expect(onInstalled).toHaveBeenCalledTimes(1);
    expect(readFileSync(path.join(dataDir, 'extensions', 'dup-ext', 'index.js'), 'utf8')).toBe('v1-content');

    // overwrite=true：v2 落位、仅存于 v1 的旧文件消失、回调再触发
    const zipV2 = await writeCraftedZip([manifestEntry('dup-ext'), { name: 'index.js', data: 'v2-content' }]);
    const second = await installExtensionZip(cfg, zipV2, { overwrite: true });
    expect(second.dir).toBe(path.join(dataDir, 'extensions', 'dup-ext'));
    expect(readFileSync(path.join(dataDir, 'extensions', 'dup-ext', 'index.js'), 'utf8')).toBe('v2-content');
    expect(existsSync(path.join(dataDir, 'extensions', 'dup-ext', 'old.txt'))).toBe(false);
    expect(onInstalled).toHaveBeenCalledTimes(2);
  });

  it('10. 受信目录保护：安装根解析后等于受信目录 → fail-closed BAD_REQUEST（连 zip 都不打开）', async () => {
    // 错误接线模拟：dataDir 指向受信目录的父目录 → <dataDir>/extensions === 受信目录
    const trustedDir = path.join(workDir, 'extensions');
    await mkdir(trustedDir, { recursive: true });
    await writeFile(path.join(trustedDir, 'sentinel.txt'), 'do-not-touch');
    try {
      const badCfg = { dataDir: workDir, extensionsRepoDir: trustedDir };
      // zipPath 故意不存在：证明受信闸先于任何解包执行
      await expect(installExtensionZip(badCfg, path.join(workDir, 'no-such.zip'))).rejects.toMatchObject({
        code: 'HARNESS-1008',
        status: 400,
      });
      expect(readFileSync(path.join(trustedDir, 'sentinel.txt'), 'utf8')).toBe('do-not-touch');
    } finally {
      await rm(trustedDir, { recursive: true, force: true });
    }
  });

  it('11. 正常接线（extensionsRepoDir 不同路径）→ 安装成功且受信目录不受影响', async () => {
    const zipPath = await makeValidZip('safe-ext');
    const result = await installExtensionZip({ dataDir, extensionsRepoDir: repoExtDir }, zipPath);
    expect(result.id).toBe('safe-ext');
    expect(existsSync(path.join(repoExtDir, 'safe-ext'))).toBe(false);
  });
});

// ############################################################################
// B. REST — POST /api/v1/extensions/install
// ############################################################################

const ADMIN_TOKEN = 'token-admin';
const ROOT_TOKEN = 'token-root';
const NORMAL_TOKEN = 'token-normal';
const AUTH_ADMIN = { authorization: `Bearer ${ADMIN_TOKEN}` };
const AUTH_ROOT = { authorization: `Bearer ${ROOT_TOKEN}` };
const AUTH_NORMAL = { authorization: `Bearer ${NORMAL_TOKEN}` };

let boundarySeq = 0;

/** 手工构造 multipart/form-data 请求体（field 名固定 'file'） */
function multipartBody(filename: string, mime: string, content: Buffer): {
  payload: Buffer;
  headers: Record<string, string>;
} {
  boundarySeq += 1;
  const boundary = `----opptrixextboundary${boundarySeq}`;
  const head =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: ${mime}\r\n\r\n`;
  const tail = `\r\n--${boundary}--\r\n`;
  return {
    payload: Buffer.concat([Buffer.from(head, 'utf8'), content, Buffer.from(tail, 'utf8')]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

/** zip 文件读为 Buffer（multipart payload 用） */
function readZip(p: string): Promise<Buffer> {
  return readFile(p);
}

/** ExtensionsApiDeps 的最小 stub（manager/registry 仅满足只读面）+ 真实安装器接线 */
function buildDeps(installOpts?: { maxZipBytes?: number }): {
  deps: ExtensionsApiDeps;
  onInstalled: ReturnType<typeof vi.fn>;
} {
  const onInstalled = vi.fn();
  const deps: ExtensionsApiDeps = {
    checker: async ({ token }) => {
      if (token === ADMIN_TOKEN) return { role: 'admin' };
      if (token === ROOT_TOKEN) return { role: 'root' };
      if (token === NORMAL_TOKEN) return { role: 'normal' };
      throw err('UNAUTHORIZED', { detail: 'token rejected by all auth providers' });
    },
    manager: {
      list: () => [],
      enable: async () => {},
      disable: async () => {},
      reload: async () => {},
      uninstall: async () => {},
      rescan: async () => ({ discovered: [] }),
      getRoutes: () => [],
    },
    registry: { list: () => [] },
    install: {
      installZip: (cfg, zipPath, opts) => installExtensionZip(cfg, zipPath, opts),
      dataDir,
      extensionsRepoDir: repoExtDir,
      onInstalled,
      ...(installOpts?.maxZipBytes !== undefined ? { maxZipBytes: installOpts.maxZipBytes } : {}),
    },
  };
  return { deps, onInstalled };
}

/** 组装被测服务器（真实 installExtensionZip 接线；registerExtensionRoutes 自挂安装子上下文） */
function buildServer(installOpts?: { maxZipBytes?: number }): {
  app: FastifyInstance;
  onInstalled: ReturnType<typeof vi.fn>;
} {
  const { deps, onInstalled } = buildDeps(installOpts);
  const config = loadConfig({ NODE_ENV: 'test', HARNESS_LOG_LEVEL: 'error', HARNESS_DATA_DIR: dataDir });
  const { app } = createHttpServer({
    config,
    logger: pino({ level: 'silent' }),
    isReady: () => true,
    state: () => 'ready',
    registerExtra: (a) => {
      registerExtensionRoutes(a, deps);
    },
  });
  return { app, onInstalled };
}

describe('extensions install api — 鉴权门禁', () => {
  it('12. POST install 无 token → 401 HARNESS-1006', async () => {
    const { app } = buildServer();
    const { payload, headers } = multipartBody(
      'gate-ext.zip',
      'application/zip',
      craftStoredZip([manifestEntry('gate-ext')]),
    );
    const res = await app.inject({ method: 'POST', url: '/api/v1/extensions/install', headers, payload });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'HARNESS-1006' });
    await app.close();
  });

  it('13. normal 角色 → 403 HARNESS-1007 且不触达安装器（目标目录不落盘）', async () => {
    const { app, onInstalled } = buildServer();
    const { payload, headers } = multipartBody(
      'gate-ext.zip',
      'application/zip',
      craftStoredZip([manifestEntry('gate-ext')]),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/extensions/install',
      headers: { ...AUTH_NORMAL, ...headers },
      payload,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('HARNESS-1007');
    expect(res.json().message).toContain('admin or root');
    expect(onInstalled).not.toHaveBeenCalled();
    expect(existsSync(path.join(dataDir, 'extensions'))).toBe(false);
    await app.close();
  });

  it('14. root 角色放行 → 201', async () => {
    const { app } = buildServer();
    const { payload, headers } = multipartBody(
      'root-api-ext.zip',
      'application/zip',
      craftStoredZip([manifestEntry('root-api-ext')]),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/extensions/install',
      headers: { ...AUTH_ROOT, ...headers },
      payload,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ ok: true, id: 'root-api-ext', enabled: false });
    await app.close();
  });
});

describe('extensions install api — 安装全链（真实 installExtensionZip）', () => {
  it('15. admin multipart 合法 zip → 201 { id, manifest 摘要, enabled:false }，磁盘落位 + onInstalled(id)', async () => {
    const { app, onInstalled } = buildServer();
    const zipPath = await makeValidZip('rest-ext');
    const { payload, headers } = multipartBody('rest-ext.zip', 'application/zip', await readZip(zipPath));
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/extensions/install',
      headers: { ...AUTH_ADMIN, ...headers },
      payload,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      ok: true,
      id: 'rest-ext',
      dir: path.join(dataDir, 'extensions', 'rest-ext'),
      manifest: { id: 'rest-ext', version: '1.0.0', api: 1, displayName: 'Demo Ext', permissions: ['events'] },
      enabled: false,
      overwrite: false,
    });
    expect(existsSync(path.join(dataDir, 'extensions', 'rest-ext', 'manifest.json'))).toBe(true);
    expect(onInstalled).toHaveBeenCalledTimes(1);
    expect(onInstalled).toHaveBeenCalledWith('rest-ext');
    await app.close();
  });

  it('16. 重复安装 → 400 HARNESS-1008（extension id already installed, use overwrite）；?overwrite=1 → 201', async () => {
    const { app, onInstalled } = buildServer();
    const zipPath = await makeValidZip('dup-rest-ext');
    const { payload, headers } = multipartBody('dup-rest-ext.zip', 'application/zip', await readZip(zipPath));
    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/extensions/install',
      headers: { ...AUTH_ADMIN, ...headers },
      payload,
    });
    expect(first.statusCode).toBe(201);

    const dup = await app.inject({
      method: 'POST',
      url: '/api/v1/extensions/install',
      headers: { ...AUTH_ADMIN, ...headers },
      payload,
    });
    expect(dup.statusCode).toBe(400);
    expect(dup.json()).toMatchObject({ code: 'HARNESS-1008', message: 'extension id already installed, use overwrite' });
    expect(onInstalled).toHaveBeenCalledTimes(1);

    const over = await app.inject({
      method: 'POST',
      url: '/api/v1/extensions/install?overwrite=1',
      headers: { ...AUTH_ADMIN, ...headers },
      payload,
    });
    expect(over.statusCode).toBe(201);
    expect(over.json()).toMatchObject({ overwrite: true, id: 'dup-rest-ext' });
    expect(onInstalled).toHaveBeenCalledTimes(2);
    await app.close();
  });

  it('17. 超过上限 → 413 HARNESS-1005（maxZipBytes 收紧后小包即超限）', async () => {
    const { app } = buildServer({ maxZipBytes: 64 });
    const zipPath = await writeCraftedZip([
      manifestEntry('big-ext'),
      { name: 'index.js', data: 'x'.repeat(500) },
    ]);
    const { payload, headers } = multipartBody('big-ext.zip', 'application/zip', await readZip(zipPath));
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/extensions/install',
      headers: { ...AUTH_ADMIN, ...headers },
      payload,
    });
    expect(res.statusCode).toBe(413);
    expect(res.json().code).toBe('HARNESS-1005');
    await app.close();
  });

  it('18. 非 .zip 文件名 → 400 HARNESS-1009；非 multipart → 400 HARNESS-1008；?overwrite=abc → 400 HARNESS-1009', async () => {
    const { app } = buildServer();
    const zipPath = await writeCraftedZip([manifestEntry('n-zip-ext')]);
    const buf = await readZip(zipPath);

    const notZip = multipartBody('evil.txt', 'text/plain', buf);
    const res1 = await app.inject({
      method: 'POST',
      url: '/api/v1/extensions/install',
      headers: { ...AUTH_ADMIN, ...notZip.headers },
      payload: notZip.payload,
    });
    expect(res1.statusCode).toBe(400);
    expect(res1.json().code).toBe('HARNESS-1009');

    const res2 = await app.inject({
      method: 'POST',
      url: '/api/v1/extensions/install',
      headers: { ...AUTH_ADMIN, 'content-type': 'application/json' },
      payload: { nope: true },
    });
    expect(res2.statusCode).toBe(400);
    expect(res2.json().code).toBe('HARNESS-1008');

    const badQuery = multipartBody('n-zip-ext.zip', 'application/zip', buf);
    const res3 = await app.inject({
      method: 'POST',
      url: '/api/v1/extensions/install?overwrite=abc',
      headers: { ...AUTH_ADMIN, ...badQuery.headers },
      payload: badQuery.payload,
    });
    expect(res3.statusCode).toBe(400);
    expect(res3.json().code).toBe('HARNESS-1009');
    await app.close();
  });
});

// ############################################################################
// C. UI 契约面（webui 测试手法：源码静态断言）
// ############################################################################

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const UI_SRC = path.join(REPO_ROOT, 'extensions', 'webui', 'ui-src', 'src');
const EXT_DIR = path.join(UI_SRC, 'pages', 'Extensions');

describe('extensions install — UI 契约面（源码断言）', () => {
  const page = readFileSync(path.join(UI_SRC, 'pages', 'Extensions.tsx'), 'utf8');
  const shared = readFileSync(path.join(EXT_DIR, 'shared.tsx'), 'utf8');
  const card = readFileSync(path.join(EXT_DIR, 'ExtensionCard.tsx'), 'utf8');
  const dialog = readFileSync(path.join(EXT_DIR, 'InstallConfirmDialog.tsx'), 'utf8');

  it('19. 分类 Tabs：全部 / 内置扩展（host=builtin）/ 本地扩展（host=community）三分类齐备', () => {
    expect(page).toContain('value="all"');
    expect(page).toContain('value="builtin"');
    expect(page).toContain('value="community"');
    expect(page).toContain('>内置扩展（');
    expect(page).toContain('>本地扩展（');
    expect(page).toContain("filter((ext) => ext.host === 'builtin')");
    expect(page).toContain("filter((ext) => ext.host === 'community')");
  });

  it('20. 徽标文案统一「本地扩展」（单一来源 hostBadgeLabel，卡片不再出现「社区」文案）', () => {
    expect(shared).toContain("'内置' : '本地扩展'");
    expect(card).toContain('hostBadgeLabel(ext.host)');
    expect(card).not.toContain('社区');
    expect(page).not.toContain('>社区<');
  });

  it('21. 安装入口：工具条「安装扩展包」+ 页面级拖拽（dragover 高亮）+ 32MB/.zip 客户端预检', () => {
    expect(page).toContain('安装扩展包');
    expect(page).toContain('accept=".zip"');
    expect(page).toContain('onDragEnter=');
    expect(page).toContain('onDragOver=');
    expect(page).toContain('onDragLeave=');
    expect(page).toContain('onDrop=');
    expect(page).toContain('松开以安装扩展包');
    expect(shared).toContain('MAX_EXTENSION_ZIP_BYTES = 32 * 1024 * 1024');
    expect(page).toContain("endsWith('.zip')");
    expect(page).toContain('MAX_EXTENSION_ZIP_BYTES');
  });

  it('22. POST install（FormData field file）→ 二次确认 Dialog（manifest 摘要 + 信任提示）→ 确认后 rescan 刷新', () => {
    expect(page).toContain("api.post<ExtensionInstallResponse>('/api/v1/extensions/install', form");
    expect(page).toContain("form.append('file', file)");
    expect(page).toContain('<InstallConfirmDialog');
    // Dialog 展示摘要 + 信任提示（2FA 管理员账户提示语）
    expect(dialog).toContain('result.manifest.displayName');
    expect(dialog).toContain('result.manifest.version');
    expect(dialog).toContain('result.manifest.permissions');
    expect(dialog).toContain('该扩展为第三方，启用时需信任确认 + 可绑定 2FA 保护的管理员账户');
    // 确认后自动 rescan → 刷新列表，并提示新扩展默认停用（启用走既有信任确认流）
    expect(page).toContain("api.post('/api/v1/extensions/rescan')");
    expect(page).toContain('默认停用，启用时需信任确认');
  });

  it('23. 重复安装 400 的引导文案「已安装，可开启覆盖重装」', () => {
    expect(page).toContain('isDuplicateInstallError(e)');
    expect(page).toContain('已安装，可开启覆盖重装');
  });

  it('24. 移动端适配：<md 单列卡片流、长 id/code 断行 break-all、操作行 wrap、Badge 收缩；≥md 双列保持', () => {
    expect(page).toContain('grid grid-cols-1 gap-3 md:grid-cols-2');
    expect(page).toContain('h-auto flex-wrap');
    // 卡片：id/目录断行 + 元数据/操作行 wrap + min-w-0 收缩
    expect(card).toContain('break-all');
    expect(card).toContain('flex-wrap');
    expect(card).toContain('min-w-0');
    // 表格长路径 / 服务全名断行
    expect(page).toContain('break-all font-mono text-xs');
  });

  it('25. 新增 UI 源码无 console.*', () => {
    const files = [
      path.join(EXT_DIR, 'shared.tsx'),
      path.join(EXT_DIR, 'ExtensionCard.tsx'),
      path.join(EXT_DIR, 'InstallConfirmDialog.tsx'),
      path.join(UI_SRC, 'pages', 'Extensions.tsx'),
    ];
    for (const f of files) {
      expect(readFileSync(f, 'utf8'), `${f} uses console.*`).not.toMatch(/\bconsole\.(log|error|warn|info|debug)/);
    }
  });
});
