/**
 * 记忆抽取器：把一段对话/文本交给 LLM，抽提"值得长期记住"的原子事实。
 *
 * Package-First 评估结论（详见 docs/memory.mdx）：Mem0 开源核心是 Python、npm 的
 * mem0ai 只是托管平台客户端、LangChain 记忆组件绑定其框架生态——Node 侧无合格
 * 的可自托管记忆引擎包。按规则记录评估后**自研轻量实现**：本抽取器即"LLM 抽取
 * 管线"一环，LLM 调用走自家 LlmGateway（结构化 chat 契约），不引入外部记忆 SDK。
 *
 * 容错约定：
 * - LLM 输出必须为 JSON 数组；模型裹了 markdown 代码围栏/前后缀说明时，截取首个
 *   '[' 到最后一个 ']' 再解析；解析失败 → 返回 []（不抛错——抽取是"尽力而为"，
 *   失败不应打断主流程）；
 * - 条目形状逐项校验：content 非空字符串、kind 归一到合法枚举（不符 → 'fact'）、
 *   tags 过滤为字符串数组；
 * - 结果内部去重：与本次已接受条目精确/前缀匹配的后续条目跳过（LLM 对同一事实
 *   常给出长短两种措辞）。
 */
import { err } from '../errors/index.js';
import type { LlmChatInput, LlmChatResult, LlmStreamEvent } from '../llm/types.js';
import type { ExtractedFact, MemoryKind } from './types.js';
import { MEMORY_KINDS } from './types.js';

/** 抽取提示词上限（UTF-16 码元；与 REST 层 body 上限同量级） */
const EXTRACT_TEXT_MAX_CHARS = 100_000;

/** 单次抽取的最大事实数（防提示注入撑爆存储；超出截断） */
const MAX_FACTS_PER_EXTRACT = 32;

/**
 * 抽取提示词（中文，面向中英混合输入；要求只输出 JSON 数组）。
 * 导出供 docs 与测试对齐口径。
 */
export const EXTRACTION_PROMPT = [
  '你是长期记忆抽取器。从下面的文本中提取值得长期记住的信息：原子事实、用户偏好、重要事件、操作步骤。',
  '要求：',
  '1. 每条记忆必须是独立、原子的一句话陈述，保留关键实体与数值；不臆测、不概括原文之外的信息；',
  '2. kind 只能取：fact（事实）、preference（偏好）、event（事件）、procedure（操作步骤）；',
  '3. tags 是主题标签数组（0-5 个短标签）；',
  '4. 没有值得记住的内容时输出空数组 []。',
  '只输出一个 JSON 数组，不要任何解释、markdown 代码块或其他文本。格式示例：',
  '[{"content":"用户部署在 Kubernetes 1.30 集群","kind":"fact","tags":["部署","k8s"]}]',
].join('\n');

/** 抽取器依赖的网关契约（LlmGateway 的结构子集；chat 非 stream 调用） */
export interface MemoryExtractorGateway {
  chat(input: LlmChatInput): Promise<LlmChatResult | AsyncGenerator<LlmStreamEvent>>;
}

export interface MemoryExtractorDeps {
  /** LLM 网关（自家 LlmGateway 或同形状 stub） */
  gateway: MemoryExtractorGateway;
  /** 缺省模型（opts.model 未给时使用；两者皆缺 → 调用报 BAD_REQUEST） */
  model?: string;
}

export interface MemoryExtractOptions {
  /** 本次抽取覆盖模型（优先于 deps.model） */
  model?: string;
  /** 关联会话引用（透传给 manager 落 session_ref；抽取器本体不消费） */
  sessionRef?: string;
  /** 单次抽取事实数上限（缺省 32） */
  maxFacts?: number;
}

export interface MemoryExtractor {
  extractFromText(text: string, opts?: MemoryExtractOptions): Promise<ExtractedFact[]>;
}

