/**
 * Skills/dragdrop — 「拖拽批量创建技能」的文件分类与草稿构建纯函数集。
 *
 * 设计约束：**除 `./frontmatter.js` 外零导入**（不依赖 React / `@/` 别名 / DOM /
 * fs）——同时被两条工具链消费：
 * - ui-src（vite + tsc，供 Skills.tsx / BatchImportDialog 使用）；
 * - 根 vitest（node 环境，test/skills-dragdrop.test.ts 经相对路径直测）。
 *
 * 批量创建流水（纯部分）：拖入文件按扩展名分类 →
 * - .md / .markdown：parseSkillFile 检测 frontmatter——有文件头按字段创建
 *   （name/description/tags/author；id 由 name slug 化）；无文件头 → 文件名作
 *   name、正文首段非空文本（≤200 字）作 description；
 * - .txt：文件名作 name、全文作 body（≤128KB 截断）；
 * - .pdf / .docx 等二进制：文本由 POST /api/v1/extract 提取（异步部分见
 *   ./batchImport，本模块只接收提取结果）——提取成功后优先用 LLM 生成的
 *   name/description，缺省回落文件名 + 首段；
 * - id 冲突不失败：dedupeSkillId 以 `-2`、`-3`… slug 去重（批量体验优先）；
 *   slug 产出空串（纯中文文件名等）时以 'skill' 兜底再参与去重。
 *
 * 失败项（不支持的类型 / 提取失败 / 空内容）不抛错，以 error 字段随清单返回，
 * 由 UI 列入失败清单展示。
 */
import { parseSkillFile, slugifyId } from './frontmatter.js';

/** 技能 id 合法形态（与内核 SKILL_NAME_PATTERN / CreateSkillDialog 一致的镜像） */
export const SKILL_ID_PATTERN = /^[a-z0-9-]{1,64}$/;

/** 正文 UTF-8 字节上限（与内核 SKILL_BODY_MAX_BYTES 一致：128KB） */
export const SKILL_BODY_MAX_BYTES = 128 * 1024;

/** frontmatter description 上限（与内核 SKILL_DESCRIPTION_MAX_CHARS 一致：1024 字符） */
export const SKILL_DESCRIPTION_MAX_CHARS = 1024;

/** 展示名上限（与 POST /api/v1/skills 的 name max(200) 一致） */
export const SKILL_NAME_MAX_CHARS = 200;

/** 首段描述缺省截断长度（拖拽导入的 description 预览口径） */
export const FIRST_PARAGRAPH_MAX_CHARS = 200;

/** slug 产出空串（无法转写的文件名）时的 id 兜底基底 */
export const FALLBACK_ID_BASE = 'skill';

/** 拖入文件的类别（决定读取方式与来源图标） */
export type DroppedFileKind = 'markdown' | 'text' | 'binary' | 'unsupported';

/** 已读取内容的拖入文件（文本读取 / extract 提取的产物；error 非空 = 该文件失败） */
export interface DroppedFileInput {
  fileName: string;
  kind: DroppedFileKind;
  /** 文本内容（markdown / txt 原文；binary 为 extract 提取结果） */
  text?: string;
  /** 读取 / 提取失败原因（非空 → 该文件进失败清单） */
  error?: string;
}

/** LLM 生成的技能元信息（batchImport 经 POST /api/v1/llm/chat 产出的解析结果） */
export interface LlmDraftMeta {
  name: string;
  description: string;
}

/** 待创建清单的一项（error 非空 = 失败清单行，其余字段仅部分有效） */
export interface SkillDraft {
  /** 来源文件名（清单展示与去重展示用） */
  fileName: string;
  /** 来源类别（图标） */
  kind: DroppedFileKind;
  /** 展示名（POST body.name） */
  name: string;
  /** 注册 id（POST body.id；buildSkillDrafts 已按批次去重） */
  id: string;
  /** 一句话描述（POST body.description；≤1024 字符） */
  description: string;
  /** 正文（POST body.body；已按 128KB 截断） */
  body: string;
  /** 标签（frontmatter tags；其余来源为 []） */
  tags: string[];
  /** 作者（frontmatter author；可选） */
  author?: string;
  /** 正文是否因 128KB 上限被截断（清单提示） */
  truncated: boolean;
  /** 字段来源说明（frontmatter / 文件名+首段 / 文本提取+首段 / 文本提取+LLM） */
  sourceNote: string;
  /** 非空 = 该文件无法创建（失败清单原因） */
  error?: string;
}

/** 可提取文本的二进制扩展名（尝试 POST /api/v1/extract；不带点小写） */
export const EXTRACTABLE_EXTS: readonly string[] = [
  'pdf',
  'docx',
  'doc',
  'pptx',
  'ppt',
  'xlsx',
  'xls',
  'rtf',
  'html',
  'htm',
];

