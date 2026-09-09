/**
 * skills/registry — SkillRegistry：技能目录事实的聚合读模型。
 *
 * 职责与边界：
 * - **纯读模型**：只做磁盘扫描聚合 + 扩展贡献的内存登记，不提供任何写盘/启停
 *   API（启停状态属使用方/扩展；frontmatter `enabled: false` 仅作为事实出现在
 *   条目上）；`repoRoot/skills`（builtin）与 `<dataDir>/skills`（data）等根目录
 *   由装配方经 deps.roots 注入。
 * - **冲突裁决**：同 id 冲突按 builtin > data > extension 取优先者，落败者计入
 *   duplicates（list 不出现、get 不可达）；extension 内部按贡献登记顺序先到先得。
 * - **正文惰性读**：磁盘条目 get 时才读 `<sourceRef>/SKILL.md`（剥离 frontmatter、
 *   复核 128KB；扫描后文件被删/改坏 → null）；extension 条目正文随注册驻留内存。
 * - 根目录不存在 → 空结果（技能库可选）；单根扫描失败 → warn 后继续其余根。
 */
import type { Logger } from 'pino';

import { readSkillBody, scanSkillDir } from './loader.js';
import {
  SKILL_BODY_MAX_BYTES,
  SKILL_NAME_PATTERN,
  type ContributedSkillInput,
  type SkillEntry,
  type SkillRegistryDeps,
  type SkillRegistryLike,
  type SkillRoot,
  type SkillSource,
  type SkillWithBody,
} from './types.js';
import { err } from '../errors/index.js';

/** 同 id 冲突中被跳过的落败条目记录（可观测性：运维据此发现被遮蔽的技能包） */
export interface SkillDuplicate {
  id: string;
  source: SkillSource;
  sourceRef: string;
}

/** extension 贡献的驻留形态（条目 + 内存正文） */
interface ContributedRecord {
  entry: SkillEntry;
  body: string;
}

/**
 * 技能注册表（纯读模型，见模块头注释）。
 *
 * 用法：`new SkillRegistry({ roots: [{ root: repoSkills, source: 'builtin' }, ...], logger })`
 * → `await registry.refresh()` 后 `list()/get()` 可用；扩展经桥 `skills.register`
 * 贡献的技能落到 registerContributed/removeContributed。
 */
export class SkillRegistry implements SkillRegistryLike {
  private readonly roots: SkillRoot[];
  private readonly logger: Logger;

  /** 最近一次 refresh 的磁盘条目（builtin/data；id → entry） */
  private diskEntries = new Map<string, SkillEntry>();
  /** extension 贡献（extId → 记录数组；登记顺序即冲突裁决顺序） */
  private contributed = new Map<string, ContributedRecord[]>();
  /** 当前生效视图（disk + contribution 合并后；id → entry） */
  private entries = new Map<string, SkillEntry>();
  /** extension 条目的内存正文（id → body；与 this.entries 同步重建） */
  private extBodies = new Map<string, string>();
  /** 最近一次 refresh/register 观测到的同 id 冲突（落败者） */
  private duplicates: SkillDuplicate[] = [];

  constructor(deps: SkillRegistryDeps) {
    this.roots = deps.roots;
    this.logger = deps.logger;
  }

  /**
   * 重扫全部根目录并重放扩展贡献 → 当前生效条目（id 升序）。
   * 根目录不存在 → 空结果；单根失败 → warn 继续。
   */
  async refresh(): Promise<SkillEntry[]> {
    const disk = new Map<string, SkillEntry>();
    const dups: SkillDuplicate[] = [];
    for (const root of this.roots) {
      let found: SkillEntry[];
      try {
        found = await scanSkillDir(root.root, root.source);
      } catch (e) {
        this.logger.warn(
          { root: root.root, source: root.source, err: e instanceof Error ? e.message : String(e) },
          'skills: scanSkillDir failed; skipping this root',
        );
        continue;
      }
      for (const entry of found) {
        const winner = disk.get(entry.id);
        if (winner !== undefined) {
          dups.push({ id: entry.id, source: entry.source, sourceRef: entry.sourceRef });
          this.logger.warn(
            { id: entry.id, skippedSource: entry.source, keptSource: winner.source },
            'skills: duplicate id skipped (lower priority loses)',
          );
          continue;
        }
        disk.set(entry.id, entry);
      }
    }
    this.diskEntries = disk;
    this.rebuildView(dups);
    return this.sortedEntries();
  }