/** 用户消息组装（提示词 + 待抽取正文） */
function buildUserMessage(text: string): string {
  return `${EXTRACTION_PROMPT}\n\n待抽取文本：\n${text}`;
}

/**
 * 宽容 JSON 解析：剥离 markdown 围栏与前后杂文，截取首个 '[' 到最后一个 ']'；
 * 解析失败 / 非数组 → []。逐项校验形状（content 必须非空字符串），非法项丢弃。
 */
export function parseFactsJson(raw: string): ExtractedFact[] {
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return []; // 模型输出非法 JSON：抽取尽力而为，不抛错
  }
  if (!Array.isArray(parsed)) return [];
  const facts: ExtractedFact[] = [];
  for (const item of parsed) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const content = typeof record['content'] === 'string' ? record['content'].trim() : '';
    if (content === '') continue;
    const rawKind = typeof record['kind'] === 'string' ? record['kind'] : '';
    const kind = (MEMORY_KINDS as readonly string[]).includes(rawKind)
      ? (rawKind as MemoryKind)
      : 'fact';
    const rawTags = Array.isArray(record['tags'])
      ? (record['tags'] as unknown[]).filter((t): t is string => typeof t === 'string' && t.trim() !== '')
      : [];
    facts.push({ content, kind, tags: rawTags.slice(0, 8) });
  }
  return facts;
}

/** 结果内部去重：与已接受条目精确/前缀互含（trim 后）即视为同一事实 */
function isDuplicate(candidates: ExtractedFact[], content: string): boolean {
  return candidates.some((existing) => {
    const a = existing.content;
    const b = content;
    return a === b || (a.length > 0 && b.startsWith(a)) || (b.length > 0 && a.startsWith(b));
  });
}

/**
 * 创建记忆抽取器（同一实例可复用；无状态）。
 *
 * @throws BAD_REQUEST 未提供模型（deps.model 与 opts.model 皆缺）或 text 为空/超长
 */
export function createMemoryExtractor(deps: MemoryExtractorDeps): MemoryExtractor {
  return {
    async extractFromText(text: string, opts: MemoryExtractOptions = {}): Promise<ExtractedFact[]> {
      const trimmed = typeof text === 'string' ? text.trim() : '';
      if (trimmed === '') {
        throw err('BAD_REQUEST', { message: 'memory extraction requires non-empty "text"' });
      }
      if (trimmed.length > EXTRACT_TEXT_MAX_CHARS) {
        throw err('BAD_REQUEST', {
          message: `memory extraction text exceeds ${EXTRACT_TEXT_MAX_CHARS} chars`,
          detail: { length: trimmed.length, max: EXTRACT_TEXT_MAX_CHARS },
        });
      }
      const model = opts.model ?? deps.model;
      if (model === undefined || model === '') {
        throw err('BAD_REQUEST', {
          message: 'memory extraction requires a model: pass opts.model or configure the extractor default (deps.model)',
        });
      }
      const result = await deps.gateway.chat({
        model,
        messages: [
          { role: 'user', content: buildUserMessage(trimmed) },
        ],
        temperature: 0,
      });
      // 防御：契约是非流式 chat；若实现误回流迭代器则显式报错（不消费流）
      if (typeof (result as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function') {
        throw err('BAD_REQUEST', {
          message: 'memory extraction requires a non-streaming chat result (got an async generator)',
        });
      }
      const text0 = (result as LlmChatResult).text;
      const facts = parseFactsJson(typeof text0 === 'string' ? text0 : '');
      // 上限截断 + 结果内部去重（与已接受条目精确/前缀互含即跳过）
      const max = opts.maxFacts && opts.maxFacts >= 1 ? Math.floor(opts.maxFacts) : MAX_FACTS_PER_EXTRACT;
      const accepted: ExtractedFact[] = [];
      for (const fact of facts) {
        if (accepted.length >= max) break;
        if (isDuplicate(accepted, fact.content)) continue;
        accepted.push(fact);
      }
      return accepted;
    },
  };
}
