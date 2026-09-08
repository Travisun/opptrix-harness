/**
 * 发布工程单测：scripts/release-core.mjs 的 buildRelease + docker 静态断言。
 *
 * 覆盖（对应 scripts/release-core.mjs 头注释的契约）：
 * - 产物三件套存在、staging 清理
 * - tar 结构（manifest.json 首项、dist/node_modules/bootstrap/package.json/types、symlink 保留）
 * - sha256 文件与实际包一致（sha256sum 格式）
 * - feed json 形状（stable/beta、version/url/sha256/notes）
 * - 幂等冲突（--force 覆盖）
 * - --version 仅命名产物（源 package.json 不动）
 * - 非法版本 / 输入缺失的 fail-fast
 * - Dockerfile / Dockerfile.sandbox / docker-compose.yml / .dockerignore 关键指令
 */

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { extract } from 'tar-stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { buildRelease } from '../scripts/release-core.mjs';

/* ---------- fixtures ---------- */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let baseDir: string;

beforeAll(async () => {
  baseDir = await mkdtemp(path.join(tmpdir(), 'opptrix-release-'));
});

afterAll(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

/** 造一个最小"项目"：package.json + dist + node_modules(含 .bin symlink) + bootstrap.mjs + types */
async function makeProject(
  name: string,
  opts: { version?: string; withDist?: boolean } = {},
): Promise<string> {
  const proj = path.join(baseDir, name);
  await mkdir(path.join(proj, 'node_modules', 'a'), { recursive: true });
  await mkdir(path.join(proj, 'node_modules', 'a', 'nested'), { recursive: true });
  await mkdir(path.join(proj, 'node_modules', '.bin'), { recursive: true });
  await mkdir(path.join(proj, 'types'), { recursive: true });

  await writeFile(
    path.join(proj, 'package.json'),
    JSON.stringify({ name: 'opptrix-harness', version: opts.version ?? '0.1.0', type: 'module' }),
    'utf8',
  );
  await writeFile(path.join(proj, 'bootstrap.mjs'), 'export const BOOTSTRAP = "ok";\n', 'utf8');
  if (opts.withDist !== false) {
    await mkdir(path.join(proj, 'dist'), { recursive: true });
    await writeFile(path.join(proj, 'dist', 'main.js'), 'process.stdout.write("kernel-ok\\n");\n', 'utf8');
  }
  await writeFile(path.join(proj, 'node_modules', 'a', 'package.json'), '{"name":"a","version":"1.0.0"}', 'utf8');
  await writeFile(path.join(proj, 'node_modules', 'a', 'index.js'), 'module.exports = "a";\n', 'utf8');
  await writeFile(
    path.join(proj, 'node_modules', 'a', 'nested', 'deep.js'),
    'module.exports = "deep";\n',
    'utf8',
  );
  await writeFile(path.join(proj, 'node_modules', 'a', 'cli.js'), '#!/usr/bin/env node\n', 'utf8');
  // node_modules 里最常见的 symlink：.bin 入口（发布包必须保留）
  await symlink('../a/cli.js', path.join(proj, 'node_modules', '.bin', 'a-cli'));
  await writeFile(path.join(proj, 'types', 'harness.d.ts'), 'export {};\n', 'utf8');
  return proj;
}

/* ---------- 解包工具：tar-stream 解回断言结构（与 backup.test.ts 同款思路） ---------- */

interface ArchiveContents {
  /** 条目顺序（manifest.json 应为第一项） */
  order: string[];
  files: Map<string, Buffer>;
  symlinks: Map<string, string>;
}

async function extractArchive(archivePath: string): Promise<ArchiveContents> {
  const tar = gunzipSync(await readFile(archivePath));
  const ex = extract();
  const order: string[] = [];
  const files = new Map<string, Buffer>();
  const symlinks = new Map<string, string>();

  const consuming = (async () => {
    for await (const source of ex) {
      const header = source.header;
      order.push(header.name);
      if (header.type === 'symlink') {
        symlinks.set(header.name, header.linkname ?? '');
        for await (const _chunk of source) void _chunk; // 空流，仍需消费完
        continue;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of source) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
      files.set(header.name, Buffer.concat(chunks));
    }
  })();
  ex.end(tar);
  await consuming;
  return { order, files, symlinks };
}

async function listOutDir(outDir: string): Promise<string[]> {
  return (await readdir(outDir)).sort();
}

/* ---------- buildRelease ---------- */

describe('buildRelease（scripts/release-core.mjs）', () => {
  it('1. 产出 tar/sha256/feed 三件套，且 staging 临时目录被清理', async () => {
    const proj = await makeProject('p-basic');
    const outDir = path.join(baseDir, 'out-basic');

    const result = await buildRelease({ projectRoot: proj, build: false, outDir });

    expect(result.version).toBe('0.1.0');
    expect(result.tarPath).toBe(path.join(outDir, 'opptrix-harness-0.1.0.tar.gz'));
    expect(result.sha256Path).toBe(path.join(outDir, 'opptrix-harness-0.1.0.tar.gz.sha256'));
    expect(result.feedPath).toBe(path.join(outDir, 'feed-stable.json'));
    await expect(readFile(result.tarPath)).resolves.toBeTruthy();
    await expect(readFile(result.sha256Path)).resolves.toBeTruthy();
    await expect(readFile(result.feedPath)).resolves.toBeTruthy();
    // staging 清理干净：outDir 只剩三件套
    expect(await listOutDir(outDir)).toEqual([
      'feed-stable.json',
      'opptrix-harness-0.1.0.tar.gz',
      'opptrix-harness-0.1.0.tar.gz.sha256',
    ]);
    expect(result.fileCount).toBeGreaterThan(0);
    expect(result.sizeBytes).toBeGreaterThan(0);
  });

  it('2. tar 可解：manifest.json 是第一项，dist/node_modules/bootstrap/package.json/types 齐全', async () => {
    const proj = await makeProject('p-tar');
    const outDir = path.join(baseDir, 'out-tar');
    const result = await buildRelease({ projectRoot: proj, build: false, outDir });

    const { order, files, symlinks } = await extractArchive(result.tarPath);

    expect(order[0]).toBe('manifest.json');
    expect(files.get('dist/main.js')?.toString('utf8')).toContain('kernel-ok');
    expect(files.get('bootstrap.mjs')?.toString('utf8')).toContain('BOOTSTRAP');
    expect(files.get('package.json')?.toString('utf8')).toContain('"version":"0.1.0"');
    expect(files.get('types/harness.d.ts')?.toString('utf8')).toContain('export');
    expect(files.get('node_modules/a/index.js')?.toString('utf8')).toContain('"a"');
    expect(files.get('node_modules/a/nested/deep.js')?.toString('utf8')).toContain('deep');
    // manifest 的 files 列表 = 包内除 manifest 外全部条目
    const manifest = JSON.parse(files.get('manifest.json')!.toString('utf8')) as {
      createdAt: number;
      version: string;
      channel: string;
      files: string[];
    };
    expect(manifest.version).toBe('0.1.0');
    expect(manifest.channel).toBe('stable');
    expect(typeof manifest.createdAt).toBe('number');
    expect(manifest.files).not.toContain('manifest.json');
    for (const name of order.filter((n) => n !== 'manifest.json')) {
      expect(manifest.files).toContain(name);
    }
    // symlink 条目保留（node_modules/.bin/*）
    expect(symlinks.get('node_modules/.bin/a-cli')).toBe('../a/cli.js');
  });

  it('3. sha256 文件与发布包实际摘要一致（sha256sum 格式）', async () => {
    const proj = await makeProject('p-sha');
    const outDir = path.join(baseDir, 'out-sha');
    const result = await buildRelease({ projectRoot: proj, build: false, outDir });

    const actual = createHash('sha256').update(await readFile(result.tarPath)).digest('hex');
    const shaFile = (await readFile(result.sha256Path, 'utf8')).trim();
    // sha256sum 兼容格式：<hex>  <文件名>
    expect(shaFile).toBe(`${actual}  opptrix-harness-0.1.0.tar.gz`);
    expect(result.sha256).toBe(actual);
  });

  it('4. feed json 形状：对齐 updater feedDocSchema（条目带 channel，另一频道缺省）', async () => {
    const proj = await makeProject('p-feed');
    const outDir = path.join(baseDir, 'out-feed');
    const result = await buildRelease({ projectRoot: proj, build: false, outDir });

    const feed = JSON.parse(await readFile(result.feedPath, 'utf8')) as Record<string, unknown>;
    // 未发布频道整体缺省（不能写 null：updater 的 zod .optional() 拒绝 null）
    expect(feed).not.toHaveProperty('beta');
    expect(feed).toHaveProperty('stable');

    // 用升级器同款 zod 契约校验（src/kernel/update/updater.ts feedDocSchema）
    const feedEntrySchema = z.object({
      channel: z.enum(['stable', 'beta']),
      version: z.string().min(1),
      url: z.string().min(1),
      sha256: z.string().regex(/^[0-9a-fA-F]{64}$/),
      notes: z.string().optional(),
    });
    const parsed = z.object({ stable: feedEntrySchema }).safeParse(feed);
    expect(parsed.success).toBe(true);
    const stable = (feed.stable ?? {}) as { channel: string; version: string; url: string; sha256: string; notes: string };
    expect(stable.channel).toBe('stable');
    expect(stable.version).toBe('0.1.0');
    expect(stable.url).toBe(path.join(outDir, 'opptrix-harness-0.1.0.tar.gz'));
    expect(stable.notes).toBe('release 0.1.0');
  });

  it('5. channel=beta 时 feed 对调（beta 有值，stable 缺省）', async () => {
    const proj = await makeProject('p-beta');
    const outDir = path.join(baseDir, 'out-beta');
    const result = await buildRelease({ projectRoot: proj, build: false, outDir, channel: 'beta' });

    expect(result.feedPath).toBe(path.join(outDir, 'feed-beta.json'));
    expect(result.feed).not.toHaveProperty('stable');
    expect(result.feed.beta).not.toBeNull();
    expect((result.feed.beta as { channel?: string } | undefined)?.channel).toBe('beta');
    expect((result.feed.beta as { version?: string } | undefined)?.version).toBe('0.1.0');
  });

  it('6. 幂等：同名产物已存在时冲突报错，--force 覆盖后产物仍完整', async () => {
    const proj = await makeProject('p-conflict');
    const outDir = path.join(baseDir, 'out-conflict');
    const first = await buildRelease({ projectRoot: proj, build: false, outDir });

    await expect(buildRelease({ projectRoot: proj, build: false, outDir })).rejects.toMatchObject({
      code: 'RELEASE_CONFLICT',
    });

    const second = await buildRelease({ projectRoot: proj, build: false, outDir, force: true });
    expect(second.tarPath).toBe(first.tarPath);
    // 覆盖后三件套仍然自洽（sha 与包一致）
    const actual = createHash('sha256').update(await readFile(second.tarPath)).digest('hex');
    expect(second.sha256).toBe(actual);
    expect(await listOutDir(outDir)).toHaveLength(3);
  });

  it('7. --version 仅命名产物：源 package.json 不被改动', async () => {
    const proj = await makeProject('p-version', { version: '0.1.0' });
    const outDir = path.join(baseDir, 'out-version');

    const result = await buildRelease({ projectRoot: proj, build: false, outDir, version: '9.9.9' });

    expect(result.version).toBe('9.9.9');
    expect(result.tarPath).toContain('opptrix-harness-9.9.9.tar.gz');
    expect(result.feed.stable?.version).toBe('9.9.9');
    const srcPkg = JSON.parse(await readFile(path.join(proj, 'package.json'), 'utf8')) as { version: string };
    expect(srcPkg.version).toBe('0.1.0');
  });

  it('8. 非法版本号 fail-fast（RELEASE_INVALID_VERSION）', async () => {
    const proj = await makeProject('p-badver');
    await expect(
      buildRelease({ projectRoot: proj, build: false, outDir: path.join(baseDir, 'out-badver'), version: 'not-semver' }),
    ).rejects.toMatchObject({ code: 'RELEASE_INVALID_VERSION' });
  });

  it('9. dist 缺失 fail-fast（RELEASE_MISSING_INPUT）', async () => {
    const proj = await makeProject('p-nodist', { withDist: false });
    await expect(
      buildRelease({ projectRoot: proj, build: false, outDir: path.join(baseDir, 'out-nodist') }),
    ).rejects.toMatchObject({ code: 'RELEASE_MISSING_INPUT' });
  });
});

/* ---------- docker / 发布工程静态断言 ---------- */

describe('docker 工程文件静态断言', () => {
  let dockerfile = '';
  let sandboxfile = '';
  let compose = '';
  let dockerignore = '';

  beforeAll(async () => {
    dockerfile = await readFile(path.join(REPO_ROOT, 'docker', 'Dockerfile'), 'utf8');
    sandboxfile = await readFile(path.join(REPO_ROOT, 'docker', 'Dockerfile.sandbox'), 'utf8');
    compose = await readFile(path.join(REPO_ROOT, 'docker', 'docker-compose.yml'), 'utf8');
    dockerignore = await readFile(path.join(REPO_ROOT, '.dockerignore'), 'utf8');
  });

  it('10. Dockerfile：多阶段、非 root、HEALTHCHECK、VOLUME /data、bootstrap ENTRYPOINT', () => {
    expect(dockerfile).toContain('FROM node:24-alpine AS build');
    expect(dockerfile).toContain('npm ci');
    expect(dockerfile).toContain('npm run build');
    expect(dockerfile).toContain('COPY --from=build /app/dist ./dist');
    expect(dockerfile).toContain('COPY --from=build /app/node_modules ./node_modules');
    expect(dockerfile).toContain('COPY --from=build /app/bootstrap.mjs ./bootstrap.mjs');
    expect(dockerfile).toContain('ENV NODE_ENV=production');
    expect(dockerfile).toContain('HARNESS_DATA_DIR=/data');
    expect(dockerfile).toMatch(/RUN mkdir -p \/data && chown -R node:node \/data \/app/);
    expect(dockerfile).toMatch(/^USER node$/m); // 非 root
    expect(dockerfile).toMatch(/^EXPOSE 3000$/m);
    expect(dockerfile).toMatch(/^VOLUME \/data$/m);
    expect(dockerfile).toContain('HEALTHCHECK --interval=30s --timeout=5s --start-period=15s');
    expect(dockerfile).toContain('http://127.0.0.1:3000/health');
    expect(dockerfile).toContain('ENTRYPOINT ["node", "bootstrap.mjs"]');
  });

  it('11. Dockerfile.sandbox：pin bookworm、python3/git、useradd dev、LABEL、sleep infinity', () => {
    expect(sandboxfile).toContain('FROM node:24-bookworm');
    expect(sandboxfile).toContain('python3-pip');
    expect(sandboxfile).toContain('git');
    expect(sandboxfile).toContain('ca-certificates');
    expect(sandboxfile).toContain('rm -rf /var/lib/apt/lists/*');
    expect(sandboxfile).toMatch(/useradd .*--uid 1000 .*dev/);
    expect(sandboxfile).toMatch(/^USER dev$/m);
    expect(sandboxfile).toContain('org.opencontainers.image.title="opptrix-sandbox"');
    expect(sandboxfile).toContain('CMD ["sleep", "infinity"]');
  });

  it('12. docker-compose.yml：opptrix 服务、数据卷、扩展挂载、healthcheck、mailhog profile', () => {
    expect(compose).toContain('dockerfile: docker/Dockerfile');
    expect(compose).toContain('- "3000:3000"');
    expect(compose).toContain('opptrix-data:/data');
    expect(compose).toContain('../extensions:/data/extensions');
    expect(compose).toContain('restart: unless-stopped');
    expect(compose).toContain('http://127.0.0.1:3000/health');
    expect(compose).toContain('mailhog/mailhog:latest');
    expect(compose).toMatch(/profiles:\s*\["mail"\]/);
    expect(compose).toMatch(/^volumes:/m);
    // 首次运行说明（root token 获取路径）
    expect(compose).toContain('root-token');
  });

  it('13. .dockerignore 覆盖 node_modules/dist/data/test/coverage/ui-src', () => {
    for (const line of ['node_modules', 'dist', 'data', '*.log', '.git', 'test', 'coverage', 'extensions/*/ui-src']) {
      expect(dockerignore).toContain(line);
    }
  });
});
