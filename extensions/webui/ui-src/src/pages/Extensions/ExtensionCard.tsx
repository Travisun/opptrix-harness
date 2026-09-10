import { useState } from 'react';
import {
  LockIcon,
  PackageXIcon,
  PuzzleIcon,
  RotateCwIcon,
  ShieldCheckIcon,
  TriangleAlertIcon,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { CodeBlock } from '@/pages/_shared';
import type { ExtSummary } from '@/pages/_shared';
import { hostBadgeLabel } from '@/pages/Extensions/shared';
import { PermissionBadges, TrustStatusBadge } from '@/pages/Extensions/TrustDialog';
import { isBuiltinLockedExt, trustStatus } from '@/pages/Extensions/trust';

/**
 * ExtensionCard — 单个扩展卡片（移动端适配版）。
 *
 * - <md：单列卡片流（父级 grid grid-cols-1），行内元数据换行、操作按钮 wrap、
 *   长 id / 目录路径 break-all 断行，Badge 可收缩换行，不再出现超宽横滚；
 * - ≥md：保持双列网格布局不变。
 * - 徽标文案：内置池「内置」/ 本地扩展统一「本地扩展」（hostBadgeLabel 单一来源）。
 * - 安全面板：信任状态 badge（内置 / 已授信 / 未授信，trustStatus 单一来源）+
 *   「安全详情」行展开（manifest.permissions 逐项 + 中文说明映射）；
 * - 内置锁定（auth/webui/doc-extract，BUILTIN_LOCKED_EXTS）：锁定图标 + tooltip
 *   「系统内置，不可禁用或卸载」，Switch 与卸载按钮禁用（与内核 core-builtin 保护一致）。
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
  const [showSecurity, setShowSecurity] = useState(false);
  const name = ext.manifest?.displayName ?? ext.id;
  const isBuiltin = ext.host === 'builtin';
  const locked = isBuiltin || isBuiltinLockedExt(ext.id);
  const status = trustStatus(ext);

  return (
    <Card className="min-w-0 gap-3 py-4">
      <CardContent className="flex min-w-0 flex-col gap-3 px-4">
        {/* 标题行：名称 + host/信任徽标 + 内置锁 + 启停 Switch（<md 徽标换行、Switch 不被挤出） */}
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
              {/* 信任状态徽标：内置=受信第一方 / 已授信=第三方 trusted_at 已落库 / 未授信=待人工授信 */}
              <TrustStatusBadge status={status} />
              {/* 内置锁定：系统内置扩展不可禁用或卸载（内核 core-builtin 保护的 UI 侧呈现） */}
              {locked && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="inline-flex cursor-default" aria-label="系统内置，不可禁用或卸载">
                      <LockIcon className="text-muted-foreground size-3.5" aria-hidden />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="top">系统内置，不可禁用或卸载</TooltipContent>
                </Tooltip>
              )}
            </div>
            {/* 长 id / 目录路径：break-all 断行（移动端不再超宽截断到不可读） */}
            <p className="text-muted-foreground min-w-0 text-xs break-all">
              {ext.id}
              {ext.dir !== undefined && ` · ${ext.dir}`}
            </p>
          </div>
          <Switch
            checked={ext.enabled}
            disabled={busyAction !== undefined || locked}
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

        {/* 安全面板（行展开）：信任状态 + manifest 声明权限逐项（中文说明映射） */}
        <div className="flex flex-col gap-1.5">
          <button
            type="button"
            onClick={() => setShowSecurity((prev) => !prev)}
            className="text-muted-foreground flex items-center gap-1.5 text-left text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ShieldCheckIcon className="size-3.5 shrink-0" aria-hidden />
            安全详情
            <span className="underline">{showSecurity ? '收起' : '展开'}</span>
          </button>
          {showSecurity && (
            <div className="bg-muted/30 flex flex-col gap-2 rounded-md border p-2.5">
              <div className="flex items-center gap-2 text-xs">
                <span className="text-muted-foreground">信任状态</span>
                <TrustStatusBadge status={status} />
              </div>
              <div className="flex flex-col gap-1.5">
                <span className="text-muted-foreground text-xs">声明权限</span>
                <PermissionBadges permissions={ext.manifest?.permissions ?? []} />
              </div>
            </div>
          )}
        </div>

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

        {/* 操作行（窄屏 wrap 换行；内置锁定时卸载禁用） */}
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
            disabled={busyAction !== undefined || locked}
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
