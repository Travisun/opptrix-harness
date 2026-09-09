/**
 * MemoryManager — 全局记忆系统的领域编排层（存储 + 抽取 + 容量治理）。
 *
 * 职责边界：
 * - **add 去重（v1 口径：精确匹配）**：同 scope 下 content 精确命中既有记忆 →
 *   只推 updated_at，不重复插入（避免重复写入膨胀）。FTS 相似度去重留给
 *   sqlite-vec 向量检索（T1.5 路线），v1 刻意只做 O(1) 的精确索引命中；
 * - **extractAndStore**：extractor 抽取 → 逐条入库（source='llm_extract'）；
 *   入库前用 store 的"精确/前缀"匹配跳过与既有记忆相似的事实（LLM 对同一
 *   事实常给出长短两种措辞），这是比 add 更激进的一层去重；
 * - **search**：FTS5 优先 + LIKE 兜底（见 store.search），命中回写
 *   access_count / last_accessed_at（检索反馈闭环，供容量治理加权）；
 * - **容量治理**：maxMemories（缺省 10000，构造可配 / setMaxMemories 运行期
 *   可调）超限 → 删"最旧最弱"（strength*access_count 最低，同分最旧优先）；
 * - **manager 层不做 enabled 门禁**：总开关是 REST 层职责（settings 门控），
 *   manager 直连（桥/内部调用）恒可用。
 */
import { randomUUID } from 'node:crypto';

import { err } from '../errors/index.js';
import type { MemoryExtractor } from './extractor.js';
import { DEFAULT_SEARCH_LIMIT, MemoryStore } from './store.js';
import type {
  ExtractedFact,
  MemoryAddInput,
  MemoryExtractResult,
  MemoryForgetFilter,
  MemoryListOptions,
  MemoryRecord,
  MemorySearchHit,
  MemorySearchOptions,
  MemoryStats,
} from './types.js';
import { MEMORY_KINDS } from './types.js';

/** 记忆条数上限缺省值（容量治理） */
export const DEFAULT_MAX_MEMORIES = 10_000;

/** content 长度上限（UTF-16 码元；原子陈述的工程上限，防大段文本入库） */
const CONTENT_MAX_CHARS = 8_000;

/** add 的结果：入库/去重后的记录 + 是否发生了去重 */
export interface MemoryAddResult {
  record: MemoryRecord;
  /** true = 命中既有记忆只刷新了 updated_at（未插入新行） */
  deduped: boolean;
}

export interface MemoryManagerDeps {
  /** 存储层（内核全局库的 MemoryStore） */
  store: MemoryStore;
  /** LLM 抽取器（可选；缺省时 extractAndStore → NOT_IMPLEMENTED） */
  extractor?: MemoryExtractor;
  /** 记忆条数上限（缺省 10000） */
  maxMemories?: number;
  /** 时钟注入（测试用；缺省 Date.now） */
  now?: () => number;
}

export class MemoryManager {
  private readonly store: MemoryStore;
  private readonly extractor?: MemoryExtractor;
  private readonly now: () => number;
  private maxMemories: number;

  constructor(deps: MemoryManagerDeps) {
    this.store = deps.store;
    this.extractor = deps.extractor;
    this.now = deps.now ?? (() => Date.now());
    this.maxMemories =
      deps.maxMemories !== undefined && deps.maxMemories >= 1
        ? Math.floor(deps.maxMemories)
        : DEFAULT_MAX_MEMORIES;
  }

  /** 当前容量上限 */
  get capacity(): number {
    return this.maxMemories;
  }

  /** 运行期调整容量上限（REST PUT settings 后由集成方/REST 层联动调用） */
  setMaxMemories(max: number): void {
    if (max >= 1) this.maxMemories = Math.floor(max);
  }

