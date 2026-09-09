/**
 * 全局 LLM 记忆系统 — 共享类型与常量。
 *
 * 记忆是**内核全局库**（kernel.sqlite 的 `memories` 表，不按扩展隔离）：
 * 长期记忆属于智能体本身（参考 Mem0/Letta/Zep 的 agent-memory 定位），经
 * REST（src/api/memory.ts）与扩展桥（bridge.ts）两个面读写；行级隔离不在
 * v1 范围（scope 列为后续多租户预留，缺省恒 'main'）。
 */

/** 记忆类别：事实 | 偏好 | 事件 | 操作步骤 */
export type MemoryKind = 'fact' | 'preference' | 'event' | 'procedure';

/** 合法类别全集（zod 枚举与归一化的单一事实来源） */
export const MEMORY_KINDS: readonly MemoryKind[] = ['fact', 'preference', 'event', 'procedure'];

/** 记忆来源：人工写入 | LLM 抽取 | 扩展写入 */
export type MemorySource = 'manual' | 'llm_extract' | 'extension';

/** 一条长期记忆（camelCase 对外形状；tags 反序列化为字符串数组） */
export interface MemoryRecord {
  id: string;
  /** 原子化的一句话陈述（去重与检索的主键语义） */
  content: string;
  kind: MemoryKind;
  /** 主题标签（JSON 字符串落库，边界层序列化/反序列化） */
  tags: string[];
  source: MemorySource;
  /** 作用域（v1 恒 'main'，多智能体隔离为后续版本预留） */
  scope: string;
  /** 关联会话引用（可空；抽取来源的溯源线索） */
  sessionRef: string | null;
  /** 记忆强度 0..1（forget/reinforce 语义由调用方组合；检索加权项） */
  strength: number;
  /** 累计命中次数（search 命中即 +1；容量治理的权重项） */
  accessCount: number;
  /** UTC epoch ms */
  createdAt: number;
  /** UTC epoch ms */
  updatedAt: number;
  /** 最近命中时刻（UTC epoch ms；可空 = 从未被检索命中） */
  lastAccessedAt: number | null;
}

/** add 的规范化入参（REST/桥/抽取管线共用） */
export interface MemoryAddInput {
  content: string;
  kind?: MemoryKind;
  tags?: string[];
  source?: MemorySource;
  scope?: string;
  sessionRef?: string | null;
}

/** 检索选项（limit 缺省 8；kind 可选过滤） */
export interface MemorySearchOptions {
  limit?: number;
  kind?: string;
}

/** 检索命中：记录 + 简化加权得分（越大越相关；口径见 store.search JSDoc） */
export interface MemorySearchHit extends MemoryRecord {
  score: number;
}

/** 列表过滤（kind 过滤 + limit；按 updated_at 倒序） */
export interface MemoryListOptions {
  kind?: string;
  limit?: number;
}

/** forgetWhere 的过滤条件（全部可选，命中即删；返回删除行数） */
export interface MemoryForgetFilter {
  kind?: string;
  source?: string;
  scope?: string;
  sessionRef?: string;
  /** 删除 updated_at 早于该时刻（UTC epoch ms）的记忆 */
  updatedBefore?: number;
}

/** 统计快照：总数 + 按类别计数 */
export interface MemoryStats {
  count: number;
  byKind: Record<string, number>;
}

/** LLM 抽取出的单条候选事实 */
export interface ExtractedFact {
  content: string;
  kind: MemoryKind;
  tags: string[];
}

/** extractAndStore 的结果（抽取 → 逐条入库的账目） */
export interface MemoryExtractResult {
  /** 抽取并去重后的候选事实数 */
  extracted: number;
  /** 实际新增条数（去重命中的不计入） */
  added: number;
  /** 因与既有记忆精确/前缀匹配而跳过的条数 */
  skipped: number;
  /** 新增的记录（新增为 0 时为数组） */
  items: MemoryRecord[];
}

// ---------------------------------------------------------------------------
// Settings（REST 门控；manager 层不强制）
// ---------------------------------------------------------------------------

/** settings 键：记忆系统设置（{ enabled, maxMemories, autoExtract }） */
export const MEMORY_SETTINGS_KEY = 'memory.settings';

/** 记忆系统设置（GET/PUT /api/v1/memory/settings 的形状） */
export interface MemorySettings {
  /** 总开关：false 时 REST 层门禁 extract/search（manager 不感知，直连仍可用） */
  enabled: boolean;
  /** 记忆条数上限（容量治理；manager 构造缺省见 DEFAULT_MAX_MEMORIES） */
  maxMemories: number;
  /** 自动抽取预留开关（v1 仅持久化，供上层编排决定是否在会话后自动调 extract） */
  autoExtract: boolean;
}

/** 设置缺省值（settings 无值/形状非法时合并兜底） */
export const DEFAULT_MEMORY_SETTINGS: MemorySettings = {
  enabled: true,
  maxMemories: 10_000,
  autoExtract: true,
};

/** settings 原始值 → 合并缺省的完整形状（非对象/字段类型不符按缺省处理） */
export function mergeMemorySettings(raw: unknown): MemorySettings {
  const rawRecord =
    raw !== null && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  return {
    enabled: typeof rawRecord['enabled'] === 'boolean' ? rawRecord['enabled'] : DEFAULT_MEMORY_SETTINGS.enabled,
    maxMemories:
      typeof rawRecord['maxMemories'] === 'number' &&
      Number.isFinite(rawRecord['maxMemories']) &&
      rawRecord['maxMemories'] >= 1
        ? Math.floor(rawRecord['maxMemories'])
        : DEFAULT_MEMORY_SETTINGS.maxMemories,
    autoExtract:
      typeof rawRecord['autoExtract'] === 'boolean' ? rawRecord['autoExtract'] : DEFAULT_MEMORY_SETTINGS.autoExtract,
  };
}
