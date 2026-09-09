import { useState } from 'react';
import { PackageXIcon, PuzzleIcon, RotateCwIcon, ShieldCheckIcon, TriangleAlertIcon } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { CodeBlock } from '@/pages/_shared';
import type { ExtSummary } from '@/pages/_shared';
import { hostBadgeLabel } from '@/pages/Extensions/shared';

/**
 * ExtensionCard — 单个扩展卡片（移动端适配版）。
 *
 * - <md：单列卡片流（父级 grid grid-cols-1），行内元数据换行、操作按钮 wrap、
 *   长 id / 目录路径 break-all 断行，Badge 可收缩换行，不再出现超宽横滚；
 * - ≥md：保持双列网格布局不变。
 * - 徽标文案：内置池「内置」/ 本地扩展统一「本地扩展」（hostBadgeLabel 单一来源）。
 */
export function ExtensionCard({
  ext,
  busyAction,
  onToggle,
  onReload,
  onUninstall,
}: {
  ext: ExtSummary;
  busyAction: 'enable' | 'disable' | 'reload' | 'uninstall' | undefined;
  onToggle: (enabled: boolean) => void;
  onReload: () => void;
  onUninstall: () => void;
}): React.ReactNode {
  const [showError, setShowError] = useState(false);
  const name = ext.manifest?.displayName ?? ext.id;
  const isBuiltin = ext.host === 'builtin';

  return (
    <Card className="min-w-0 gap-3 py-4">
      <CardContent className="flex min-w-0 flex-col gap-3 px-4">
        {/* 标题行：名称 + host/信任徽标 + 启停 Switch（<md 徽标换行、Switch 不被挤出） */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1.5">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <PuzzleIcon className="text-muted-foreground size-4 shrink-0" aria-hidden />
              <span className="min-w-0 max-w-full truncate text-sm font-semibold" title={name}>
                {name}
              </span>
              <Badge variant="outline" className="font-mono text-[11px]">
                v{ext.version || '?'}
              </Badge>
              <Badge variant={isBuiltin ? 'success' : 'secondary'}>{hostBadgeLabel(ext.host)}</Badge>
              {/* 信任徽标：内置池目录受信；本地扩展需首次启用时人工授信（trusted_at 由内核落库） */}
              <Badge variant={isBuiltin ? 'outline' : 'warning'} className="gap-1">
                <ShieldCheckIcon className="size-3" aria-hidden />
                {isBuiltin ? '受信' : '待授信'}
              </Badge>
            </div>
            {/* 长 id / 目录路径：break-all 断行（移动端不再超宽截断到不可读） */}
            <p className="text-muted-foreground min-w-0 text-xs break-all">
              {ext.id}
              {ext.dir !== undefined && ` · ${ext.dir}`}
            </p>
          </div>
          <Switch
            checked={ext.enabled}
            disabled={busyAction !== undefined}
            onCheckedChange={onToggle}
            aria-label={ext.enabled ? `停用 ${name}` : `启用 ${name}`}
          />
        </div>

        {/* 贡献点计数（窄屏自动换行收缩） */}
        {ext.contributions !== undefined && (
          <div className="flex flex-wrap gap-1.5">
            <Badge variant="secondary">路由 {ext.contributions.routes}</Badge>
            <Badge variant="secondary">定时 {ext.contributions.crons}</Badge>
            <Badge variant="secondary">事件 {ext.contributions.events}</Badge>
            <Badge variant="secondary">钩子 {ext.contributions.hooks}</Badge>
            <Badge variant="secondary">服务 {ext.contributions.services}</Badge>
          </div>
        )}

        {/* lastError 折叠 */}
        {ext.lastError !== null && ext.lastError !== '' && (
          <div className="flex min-w-0 flex-col gap-1.5">
            <button
              type="button"
              onClick={() => setShowError((prev) => !prev)}
              className="text-destructive flex items-center gap-1.5 text-left text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <TriangleAlertIcon className="size-3.5 shrink-0" aria-hidden />
              最近一次错误
              <span className="text-muted-foreground underline">{showError ? '收起' : '展开'}</span>
            </button>
            {showError && <CodeBlock text={ext.lastError} />}
          </div>
        )}

        {/* 操作行（窄屏 wrap 换行） */}
        <div className="flex flex-wrap items-center gap-2 border-t pt-3">
          <Button variant="outline" size="sm" onClick={onReload} disabled={busyAction !== undefined}>
            <RotateCwIcon className={cn(busyAction === 'reload' && 'animate-spin')} aria-hidden />
            {busyAction === 'reload' ? '重载中…' : '重载'}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={onUninstall}
            disabled={busyAction !== undefined}
          >
            <PackageXIcon aria-hidden />
            {busyAction === 'uninstall' ? '卸载中…' : '卸载'}
          </Button>
          {busyAction === 'enable' && <span className="text-muted-foreground text-xs">启用中…</span>}
          {busyAction === 'disable' && <span className="text-muted-foreground text-xs">停用中…</span>}
          {ext.crashCount > 0 && (
            <Badge variant="warning" className="ml-auto">
              近期崩溃 {ext.crashCount}
            </Badge>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
