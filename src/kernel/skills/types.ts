/**
 * skills/types — Skill 包格式类型与常量（兼容 Anthropic Agent Skills 规范）。
 *
 * 一个 Skill = 一个目录 `<root>/<skill-id>/SKILL.md`：
 * - YAML frontmatter：name（可选，缺省取目录 id；`^[a-z0-9-]{1,64}$`）、
 *   description（必填，≤1024 字符）、version/author/tags/enabled（可选）；
 * - 正文为提示词/指令 Markdown，≤128KB；
 * - 同目录可带附属文件（scripts/*.js、resources/*…）——v1 仅登记清单（`files`），
 *   不执行、不下发。
 *
 * 注册表是**纯读模型**：只聚合目录事实（含 frontmatter 里的 enabled 布尔），
 * 启停状态的管理属于使用方/扩展，注册表不做写操作。
 */
import type { Logger } from 'pino';

/** Skill 来源：builtin=repoRoot/skills，data=dataDir/skills，extension=扩展贡献 */
export type SkillSource = 'builtin' | 'data' | 'extension';

/** 磁盘根目录声明（extension 贡献不走磁盘根，经 registerContributed 注入） */
export interface SkillRoot {
  /** 技能库根目录（其一层子目录各含一个 SKILL.md） */
  root: string;
  /** 该根目录的来源标签 */
  source: Exclude<SkillSource, 'extension'>;
}

/** Skill 条目（目录事实的只读投影；不含正文——正文经 registry.get 惰性读取） */
export interface SkillEntry {
  /** 全局唯一 id（= frontmatter name，缺省取目录 id） */
  id: string;
  /** 规范 name 字段（当前与 id 同值，独立保留以对齐 Anthropic 字段名） */
  name: string;
  /** 一句话描述（必填；≤1024 字符） */
  description: string;
  /** 语义化版本（可选） */
  version?: string;
  /** 作者（可选） */
  author?: string;
  /** 标签（可选；frontmatter 非法时为 []） */
  tags: string[];
  /** frontmatter enabled（缺省 true；false 仍会在 list 中出现——注册表只记录事实） */
  enabled: boolean;
  /** 来源：builtin > data > extension */
  source: SkillSource;
  /**
   * 来源引用：磁盘条目 = 技能目录绝对路径（get 读 `<sourceRef>/SKILL.md`）；
   * extension 条目 = 贡献方扩展 id。
   */
  sourceRef: string;
  /** 正文字节数（UTF-8；不含 frontmatter） */
  bodyBytes: number;
  /** 附属文件清单（相对技能目录的 posix 路径，如 scripts/run.js；v1 仅登记不执行） */
  files: string[];
}

/** registry.get 的返回：条目 + 正文（正文 ≤128KB） */
export interface SkillWithBody {
  entry: SkillEntry;
  body: string;
}

/** 扩展经 skills.register 贡献的单个技能输入（正文随行内携带，落内存不落盘） */
export interface ContributedSkillInput {
  id: string;
  name: string;
  description: string;
  body: string;
}

/** SkillRegistry 的结构化形状（桥与 REST 只依赖此子集，便于最小桩测试） */
export interface SkillRegistryLike {
  /** 重新扫描全部根目录并重放扩展贡献 → 当前生效条目（id 升序） */
  refresh(): Promise<SkillEntry[]>;
  /** 按条件过滤当前条目（id 升序；全部条件可选、可组合） */
  list(filter?: { source?: SkillSource; tag?: string; q?: string }): SkillEntry[];
  /** 读取条目 + 正文（磁盘惰性读 / extension 内存取）；不存在或正文不可读 → null */
  get(id: string): Promise<SkillWithBody | null>;
  /** 登记某扩展的贡献（整组替换该 extId 既有贡献）→ 实际生效条数 */
  registerContributed(extId: string, skills: ContributedSkillInput[]): number;
  /** 摘除某扩展的贡献（未登记过则幂等静默） */
  removeContributed(extId: string): void;
}

/** SkillRegistry 构造依赖 */
export interface SkillRegistryDeps {
  /** 磁盘技能根目录（按数组顺序聚合，冲突时 builtin > data 优先） */
  roots: SkillRoot[];
  /** 内核 logger（扫描失败/冲突跳过走 warn，不抛出） */
  logger: Logger;
}

// ---------------------------------------------------------------- 规范常量

/** skill id / frontmatter name 的合法形态（Anthropic Agent Skills 规范） */
export const SKILL_NAME_PATTERN = /^[a-z0-9-]{1,64}$/;

/** 正文（frontmatter 之后的 Markdown）字节数上限：128KB */
export const SKILL_BODY_MAX_BYTES = 128 * 1024;

/** description 字符数上限（Anthropic 规范 ≤1024） */
export const SKILL_DESCRIPTION_MAX_CHARS = 1024;

/** SKILL.md 文件名（固定，兼容 Anthropic 规范） */
export const SKILL_FILE_NAME = 'SKILL.md';

/** 附属文件清单上限（防御病态目录如误放 node_modules；超出部分不登记） */
export const SKILL_FILES_LIMIT = 1000;
