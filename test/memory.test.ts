/**
 * 全局 LLM 记忆系统测试（真 better-sqlite3 临时文件库 + gateway stub + 桩 requirePermission）。
 *
 * 覆盖：
 * - store：惰性建表幂等/并发、插入/读取、精确与前缀查找、touch、trackAccess、
 *   remove/removeWhere/count/countByKind/pruneToMax/rebuildFts、ftsMatchQuery 转义；
 * - manager：CRUD、精确去重（v1 口径）、FTS 搜索命中/排序/limit/kind 过滤、
 *   命中回写 access_count/last_accessed_at、CJK LIKE 兜底、forget/forgetWhere、
 *   stats、容量治理（最旧最先淘汰、运行期 setMaxMemories）；
 * - extractor：JSON 严格解析容错（围栏/前后杂文/非法 JSON/非数组/非法条目）、
 *   kind 归一、结果内部去重、空文本/缺模型报错、流式误用报错；
 * - extractAndStore：source='llm_extract'、精确/前缀相似跳过、未接线 501 语义；
 * - 桥：'kernel' 端点拒绝（RPC_PERMISSION_DENIED）、权限矩阵（每 topic 均过
 *   requirePermission('…','memory.…','memory')）、五个 topic 全链、payload 校验；
 * - REST：401 矩阵、normal 可读写而 settings 需 admin（403）、add/search/list/
 *   delete/stats/extract 全链、enabled=false 门禁（search/extract 空响应）、
 *   settings GET/PUT（持久化往返、部分更新合并、校验失败 400、未接线 501）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import pino from 'pino';
import type { Knex } from 'knex';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { registerMemoryRoutes, type MemoryRoutesDeps } from '../src/api/memory.js';
import { loadConfig } from '../src/kernel/config/index.js';
import { err } from '../src/kernel/errors/HarnessError.js';
import { createMemoryBridge, MEMORY_PERMISSION } from '../src/kernel/memory/bridge.js';
import { createMemoryExtractor, parseFactsJson, type MemoryExtractorGateway } from '../src/kernel/memory/extractor.js';
import { MemoryManager } from '../src/kernel/memory/manager.js';
import { MemoryStore, ftsMatchQuery } from '../src/kernel/memory/store.js';
import { DEFAULT_MEMORY_SETTINGS, MEMORY_SETTINGS_KEY } from '../src/kernel/memory/types.js';
import type { LlmChatInput } from '../src/kernel/llm/types.js';
import { openSqlite } from '../src/kernel/storage/db.js';
import { createHttpServer } from '../src/kernel/http/server.js';

// ---------------------------------------------------------------------------
// 公共装配
// ---------------------------------------------------------------------------

let dir: string;
let db: Knex;
let store: MemoryStore;

/** 递增时钟（epoch ms 基线在 2023 年，保证 recency 权重为正） */
let nowMs = 1_700_000_000_000;
const tick = (): number => {
  nowMs += 60_000;
  return nowMs;
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'opptrix-memory-'));
  db = await openSqlite(join(dir, 'kernel.sqlite'));
  store = new MemoryStore(db);
});

afterAll(async () => {
  await db?.destroy();
  rmSync(dir, { recursive: true, force: true });
});

/** 清空记忆表（测试隔离；连 FTS 触发器一并联动） */
async function resetRows(): Promise<void> {
  await store.removeWhere({});
  nowMs = 1_700_000_000_000;
}

/** gateway stub：按脚本回文本，记录全部 chat 入参 */
function gatewayStub(script: string | ((input: LlmChatInput) => string)): MemoryExtractorGateway & { calls: LlmChatInput[] } {
  const calls: LlmChatInput[] = [];
  return {
    calls,
    chat: async (input: LlmChatInput) => {
      calls.push(input);
      return { text: typeof script === 'string' ? script : script(input) };
    },
  };
}

/** 默认抽取脚本：两条事实（一条 preference 一条带非法 kind） */
const DEFAULT_EXTRACT_SCRIPT = JSON.stringify([
  { content: '用户的部署环境是 Kubernetes 1.30', kind: 'fact', tags: ['部署', 'k8s'] },
  { content: '用户偏好简洁的回复', kind: 'preference', tags: ['偏好'] },
]);

/** 组装 manager（可注入 gateway 脚本 / 容量上限） */
function buildManager(opts: {
  script?: string | ((input: LlmChatInput) => string);
  maxMemories?: number;
  withExtractor?: boolean;
} = {}): { manager: MemoryManager; gateway: ReturnType<typeof gatewayStub> | null } {
  const gateway = opts.withExtractor === false ? null : gatewayStub(opts.script ?? DEFAULT_EXTRACT_SCRIPT);
  const manager = new MemoryManager({
    store,
    ...(gateway !== null
      ? { extractor: createMemoryExtractor({ gateway, model: 'stub-model' }) }
      : {}),
    ...(opts.maxMemories !== undefined ? { maxMemories: opts.maxMemories } : {}),
    now: tick,
  });
  return { manager, gateway };
}

