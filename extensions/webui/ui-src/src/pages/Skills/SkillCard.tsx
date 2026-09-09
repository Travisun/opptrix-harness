/**
 * Skills/SkillCard — 技能卡片：名称 / 描述 / version / author / tags chips /
 * 来源徽标 / 正文大小 / 附属文件数；整卡可点（键盘 Enter/Space 等效）打开详情。
 * 行操作「删除」仅在调用方传入 onDelete 时渲染（数据卷来源 + admin；builtin/
 * extension 来源隐藏），点击不触发整卡的 onOpen。
 */
import { FileCodeIcon, Trash2Icon } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { formatBytes } from '@/pages/_shared';
import { SourceBadge, type SkillEntryView } from './shared';

export function SkillCard({
  skill,
  onOpen,
  onDelete,
}: {
  skill: SkillEntryView;
  onOpen: () => void;
  /** 传入才渲染行操作「删除」（数据卷来源 + admin 由调用方判定） */
  onDelete?: () => void;
}): React.ReactNode {
  return (
    <Card
      role="button"
      tabIndex={0}
      aria-label={`查看技能 ${skill.name}`}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      className="focus-visible:ring-ring/50 gap-3 py-4 transition-colors duration-150 hover:border-ring/60 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:outline-none"
    >
      <CardContent className="flex flex-col gap-2.5 px-4">
        {/* 标题行：name + 来源徽标 + version + enabled 事实 */}
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-semibold" title={skill.name}>
              {skill.name}
            </span>
            <SourceBadge source={skill.source} />
            {skill.version !== undefined && (
              <Badge variant="outline" className="font-mono text-[11px]">
                v{skill.version}
              </Badge>
            )}
            {!skill.enabled && <Badge variant="warning">已停用</Badge>}
            {onDelete !== undefined && (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`删除技能 ${skill.name}`}
                title="删除该技能（数据卷目录）"
                className="text-muted-foreground hover:text-destructive ml-auto"
                onClick={(e) => {
                  e.stopPropagation(); // 不触发整卡 onOpen
                  onDelete();
                }}
                onKeyDown={(e) => {
                  // 键盘等效点击时不冒泡给整卡（避免同时打开详情）
                  if (e.key === 'Enter' || e.key === ' ') e.stopPropagation();
                }}
              >
                <Trash2Icon aria-hidden />
              </Button>
            )}
          </div>
          <p className="text-muted-foreground truncate font-mono text-xs" title={skill.id}>
            {skill.id}
          </p>
        </div>

        {/* 描述（两行截断，悬停看全文） */}
        <p className="text-muted-foreground line-clamp-2 min-h-10 text-sm leading-relaxed" title={skill.description}>
          {skill.description}
        </p>

        {/* 标签 chips */}
        {skill.tags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {skill.tags.map((t) => (
              <Badge key={t} variant="secondary" className="text-[11px]">
                {t}
              </Badge>
            ))}
          </div>
        )}

        {/* 事实行：作者 / 正文大小 / 附属文件数 */}
        <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 border-t pt-3 text-xs">
          {skill.author !== undefined && <span title={`作者 ${skill.author}`}>作者 {skill.author}</span>}
          <span className="tabular-nums">正文 {formatBytes(skill.bodyBytes)}</span>
          {skill.files.length > 0 && (
            <span className="inline-flex items-center gap-1">
              <FileCodeIcon className="size-3" aria-hidden />
              {skill.files.length} 个附属文件
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