/** 小写扩展名（不含点；无扩展名为 ''） */
function extOf(fileName: string): string {
  const base = fileName.replace(/\\/g, '/').split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return ''; // 无点 / 点开头（.gitignore 等隐藏文件）→ 无扩展名
  return base.slice(dot + 1).toLowerCase();
}

/** 去扩展名的文件基础名（展示名缺省来源；路径分隔符已剥离） */
export function baseNameOf(fileName: string): string {
  const base = fileName.replace(/\\/g, '/').split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  const stem = dot <= 0 ? base : base.slice(0, dot);
  return stem.trim();
}

/** 按扩展名分类拖入文件（大小写不敏感） */
export function classifyDroppedFile(fileName: string): DroppedFileKind {
  const ext = extOf(fileName);
  if (ext === 'md' || ext === 'markdown') return 'markdown';
  if (ext === 'txt') return 'text';
  if (EXTRACTABLE_EXTS.includes(ext)) return 'binary';
  return 'unsupported';
}

/**
 * 正文首段非空文本（≤maxChars，含截断省略号）：跳过空白行取第一个非空段落
 * （连续非空行合并），剥离行首 Markdown 标记（标题 #、引用 >、列表 - * + 与
 * 有序列表）、折叠内部空白——用作缺省 description。
 */
export function firstParagraph(text: string, maxChars = FIRST_PARAGRAPH_MAX_CHARS): string {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  let paragraph = '';
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') {
      if (paragraph !== '') break; // 段落已收集完毕，遇空行即止
      continue;
    }
    // 剥行首 Markdown 标记（重复剥，如 `## - 标题`）
    const stripped = trimmed
      .replace(/^#{1,6}\s+/, '')
      .replace(/^>\s?/, '')
      .replace(/^[-*+]\s+/, '')
      .replace(/^\d+[.)]\s+/, '');
    paragraph = paragraph === '' ? stripped : `${paragraph} ${stripped}`;
  }
  const collapsed = paragraph.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxChars) return collapsed;
  return `${collapsed.slice(0, Math.max(1, maxChars - 1))}…`;
}

/** 文本按 UTF-8 字节上限截断（不劈开代理对；未超限原样返回） */
export function truncateToByteLimit(text: string, limit = SKILL_BODY_MAX_BYTES): { text: string; truncated: boolean } {
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= limit) return { text, truncated: false };
  // 二分最大字符前缀（UTF-8 ≤ limit），再回退可能的半个代理对
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi + 1) / 2);
    if (encoder.encode(text.slice(0, mid)).length <= limit) lo = mid;
    else hi = mid - 1;
  }
  let cut = text.slice(0, lo);
  while (cut.length > 0) {
    const last = cut.charCodeAt(cut.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
    else break;
  }
  return { text: cut, truncated: true };
}

/**
 * 批内 id 去重：base 未被占用原样返回；被占用依序尝试 `base-2`、`base-3`…
 * （后缀拼接超 64 位时先截断基底）；base 为空串（slug 产出空）时以 'skill' 兜底。
 */
export function dedupeSkillId(base: string, taken: ReadonlySet<string>): string {
  const root = base === '' ? FALLBACK_ID_BASE : base;
  if (!taken.has(root)) return root;
  for (let n = 2; ; n += 1) {
    const suffix = `-${String(n)}`;
    let candidate = root.slice(0, Math.max(1, 64 - suffix.length)) + suffix;
    candidate = candidate.replace(/-+$/, '');
    if (candidate !== '' && !taken.has(candidate)) return candidate;
  }
}

/** 失败清单行（该文件无法创建；id 留空） */
function failureDraft(fileName: string, kind: DroppedFileKind, error: string): SkillDraft {
  return {
    fileName,
    kind,
    name: baseNameOf(fileName),
    id: '',
    description: '',
    body: '',
    tags: [],
    truncated: false,
    sourceNote: '',
    error,
  };
}