// ---------------------------------------------------------------------------
// store：建表 / 查找 / 治理
// ---------------------------------------------------------------------------

describe('MemoryStore — 惰性建表与基础读写', () => {
  it('ensureTable 幂等且并发安全；建出的表与 FTS 触发器齐全', async () => {
    await store.ensureTable();
    await Promise.all([store.ensureTable(), store.ensureTable()]);
    expect(await db.schema.hasTable('memories')).toBe(true);
    const triggers = (await db.raw(
      "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'memories_fts_%'",
    )) as unknown as Array<{ name: string }>;
    expect(triggers.map((t) => t.name).sort()).toEqual(['memories_fts_ad', 'memories_fts_ai', 'memories_fts_au']);
  });

  it('insert 后 FTS 由触发器同步；get/list 返回 camelCase 记录', async () => {
    await resetRows();
    await store.insert({
      id: 'm-1',
      content: 'project uses pnpm workspaces',
      kind: 'fact',
      tags: JSON.stringify(['tooling']),
      source: 'manual',
      scope: 'main',
      sessionRef: null,
      strength: 1.0,
      createdAt: 1,
      updatedAt: 1,
    });
    const rec = await store.get('m-1');
    expect(rec).toMatchObject({
      id: 'm-1',
      content: 'project uses pnpm workspaces',
      kind: 'fact',
      tags: ['tooling'],
      source: 'manual',
      scope: 'main',
      strength: 1,
      accessCount: 0,
      lastAccessedAt: null,
    });
    // FTS 索引经触发器同步（直接 MATCH 命中）
    const hits = await store.search('pnpm');
    expect(hits.map((h) => h.id)).toContain('m-1');
  });

  it('findByExactContent / findByExactOrPrefix（精确 + 前缀互含）', async () => {
    await resetRows();
    await store.insert({
      id: 'p-1', content: '用户部署在 Kubernetes', kind: 'fact', tags: '[]',
      source: 'manual', scope: 'main', sessionRef: null, strength: 1, createdAt: 1, updatedAt: 10,
    });
    expect((await store.findByExactContent('用户部署在 Kubernetes', 'main'))?.id).toBe('p-1');
    expect(await store.findByExactContent('用户部署在 Kubernetes 1.30', 'main')).toBeNull();
    // 既有是新的前缀 / 新的是既有的前缀 → 双向命中
    expect((await store.findByExactOrPrefix('用户部署在 Kubernetes 1.30', 'main'))?.id).toBe('p-1');
    // 新 content 是既有记忆的前缀 → 同样命中
    expect((await store.findByExactOrPrefix('用户部署在', 'main'))?.id).toBe('p-1');
    expect(await store.findByExactOrPrefix('毫不相关的内容', 'main')).toBeNull();
  });

  it('touch 只推 updated_at；trackAccess 累加 access_count 并盖 last_accessed_at', async () => {
    await resetRows();
    await store.insert({
      id: 't-1', content: 'touch me', kind: 'fact', tags: '[]',
      source: 'manual', scope: 'main', sessionRef: null, strength: 1, createdAt: 1, updatedAt: 1,
    });
    await store.touch('t-1', 555);
    expect((await store.get('t-1'))?.updatedAt).toBe(555);
    await store.trackAccess(['t-1', 'missing'], 777);
    const rec = await store.get('t-1');
    expect(rec?.accessCount).toBe(1);
    expect(rec?.lastAccessedAt).toBe(777);
  });

  it('remove / removeWhere / count / countByKind', async () => {
    await resetRows();
    for (const [id, kind, source] of [
      ['r-1', 'fact', 'manual'],
      ['r-2', 'preference', 'llm_extract'],
      ['r-3', 'preference', 'llm_extract'],
    ] as const) {
      await store.insert({
        id, content: `content ${id}`, kind, tags: '[]', source,
        scope: 'main', sessionRef: null, strength: 1, createdAt: 1, updatedAt: 1,
      });
    }
    expect(await store.remove('r-1')).toBe(true);
    expect(await store.remove('r-1')).toBe(false);
    expect(await store.removeWhere({ source: 'llm_extract' })).toBe(2);
    expect(await store.count()).toBe(0);
    await store.insert({
      id: 'r-4', content: 'x', kind: 'event', tags: '[]', source: 'manual',
      scope: 'main', sessionRef: null, strength: 1, createdAt: 1, updatedAt: 1,
    });
    expect(await store.countByKind()).toEqual({ event: 1 });
  });

  it('ftsMatchQuery 剥离 FTS 语法符并逐词加引号；纯符号 → null', () => {
    expect(ftsMatchQuery('hello world')).toBe('"hello" "world"');
    // OR 引号被剥除（中性词），FTS 语法符不再有语法效果
    expect(ftsMatchQuery('  deps "quoted" OR  ')).toBe('"deps" "quoted" "OR"');
    expect(ftsMatchQuery('，。；')).toBeNull();
    expect(ftsMatchQuery('')).toBeNull();
  });

  it('rebuildFts 全量重建索引后检索仍命中', async () => {
    await resetRows();
    await store.insert({
      id: 'rb-1', content: 'rebuild index sanity', kind: 'fact', tags: '[]',
      source: 'manual', scope: 'main', sessionRef: null, strength: 1, createdAt: 1, updatedAt: 1,
    });
    await store.rebuildFts();
    expect((await store.search('rebuild')).map((h) => h.id)).toContain('rb-1');
  });
});