  /**
   * 新增一条记忆（**v1 去重口径：精确匹配**——同 scope 下 content trim 后全等即视为
   * 同一条：只推 updated_at 而非重复插入，返回 deduped=true）。FTS/向量相似度去重
   * 属 sqlite-vec（T1.5）路线，v1 刻意不做。
   *
   * @throws VALIDATION_FAILED content 为空或超长（> 8000 字符）
   */
  async add(input: MemoryAddInput): Promise<MemoryAddResult> {
    const content = typeof input.content === 'string' ? input.content.trim() : '';
    if (content === '') {
      throw err('VALIDATION_FAILED', { message: 'memory add requires non-empty "content"' });
    }
    if (content.length > CONTENT_MAX_CHARS) {
      throw err('VALIDATION_FAILED', {
        message: `memory "content" exceeds ${CONTENT_MAX_CHARS} chars`,
        detail: { length: content.length, max: CONTENT_MAX_CHARS },
      });
    }
    const scope = input.scope ?? 'main';
    const at = this.now();

    const existing = await this.store.findByExactContent(content, scope);
    if (existing !== null) {
      await this.store.touch(existing.id, at);
      return { record: { ...existing, updatedAt: at }, deduped: true };
    }

    const kind = normalizeKind(input.kind);
    const source = input.source ?? 'manual';
    const tags = Array.isArray(input.tags)
      ? input.tags.filter((t): t is string => typeof t === 'string' && t.trim() !== '')
      : [];
    const record: MemoryRecord = {
      id: randomUUID(),
      content,
      kind,
      tags,
      source,
      scope,
      sessionRef: input.sessionRef ?? null,
      strength: 1.0,
      accessCount: 0,
      createdAt: at,
      updatedAt: at,
      lastAccessedAt: null,
    };
    await this.store.insert({
      id: record.id,
      content: record.content,
      kind: record.kind,
      tags: JSON.stringify(record.tags),
      source: record.source,
      scope: record.scope,
      sessionRef: record.sessionRef,
      strength: record.strength,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
    await this.enforceCapacity();
    return { record, deduped: false };
  }

  /**
   * 检索：FTS5 加权排序（相关性 + strength + recency，见 store.search）；
   * 命中回写 access_count / last_accessed_at（异步反馈，不阻塞返回值）。
   * 空 query / 空白 → 返回 []（不做全表扫描）。
   */
  async search(query: string, opts: MemorySearchOptions = {}): Promise<MemorySearchHit[]> {
    const trimmed = typeof query === 'string' ? query.trim() : '';
    if (trimmed === '') return [];
    const hits = await this.store.search(trimmed, {
      limit: opts.limit ?? DEFAULT_SEARCH_LIMIT,
      kind: opts.kind,
    });
    if (hits.length > 0) {
      await this.store.trackAccess(hits.map((h) => h.id), this.now());
    }
    return hits;
  }

  /** 抽取器是否已接线（REST 501 判定用） */
  get canExtract(): boolean {
    return this.extractor !== undefined;
  }

  /**
   * LLM 抽取管线：extractor.extractFromText → 逐条入库（source='llm_extract'）。
   * 入库前用"精确/前缀"匹配跳过与既有记忆相似的事实（skipped 计入账目）；
   * add 内层的精确去重作为最后防线（理论上前缀检查已覆盖，防御性保留）。
   *
   * @throws NOT_IMPLEMENTED 抽取器未接线
   * @throws BAD_REQUEST text 为空/超长或未指定模型（透传 extractor）
   */
  async extractAndStore(
    text: string,
    opts: { model?: string; sessionRef?: string; scope?: string } = {},
  ): Promise<MemoryExtractResult> {
    if (this.extractor === undefined) {
      throw err('NOT_IMPLEMENTED', {
        message: 'memory extract is not wired: the MemoryManager was assembled without an extractor (deps.extractor)',
      });
    }
    const facts: ExtractedFact[] = await this.extractor.extractFromText(text, {
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      ...(opts.sessionRef !== undefined ? { sessionRef: opts.sessionRef } : {}),
    });
    const items: MemoryRecord[] = [];
    let skipped = 0;
    for (const fact of facts) {
      // 相似跳过（精确/前缀互含）：LLM 常复述既有记忆，只在真正新增时插入
      const similar = await this.store.findByExactOrPrefix(fact.content, opts.scope ?? 'main');
      if (similar !== null) {
        skipped += 1;
        continue;
      }
      const added = await this.add({
        content: fact.content,
        kind: fact.kind,
        tags: fact.tags,
        source: 'llm_extract',
        ...(opts.scope !== undefined ? { scope: opts.scope } : {}),
        ...(opts.sessionRef !== undefined ? { sessionRef: opts.sessionRef } : {}),
      });
      if (added.deduped) {
        skipped += 1; // add 精确去重命中（防御路径）
        continue;
      }
      items.push(added.record);
    }
    return { extracted: facts.length, added: items.length, skipped, items };
  }

  /** 列表（updated_at 倒序；kind/limit 可选） */
  async list(opts: MemoryListOptions = {}): Promise<MemoryRecord[]> {
    return this.store.list(opts);
  }

  /** 按 id 遗忘；返回是否确有行被删除 */
  async forget(id: string): Promise<boolean> {
    return this.store.remove(id);
  }

  /** 条件批量遗忘；返回删除行数 */
  async forgetWhere(filter: MemoryForgetFilter): Promise<number> {
    return this.store.removeWhere(filter);
  }

  /** 统计：总数 + 按类别计数 */
  async stats(): Promise<MemoryStats> {
    const [count, byKind] = await Promise.all([this.store.count(), this.store.countByKind()]);
    return { count, byKind };
  }

  /** 容量治理：超限删"最旧最弱"（strength*access_count 最低，同分最旧优先） */
  private async enforceCapacity(): Promise<void> {
    await this.store.pruneToMax(this.maxMemories);
  }
}

/** kind 归一：合法枚举原样返回，其余兜底 'fact' */
function normalizeKind(kind: unknown): MemoryRecord['kind'] {
  return typeof kind === 'string' && (MEMORY_KINDS as readonly string[]).includes(kind)
    ? (kind as (typeof MEMORY_KINDS)[number])
    : 'fact';
}
