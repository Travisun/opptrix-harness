/**
 * skills — 技能子系统测试（SKILL.md 解析 / 注册表聚合 / 扩展注入桥 / REST）。
 *
 * 覆盖：
 * - loader：frontmatter 解析（含 tags/enabled/version/author）、name 缺省=目录 id、
 *   缺 frontmatter / description 超限 / name 非法 / 正文超 128KB / YAML 损坏 → 跳过、
 *   附属文件清单、根目录不存在 → 空；
 * - registry：同 id 冲突优先级（builtin > data > extension，落败者记 duplicates）、
 *   list 过滤（source/tag/q）、get（磁盘正文惰性读 / extension 内存正文 / 扫描后删除
 *   → null）、registerContributed 计数与整组替换、removeContributed、缺根目录；
 * - bridge（最小 deps 桩，风格参照 security-regression.test.ts）：kernel 端点拒绝、
 *   list/get/register/refresh 四 handler、单 body 超 128KB → RPC_PAYLOAD_TOO_LARGE、
 *   未知 id → EXT_NOT_FOUND；
 * - REST：真实 fastify 注入 + 真 SkillRegistry——401、列表与过滤、详情含正文、
 *   404 形状、refresh 角色门禁（normal 403 / admin 200 { total, bySource }）；
 * - writer（受控写面）：writeSkill 落盘往返（frontmatter 形状 / scanSkillDir 可见）、
 *   重复 id / 非法 id / 空·超限正文 → BAD_REQUEST；deleteSkill 的 data 删除、
 *   builtin FORBIDDEN、未知 EXT_NOT_FOUND、builtin 遮蔽态 force 语义；
 * - REST 写面（注入 writer）：POST 201 { id, path } + 写后立即可 GET（含正文）、
 *   重复 id 400、正文超限 400、id 非法 400、角色门禁（normal 403 / 无 token 401）、
 *   DELETE data 源 200 → 404 消失、builtin/extension 源 403、未知 id 404。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import matter from 'gray-matter';
import pino from 'pino';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerSkillRoutes } from '../src/api/skills.js';
import { KERNEL_TOPICS } from '../src/extension-host/protocol.js';
import { loadConfig } from '../src/kernel/config/index.js';
import { err } from '../src/kernel/errors/index.js';
import { createHttpServer } from '../src/kernel/http/server.js';
import { createSkillsBridge, deleteSkill, SkillRegistry, scanSkillDir, writeSkill as writeSkillPack } from '../src/kernel/skills/index.js';
import type { SkillEntry, SkillRegistryLike } from '../src/kernel/skills/types.js';

const logger = pino({ level: 'silent' });

// ---------------------------------------------------------------- fixture 工具

const DOC_BODY = '# doc-review\n\n审阅文档并给出修改建议。\n';

interface SkillFixture {
  /** frontmatter 字段；null = 不写 frontmatter（纯 Markdown） */
  fm?: Record<string, unknown> | null;
  body?: string;
  /** 附属文件（相对技能目录路径 → 内容） */
  companions?: Record<string, string>;
}

/** 在 root 下写一个技能目录 `<root>/<dirId>/SKILL.md`（matter.stringify 产出规范格式） */
function writeSkill(root: string, dirId: string, fixture: SkillFixture = {}): string {
  const skillDir = path.join(root, dirId);
  fs.mkdirSync(skillDir, { recursive: true });
  const body = fixture.body ?? DOC_BODY;
  const content =
    fixture.fm === null ? body : matter.stringify(body, fixture.fm ?? {});
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), content, 'utf8');
  for (const [rel, fileContent] of Object.entries(fixture.companions ?? {})) {
    const target = path.join(skillDir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, fileContent, 'utf8');
  }
  return skillDir;
}