/** bridge topic 名（extension-host/protocol.ts 预置键的线格式，与 KERNEL_TOPICS.memory* 一致） */
const MEMORY_TOPICS = {
  search: 'memory.search',
  add: 'memory.add',
  extract: 'memory.extract',
  list: 'memory.list',
  forget: 'memory.forget',
};

// ---------------------------------------------------------------------------
// manager：CRUD / 去重 / 检索 / 容量
// ---------------------------------------------------------------------------

describe('MemoryManager — add 与精确去重（v1 口径）', () => {
  it('add 落库：缺省 kind=fact、source=manual、scope=main、strength=1、tags 过滤', async () => {
    await resetRows();
    const { manager } = buildManager({ withExtractor: false });
    const { record, deduped } = await manager.add({
      content: '  prefers dark mode  ',
      tags: ['ui', '  ', 42 as unknown as string],
    });
    expect(deduped).toBe(false);
    expect(record).toMatchObject({
      content: 'prefers dark mode',
      kind: 'fact',
      tags: ['ui'],
      source: 'manual',
      scope: 'main',
      strength: 1,
      accessCount: 0,
    });
    expect(record.id).toMatch(/[0-9a-f-]{36}/);
    expect((await manager.list())[0]?.content).toBe('prefers dark mode');
  });

  it('add 精确去重：同 content 第二次 → deduped=true、不重复插入、updated_at 推进', async () => {
    await resetRows();
    const { manager } = buildManager({ withExtractor: false });
    const first = await manager.add({ content: 'uses vitest for tests' });
    const second = await manager.add({ content: 'uses vitest for tests' });
    expect(second.deduped).toBe(true);
    expect(second.record.id).toBe(first.record.id);
    expect(second.record.updatedAt).toBeGreaterThan(first.record.updatedAt);
    expect(await manager.stats()).toEqual({ count: 1, byKind: { fact: 1 } });
  });

  it('add 非法入参：空 content / 超长 content → VALIDATION_FAILED；非法 kind 兜底 fact', async () => {
    await resetRows();
    const { manager } = buildManager({ withExtractor: false });
    await expect(manager.add({ content: '   ' })).rejects.toMatchObject({ code: 'HARNESS-1009' });
    await expect(manager.add({ content: 'x'.repeat(8_001) })).rejects.toMatchObject({ code: 'HARNESS-1009' });
    const { record } = await manager.add({ content: 'ok', kind: 'nonsense' as never });
    expect(record.kind).toBe('fact');
    const { record: pref } = await manager.add({ content: 'ok2', kind: 'preference' });
    expect(pref.kind).toBe('preference');
  });
});

describe('MemoryManager — search：FTS 命中 / 排序 / 过滤 / CJK 兜底', () => {
  it('FTS 命中按词频加权排序；limit 截断；kind 过滤', async () => {
    await resetRows();
    const { manager } = buildManager({ withExtractor: false });
    await manager.add({ content: 'alpha report about the quarterly numbers' });
    await manager.add({ content: 'alpha alpha deep dive notes' });
    await manager.add({ content: 'unrelated entry', kind: 'event' });

    const hits = await manager.search('alpha');
    expect(hits[0]?.content).toBe('alpha alpha deep dive notes'); // 词频高 → bm25 更负 → 排前
    expect(hits).toHaveLength(2);
    expect(hits[0]?.score).toBeGreaterThan(hits[1]?.score ?? 0);

    expect(await manager.search('alpha', { limit: 1 })).toHaveLength(1);
    expect((await manager.search('alpha', { kind: 'event' }))).toHaveLength(0);
    expect(await manager.search('quarterly')).toHaveLength(1);
    expect(await manager.search('')).toEqual([]);
    expect(await manager.search('   ')).toEqual([]);
  });

  it('命中回写 access_count / last_accessed_at（检索反馈闭环）', async () => {
    await resetRows();
    const { manager } = buildManager({ withExtractor: false });
    const { record } = await manager.add({ content: 'cache invalidation strategy' });
    expect(record.accessCount).toBe(0);
    await manager.search('cache');
    const after = await manager.search('cache');
    // 返回的命中是"读取时刻"的快照（首次 trackAccess 已生效：1）；累计值落在库上
    expect(after.find((h) => h.id === record.id)?.accessCount).toBe(1);
    const stored = await store.get(record.id);
    expect(stored?.accessCount).toBe(2);
    expect(stored?.lastAccessedAt).toBeGreaterThan(0);
  });

  it('CJK 短词：FTS（unicode61）空命中时 LIKE 兜底', async () => {
    await resetRows();
    const { manager } = buildManager({ withExtractor: false });
    await manager.add({ content: '用户偏好简洁的回复风格', tags: ['偏好'] });
    await manager.add({ content: '部署在 Kubernetes 1.30' });
    // unicode61 不切 CJK：'简洁' 不是整段 token，FTS MATCH 无命中 → LIKE 子串命中
    const hits = await manager.search('简洁');
    expect(hits.map((h) => h.content)).toEqual(['用户偏好简洁的回复风格']);
    expect(await manager.search('不存在的词汇')).toEqual([]);
  });
});