/** 夹取展示名 / 描述到内核上限（超限静默截断——批量体验优先，不整单失败） */
function clampField(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

/** .md / .markdown → 草稿：frontmatter 字段优先，缺省回落文件名 + 首段 */
export function draftFromMarkdown(fileName: string, text: string): SkillDraft {
  const parsed = parseSkillFile(text);
  const fallbackName = baseNameOf(fileName);
  const bodyInfo = truncateToByteLimit(parsed.body);

  if (parsed.hasFrontmatter) {
    const fmName = (parsed.fields.name ?? '').trim();
    const name = fmName !== '' ? fmName : fallbackName;
    const fmDescription = (parsed.fields.description ?? '').trim();
    const description = fmDescription !== '' ? fmDescription : firstParagraph(bodyInfo.text);
    return {
      fileName,
      kind: 'markdown',
      name: clampField(name, SKILL_NAME_MAX_CHARS),
      id: slugifyId(name),
      description: clampField(description, SKILL_DESCRIPTION_MAX_CHARS),
      body: bodyInfo.text,
      tags: parsed.fields.tags,
      ...(parsed.fields.author !== undefined && parsed.fields.author.trim() !== ''
        ? { author: parsed.fields.author.trim() }
        : {}),
      truncated: bodyInfo.truncated,
      sourceNote: 'frontmatter 文件头',
    };
  }

  return {
    fileName,
    kind: 'markdown',
    name: clampField(fallbackName, SKILL_NAME_MAX_CHARS),
    id: slugifyId(fallbackName),
    description: firstParagraph(bodyInfo.text),
    body: bodyInfo.text,
    tags: [],
    truncated: bodyInfo.truncated,
    sourceNote: '文件名 + 首段',
  };
}

/** .txt → 草稿：文件名作 name、全文作 body（≤128KB 截断）、首段作 description */
export function draftFromText(fileName: string, text: string): SkillDraft {
  const bodyInfo = truncateToByteLimit(text);
  const name = baseNameOf(fileName);
  return {
    fileName,
    kind: 'text',
    name: clampField(name, SKILL_NAME_MAX_CHARS),
    id: slugifyId(name),
    description: firstParagraph(bodyInfo.text),
    body: bodyInfo.text,
    tags: [],
    truncated: bodyInfo.truncated,
    sourceNote: '文件名 + 全文',
  };
}

/** 二进制提取成功 → 草稿：LLM 元信息优先，缺省文件名 + 首段 */
export function draftFromExtract(fileName: string, text: string, llm?: LlmDraftMeta): SkillDraft {
  const bodyInfo = truncateToByteLimit(text);
  const llmName = (llm?.name ?? '').trim();
  const llmDescription = (llm?.description ?? '').trim();
  const name = llmName !== '' ? llmName : baseNameOf(fileName);
  const description = llmDescription !== '' ? llmDescription : firstParagraph(bodyInfo.text);
  return {
    fileName,
    kind: 'binary',
    name: clampField(name, SKILL_NAME_MAX_CHARS),
    id: slugifyId(name),
    description: clampField(description, SKILL_DESCRIPTION_MAX_CHARS),
    body: bodyInfo.text,
    tags: [],
    truncated: bodyInfo.truncated,
    sourceNote: llmName !== '' || llmDescription !== '' ? '文本提取 + LLM' : '文本提取 + 首段',
  };
}

/**
 * 解析 LLM 输出中的 `{"name": …, "description": …}` JSON：容忍 ```json 代码栅栏
 * 与前后赘述（取首个 `{` 到最后一个 `}`），name/description 须为非空字符串，
 * 否则返回 null（调用方降级文件名 + 首段）。
 */
export function parseLlmMetaJson(raw: string): LlmDraftMeta | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(raw.slice(start, end + 1)) as unknown;
  } catch {
    return null;
  }
  if (typeof obj !== 'object' || obj === null) return null;
  const name = (obj as Record<string, unknown>).name;
  const description = (obj as Record<string, unknown>).description;
  if (typeof name !== 'string' || typeof description !== 'string') return null;
  const trimmedName = name.trim();
  const trimmedDescription = description.trim();
  if (trimmedName === '' || trimmedDescription === '') return null;
  return { name: trimmedName, description: trimmedDescription };
}

/**
 * 批量构建待创建清单（纯函数；文件读取由调用方注入已完成的结果，不真读 fs）：
 * - unsupported / error / 空内容 → 失败清单行（error 原因）；
 * - 可创建项依序做 id 去重（对 existingIds + 批内已分配）。
 */
export function buildSkillDrafts(
  inputs: readonly DroppedFileInput[],
  existingIds: readonly string[] = [],
): SkillDraft[] {
  const taken = new Set<string>(existingIds);
  return inputs.map((input) => {
    if (input.error !== undefined && input.error !== '') {
      return failureDraft(input.fileName, input.kind, input.error);
    }
    if (input.kind === 'unsupported') {
      return failureDraft(input.fileName, input.kind, '不支持的文件类型（支持 .md / .markdown / .txt 与 pdf、docx 等可提取文本的文档）');
    }
    const text = input.text ?? '';
    if (text.trim() === '') {
      return failureDraft(input.fileName, input.kind, input.kind === 'binary' ? '未从文件中提取到文本' : '文件内容为空');
    }
    let draft: SkillDraft;
    if (input.kind === 'markdown') draft = draftFromMarkdown(input.fileName, text);
    else if (input.kind === 'text') draft = draftFromText(input.fileName, text);
    else draft = draftFromExtract(input.fileName, text);
    if (draft.body.trim() === '') {
      return failureDraft(input.fileName, input.kind, '文件内容为空');
    }
    draft.id = dedupeSkillId(draft.id, taken);
    taken.add(draft.id);
    return draft;
  });
}
