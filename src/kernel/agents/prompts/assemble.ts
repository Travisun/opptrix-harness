/**
 * agents/prompts/assemble — bootstrap 分层提示词的纯函数装配器。
 *
 * 职责（全部**纯函数**，无 IO / 无时钟 / 无可变全局，方便单测）：
 * - `parseBootstrapSections`：按 `<!-- section:xxx -->` 锚点把 bootstrap 正文切分为有序节；
 * - `renderBootstrapSections`：把节列表还原为提示词文本（parse ∘ render 幂等，支持未来
 *   对任意提示词做「切分 → 插节 → 还原」式扩展）；
 * - `buildToolCatalogSection`：由工具名清单生成按域分组的一行式中文目录段
 *   （复用 chat-progress.formatToolLabel 的工具名映射；未知名回退原名；≤40 行）；
 * - `assembleBootstrapPrompt`：一步式装配——按 bootstrap.ts 的锚点节序重组、
 *   `{{TOOL_CATALOG}}` 占位符注入目录段、#skills 节按会话能力保留/剔除、
 *   extraSections 追加尾部（未来提示词注入的扩展点）、总长截断保护 48KB。
 *
 * 与 runner 的衔接：runner.ts 缺省 system prompt 组装点调用
 * `assembleBootstrapPrompt({ toolNames })`；会话显式 systemPrompt 仍整体替换（优先级不变）。
 * 技能已激活正文的第二层注入仍由 skill-catalog.assembleSystemPrompt 负责（不在此处）。
 */
import { formatToolLabel } from '../chat-progress.js';
import { BOOTSTRAP_PROMPT } from './bootstrap.js';

// ---------------------------------------------------------------- 规范常量

/** 技能激活工具名（#skills 节是否保留的缺省判定锚点：白名单含此工具才注入该节） */
export const SKILL_ACTIVATE_TOOL = 'skill_activate';

/** 工具目录占位符（bootstrap.ts 的 tools-catalog 节内；装配时必被替换） */
export const TOOL_CATALOG_PLACEHOLDER = '{{TOOL_CATALOG}}';

/** 装配后的 bootstrap prompt 总长截断保护（字符数，≈48KB） */
export const BOOTSTRAP_PROMPT_MAX_CHARS = 48 * 1024;

/** 工具目录段的总行数上限（含分组标题行与截断说明行） */
export const TOOL_CATALOG_MAX_LINES = 40;

/** bootstrap 锚点节 id 的既定节序（与 bootstrap.ts 单一事实源一致；测试锚定用） */
export const BOOTSTRAP_SECTION_IDS = [
  'role',
  'tools-principles',
  'tools-catalog',
  'skills',
  'workspace',
  'output',
  'safety',
] as const;

// ---------------------------------------------------------------- 节的切分与还原

/** 单个锚点节：id 为锚点名，content 为该节正文（不含锚点行，首尾已 trim） */
export interface BootstrapSection {
  id: string;
  content: string;
}

/** 锚点行匹配（g 模式逐个推进；id 限定为字母/数字/连字符/下划线） */
const SECTION_ANCHOR_RE = /<!--\s*section:([A-Za-z0-9_-]+)\s*-->/g;

/**
 * 按 `<!-- section:xxx -->` 锚点把提示词源文本切分为有序节列表。
 * 锚点之间的文本（trim 后）为节正文；无锚点 → 空数组。纯函数。
 */
export function parseBootstrapSections(source: string): BootstrapSection[] {
  const marks: Array<{ id: string; end: number }> = [];
  const ends: number[] = [];
  const re = new RegExp(SECTION_ANCHOR_RE.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    marks.push({ id: match[1] ?? '', end: match.index + match[0].length });
    ends.push(match.index);
  }
  return marks.map((mark, i) => ({
    id: mark.id,
    content: source.slice(mark.end, ends[i + 1] ?? source.length).trim(),
  }));
}

/** 节列表 → 提示词文本（每节渲染为「锚点行 + 正文」，节间以空行相接；空数组 → 空串） */
export function renderBootstrapSections(sections: readonly BootstrapSection[]): string {
  return sections.map((s) => `<!-- section:${s.id} -->\n${s.content}`).join('\n\n');
}

// ---------------------------------------------------------------- 工具目录段

/** 目录分组的渲染定义（title 为中文组名；prefixes 命中任一前缀即归入该组） */
interface ToolCatalogGroup {
  title: string;
  prefixes: readonly string[];
}

/**
 * 工具目录的分组与组序（固定；未命中任何前缀的工具归入末组「其他」；
 * 前缀命中按声明顺序取首个匹配组）。
 */
const TOOL_CATALOG_GROUPS: readonly ToolCatalogGroup[] = [
  { title: '工作区', prefixes: ['workspace_'] },
  { title: '报告', prefixes: ['report_'] },
  { title: '浏览器', prefixes: ['browser_'] },
  { title: '代码执行', prefixes: ['coding_'] },
  { title: '技能', prefixes: ['skills_', 'skill_'] },
  { title: '任务', prefixes: ['cron_', 'subagent_'] },
  { title: '其他', prefixes: [] },
];