describe('MemoryManager — forget / stats / 容量治理', () => {
  it('forget(id) 与 forgetWhere（kind/source/sessionRef/updatedBefore）', async () => {
    await resetRows();
    const { manager } = buildManager({ withExtractor: false });
    const a = await manager.add({ content: 'a', source: 'llm_extract', kind: 'event' });
    await manager.add({ content: 'b', source: 'manual' });
    expect(await manager.forget(a.record.id)).toBe(true);
    expect(await manager.forget('nope')).toBe(false);
    expect(await manager.forgetWhere({ source: 'manual' })).toBe(1);
    expect(await manager.stats()).toEqual({ count: 0, byKind: {} });
  });

  it('容量治理：超限删最旧最弱（strength*access_count 最低、同分最旧优先）', async () => {
    await resetRows();
    const { manager } = buildManager({ withExtractor: false, maxMemories: 3 });
    const first = await manager.add({ content: 'oldest weakest one' });
    await manager.add({ content: 'second entry here' });
    await manager.add({ content: 'third entry here' });
    // 让 third 被检索命中一次（access_count=1 → 权重高于未访问的）
    await manager.search('third entry');
    await manager.add({ content: 'fourth entry here' });
    await manager.add({ content: 'fifth entry here' });

    const stats = await manager.stats();
    expect(stats.count).toBe(3);
    const contents = (await manager.list({ limit: 10 })).map((r) => r.content).sort();
    // 最旧且零访问的 first 被淘汰；被访问过的 third 与最新的 fourth/fifth 保留
    expect(contents).toEqual(['fifth entry here', 'fourth entry here', 'third entry here']);
    expect(await manager.forget(first.record.id)).toBe(false);
  });

  it('setMaxMemories 运行期生效（新上限立即约束容量）', async () => {
    await resetRows();
    const { manager } = buildManager({ withExtractor: false, maxMemories: 10 });
    await manager.add({ content: 'one' });
    await manager.add({ content: 'two' });
    manager.setMaxMemories(1);
    expect(manager.capacity).toBe(1);
    await manager.add({ content: 'three' });
    expect(await manager.stats()).toEqual({ count: 1, byKind: { fact: 1 } });
    expect((await manager.list())[0]?.content).toBe('three');
  });
});

// ---------------------------------------------------------------------------
// extractor：JSON 容错与 LLM 管线
// ---------------------------------------------------------------------------

describe('parseFactsJson — 严格 JSON 解析容错', () => {
  it('裸数组 / markdown 围栏 / 前后杂文都能解析', () => {
    const item = { content: '事实', kind: 'fact', tags: ['t'] };
    expect(parseFactsJson(JSON.stringify([item]))).toHaveLength(1);
    expect(parseFactsJson(`\`\`\`json\n${JSON.stringify([item])}\n\`\`\``)).toHaveLength(1);
    expect(parseFactsJson(`好的，以下是抽取结果：${JSON.stringify([item])} 请查收`)).toHaveLength(1);
  });

  it('非法 JSON / 非数组 / 无数组括号 → 空数组（不抛错）', () => {
    expect(parseFactsJson('not json at all')).toEqual([]);
    expect(parseFactsJson('{"content":"nope"}')).toEqual([]);
    expect(parseFactsJson('[broken')).toEqual([]);
    expect(parseFactsJson('')).toEqual([]);
  });

  it('条目形状校验：非法条目丢弃、kind 归一 fact、tags 过滤非字符串并截断', () => {
    const facts = parseFactsJson(
      JSON.stringify([
        null,
        'string item',
        { content: '  ' },
        { content: '合法事实', kind: 'preference', tags: ['a', 3, 'b', 'c', 'd', 'e', 'f', 'g', 'h'] },
        { content: 'kind 非法', kind: 'gossip', tags: 'not-array' },
      ]),
    );
    expect(facts).toHaveLength(2);
    expect(facts[0]).toEqual({
      content: '合法事实',
      kind: 'preference',
      tags: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
    });
    expect(facts[1]).toEqual({ content: 'kind 非法', kind: 'fact', tags: [] });
  });
});

