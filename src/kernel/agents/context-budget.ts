/**
 * context-budget — 上下文预算估算与压缩（三级压缩的内核纯函数子集，借鉴 ../Opptrix）。
 *
 * 定位：**纯函数、无 IO、可单测**；不触碰 runner 既有路径——对接点在 runner 的
 * chatOnce 组装 messages 之后调用 applyContextBudget（runner.ts 属并行包冻结文件，
 * 落地由集成完成，见交付报告「runner 对接点」）。
 *
 * 压缩策略（按需递进，单次调用内完成）：
 * 1. **不超限**：估算总 token ≤ budget → 原样返回（compacted=false）；
 * 2. **micro 压缩**：keepRecent 窗口之前的早期 tool / 长消息体替换为摘要对象
 *    `{_compacted:true, keys:[前8个键], preview:前120字}`——tool 消息保留
 *    `{toolCallId, text}` 信封（tool_call_id 结构不动，text 为摘要 JSON）、
 *    assistant 富形状保留 toolCalls 只摘要长 text；
 * 3. **丢轮**：micro 后仍超限 → 从最旧开始丢弃早期的 user / assistant 纯文本轮
 *    （assistant 含 toolCalls 的消息永不丢，防 tool 结果悬空；system 与
 *    keepRecent 窗口恒保留）。全部可丢项耗尽仍超限 → 尽力而为返回（不抛错）。
 */
import { assistantToolCallsOf, isRecord, toolContentOf, type LlmMessage } from '../llm/types.js';

// ---------------------------------------------------------------- 规范常量

/** 上下文预算缺省值（token） */
export const DEFAULT_CONTEXT_BUDGET_TOKENS = 96_000;

/** 近端保留窗口缺省值（从尾部数起的消息条数，含 system 之外的最近消息） */
export const DEFAULT_KEEP_RECENT = 16;

/** micro 压缩的体量阈值：早期消息体（估算文本）超过该字符数才值得摘要 */
export const MICRO_COMPACT_MIN_CHARS = 240;

/** 摘要对象 preview 的字符上限 */
export const MICRO_PREVIEW_CHARS = 120;

/** 摘要对象 keys 的个数上限（富形状 JSON 内容取前 8 个键） */
export const MICRO_KEYS_LIMIT = 8;

/** CJK 统一表意文字/假名/谚文（用于估算的中文占比判定） */
const CJK_PATTERN = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]/g;

// ---------------------------------------------------------------- 估算

/**
 * 文本 token 估算（中英混合启发式）：非 CJK ≈ chars/4，CJK ≈ chars×0.6，向上取整。
 * 只求偏差有界（用于预算决策），不追求与具体 tokenizer 一致。
 */
export function estimateTokens(text: string): number {
  if (text === '') return 0;
  const cjk = text.match(CJK_PATTERN)?.length ?? 0;
  const other = text.length - cjk;
  return Math.ceil(other / 4 + cjk * 0.6);
}

/** 单条消息的估算 token：字符串 content 直取；其余（富形状/对象）按 JSON 序列化估算 */
function estimateMessageTokens(message: LlmMessage): number {
  const text = typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '');
  return estimateTokens(text);
}

/** 消息数组估算合计 */
function estimateMessagesTokens(messages: readonly LlmMessage[]): number {
  let total = 0;
  for (const message of messages) total += estimateMessageTokens(message);
  return total;
}

// ---------------------------------------------------------------- micro 压缩

/** 富形状 tool 内容的 JSON 摘要：前 8 键 + 前 120 字 preview（`{_compacted,keys,preview}`） */
function summarizeText(text: string): string {
  let keys: string[] = [];
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed)) keys = Object.keys(parsed).slice(0, MICRO_KEYS_LIMIT);
  } catch {
    // 纯文本（非 JSON）：keys 留空，仅保留 preview
  }
  return JSON.stringify({ _compacted: true, keys, preview: text.slice(0, MICRO_PREVIEW_CHARS) });
}

/** 纯文本轮的摘要对象（user/assistant 长正文原位替换） */
function summarizePlain(text: string): Record<string, unknown> {
  return { _compacted: true, keys: [], preview: text.slice(0, MICRO_PREVIEW_CHARS) };
}

/**
 * 单条早期消息的 micro 压缩：可压缩 → 返回新消息（原消息不动）；不满足阈值 → null。
 * - tool：保留 `{toolCallId, text}` 信封，text 换为摘要 JSON（tool_call_id 结构不动）；
 * - user/assistant 字符串正文 → 摘要对象原位替换；
 * - assistant 富形状：保留 toolCalls（协议结构不动），仅把超长 text 换为摘要 JSON；
 * - system：永不压缩。
 */
