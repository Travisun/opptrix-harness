import { PackagePlusIcon, ShieldCheckIcon, TriangleAlertIcon } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { PermissionChips } from '@/pages/Extensions/shared';
import type { ExtensionInstallResponse } from '@/pages/Extensions/shared';

/**
 * InstallConfirmDialog — 扩展包安装的二次确认弹窗。
 *
 * 展示 POST /api/v1/extensions/install 返回的 manifest 摘要（id / version / 权限 chips /
 * api 版本 / 覆盖标记），并给出信任提示：该扩展为第三方，启用时需信任确认 +
 * 可绑定 2FA 保护的管理员账户。确认后由父级自动 rescan 并刷新列表
 * （新扩展 enabled=false，启用走既有信任确认流）。
 */
export function InstallConfirmDialog({
  result,
  confirming,
  onOpenChange,
  onConfirm,
}: {
  /** 非空 = 弹窗打开（携带安装返回的 manifest 摘要） */
  result: ExtensionInstallResponse | null;
  /** 父级正在执行 rescan + 刷新 */
  confirming: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}): React.ReactNode {
  return (
    <Dialog open={result !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PackagePlusIcon className="size-5" aria-hidden />
            扩展包已安装，确认信任该来源？
          </DialogTitle>
          <DialogDescription>
            以下为包内 manifest 摘要，请核对无误后确认。确认后将自动重扫扩展目录并刷新列表；
            新扩展默认停用。
          </DialogDescription>
        </DialogHeader>

        {result !== null && (
          <div className="flex flex-col gap-3 text-sm">
            {/* manifest 摘要 */}
            <div className="flex min-w-0 flex-col gap-1.5 rounded-md border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 max-w-full truncate text-sm font-semibold" title={result.manifest.displayName ?? result.manifest.id}>
                  {result.manifest.displayName ?? result.manifest.id}
                </span>
                <Badge variant="outline" className="font-mono text-[11px]">
                  v{result.manifest.version}
                </Badge>
                <Badge variant="outline" className="font-mono text-[11px]">
                  api {result.manifest.api}
                </Badge>
                {result.overwrite && <Badge variant="warning">覆盖安装</Badge>}
              </div>
              <p className="text-muted-foreground text-xs break-all">{result.manifest.id}</p>
              <p className="text-muted-foreground text-xs break-all">{result.dir}</p>
            </div>

            {/* 声明权限 chips */}
            <div className="flex flex-col gap-1.5">
              <span className="text-muted-foreground text-xs">该扩展声明的权限</span>
              <PermissionChips permissions={result.manifest.permissions} />
            </div>

            {/* 信任提示 */}
            <p className="text-destructive flex items-start gap-1.5 text-xs leading-relaxed">
              <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              该扩展为第三方，启用时需信任确认 + 可绑定 2FA 保护的管理员账户。请仅安装与启用来源可靠的扩展包。
            </p>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={confirming}>
            稍后再说
          </Button>
          <Button onClick={onConfirm} disabled={confirming}>
            <ShieldCheckIcon className={cn(confirming && 'animate-pulse')} aria-hidden />
            {confirming ? '扫描中…' : '确认并扫描刷新'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