describe('createMemoryExtractor — LLM 抽取管线', () => {
  it('组装提示词并调用网关；kind 归一 + 结果内部去重（精确/前缀互含）', async () => {
    const gateway = gatewayStub(
      JSON.stringify([
        { content: '用户部署在 Kubernetes', kind: 'fact', tags: [] },
        { content: '用户部署在 Kubernetes 1.30 集群', kind: 'fact', tags: [] }, // 前缀互含 → 跳过
        { content: '用户部署在 Kubernetes', kind: 'fact', tags: [] }, // 精确重复 → 跳过
      ]),
    );
    const extractor = createMemoryExtractor({ gateway });
    const facts = await extractor.extractFromText('刚才聊了部署的话题', { model: 'm1' });
    expect(facts).toHaveLength(1);
    expect(gateway.calls).toHaveLength(1);
    expect(gateway.calls[0]?.model).toBe('m1');
    expect(gateway.calls[0]?.temperature).toBe(0);
    const message = gateway.calls[0]?.messages[0]?.content;
    expect(typeof message).toBe('string');
    expect(String(message)).toContain('长期记忆抽取器');
  });

  it('缺省模型来自 deps.model；opts.model 优先', async () => {
    const gateway = gatewayStub('[]');
    const extractor = createMemoryExtractor({ gateway, model: 'default-model' });
    await extractor.extractFromText('随便一点文本');
    expect(gateway.calls[0]?.model).toBe('default-model');
    await extractor.extractFromText('随便一点文本', { model: 'override' });
    expect(gateway.calls[1]?.model).toBe('override');
  });

  it('空文本 / 缺模型 → BAD_REQUEST；网关误回流 → BAD_REQUEST', async () => {
    const gateway = gatewayStub('[]');
    const extractor = createMemoryExtractor({ gateway });
    await expect(extractor.extractFromText('')).rejects.toMatchObject({ code: 'HARNESS-1008' });
    await expect(
      createMemoryExtractor({ gateway }).extractFromText('文本'),
    ).rejects.toMatchObject({ code: 'HARNESS-1008' });
    const streamGateway: MemoryExtractorGateway = {
      chat: async () =>
        (async function* () {
          yield { type: 'delta', text: 'x' };
        })(),
    };
    await expect(
      createMemoryExtractor({ gateway: streamGateway, model: 'm' }).extractFromText('文本'),
    ).rejects.toMatchObject({ code: 'HARNESS-1008' });
  });

  it('模型输出纯杂文（无可解析数组）→ 抽取为空，不抛错', async () => {
    const gateway = gatewayStub('今天没什么值得记住的。');
    const extractor = createMemoryExtractor({ gateway, model: 'm' });
    await expect(extractor.extractFromText('随便聊聊')).resolves.toEqual([]);
  });
});

describe('MemoryManager — extractAndStore 抽取入库管线', () => {
  it('抽取 → 逐条入库 source=llm_extract；与既有记忆前缀互含 → skipped', async () => {
    await resetRows();
    const { manager } = buildManager();
    // 既有记忆是新事实的前缀（用户已记过一半）
    await manager.add({ content: '用户的部署环境是 Kubernetes' });
    const result = await manager.extractAndStore('聊了部署与回复偏好', { sessionRef: 'sess-9' });
    expect(result.extracted).toBe(2);
    expect(result.skipped).toBe(1); // 前缀命中既有记忆
    expect(result.added).toBe(1);
    expect(result.items[0]).toMatchObject({
      content: '用户偏好简洁的回复',
      kind: 'preference',
      source: 'llm_extract',
      sessionRef: 'sess-9',
    });
    // 再跑一次：全部命中既有记忆（精确/前缀）→ 全部跳过
    const again = await manager.extractAndStore('同样的对话再来一遍');
    expect(again.added).toBe(0);
    expect(again.skipped).toBe(2);
  });

  it('未接线抽取器 → canExtract=false；extractAndStore → NOT_IMPLEMENTED', async () => {
    await resetRows();
    const { manager } = buildManager({ withExtractor: false });
    expect(manager.canExtract).toBe(false);
    await expect(manager.extractAndStore('文本')).rejects.toMatchObject({ code: 'HARNESS-9004' });
  });
});

// ---------------------------------------------------------------------------
// bridge：扩展 RPC 面（权限矩阵 + 全链）
// ---------------------------------------------------------------------------