/** 目录行渲染：`- {工具名}：{中文用途}`（未知名经 formatToolLabel 回退原名） */
function catalogLineOf(name: string): string {
  return `- ${name}：${formatToolLabel(name)}`;
}

/**
 * 由工具名清单生成按域分组的一行式工具目录段（纯函数）：
 * - 组序固定（工作区 → 报告 → 浏览器 → 代码执行 → 技能 → 任务 → 其他），空组不出现；
 * - 组内保持传入顺序，重名工具只保留首次出现；
 * - 总行数（含分组标题）≤ `TOOL_CATALOG_MAX_LINES`(40)，超限时截断并附剩余数说明；
 * - 空清单 → 「（本次未提供任何工具）」占位。
 */
export function buildToolCatalogSection(toolNames: readonly string[]): string {
  const deduped = [...new Set(toolNames)];
  if (deduped.length === 0) return '（本次未提供任何工具）';

  // 归组：每个工具归入首个前缀命中的组（「其他」组无前缀、只作兜底）；组内保持传入顺序
  const buckets = new Map<string, string[]>(TOOL_CATALOG_GROUPS.map((g) => [g.title, []]));
  for (const name of deduped) {
    const hit = TOOL_CATALOG_GROUPS.find(
      (g) => g.prefixes.length > 0 && g.prefixes.some((p) => name.startsWith(p)),
    );
    const bucket = buckets.get(hit?.title ?? '其他');
    if (bucket !== undefined) bucket.push(name);
  }

  // 按固定组序展开为行（组标题行 + 条目行）；记录条目总数用于截断说明
  const lines: string[] = [];
  let entryTotal = 0;
  for (const group of TOOL_CATALOG_GROUPS) {
    const tools = buckets.get(group.title) ?? [];
    if (tools.length === 0) continue;
    lines.push(`### ${group.title}`);
    for (const name of tools) {
      lines.push(catalogLineOf(name));
      entryTotal += 1;
    }
  }
  if (lines.length <= TOOL_CATALOG_MAX_LINES) return lines.join('\n');

  const kept = lines.slice(0, TOOL_CATALOG_MAX_LINES - 1);
  const keptEntries = kept.filter((line) => line.startsWith('- ')).length;
  kept.push(`…（另有 ${entryTotal - keptEntries} 个工具未列入目录，完整清单以各工具的描述与参数 schema 为准）`);
  return kept.join('\n');
}

// ---------------------------------------------------------------- 一步式装配

/** 追加尾部的自定义节（未来扩展点） */
export interface BootstrapExtraSection {
  /** 节 id（渲染为锚点名；建议沿用小写连字符风格） */
  id: string;
  /** 节正文（空白正文跳过不注入） */
  content: string;
}

/** assembleBootstrapPrompt 输入 */
export interface AssembleBootstrapPromptOptions {
  /** 本次会话可用的工具白名单（缺省目录段与 #skills 节判定的输入；空数组 = 无工具） */
  toolNames: string[];
  /** 工具目录段覆盖（缺省 = buildToolCatalogSection(toolNames) 现生成） */
  toolCatalog?: string;
  /** 是否保留 #skills 节（缺省 = toolNames 含 skill_activate 时保留） */
  hasSkillTools?: boolean;
  /** 追加尾部的自定义节（按传入顺序排在全部锚点节之后；未来提示词注入点） */
  extraSections?: BootstrapExtraSection[];
}

/**
 * 一步式装配缺省 bootstrap system prompt（纯函数）：
 * 1. 按 bootstrap.ts 的锚点节序切分并重组（hasSkillTools=false 时剔除 #skills 节）；
 * 2. tools-catalog 节的 `{{TOOL_CATALOG}}` 占位符替换为目录段（显式 toolCatalog 优先，
 *    否则由 toolNames 现生成；以替换函数实现，目录段中的 `$` 系列字符不具特殊语义）；
 * 3. extraSections 依次追加尾部（空白正文跳过）；
 * 4. 总长超过 `BOOTSTRAP_PROMPT_MAX_CHARS`(48KB) 时从尾部截断并附标记。
 * 同参多次调用结果一致（幂等；parse ∘ render 往返不改变节序与正文）。
 */
export function assembleBootstrapPrompt(opts: AssembleBootstrapPromptOptions): string {
  const hasSkills = opts.hasSkillTools ?? opts.toolNames.includes(SKILL_ACTIVATE_TOOL);
  const catalog = opts.toolCatalog ?? buildToolCatalogSection(opts.toolNames);

  const base = parseBootstrapSections(BOOTSTRAP_PROMPT)
    .filter((section) => hasSkills || section.id !== 'skills')
    .map((section) =>
      section.id === 'tools-catalog'
        ? { id: section.id, content: section.content.replace(TOOL_CATALOG_PLACEHOLDER, () => catalog) }
        : section,
    );
  const extras = (opts.extraSections ?? [])
    .filter((section) => section.content.trim() !== '')
    .map((section) => ({ id: section.id, content: section.content.trim() }));

  const joined = renderBootstrapSections([...base, ...extras]);
  if (joined.length > BOOTSTRAP_PROMPT_MAX_CHARS) {
    return `${joined.slice(0, BOOTSTRAP_PROMPT_MAX_CHARS)}\n…（system prompt 超长已截断）`;
  }
  return joined;
}
