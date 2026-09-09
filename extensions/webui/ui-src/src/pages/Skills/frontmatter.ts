/**
 * Skills/frontmatter — SKILL.md 文件头（YAML frontmatter）识别纯函数。
 *
 * 「粘贴 SKILL.md」导入模式的解析核心：把一份完整 SKILL.md（或纯 Markdown）
 * 拆成 frontmatter 字段 + 正文，供创建/编辑弹窗回填表单。刻意保持**纯函数、
 * 零依赖**（不引 YAML 库、不依赖 DOM/BOM API），便于仓库根 vitest 直接导入测试。
 *
 * 识别规则（与内核 src/kernel/skills/loader.ts 的 gray-matter 解析对齐的最小子集）：
 * - 首行（允许 BOM 前缀）为 `---` 且存在闭合行（`---` 或 `...`）→ 视为带文件头；
 *   两分隔符之间的行为 frontmatter 块，其后为正文；
 * - 未闭合 / 首行不是 `---` → 整体视为正文（hasFrontmatter=false），不抛错；
 * - frontmatter 块按行解析 `key: value`：已知键 name/description/version/author/
 *   tags/enabled，其余键收进 unknownKeys（UI 提示「该字段不会被保存」）；
 * - 标量值剥离成对的单/双引号；enabled 仅识别 true/false 布尔；
 * - tags 支持行内 `[a, b]` / `a, b` 与 YAML 块序列（`tags:` 换行 `- a`）两种形态；
 * - 正文 = 闭合行之后的内容：剥去紧跟的一个换行、去尾部空白（gray-matter 语义近似）。
 *
 * 已知限制（刻意不做完整 YAML）：不支持锚点/多行折叠标量/行内注释剔除——SKILL.md
 * 的 frontmatter 按规范就是扁平键值对，超出子集的写法按普通文本回落到正文。
 */

/** 识别出的 frontmatter 已知字段（未识别到的键缺省不存在；tags 恒为数组） */
export interface SkillFrontmatterFields {
  /** 技能 id（注册名；合法形态 ^[a-z0-9-]{1,64}$ 由表单校验） */
  name?: string;
  /** 一句话描述 */
  description?: string;
  /** 语义化版本（注意：POST /api/v1/skills 不接收，保存由 writer 固定 1.0.0） */
  version?: string;
  /** 作者 */
  author?: string;
  /** 标签（识别失败恒 []） */
  tags: string[];
  /** 停用事实（仅显式 false；POST 不接收，保存后该标记丢失） */
  enabled?: boolean;
}

/** parseSkillFile 结果 */
export interface ParsedSkillFile {
  /** 是否识别到 frontmatter 文件头 */
  hasFrontmatter: boolean;
  /** 已知字段（hasFrontmatter=false 时仅 tags: []） */
  fields: SkillFrontmatterFields;
  /** frontmatter 中不可保存的未知键（UI 提示用；去重保序） */
  unknownKeys: string[];
  /** 正文（无文件头时为原文；带文件头时为闭合行之后的内容） */
  body: string;
}

/** 已知 frontmatter 键（与内核 loader/frontmatter 事实形状一致） */
const KNOWN_KEYS = new Set(['name', 'description', 'version', 'author', 'tags', 'enabled']);

/**
 * 把一份 SKILL.md 原文拆解为 frontmatter 字段 + 正文（纯函数，不抛错）。
 */
export function parseSkillFile(raw: string): ParsedSkillFile {
  const text = raw.replace(/^\uFEFF/, ''); // 剪贴板粘贴常带 BOM
  const lines = text.split(/\r?\n/);

  const first = lines[0]?.trim() ?? '';
  if (first !== '---') {
    return { hasFrontmatter: false, fields: { tags: [] }, unknownKeys: [], body: text };
  }

  // 闭合行（`---` 或 `...`）行号；未闭合 → 整体按正文回落
  let close = -1;
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i]?.trim() ?? '';
    if (line === '---' || line === '...') {
      close = i;
      break;
    }
  }
  if (close === -1) {
    return { hasFrontmatter: false, fields: { tags: [] }, unknownKeys: [], body: text };
  }

  const fields: SkillFrontmatterFields = { tags: [] };
  const unknownKeys: string[] = [];
  let pendingTags = false; // 上一行是 `tags:`（空值），后续 `- item` 块序列归属它

  for (let i = 1; i < close; i += 1) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue; // 空行 / 整行注释
    if (pendingTags) {
      const item = /^-\s+(.+)$/.exec(trimmed);
      if (item !== null) {
        const value = stripQuotes(item[1] ?? '');
        if (value !== '') fields.tags.push(value);
        continue;
      }
      pendingTags = false;
    }

    const match = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(trimmed);
    if (match === null) continue; // 非 key: value 行（子集外写法）→ 忽略
    const key = match[1] ?? '';
    const rest = (match[2] ?? '').trim();

    if (key === 'tags') {
      const inline = /^\[(.*)\]$/.exec(rest);
      if (inline !== null) {
        // 行内数组 [a, b]（项可带引号，逗号分隔）
        for (const piece of inline[1]?.split(',') ?? []) {
          const value = stripQuotes(piece.trim());
          if (value !== '') fields.tags.push(value);
        }
      } else if (rest === '') {
        pendingTags = true; // 块序列在后续行
      } else {
        // 宽松形态 `tags: a, b`
        for (const piece of rest.split(',')) {
          const value = stripQuotes(piece.trim());
          if (value !== '') fields.tags.push(value);
        }
      }
      continue;
    }

    if (!KNOWN_KEYS.has(key)) {
      if (!unknownKeys.includes(key)) unknownKeys.push(key);
      continue;
    }
    if (key === 'enabled') {
      if (rest === 'true') fields.enabled = true;
      else if (rest === 'false') fields.enabled = false;
      continue;
    }
    if (rest !== '') {
      const value = stripQuotes(rest);
      if (key === 'name') fields.name = value;
      else if (key === 'description') fields.description = value;
      else if (key === 'version') fields.version = value;
      else if (key === 'author') fields.author = value;
    }
  }

  // 正文：闭合行之后，剥一个紧跟换行 + 去尾部空白（近似 gray-matter content 语义）
  const body = lines
    .slice(close + 1)
    .join('\n')
    .replace(/^\r?\n/, '')
    .replace(/\s+$/, '');

  return { hasFrontmatter: true, fields, unknownKeys, body };
}

/**
 * 展示名 → 合法技能 id（slug）：小写化、变音符号剥离、非 `[a-z0-9]` 连字符化、
 * 压缩并去首尾连字符、截断 64 位。中文等无法转写的字符被剔除——产出空串时由
 * 调用方保留手填的 id（表单校验兜底）。
 */
export function slugifyId(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/^-+|-+$/g, '');
}

/** 剥离成对的单/双引号（不成对则原样返回） */
function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const head = value[0] ?? '';
    const tail = value[value.length - 1] ?? '';
    if ((head === '"' && tail === '"') || (head === "'" && tail === "'")) {
      return value.slice(1, -1).trim();
    }
  }
  return value;
}