describe('createMemoryBridge — 端点与权限闸', () => {
  function buildBridge(opts: { allow?: boolean } = {}) {
    const { manager } = buildManager();
    const calls: Array<{ extId: string; topic: string; permission: string }> = [];
    const bridge = createMemoryBridge({
      manager,
      requirePermission: (extId, topic, permission) => {
        calls.push({ extId, topic, permission });
        if (opts.allow === false) {
          throw err('FORBIDDEN', { message: 'denied by stub', detail: { extId, topic } });
        }
      },
    });
    return { bridge, calls, manager };
  }

  const TOPICS = ['memory.search', 'memory.add', 'memory.extract', 'memory.list', 'memory.forget'];

  it("from='kernel' → RPC_PERMISSION_DENIED（内核自身不走 worker→kernel 通道）", async () => {
    const { bridge } = buildBridge();
    for (const topic of TOPICS) {
      await expect(bridge[topic]({}, 'kernel')).rejects.toMatchObject({ code: 'HARNESS-2003' });
    }
  });

  it('权限矩阵：每个 topic 都过 requirePermission(extId, topic, "memory")；拒绝时透传 FORBIDDEN', async () => {
    const { bridge, calls } = buildBridge({ allow: false });
    for (const topic of TOPICS) {
      await expect(bridge[topic]({}, 'ext:review-bot')).rejects.toMatchObject({ code: 'HARNESS-1007' });
    }
    expect(calls.map((c) => c.permission)).toEqual(new Array(5).fill(MEMORY_PERMISSION));
    expect(calls.map((c) => c.topic)).toEqual(TOPICS);
    expect(new Set(calls.map((c) => c.extId))).toEqual(new Set(['review-bot']));
  });

  it('memory.add / memory.search / memory.list / memory.forget 全链（source 恒 extension）', async () => {
    await resetRows();
    const { bridge, manager } = buildBridge();
    const added = (await bridge[MEMORY_TOPICS.add]({ content: 'bridge stored fact', tags: ['x'] }, 'ext:bot')) as {
      record: { id: string; source: string };
      deduped: boolean;
    };
    expect(added.deduped).toBe(false);
    expect(added.record.source).toBe('extension');

    const search = (await bridge[MEMORY_TOPICS.search]({ query: 'bridge' }, 'ext:bot')) as { items: unknown[] };
    expect(search.items).toHaveLength(1);

    const list = (await bridge[MEMORY_TOPICS.list]({ limit: 10 }, 'ext:bot')) as { items: unknown[] };
    expect(list.items).toHaveLength(1);

    const forgotten = (await bridge[MEMORY_TOPICS.forget]({ id: added.record.id }, 'ext:bot')) as {
      ok: boolean;
      removed: boolean;
    };
    expect(forgotten).toEqual({ ok: true, removed: true });
    expect(await manager.stats()).toEqual({ count: 0, byKind: {} });
  });

  it('memory.extract 全链（gateway stub）与 payload 校验失败 → VALIDATION_FAILED', async () => {
    await resetRows();
    const { bridge } = buildBridge();
    const result = (await bridge[MEMORY_TOPICS.extract](
      { text: '聊了些值得记住的事', sessionRef: 's-1' },
      'ext:bot',
    )) as { added: number };
    expect(result.added).toBe(2);
    await expect(bridge[MEMORY_TOPICS.add]({ content: '' }, 'ext:bot')).rejects.toMatchObject({
      code: 'HARNESS-1009',
    });
    await expect(bridge[MEMORY_TOPICS.search]({ nope: 1 }, 'ext:bot')).rejects.toMatchObject({
      code: 'HARNESS-1009',
    });
  });
});

// ---------------------------------------------------------------------------
// REST：/api/v1/memory*（真实 fastify 注入）
// ---------------------------------------------------------------------------

const ADMIN_TOKEN = 'token-admin';
const NORMAL_TOKEN = 'token-normal';

const AUTH_ADMIN = { authorization: `Bearer ${ADMIN_TOKEN}` };
const AUTH_NORMAL = { authorization: `Bearer ${NORMAL_TOKEN}` };

/** settings 桩（与 SettingsService 的 get/set 契约一致的最小内存实现） */
class SettingsStub {
  readonly map = new Map<string, unknown>();
  async get<T>(key: string, fallback?: T): Promise<T | undefined> {
    return this.map.has(key) ? (this.map.get(key) as T) : fallback;
  }
  async set(key: string, value: unknown): Promise<void> {
    this.map.set(key, value);
  }
}

