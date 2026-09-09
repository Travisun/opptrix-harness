/**
 * Skills/shared — Skills 页面包内部共享的 REST 类型视图与来源徽标。
 *
 * 与内核真值逐字段对齐（src/api/skills.ts、src/kernel/skills/types.ts）：
 * - GET  /api/v1/skills        → SkillEntryView[]（不含正文）；
 * - GET  /api/v1/skills/:id    → SkillDetailView = 条目 + body（正文 ≤128KB）；
 * - POST /api/v1/skills/refresh → SkillsRefreshReportView = { total, bySource }。
 *
 * 注意：同 id 冲突的落败者（「重复(降级)」）在内核 registry 中不进 list（仅
 * logger.warn 记录），REST 列表恒为胜者视图，故来源只有三态可渲染。
 */
import { Badge } from '@/components/ui/badge';

/** Skill 来源视图（内核 SkillSource 的线形状：builtin > data > extension 优先级） */
export type SkillSourceView = 'builtin' | 'data' | 'extension';

/** GET /api/v1/skills 条目（内核 SkillEntry 只读投影；不含正文） */
export interface SkillEntryView {
  /** 全局唯一 id（= frontmatter name，缺省取目录 id） */
  id: string;
  /** 规范 name 字段（当前与 id 同值） */
  name: string;
  /** 一句话描述（必填；≤1024 字符） */
  description: string;
  /** 语义化版本（可选） */
  version?: string;
  /** 作者（可选） */
  author?: string;
  /** 标签（frontmatter 非法时为 []） */
  tags: string[];
  /** frontmatter enabled（缺省 true；false 仍出现在列表——注册表只记录事实） */
  enabled: boolean;
  /** 来源：内置（仓库 skills/）| 数据卷（<dataDir>/skills）| 扩展（贡献） */
  source: SkillSourceView;
  /** 磁盘条目 = 技能目录绝对路径；extension 条目 = 贡献方扩展 id */
  sourceRef: string;
  /** 正文字节数（UTF-8；不含 frontmatter） */
  bodyBytes: number;
  /** 附属文件清单（相对技能目录 posix 路径；v1 仅登记不执行） */
  files: string[];
}

/** GET /api/v1/skills/:id 响应 = 条目 + 正文 */
export type SkillDetailView = SkillEntryView & { body: string };

/** POST /api/v1/skills/refresh 响应（bySource 三键恒在） */
export interface SkillsRefreshReportView {
  /** 当前生效技能总数 */
  total: number;
  /** 按来源分布（与列表计数一致） */
  bySource: Record<SkillSourceView, number>;
}

/** 来源元数据：Select 选项文案 + 徽标配色 */
export const SKILL_SOURCE_META: Record<
  SkillSourceView,
  { label: string; badgeVariant: React.ComponentProps<typeof Badge>['variant'] }
> = {
  builtin: { label: '内置', badgeVariant: 'success' },
  data: { label: '数据卷', badgeVariant: 'secondary' },
  extension: { label: '扩展', badgeVariant: 'outline' },
};

/** 来源 Select 选项序列（「全部」哨兵值由调用方用 'all' 处理） */
export const SKILL_SOURCE_OPTIONS = ['builtin', 'data', 'extension'] as const;

/** 来源徽标（内置 | 数据卷 | 扩展） */
export function SourceBadge({ source }: { source: SkillSourceView }): React.ReactNode {
  const meta = SKILL_SOURCE_META[source];
  return <Badge variant={meta.badgeVariant}>{meta.label}</Badge>;
}