function microCompactMessage(message: LlmMessage): LlmMessage | null {
  if (message.role === 'system') return null;
  if (message.role === 'tool') {
    const { toolCallId, text } = toolContentOf(message.content);
    if (text.length <= MICRO_COMPACT_MIN_CHARS) return null;
    return { role: 'tool', content: { toolCallId, text: summarizeText(text) } };
  }
  // user / assistant
  if (typeof message.content === 'string') {
    if (message.content.length <= MICRO_COMPACT_MIN_CHARS) return null;
    return { role: message.role, content: summarizePlain(message.content) };
  }
  if (isRecord(message.content)) {
    const text = typeof message.content['text'] === 'string' ? message.content['text'] : '';
    if (text.length <= MICRO_COMPACT_MIN_CHARS) return null;
    return { role: message.role, content: { ...message.content, text: summarizeText(text) } };
  }
  return null;
}

// ---------------------------------------------------------------- 预算主入口

/** applyContextBudget 的可选项（全部可省，见常量缺省值） */
export interface ContextBudgetOptions {
  /** 上下文预算（token），缺省 96_000 */
  budgetTokens?: number;
  /** 近端保留窗口（条数），缺省 16 */
  keepRecent?: number;
}

/** applyContextBudget 的结果（messages 为新数组或原数组引用，输入永不被改写） */
export interface ContextBudgetResult {
  /** 压缩后的消息（未触发压缩时与输入同引用） */
  messages: LlmMessage[];
  /** 是否发生了任何压缩/丢轮 */
  compacted: boolean;
  /** 结果消息的估算 token */
  estimatedTokens: number;
}

/**
 * 上下文预算压缩主入口（语义见模块头注释）。
 *
 * 保证：
 * - 纯函数：输入数组与其元素永不被改写；未超限时返回原引用；
 * - system 消息与最后 keepRecent 条消息永不压缩/丢弃；
 * - assistant（含 toolCalls）与 tool 消息的配对结构在两个阶段都保持——只摘要内容，
 *   不删结构（丢轮阶段只丢纯文本 user/assistant）；
 * - 极端超限（可丢项耗尽仍超限）→ 返回当前最优结果，不抛错。
 */
export function applyContextBudget(messages: LlmMessage[], opts: ContextBudgetOptions = {}): ContextBudgetResult {
  const budget = opts.budgetTokens ?? DEFAULT_CONTEXT_BUDGET_TOKENS;
  const keepRecent = Math.max(0, opts.keepRecent ?? DEFAULT_KEEP_RECENT);

  const baseline = estimateMessagesTokens(messages);
  if (baseline <= budget) {
    return { messages, compacted: false, estimatedTokens: baseline };
  }

  // 受保护集合：system + 末尾 keepRecent 窗口（cut 之前的才是「早期」）
  const cut = Math.max(0, messages.length - keepRecent);
  const isProtected = (message: LlmMessage, index: number): boolean =>
    message.role === 'system' || index >= cut;

  // ---- 阶段 1：micro 摘要（早期 tool / 长消息体 → 摘要对象） ----
  let changed = false;
  let current: LlmMessage[] = messages.map((message, index) => {
    if (isProtected(message, index)) return message;
    const compactedMessage = microCompactMessage(message);
    if (compactedMessage === null) return message;
    changed = true;
    return compactedMessage;
  });
  let estimated = changed ? estimateMessagesTokens(current) : baseline;
  if (estimated <= budget) {
    return { messages: current, compacted: changed, estimatedTokens: estimated };
  }

  // ---- 阶段 2：丢轮（从最旧开始丢早期的 user / assistant 纯文本轮） ----
  // 先在原数组坐标上一次定齐待丢集合（边删边丢会移位），再一次性 filter
  const dropSet = new Set<number>();
  for (let index = 0; index < cut && estimated > budget; index += 1) {
    const message = current[index];
    if (message === undefined) continue;
    const droppable =
      message.role === 'user'
      || (message.role === 'assistant' && assistantToolCallsOf(message.content) === undefined);
    if (!droppable) continue;
    dropSet.add(index);
    estimated -= estimateMessageTokens(message);
    changed = true;
  }
  if (dropSet.size > 0) {
    current = current.filter((_, index) => !dropSet.has(index));
    estimated = estimateMessagesTokens(current); // 删除后精确复核
  }
  return { messages: current, compacted: changed, estimatedTokens: estimated };
}

// ---------------------------------------------------------------- 用量报告

/** contextUsageReport 的返回（供 done 事件 / UI 显示） */
export interface ContextUsageReport {
  /** 估算已用 token */
  usedTokens: number;
  /** 预算上限 token（原样回显） */
  limitTokens: number;
  /** 使用百分比（保留 1 位小数；budget ≤ 0 时按上限 1 计防除零） */
  usagePercent: number;
  /** 本轮是否发生过压缩（调用方透传 applyContextBudget 的 compacted） */
  compacted: boolean;
}

/**
 * 上下文用量报告（纯函数）：done 事件 / UI 显示用。
 * compacted 由调用方从 applyContextBudget 结果透传（缺省 false）。
 */
export function contextUsageReport(estimatedTokens: number, budgetTokens: number, compacted = false): ContextUsageReport {
  const limit = budgetTokens > 0 ? budgetTokens : 1;
  return {
    usedTokens: estimatedTokens,
    limitTokens: budgetTokens,
    usagePercent: Math.round((estimatedTokens / limit) * 1000) / 10,
    compacted,
  };
}