  /** 按条件过滤当前条目（id 升序；条件可组合，全部可选） */
  list(filter: { source?: SkillSource; tag?: string; q?: string } = {}): SkillEntry[] {
    const q = filter.q !== undefined && filter.q !== '' ? filter.q.toLowerCase() : null;
    const tag = filter.tag !== undefined && filter.tag !== '' ? filter.tag : null;
    return this.sortedEntries().filter((e) => {
      if (filter.source !== undefined && e.source !== filter.source) return false;
      if (tag !== null && !e.tags.includes(tag)) return false;
      if (q !== null) {
        const hay = `${e.id}\n${e.name}\n${e.description}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  /** 最近一次 refresh/register 观测到的同 id 冲突（落败者清单） */
  listDuplicates(): SkillDuplicate[] {
    return [...this.duplicates];
  }

  /**
   * 读取条目 + 正文（磁盘惰性读 / extension 内存取）；不可得 → null。
   * 磁盘正文在扫描后被删除/超限/YAML 损坏 → null（视为不存在）。
   */
  async get(id: string): Promise<SkillWithBody | null> {
    const entry = this.entries.get(id);
    if (entry === undefined) return null;
    if (entry.source === 'extension') {
      const body = this.extBodies.get(id);
      return body === undefined ? null : { entry, body };
    }
    const body = await readSkillBody(entry.sourceRef);
    if (body === null) return null;
    return { entry, body };
  }

  /**
   * 登记某扩展的贡献（**整组替换**该 extId 既有贡献）→ 实际生效条数
   * （同 id 撞上更高优先来源或本扩展组内重复 → 跳过且不计数）。
   * 输入校验（id 形态 / 正文 128KB）由调用方（桥的 zod 层）先行；此处仅防御性复核。
   */
  registerContributed(extId: string, skills: ContributedSkillInput[]): number {
    if (extId === '') {
      throw err('BAD_REQUEST', { message: 'skills.registerContributed requires a non-empty extId' });
    }
    const records: ContributedRecord[] = skills.map((s) => {
      if (typeof s.id !== 'string' || !SKILL_NAME_PATTERN.test(s.id)) {
        throw err('BAD_REQUEST', {
          message: `skills.registerContributed: invalid skill id "${String(s.id).slice(0, 64)}" (must match ^[a-z0-9-]{1,64}$)`,
          detail: { extId },
        });
      }
      const bodyBytes = Buffer.byteLength(s.body, 'utf8');
      if (bodyBytes > SKILL_BODY_MAX_BYTES) {
        throw err('BAD_REQUEST', {
          message: `skills.registerContributed: body of "${s.id}" exceeds ${SKILL_BODY_MAX_BYTES} bytes`,
          detail: { extId, id: s.id, bodyBytes },
        });
      }
      const entry: SkillEntry = {
        id: s.id,
        name: s.id,
        description: s.description,
        tags: [],
        enabled: true,
        source: 'extension',
        sourceRef: extId,
        bodyBytes,
        files: [],
      };
      return { entry, body: s.body };
    });

    this.contributed.set(extId, records); // 整组替换：重复 register 以最后一次为准
    this.rebuildView();
    return records.filter((r) => this.entries.get(r.entry.id) === r.entry).length;
  }

  /** 摘除某扩展的贡献（未登记过 → 幂等静默） */
  removeContributed(extId: string): void {
    if (!this.contributed.has(extId)) return;
    this.contributed.delete(extId);
    this.rebuildView();
  }

  // ---------------------------------------------------------------- 内部

  /**
   * 重建生效视图：diskEntries 快照 → 按 contributed 的登记顺序重放 extension 贡献
   * （extension 永远最低优先；同 id 已存在 → 计入 duplicates 跳过）。
   */
  private rebuildView(dups: SkillDuplicate[] = []): void {
    const merged = new Map(this.diskEntries);
    this.extBodies = new Map();
    for (const records of this.contributed.values()) {
      for (const record of records) {
        if (merged.has(record.entry.id)) {
          dups.push({
            id: record.entry.id,
            source: 'extension',
            sourceRef: record.entry.sourceRef,
          });
          continue;
        }
        merged.set(record.entry.id, record.entry);
        this.extBodies.set(record.entry.id, record.body);
      }
    }
    this.entries = merged;
    this.duplicates = dups;
  }

  /** id 升序快照 */
  private sortedEntries(): SkillEntry[] {
    return [...this.entries.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
}
