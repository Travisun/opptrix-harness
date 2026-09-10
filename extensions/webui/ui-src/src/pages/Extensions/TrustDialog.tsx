import { ShieldAlertIcon, TriangleAlertIcon } from 'lucide-react';

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
import { permissionLabel, trustStatusLabel } from '@/pages/Extensions/trust';
import type { ExtTrustStatus } from '@/pages/Extensions/trust';

/**
 * TrustDialog — 社区/第三方扩展授信（trust）确认弹窗。
 *
 * 触发点（Extensions.tsx）：
 * - 启用未授信扩展被信任闸拒绝（403 HARNESS-3012 / EXT_TRUST_REQUIRED）→ 弹出本弹窗，
 *   确认后由父级携带 {confirmTrust:true} 重试 POST /api/v1/extensions/:id/enable；
 * - 安装社区扩展的信任披露在 InstallConfirmDialog（安装契约 enabled=false、无 confirmTrust
 *   入参，授信动作发生在首次启用）。
 *
 * 安全披露：扩展名 / 来源 / 版本 + manifest 声明权限 badges（中文说明映射）+ 风险警示，
 * 主按钮为 danger 变体「我已了解风险，信任并继续」。
 */

/** TrustDialog 的目标扩展摘要（父级从 ExtSummary + 信任闸错误 detail 组装） */
export interface TrustDialogTarget {
  extId: string;
  displayName?: string;
  version?: string;
  /** 来源池（builtin 恒免授信，实际只会传入 community） */
  host: 'builtin' | 'community';
  /** 来源描述（安装落位目录 / 扩展池说明） */
  source: string;
  /** manifest 声明的权限（信任闸错误 detail.permissions，空数组则显示占位） */
  permissions: string[];
}

/** 权限 badges：原始权限（mono）+ 中文说明映射（permissionLabel），可换行收缩 */
export function PermissionBadges({ permissions }: { permissions: string[] }): React.ReactNode {
  if (permissions.length === 0) {
    return <span className="text-muted-foreground text-xs">（未声明权限）</span>;
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {permissions.map((p) => (
        <Badge key={p} variant="outline" className="max-w-full gap-1.5 py-0.5 font-mono text-[11px] break-all whitespace-normal">
          {p}
          <span className="text-muted-foreground font-sans font-normal">{permissionLabel(p)}</span>
        </Badge>
      ))}
    </div>
  );
}

/** 信任状态 badge（安全面板 / 卡片共用：内置=success、已授信=success、未授信=warning） */
export function TrustStatusBadge({ status }: { status: ExtTrustStatus }): React.ReactNode {
  const variant = status === 'untrusted' ? 'warning' : 'success';
  return <Badge variant={variant}>{trustStatusLabel(status)}</Badge>;
}

export function TrustDialog({
  target,
  busy = false,
  onOpenChange,
  onConfirm,
}: {
  /** 非空 = 弹窗打开（待授信扩展摘要） */
  target: TrustDialogTarget | null;
  /** 父级正在执行授信重试（enable {confirmTrust:true}） */
  busy?: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}): React.ReactNode {
  const name = target?.displayName ?? target?.extId ?? '';
  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlertIcon className="size-5 text-amber-500" aria-hidden />
            信任此扩展？
          </DialogTitle>
          <DialogDescription>
            「{name}」来自不受信来源（{target?.host === 'builtin' ? '内置池' : '本地扩展池'}），首次启用需要人工授信。
          </DialogDescription>
        </DialogHeader>

        {target !== null && (
          <div className="flex flex-col gap-3 text-sm">
            {/* 扩展名 + 来源 + 版本 */}
            <div className="flex min-w-0 flex-col gap-1.5 rounded-md border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 max-w-full truncate text-sm font-semibold" title={name}>
                  {name}
                </span>
                {target.version !== undefined && (
                  <Badge variant="outline" className="font-mono text-[11px]">
                    v{target.version}
                  </Badge>
                )}
                <Badge variant="secondary">本地扩展</Badge>
              </div>
              <p className="text-muted-foreground text-xs break-all">{target.extId}</p>
              <p className="text-muted-foreground text-xs break-all" title={target.source}>
                来源：{target.source}
              </p>
            </div>

            {/* 权限披露：manifest 声明的权限 badges（中文说明映射） */}
            <div className="flex flex-col gap-1.5">
              <span className="text-muted-foreground text-xs">该扩展将在隔离环境中运行，但可申请以下权限：</span>
              <PermissionBadges permissions={target.permissions} />
            </div>

            {/* 风险警示 */}
            <p className="text-destructive flex items-start gap-1.5 text-xs leading-relaxed">
              <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              信任表示你确认该扩展来源可靠。授信记录将持久化（trusted_at），此后启用/重载不再询问；请仅授信你了解的扩展。
            </p>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            取消
          </Button>
          <Button variant="destructive" onClick={onConfirm} disabled={busy}>
            {busy ? '授信中…' : '我已了解风险，信任并继续'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
