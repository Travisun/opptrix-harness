import { CalendarClockIcon, EyeIcon, PackageXIcon, PuzzleIcon } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ContributionChips, formatInstalledAt } from '@/pages/Plugins/shared';
import type { InstalledPlugin } from '@/pages/Plugins/shared';

/**
 * PluginCard — 单个已安装插件卡片。
 *
 * 展示 name / version / id / 描述 / 贡献计数 chips（Skills · Prompts · MCP · Scripts）/
 * 安装时间；操作：详情 Drawer、卸载 Dialog。
 * 注：内核 REST（GET /api/v1/plugins、GET /:id）不回显作者字段（plugin.json 的 author
 * 不进 InstalledPlugin 摘要），故卡片不含作者行。
 */
export function PluginCard({
  plugin,
  onDetail,
  onUninstall,
}: {
  plugin: InstalledPlugin;
  onDetail: () => void;
  onUninstall: () => void;
}): React.ReactNode {
  return (
    <Card className="gap-3 py-4">
      <CardContent className="flex flex-col gap-3 px-4">
        {/* 标题行：名称 + 版本徽标 */}
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <PuzzleIcon className="text-muted-foreground size-4 shrink-0" aria-hidden />
            <span className="truncate text-sm font-semibold" title={plugin.name}>
              {plugin.name}
            </span>
            <Badge variant="outline" className="font-mono text-[11px]">
              v{plugin.version}
            </Badge>
          </div>
          <p className="text-muted-foreground truncate font-mono text-xs" title={plugin.id}>
            {plugin.id}
          </p>
        </div>

        {/* 描述（清单可省略，空值兜底） */}
        <p className="text-muted-foreground text-sm leading-relaxed">
          {plugin.description !== '' ? plugin.description : '（无描述）'}
        </p>

        {/* 贡献计数 chips */}
        <ContributionChips plugin={plugin} />

        {/* 安装时间 + 操作行（卸载忙态在确认弹窗内呈现） */}
        <div className="flex flex-wrap items-center gap-2 border-t pt-3">
          <span className="text-muted-foreground flex items-center gap-1.5 text-xs tabular-nums" title={plugin.installedAt}>
            <CalendarClockIcon className="size-3.5" aria-hidden />
            安装于 {formatInstalledAt(plugin.installedAt)}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={onDetail}>
              <EyeIcon aria-hidden />
              详情
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={onUninstall}
            >
              <PackageXIcon aria-hidden />
              卸载
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
