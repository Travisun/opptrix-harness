/**
 * Skills/SkillCard — 技能卡片：名称 / 描述 / version / author / tags chips /
 * 来源徽标 / 正文大小 / 附属文件数；整卡可点（键盘 Enter/Space 等效）打开详情。
 */
import { FileCodeIcon } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { formatBytes } from '@/pages/_shared';
import { SourceBadge, type SkillEntryView } from './shared';

export function SkillCard({ skill, onOpen }: { skill: SkillEntryView; onOpen: () => void }): React.ReactNode {
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