describe('memory REST — 鉴权、门禁与全链', () => {
  let restDb: Knex;
  let restDir: string;

  /** 组装被测服务器：stub checker + 真 manager + settings 桩 */
  function buildServer(opts: { withSettings?: boolean; withExtractor?: boolean } = {}) {
    const restStore = new MemoryStore(restDb);
    const gateway = opts.withExtractor === false ? null : gatewayStub(DEFAULT_EXTRACT_SCRIPT);
    const manager = new MemoryManager({
      store: restStore,
      ...(gateway !== null ? { extractor: createMemoryExtractor({ gateway, model: 'stub' }) } : {}),
      now: tick,
    });
    const settings = new SettingsStub();
    const config = loadConfig({ NODE_ENV: 'test', HARNESS_LOG_LEVEL: 'error', HARNESS_DATA_DIR: './data' });
    const { app } = createHttpServer({
      config,
      logger: pino({ level: 'silent' }),
      isReady: () => true,
      state: () => 'ready',
      registerExtra: (a) => {
        const deps: MemoryRoutesDeps = {
          checker: async ({ token }) => {
            if (token === ADMIN_TOKEN) return { userId: 'admin-1', role: 'admin', scopes: ['memory'] };
            if (token === NORMAL_TOKEN) return { userId: 'user-1', role: 'normal', scopes: [] };
            throw err('UNAUTHORIZED', { detail: 'token rejected by all auth providers' });
          },
          manager,
          ...(opts.withSettings === false ? {} : { settings }),
        };
        registerMemoryRoutes(a, deps);
      },
    });
    return { app, manager, settings, gateway };
  }

  const ALL_ROUTES = [
    { method: 'GET', url: '/api/v1/memory/search?q=x' },
    { method: 'POST', url: '/api/v1/memory', body: { content: 'c' } },
    { method: 'GET', url: '/api/v1/memory' },
    { method: 'DELETE', url: '/api/v1/memory/some-id' },
    { method: 'POST', url: '/api/v1/memory/extract', body: { text: 't' } },
    { method: 'GET', url: '/api/v1/memory/stats' },
    { method: 'GET', url: '/api/v1/memory/settings' },
    { method: 'PUT', url: '/api/v1/memory/settings', body: { enabled: true } },
  ] as const;

  it('无 token → 全部路由 401 HARNESS-1006', async () => {
    restDir = mkdtempSync(join(tmpdir(), 'opptrix-memory-rest-'));
    restDb = await openSqlite(join(restDir, 'kernel.sqlite'));
    try {
      const { app } = buildServer();
      for (const route of ALL_ROUTES) {
        const res = await app.inject({
          method: route.method,
          url: route.url,
          ...('body' in route ? { payload: route.body } : {}),
        });
        expect(res.statusCode, route.url).toBe(401);
        expect(res.json().code).toBe('HARNESS-1006');
      }
    } finally {
      await restDb.destroy();
      rmSync(restDir, { recursive: true, force: true });
    }
  });

  it('normal 角色可读写记忆（200/201）；settings 面要求 admin（403）', async () => {
    restDir = mkdtempSync(join(tmpdir(), 'opptrix-memory-rest-'));
    restDb = await openSqlite(join(restDir, 'kernel.sqlite'));
    try {
      const { app } = buildServer();
      const add = await app.inject({
        method: 'POST',
        url: '/api/v1/memory',
        headers: AUTH_NORMAL,
        payload: { content: 'rest added memory', tags: ['rest'] },
      });
      expect(add.statusCode).toBe(201);
      expect(add.json()).toMatchObject({ deduped: false, record: { content: 'rest added memory', source: 'manual' } });

      for (const url of ['/api/v1/memory', '/api/v1/memory/stats']) {
        const res = await app.inject({ method: 'GET', url, headers: AUTH_NORMAL });
        expect(res.statusCode).toBe(200);
      }
      const settingsNormal = await app.inject({
        method: 'GET',
        url: '/api/v1/memory/settings',
        headers: AUTH_NORMAL,
      });
      expect(settingsNormal.statusCode).toBe(403);
      expect(settingsNormal.json().code).toBe('HARNESS-1007');
      const putNormal = await app.inject({
        method: 'PUT',
        url: '/api/v1/memory/settings',
        headers: AUTH_NORMAL,
        payload: { enabled: false },
      });
      expect(putNormal.statusCode).toBe(403);
    } finally {
      await restDb.destroy();
      rmSync(restDir, { recursive: true, force: true });
    }
  });

  it('全链：add → 去重 → search 命中 → list → delete（404 语义）→ stats', async () => {
    restDir = mkdtempSync(join(tmpdir(), 'opptrix-memory-rest-'));
    restDb = await openSqlite(join(restDir, 'kernel.sqlite'));
    try {
      const { app } = buildServer();
      const first = await app.inject({
        method: 'POST',
        url: '/api/v1/memory',
        headers: AUTH_ADMIN,
        payload: { content: 'the release cadence is biweekly', kind: 'fact' },
      });
      expect(first.statusCode).toBe(201);
      const id = first.json().record.id as string;

      const dup = await app.inject({
        method: 'POST',
        url: '/api/v1/memory',
        headers: AUTH_ADMIN,
        payload: { content: 'the release cadence is biweekly' },
      });
      expect(dup.statusCode).toBe(201);
      expect(dup.json().deduped).toBe(true);

      const search = await app.inject({
        method: 'GET',
        url: '/api/v1/memory/search?q=release%20cadence',
        headers: AUTH_ADMIN,
      });
      expect(search.statusCode).toBe(200);
      expect(search.json().items).toHaveLength(1);
      expect(search.json().query).toBe('release cadence');

      const badSearch = await app.inject({ method: 'GET', url: '/api/v1/memory/search', headers: AUTH_ADMIN });
      expect(badSearch.statusCode).toBe(400);

      const list = await app.inject({ method: 'GET', url: '/api/v1/memory?limit=10', headers: AUTH_ADMIN });
      expect(list.json().items).toHaveLength(1);

      const del = await app.inject({ method: 'DELETE', url: `/api/v1/memory/${id}`, headers: AUTH_ADMIN });
      expect(del.statusCode).toBe(200);
      expect(del.json()).toEqual({ ok: true, removed: true });
      const delAgain = await app.inject({ method: 'DELETE', url: `/api/v1/memory/${id}`, headers: AUTH_ADMIN });
      expect(delAgain.statusCode).toBe(404);
      expect(delAgain.json().code).toBe('HARNESS-3004');

      const stats = await app.inject({ method: 'GET', url: '/api/v1/memory/stats', headers: AUTH_ADMIN });
      expect(stats.json()).toEqual({ count: 0, byKind: {} });

      const badBody = await app.inject({
        method: 'POST',
        url: '/api/v1/memory',
        headers: AUTH_ADMIN,
        payload: { content: '' },
      });
      expect(badBody.statusCode).toBe(400);
    } finally {
      await restDb.destroy();
      rmSync(restDir, { recursive: true, force: true });
    }
  });

  it('extract 全链（gateway stub 入库）；非法 body → 400', async () => {
    restDir = mkdtempSync(join(tmpdir(), 'opptrix-memory-rest-'));
    restDb = await openSqlite(join(restDir, 'kernel.sqlite'));
    try {
      const { app, gateway } = buildServer();
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/memory/extract',
        headers: AUTH_ADMIN,
        payload: { text: '聊了部署环境与回复偏好', sessionRef: 'sess-rest' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ extracted: 2, added: 2, skipped: 0 });
      expect(gateway?.calls[0]?.messages[0]).toBeDefined();

      const bad = await app.inject({
        method: 'POST',
        url: '/api/v1/memory/extract',
        headers: AUTH_ADMIN,
        payload: { nope: true },
      });
      expect(bad.statusCode).toBe(400);
    } finally {
      await restDb.destroy();
      rmSync(restDir, { recursive: true, force: true });
    }
  });

  it('enabled=false 门禁：search/extract 返回空 + 禁用提示（HTTP 200，manager 直连不受影响）', async () => {
    restDir = mkdtempSync(join(tmpdir(), 'opptrix-memory-rest-'));
    restDb = await openSqlite(join(restDir, 'kernel.sqlite'));
    try {
      const { app, manager } = buildServer();
      const put = await app.inject({
        method: 'PUT',
        url: '/api/v1/memory/settings',
        headers: AUTH_ADMIN,
        payload: { enabled: false },
      });
      expect(put.statusCode).toBe(200);
      expect(put.json()).toMatchObject({ enabled: false, maxMemories: 10_000, autoExtract: true });

      const search = await app.inject({
        method: 'GET',
        url: '/api/v1/memory/search?q=anything',
        headers: AUTH_ADMIN,
      });
      expect(search.statusCode).toBe(200);
      expect(search.json()).toMatchObject({ items: [], enabled: false, disabled: true });

      const extract = await app.inject({
        method: 'POST',
        url: '/api/v1/memory/extract',
        headers: AUTH_ADMIN,
        payload: { text: '值得记住的内容' },
      });
      expect(extract.statusCode).toBe(200);
      expect(extract.json()).toMatchObject({ added: 0, enabled: false, disabled: true });

      // manager 层不强制：直连仍可 add（门禁只在 REST 层）
      const direct = await manager.add({ content: 'direct write bypasses the REST gate' });
      expect(direct.deduped).toBe(false);
    } finally {
      await restDb.destroy();
      rmSync(restDir, { recursive: true, force: true });
    }
  });

  it('settings GET/PUT：未接线 501；接线后缺省合并、部分更新持久化往返、校验失败 400', async () => {
    restDir = mkdtempSync(join(tmpdir(), 'opptrix-memory-rest-'));
    restDb = await openSqlite(join(restDir, 'kernel.sqlite'));
    try {
      const { app } = buildServer({ withSettings: false });
      const getNoWire = await app.inject({ method: 'GET', url: '/api/v1/memory/settings', headers: AUTH_ADMIN });
      expect(getNoWire.statusCode).toBe(501);
      const putNoWire = await app.inject({
        method: 'PUT',
        url: '/api/v1/memory/settings',
        headers: AUTH_ADMIN,
        payload: { enabled: false },
      });
      expect(putNoWire.statusCode).toBe(501);

      const { app: wired, settings } = buildServer();
      const get = await wired.inject({ method: 'GET', url: '/api/v1/memory/settings', headers: AUTH_ADMIN });
      expect(get.statusCode).toBe(200);
      expect(get.json()).toEqual(DEFAULT_MEMORY_SETTINGS);

      const put = await wired.inject({
        method: 'PUT',
        url: '/api/v1/memory/settings',
        headers: AUTH_ADMIN,
        payload: { maxMemories: 500 },
      });
      expect(put.statusCode).toBe(200);
      expect(put.json()).toEqual({ enabled: true, maxMemories: 500, autoExtract: true });
      expect(settings.map.get(MEMORY_SETTINGS_KEY)).toEqual({ enabled: true, maxMemories: 500, autoExtract: true });

      const bad = await wired.inject({
        method: 'PUT',
        url: '/api/v1/memory/settings',
        headers: AUTH_ADMIN,
        payload: { maxMemories: 0 },
      });
      expect(bad.statusCode).toBe(400);
    } finally {
      await restDb.destroy();
      rmSync(restDir, { recursive: true, force: true });
    }
  });
});