/** 标准 doc-review frontmatter */
function docReviewFm(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'doc-review',
    description: '审阅文档并给出修改建议',
    version: '1.0.0',
    author: 'opptrix',
    tags: ['docs', 'review'],
    enabled: true,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// A. loader — scanSkillDir
// ---------------------------------------------------------------------------

describe('skills loader — scanSkillDir', () => {
  let root = '';

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'opptrix-skills-load-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('解析完整 frontmatter：字段、附属文件清单、正文字节数', async () => {
    writeSkill(root, 'doc-review', {
      fm: docReviewFm(),
      companions: { 'scripts/run.js': 'module.exports = 42;', 'resources/guide.md': '# guide' },
    });
    const [entry] = await scanSkillDir(root, 'builtin');
    expect(entry).toBeTruthy();
    expect(entry!.id).toBe('doc-review');
    expect(entry!.name).toBe('doc-review');
    expect(entry!.description).toBe('审阅文档并给出修改建议');
    expect(entry!.version).toBe('1.0.0');
    expect(entry!.author).toBe('opptrix');
    expect(entry!.tags).toEqual(['docs', 'review']);
    expect(entry!.enabled).toBe(true);
    expect(entry!.source).toBe('builtin');
    expect(entry!.sourceRef).toBe(path.join(root, 'doc-review'));
    expect(entry!.bodyBytes).toBe(Buffer.byteLength(DOC_BODY, 'utf8'));
    expect(entry!.files).toEqual(['resources/guide.md', 'scripts/run.js']);
  });

  it('name 缺省 = 目录 id；enabled 缺省 true；version/author 可省略', async () => {
    writeSkill(root, 'my-fancy_skill', { fm: { description: 'no explicit name' } }); // 目录 id 含下划线
    writeSkill(root, 'plain-skill', { fm: { description: 'minimal' } });
    const entries = await scanSkillDir(root);
    const byId = new Map(entries.map((e) => [e.id, e]));
    const plain = byId.get('plain-skill')!;
    expect(plain).toMatchObject({ enabled: true, files: [] });
    expect('version' in plain).toBe(false); // 可选字段缺省 → 键不出现
    expect('author' in plain).toBe(false);
    // 目录 id 非法（^[a-z0-9-]{1,64}$ 不允许下划线）→ 整条跳过
    expect(byId.has('my-fancy_skill')).toBe(false);
  });

  it('缺 frontmatter（无 description）→ 跳过；YAML 损坏 → 跳过', async () => {
    writeSkill(root, 'no-fm', { fm: null });
    fs.mkdirSync(path.join(root, 'broken-yaml'), { recursive: true });
    fs.writeFileSync(path.join(root, 'broken-yaml', 'SKILL.md'), '---\nname: [unclosed\n---\nbody\n', 'utf8');
    writeSkill(root, 'ok-skill', { fm: { description: 'survivor' } });
    const entries = await scanSkillDir(root);
    expect(entries.map((e) => e.id)).toEqual(['ok-skill']);
  });

  it('description 超 1024 字符 → 跳过；name 提供但非法 → 跳过', async () => {
    writeSkill(root, 'long-desc', { fm: { description: 'x'.repeat(1025) } });
    writeSkill(root, 'bad-name', { fm: { name: 'Bad_Name', description: 'invalid name' } });
    expect(await scanSkillDir(root)).toEqual([]);
  });

  it('正文超 128KB → 跳过', async () => {
    writeSkill(root, 'too-big', { fm: { description: 'oversize' }, body: `# big\n${'a'.repeat(128 * 1024)}\n` });
    writeSkill(root, 'fits', { fm: { description: 'fits' } });
    const entries = await scanSkillDir(root);
    expect(entries.map((e) => e.id)).toEqual(['fits']);
  });

  it('根目录不存在 → []；根级散文件与无 SKILL.md 的子目录被忽略', async () => {
    expect(await scanSkillDir(path.join(root, 'missing'))).toEqual([]);
    fs.writeFileSync(path.join(root, 'stray.md'), 'not a skill', 'utf8');
    fs.mkdirSync(path.join(root, 'empty-dir'), { recursive: true });
    expect(await scanSkillDir(root)).toEqual([]);
  });

  it('enabled: false 是事实而非过滤（条目仍出现在 list 面）', async () => {
    writeSkill(root, 'off-skill', { fm: { description: 'disabled by frontmatter', enabled: false } });
    const [entry] = await scanSkillDir(root);
    expect(entry!.enabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// B. registry — SkillRegistry 聚合与冲突
// ---------------------------------------------------------------------------

describe('skills registry — 聚合 / 冲突优先级 / 过滤 / get', () => {
  let builtinRoot = '';
  let dataRoot = '';

  const makeRegistry = (): SkillRegistry =>
    new SkillRegistry({
      roots: [
        { root: builtinRoot, source: 'builtin' },
        { root: dataRoot, source: 'data' },
      ],
      logger,
    });

  beforeEach(() => {
    builtinRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opptrix-skills-builtin-'));
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opptrix-skills-data-'));
  });

  afterEach(() => {
    fs.rmSync(builtinRoot, { recursive: true, force: true });
    fs.rmSync(dataRoot, { recursive: true, force: true });
  });

  it('同 id 冲突：builtin > data > extension；落败者计入 duplicates', async () => {
    writeSkill(builtinRoot, 'dup-skill', { fm: { description: 'from builtin' } });
    writeSkill(dataRoot, 'dup-skill', { fm: { description: 'from data' } });
    writeSkill(builtinRoot, 'only-builtin', { fm: { description: 'builtin only' } });

    const registry = makeRegistry();
    await registry.refresh();
    const contributed = registry.registerContributed('ext-x', [
      { id: 'dup-skill', name: 'dup-skill', description: 'from extension', body: 'body' },
      { id: 'ext-only', name: 'ext-only', description: 'extension only', body: 'ext body\n' },
    ]);
    expect(contributed).toBe(1); // dup-skill 撞 builtin 被跳过，不计数

    const all = registry.list();
    expect(all.map((e) => e.id).sort()).toEqual(['dup-skill', 'ext-only', 'only-builtin']);
    const dup = await registry.get('dup-skill');
    expect(dup!.entry.source).toBe('builtin');
    expect(dup!.entry.description).toBe('from builtin');

    const dups = registry.listDuplicates();
    expect(dups).toContainEqual({ id: 'dup-skill', source: 'extension', sourceRef: 'ext-x' });
    // 单独再验 data vs builtin 冲突（独立 registry，避免 extension 顺序噪声）
    const registry2 = makeRegistry();
    await registry2.refresh();
    expect(registry2.listDuplicates()).toEqual([
      { id: 'dup-skill', source: 'data', sourceRef: path.join(dataRoot, 'dup-skill') },
    ]);
  });

  it('list 过滤：source / tag / q（id+name+description 大小写不敏感子串）可组合', async () => {
    writeSkill(builtinRoot, 'alpha-review', { fm: { description: 'Review Docs Deeply', tags: ['docs', 'review'] } });
    writeSkill(builtinRoot, 'beta-lint', { fm: { description: 'Lint code fast', tags: ['code'] } });
    writeSkill(dataRoot, 'gamma-translate', { fm: { description: 'Translate docs', tags: ['docs'] } });
    const registry = makeRegistry();
    await registry.refresh();

    expect(registry.list({ source: 'data' }).map((e) => e.id)).toEqual(['gamma-translate']);
    expect(registry.list({ tag: 'docs' }).map((e) => e.id)).toEqual(['alpha-review', 'gamma-translate']);
    expect(registry.list({ q: 'DEEPLY' }).map((e) => e.id)).toEqual(['alpha-review']);
    expect(registry.list({ source: 'builtin', tag: 'docs' }).map((e) => e.id)).toEqual(['alpha-review']);
    expect(registry.list({ q: 'no-hit-anything' })).toEqual([]);
  });

  it('get：磁盘正文惰性读（frontmatter 剥离）；extension 贡献返回内存正文；未知 id → null', async () => {
    writeSkill(builtinRoot, 'doc-review', { fm: docReviewFm() });
    const registry = makeRegistry();
    await registry.refresh();

    const disk = await registry.get('doc-review');
    expect(disk!.body).toBe(DOC_BODY);
    expect(disk!.entry.id).toBe('doc-review');
    expect(await registry.get('ghost')).toBeNull();

    registry.registerContributed('ext-y', [
      { id: 'mem-skill', name: 'mem-skill', description: 'in memory', body: 'memory body\n' },
    ]);
    const mem = await registry.get('mem-skill');
    expect(mem!.body).toBe('memory body\n');
    expect(mem!.entry).toMatchObject({ source: 'extension', sourceRef: 'ext-y', bodyBytes: Buffer.byteLength('memory body\n') });
  });

  it('get：扫描后技能目录被删除 → null（不抛）', async () => {
    writeSkill(builtinRoot, 'doomed', { fm: { description: 'will vanish' } });
    const registry = makeRegistry();
    await registry.refresh();
    fs.rmSync(path.join(builtinRoot, 'doomed'), { recursive: true, force: true });
    expect(await registry.get('doomed')).toBeNull();
  });

  it('registerContributed：组内重复 id 先到先得；整组替换（重复 register 以最后一次为准）；removeContributed 幂等', async () => {
    const registry = makeRegistry();
    await registry.refresh();

    const first = registry.registerContributed('ext-z', [
      { id: 'z-one', name: 'z-one', description: 'first', body: '1\n' },
      { id: 'z-one', name: 'z-one', description: 'second (dup in same batch)', body: '2\n' },
    ]);
    expect(first).toBe(1);
    expect((await registry.get('z-one'))!.body).toBe('1\n');

    const second = registry.registerContributed('ext-z', [
      { id: 'z-two', name: 'z-two', description: 'replacement batch', body: '3\n' },
    ]);
    expect(second).toBe(1);
    expect(await registry.get('z-one')).toBeNull(); // 整组替换
    expect((await registry.get('z-two'))!.entry.description).toBe('replacement batch');

    registry.removeContributed('ext-z');
    expect(await registry.get('z-two')).toBeNull();
    expect(() => registry.removeContributed('never-registered')).not.toThrow();
  });

  it('roots 指向不存在的目录 → refresh() 返回 []（不抛）', async () => {
    const registry = new SkillRegistry({
      roots: [
        { root: path.join(builtinRoot, 'nope'), source: 'builtin' },
        { root: path.join(dataRoot, 'nada'), source: 'data' },
      ],
      logger,
    });
    await expect(registry.refresh()).resolves.toEqual([]);
    expect(registry.list()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// C. bridge — createSkillsBridge（最小 deps 桩）
// ---------------------------------------------------------------------------

describe('skills bridge — createSkillsBridge', () => {
  const entryFixture = (): SkillEntry => ({
    id: 'known-skill',
    name: 'known-skill',
    description: 'a known skill',
    tags: ['docs'],
    enabled: true,
    source: 'builtin',
    sourceRef: '/skills/known-skill',
    bodyBytes: 12,
    files: [],
  });

  type RegistryStub = SkillRegistryLike & Record<string, ReturnType<typeof vi.fn>>;

  /** 最小注册表桩：只实现桥用到的五个方法 */
  function makeRegistryStub(): RegistryStub {
    return {
      refresh: vi.fn(async () => [entryFixture()]),
      list: vi.fn((): SkillEntry[] => [entryFixture()]),
      get: vi.fn(async (id: string) =>
        id === 'known-skill' ? { entry: entryFixture(), body: 'hello body\n' } : null,
      ),
      registerContributed: vi.fn(() => 2),
      removeContributed: vi.fn(),
    } as unknown as RegistryStub;
  }

  const handlers = (stub: RegistryStub): Record<string, (payload: unknown, from: string) => Promise<unknown>> =>
    createSkillsBridge({ registry: stub });

  it('kernel 端点全部拒绝（RPC_PERMISSION_DENIED）——skills 面不对内核自身开放', async () => {
    const bridge = handlers(makeRegistryStub());
    for (const topic of [KERNEL_TOPICS.skillsList, KERNEL_TOPICS.skillsGet, KERNEL_TOPICS.skillsRegister, KERNEL_TOPICS.skillsRefresh]) {
      await expect(bridge[topic]({}, 'kernel')).rejects.toMatchObject({
        code: err('RPC_PERMISSION_DENIED').code,
      });
    }
  });

  it('skills.list：过滤条件透传 registry.list；返回条目数组', async () => {
    const stub = makeRegistryStub();
    const bridge = handlers(stub);
    const items = (await bridge[KERNEL_TOPICS.skillsList]({ q: 'review', source: 'builtin', tag: 'docs' }, 'ext:reporter')) as SkillEntry[];
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe('known-skill');
    expect(stub.list).toHaveBeenCalledWith({ q: 'review', source: 'builtin', tag: 'docs' });
    // 空 payload → {} 过滤
    await bridge[KERNEL_TOPICS.skillsList]({}, 'ext:reporter');
    expect(stub.list).toHaveBeenLastCalledWith({});
  });

  it('skills.get：命中 → { entry, body }；未知 id → EXT_NOT_FOUND；id 非法 → VALIDATION_FAILED', async () => {
    const bridge = handlers(makeRegistryStub());
    const found = (await bridge[KERNEL_TOPICS.skillsGet]({ id: 'known-skill' }, 'ext:reporter')) as { entry: SkillEntry; body: string };
    expect(found.entry.id).toBe('known-skill');
    expect(found.body).toBe('hello body\n');

    await expect(bridge[KERNEL_TOPICS.skillsGet]({ id: 'ghost-skill' }, 'ext:reporter')).rejects.toMatchObject({
      code: err('EXT_NOT_FOUND').code,
    });
    await expect(bridge[KERNEL_TOPICS.skillsGet]({ id: 'BAD_ID' }, 'ext:reporter')).rejects.toMatchObject({
      code: err('VALIDATION_FAILED').code,
    });
  });

  it('skills.register：按 from extId 记贡献 → { ok, registered }；单 body 超 128KB → RPC_PAYLOAD_TOO_LARGE', async () => {
    const stub = makeRegistryStub();
    const bridge = handlers(stub);
    const result = (await bridge[KERNEL_TOPICS.skillsRegister](
      { skills: [{ id: 'ext-skill', name: 'ext-skill', description: 'contributed', body: 'hi\n' }] },
      'ext:contributor',
    )) as { ok: boolean; registered: number };
    expect(result).toEqual({ ok: true, registered: 2 });
    expect(stub.registerContributed).toHaveBeenCalledWith('contributor', [
      { id: 'ext-skill', name: 'ext-skill', description: 'contributed', body: 'hi\n' },
    ]);

    const oversize = 'a'.repeat(128 * 1024 + 1);
    await expect(
      bridge[KERNEL_TOPICS.skillsRegister](
        { skills: [{ id: 'big', name: 'big', description: 'too big', body: oversize }] },
        'ext:contributor',
      ),
    ).rejects.toMatchObject({ code: err('RPC_PAYLOAD_TOO_LARGE').code });
    expect(stub.registerContributed).toHaveBeenCalledTimes(1); // 失败调用不落注册表

    await expect(
      bridge[KERNEL_TOPICS.skillsRegister]({ skills: [] }, 'ext:contributor'),
    ).rejects.toMatchObject({ code: err('VALIDATION_FAILED').code });
  });

  it('skills.refresh：委托 registry.refresh → { total }', async () => {
    const stub = makeRegistryStub();
    const bridge = handlers(stub);
    await expect(bridge[KERNEL_TOPICS.skillsRefresh]({}, 'ext:reporter')).resolves.toEqual({ total: 1 });
    expect(stub.refresh).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// D. REST — fastify.inject + 真 SkillRegistry
// ---------------------------------------------------------------------------

const ADMIN_TOKEN = 'token-admin';
const ROOT_TOKEN = 'token-root';
const NORMAL_TOKEN = 'token-normal';
const AUTH_ADMIN = { authorization: `Bearer ${ADMIN_TOKEN}` };
const AUTH_ROOT = { authorization: `Bearer ${ROOT_TOKEN}` };
const AUTH_NORMAL = { authorization: `Bearer ${NORMAL_TOKEN}` };

/** 统一认证入口替身（与 authProxy.createAuthChecker 语义一致） */
const checker = async ({ token }: { token?: string }): Promise<{ role: string } & Record<string, unknown>> => {
  if (token === ADMIN_TOKEN) return { userId: 'admin-1', role: 'admin', scopes: ['skills'] };
  if (token === ROOT_TOKEN) return { userId: 'root', role: 'root', scopes: ['*'] };
  if (token === NORMAL_TOKEN) return { userId: 'user-1', role: 'normal', scopes: [] };
  throw err('UNAUTHORIZED', { detail: 'token rejected by all auth providers' });
};

describe('skills REST — /api/v1/skills*', () => {
  let dir = '';
  let builtinRoot = '';
  let dataRoot = '';
  let registry: SkillRegistry;
  let app: FastifyInstance;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opptrix-skills-rest-'));
    builtinRoot = path.join(dir, 'builtin-skills');
    dataRoot = path.join(dir, 'data-skills');
    writeSkill(builtinRoot, 'doc-review', { fm: docReviewFm(), companions: { 'resources/rubric.md': '# rubric' } });
    writeSkill(builtinRoot, 'release-notes', { fm: { description: 'Draft release notes', tags: ['docs'] } });
    writeSkill(dataRoot, 'team-glossary', { fm: { description: 'Team glossary lookup', tags: ['internal'] } });

    registry = new SkillRegistry({
      roots: [
        { root: builtinRoot, source: 'builtin' },
        { root: dataRoot, source: 'data' },
      ],
      logger,
    });
    registry.registerContributed('ext-rest', [
      { id: 'rest-contributed', name: 'rest-contributed', description: 'from extension', body: 'hi\n' },
    ]);

    const config = loadConfig({ NODE_ENV: 'test', HARNESS_LOG_LEVEL: 'error', HARNESS_DATA_DIR: dir });
    ({ app } = createHttpServer({
      config,
      logger: pino({ level: 'silent' }),
      isReady: () => true,
      state: () => 'ready',
      registerExtra: (a) => {
        registerSkillRoutes(a, { checker, registry });
      },
    }));
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('无 token → 401 HARNESS-1006（列表/详情/refresh 全部受管）', async () => {
    for (const req of [
      { method: 'GET', url: '/api/v1/skills' },
      { method: 'GET', url: '/api/v1/skills/doc-review' },
      { method: 'POST', url: '/api/v1/skills/refresh' },
    ] as const) {
      const res = await app.inject({ method: req.method, url: req.url });
      expect(res.statusCode, req.url).toBe(401);
      expect(res.json().code).toBe('HARNESS-1006');
    }
  });

  it('GET /api/v1/skills：refresh 后列出四条（builtin+data+extension）；?source/?tag/?q 过滤', async () => {
    const refresh = await app.inject({ method: 'POST', url: '/api/v1/skills/refresh', headers: AUTH_ADMIN });
    expect(refresh.statusCode).toBe(200);

    const all = await app.inject({ method: 'GET', url: '/api/v1/skills', headers: AUTH_NORMAL });
    expect(all.statusCode).toBe(200);
    const entries = all.json() as SkillEntry[];
    expect(entries.map((e) => e.id).sort()).toEqual(['doc-review', 'release-notes', 'rest-contributed', 'team-glossary']);
    expect(entries.every((e) => !('body' in e))).toBe(true); // 列表不带正文

    const bySource = await app.inject({ method: 'GET', url: '/api/v1/skills?source=builtin', headers: AUTH_NORMAL });
    expect((bySource.json() as SkillEntry[]).map((e) => e.id)).toEqual(['doc-review', 'release-notes']);

    const byTag = await app.inject({ method: 'GET', url: '/api/v1/skills?tag=internal', headers: AUTH_NORMAL });
    expect((byTag.json() as SkillEntry[]).map((e) => e.id)).toEqual(['team-glossary']);

    const byQ = await app.inject({ method: 'GET', url: '/api/v1/skills?q=glossary', headers: AUTH_NORMAL });
    expect((byQ.json() as SkillEntry[]).map((e) => e.id)).toEqual(['team-glossary']);
  });

  it('GET /api/v1/skills/:id：200 含正文与附属文件清单；未知 id → 404 HARNESS-3004', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/skills/doc-review', headers: AUTH_NORMAL });
    expect(res.statusCode).toBe(200);
    const body = res.json() as SkillEntry & { body: string };
    expect(body.id).toBe('doc-review');
    expect(body.source).toBe('builtin');
    expect(body.body).toBe(DOC_BODY);
    expect(body.files).toEqual(['resources/rubric.md']);

    const missing = await app.inject({ method: 'GET', url: '/api/v1/skills/ghost', headers: AUTH_ADMIN });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().code).toBe('HARNESS-3004');
  });

  it('POST /api/v1/skills/refresh：normal → 403；admin/root → 200 { total, bySource }', async () => {
    const denied = await app.inject({ method: 'POST', url: '/api/v1/skills/refresh', headers: AUTH_NORMAL });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().code).toBe('HARNESS-1007');

    const ok = await app.inject({ method: 'POST', url: '/api/v1/skills/refresh', headers: AUTH_ROOT });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({
      total: 4,
      bySource: { builtin: 2, data: 1, extension: 1 },
    });
  });

  it('查询参数非法（source 枚举外）→ 400 HARNESS-1009', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/skills?source=somewhere', headers: AUTH_ADMIN });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('HARNESS-1009');
  });
});

// ---------------------------------------------------------------------------
// E. writer — writeSkill / deleteSkill（受控写面，data 源目录）
// ---------------------------------------------------------------------------

describe('skills writer — writeSkill / deleteSkill', () => {
  let dir = '';
  let dataDir = '';
  let builtinRoot = '';

  /** writeSkillPack 的最小输入 */
  const packInput = (extra: Partial<Parameters<typeof writeSkillPack>[1]> = {}): Parameters<typeof writeSkillPack>[1] => ({
    id: 'weekly-report',
    name: 'weekly-report',
    description: '生成团队周报',
    body: '# 周报\n\n汇总本周进展并输出 Markdown。\n',
    ...extra,
  });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opptrix-skills-writer-'));
    dataDir = path.join(dir, 'data');
    builtinRoot = path.join(dir, 'builtin-skills');
    fs.mkdirSync(builtinRoot, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writeSkill 往返：SKILL.md 落盘（frontmatter 形状：name/description/version=1.0.0/author/tags + 正文）→ scanSkillDir 可见', async () => {
    const result = await writeSkillPack({ dataDir }, packInput({ tags: ['docs', 'report'], author: 'alice' }));
    expect(result.id).toBe('weekly-report');
    expect(result.path).toBe(path.join(dataDir, 'skills', 'weekly-report'));

    // frontmatter 形状断言：读文件头（--- ... --- 包裹的 YAML + 正文原样）
    const raw = await fs.promises.readFile(path.join(result.path, 'SKILL.md'), 'utf8');
    expect(raw.startsWith('---')).toBe(true);
    const parsed = matter(raw);
    expect(parsed.data).toMatchObject({
      name: 'weekly-report', // frontmatter name 恒写目录 id（注册 id 不变量）
      description: '生成团队周报',
      version: '1.0.0',
      author: 'alice',
    });
    expect(parsed.data.tags).toEqual(['docs', 'report']);
    expect(parsed.content).toBe('# 周报\n\n汇总本周进展并输出 Markdown。\n');

    // 与注册表读语义对齐：scanSkillDir 能发现且 id = 目录 id = frontmatter name
    const entries = await scanSkillDir(path.join(dataDir, 'skills'), 'data');
    expect(entries.map((e) => e.id)).toEqual(['weekly-report']);
    expect(entries[0]).toMatchObject({ source: 'data', description: '生成团队周报', version: '1.0.0' });
  });

  it('writeSkill：可选字段缺省（无 tags/author）→ frontmatter 不含这两个键', async () => {
    const result = await writeSkillPack({ dataDir }, packInput());
    const parsed = matter(await fs.promises.readFile(path.join(result.path, 'SKILL.md'), 'utf8'));
    expect('author' in parsed.data).toBe(false);
    expect('tags' in parsed.data).toBe(false);
    expect(parsed.data.version).toBe('1.0.0');
  });

  it('writeSkill：重复 id（目录已存在且非本写入创建）→ BAD_REQUEST "skill id already exists"', async () => {
    await writeSkillPack({ dataDir }, packInput({ description: 'first' }));
    await expect(writeSkillPack({ dataDir }, packInput({ description: 'second' }))).rejects.toMatchObject({
      code: err('BAD_REQUEST').code,
      message: 'skill id already exists',
    });
  });

  it('writeSkill：id 非法 / name 空 / description 空·超限 / body 空·超 128KB → BAD_REQUEST（不落盘）', async () => {
    await expect(writeSkillPack({ dataDir }, packInput({ id: 'Bad_Id' }))).rejects.toMatchObject({ code: err('BAD_REQUEST').code });
    await expect(writeSkillPack({ dataDir }, packInput({ name: '   ' }))).rejects.toMatchObject({ code: err('BAD_REQUEST').code });
    await expect(writeSkillPack({ dataDir }, packInput({ description: '' }))).rejects.toMatchObject({ code: err('BAD_REQUEST').code });
    await expect(writeSkillPack({ dataDir }, packInput({ description: 'x'.repeat(1025) }))).rejects.toMatchObject({
      code: err('BAD_REQUEST').code,
    });
    await expect(writeSkillPack({ dataDir }, packInput({ body: ' \n\t ' }))).rejects.toMatchObject({ code: err('BAD_REQUEST').code });
    await expect(writeSkillPack({ dataDir }, packInput({ body: `a${'a'.repeat(128 * 1024)}` }))).rejects.toMatchObject({
      code: err('BAD_REQUEST').code,
      message: expect.stringContaining('exceeds 131072 bytes'),
    });
    // 全部失败 → 不产生任何目录
    expect(fs.existsSync(path.join(dataDir, 'skills'))).toBe(false);
  });

  it('deleteSkill：data 源删除（目录消失；再删 → EXT_NOT_FOUND；未知 id → EXT_NOT_FOUND）', async () => {
    await writeSkillPack({ dataDir }, packInput({ id: 'doomed-pack' }));
    const skillDir = path.join(dataDir, 'skills', 'doomed-pack');
    await expect(deleteSkill({ dataDir }, 'doomed-pack')).resolves.toBeUndefined();
    expect(fs.existsSync(skillDir)).toBe(false);
    // 目录已消失 → 再删按不存在收口；从未存在的 id 同样 EXT_NOT_FOUND
    await expect(deleteSkill({ dataDir }, 'doomed-pack')).rejects.toMatchObject({ code: err('EXT_NOT_FOUND').code });
    await expect(deleteSkill({ dataDir }, 'ghost-pack')).rejects.toMatchObject({ code: err('EXT_NOT_FOUND').code });
  });

  it('deleteSkill：builtin 源（builtinRoot 命中）→ FORBIDDEN', async () => {
    writeSkill(builtinRoot, 'builtin-pack', { fm: { description: 'builtin source' } });
    await expect(deleteSkill({ dataDir, builtinRoot }, 'builtin-pack')).rejects.toMatchObject({
      code: err('FORBIDDEN').code,
      message: expect.stringContaining('builtin'),
    });
    expect(fs.existsSync(path.join(builtinRoot, 'builtin-pack'))).toBe(true); // 原样保留
  });

  it('deleteSkill：builtin 遮蔽（builtin+data 并存）→ 默认 FORBIDDEN；force=true 仅删 data 副本', async () => {
    writeSkill(builtinRoot, 'shadowed', { fm: { description: 'builtin wins' } });
    await writeSkillPack({ dataDir }, packInput({ id: 'shadowed', description: 'data copy' }));

    await expect(deleteSkill({ dataDir, builtinRoot }, 'shadowed')).rejects.toMatchObject({ code: err('FORBIDDEN').code });
    expect(fs.existsSync(path.join(dataDir, 'skills', 'shadowed'))).toBe(true);
    expect(fs.existsSync(path.join(builtinRoot, 'shadowed'))).toBe(true);

    await expect(deleteSkill({ dataDir, builtinRoot }, 'shadowed', { force: true })).resolves.toBeUndefined();
    expect(fs.existsSync(path.join(dataDir, 'skills', 'shadowed'))).toBe(false); // data 副本被删
    expect(fs.existsSync(path.join(builtinRoot, 'shadowed'))).toBe(true); // builtin 原样保留
  });
});

// ---------------------------------------------------------------------------
// F. REST 写面 — POST / DELETE /api/v1/skills（admin 门禁 + writer 注入）
// ---------------------------------------------------------------------------

describe('skills REST write face — POST/DELETE /api/v1/skills', () => {
  let dir = '';
  let builtinRoot = '';
  let dataRoot = '';
  let registry: SkillRegistry;
  let app: FastifyInstance;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opptrix-skills-write-'));
    builtinRoot = path.join(dir, 'builtin-skills');
    dataRoot = path.join(dir, 'skills'); // writer 的 cfg.dataDir = dir → data 源根 = <dir>/skills
    writeSkill(builtinRoot, 'builtin-skill', { fm: { description: 'builtin source skill' } });

    registry = new SkillRegistry({
      roots: [
        { root: builtinRoot, source: 'builtin' },
        { root: dataRoot, source: 'data' },
      ],
      logger,
    });
    registry.registerContributed('ext-rest', [
      { id: 'ext-only-skill', name: 'ext-only-skill', description: 'from extension', body: 'hi\n' },
    ]);

    const config = loadConfig({ NODE_ENV: 'test', HARNESS_LOG_LEVEL: 'error', HARNESS_DATA_DIR: dir });
    ({ app } = createHttpServer({
      config,
      logger: pino({ level: 'silent' }),
      isReady: () => true,
      state: () => 'ready',
      registerExtra: (a) => {
        registerSkillRoutes(a, {
          checker,
          registry,
          // 与 core-services 总装一致：data 源写删 + builtin 源判定
          writer: {
            write: (input) => writeSkillPack({ dataDir: dir }, input),
            remove: (id, opts) => deleteSkill({ dataDir: dir, builtinRoot }, id, opts),
          },
        });
      },
    }));
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('POST /api/v1/skills：admin → 201 { id, path }；写后已 refresh（列表可见 source=data、GET :id 含正文）', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/skills',
      headers: AUTH_ADMIN,
      payload: {
        id: 'team-retro',
        name: 'team-retro',
        description: '组织迭代回顾',
        body: '# 回顾\n\n收集做得好/做得差的事项。\n',
        tags: ['agile'],
        author: 'alice',
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ id: 'team-retro', path: path.join(dataRoot, 'team-retro') });

    // 写后自动 refresh：无需手动 POST /refresh 即可读
    const detail = await app.inject({ method: 'GET', url: '/api/v1/skills/team-retro', headers: AUTH_NORMAL });
    expect(detail.statusCode).toBe(200);
    const detailBody = detail.json() as SkillEntry & { body: string };
    expect(detailBody).toMatchObject({ id: 'team-retro', source: 'data', version: '1.0.0', author: 'alice' });
    expect(detailBody.body).toBe('# 回顾\n\n收集做得好/做得差的事项。\n');

    const list = await app.inject({ method: 'GET', url: '/api/v1/skills?source=data', headers: AUTH_NORMAL });
    expect((list.json() as SkillEntry[]).map((e) => e.id)).toEqual(['team-retro']);
  });

  it('POST /api/v1/skills：重复 id → 400 BAD_REQUEST（已存在即拒，不覆盖）', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/skills',
      headers: AUTH_ADMIN,
      payload: { id: 'team-retro', name: 'team-retro', description: 'second write', body: 'nope\n' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'HARNESS-1008', message: 'skill id already exists' });
  });

  it('POST /api/v1/skills：正文超 128KB → 400；id 形态非法 → 400 VALIDATION_FAILED', async () => {
    const oversize = await app.inject({
      method: 'POST',
      url: '/api/v1/skills',
      headers: AUTH_ADMIN,
      payload: { id: 'too-big', name: 'too-big', description: 'oversize body', body: `a${'a'.repeat(128 * 1024)}` },
    });
    expect(oversize.statusCode).toBe(400);
    expect(oversize.json().code).toBe('HARNESS-1008'); // 字节级复核在 writer

    const badId = await app.inject({
      method: 'POST',
      url: '/api/v1/skills',
      headers: AUTH_ADMIN,
      payload: { id: 'Bad_Id', name: 'x', description: 'd', body: 'b\n' },
    });
    expect(badId.statusCode).toBe(400);
    expect(badId.json().code).toBe('HARNESS-1009');
    expect(fs.existsSync(path.join(dataRoot, 'too-big'))).toBe(false);
    expect(fs.existsSync(path.join(dataRoot, 'Bad_Id'))).toBe(false);
  });

  it('POST /api/v1/skills：无 token → 401；normal 角色 → 403 HARNESS-1007', async () => {
    const anon = await app.inject({
      method: 'POST',
      url: '/api/v1/skills',
      payload: { id: 'anon-skill', name: 'anon-skill', description: 'd', body: 'b\n' },
    });
    expect(anon.statusCode).toBe(401);
    expect(anon.json().code).toBe('HARNESS-1006');

    const denied = await app.inject({
      method: 'POST',
      url: '/api/v1/skills',
      headers: AUTH_NORMAL,
      payload: { id: 'normal-skill', name: 'normal-skill', description: 'd', body: 'b\n' },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().code).toBe('HARNESS-1007');
  });

  it('DELETE /api/v1/skills/:id：data 源 → 200 { ok, id } 且删后 GET 404；builtin/extension 源 → 403；未知 id → 404；normal → 403', async () => {
    const denied = await app.inject({ method: 'DELETE', url: '/api/v1/skills/team-retro', headers: AUTH_NORMAL });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().code).toBe('HARNESS-1007');

    const builtin = await app.inject({ method: 'DELETE', url: '/api/v1/skills/builtin-skill', headers: AUTH_ADMIN });
    expect(builtin.statusCode).toBe(403);
    expect(builtin.json()).toMatchObject({ code: 'HARNESS-1007' });
    expect(fs.existsSync(path.join(builtinRoot, 'builtin-skill'))).toBe(true);

    const ext = await app.inject({ method: 'DELETE', url: '/api/v1/skills/ext-only-skill', headers: AUTH_ADMIN });
    expect(ext.statusCode).toBe(403);

    const ghost = await app.inject({ method: 'DELETE', url: '/api/v1/skills/ghost-skill', headers: AUTH_ADMIN });
    expect(ghost.statusCode).toBe(404);
    expect(ghost.json().code).toBe('HARNESS-3004');

    const ok = await app.inject({ method: 'DELETE', url: '/api/v1/skills/team-retro', headers: AUTH_ADMIN });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ ok: true, id: 'team-retro' });
    expect(fs.existsSync(path.join(dataRoot, 'team-retro'))).toBe(false);

    // 删后自动 refresh：详情 404、data 源列表为空
    const detail = await app.inject({ method: 'GET', url: '/api/v1/skills/team-retro', headers: AUTH_ADMIN });
    expect(detail.statusCode).toBe(404);
    const list = await app.inject({ method: 'GET', url: '/api/v1/skills?source=data', headers: AUTH_NORMAL });
    expect(list.json()).toEqual([]);
  });
});
