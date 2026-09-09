import { useCallback, useEffect, useState } from 'react';
import { PackageXIcon, TriangleAlertIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { errText } from '@/pages/_shared';
import { isContributionGateError } from '@/pages/Plugins/shared';
import type { InstalledPlugin } from '@/pages/Plugins/shared';

/**
 * UninstallDialog — 卸载确认弹窗（含 force 开关）。
 *
 * - DELETE /api/v1/plugins/:id           无贡献在用时直接删除安装目录；
 * - DELETE /api/v1/plugins/:id?force=1   贡献仍在用时必须强制（先摘 skills/MCP 贡献再删目录）；
 *   未带 force 命中贡献闸 → 403 HARNESS-1007，此处给出「开启强制卸载」的引导提示。
 */
export function UninstallDialog({
  target,
  onClose,
  onUninstalled,
}: {
  /** 卸载目标（null = 关闭） */
  target: InstalledPlugin | null;
  onClose: () => void;
  /** 卸载成功后的回调：父级刷新列表 */
  onUninstalled: () => void;
}): React.ReactNode {
  const [force, setForce] = useState(false);
  const [busy, setBusy] = useState(false);
  const [gateHint, setGateHint] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** 打开/切换目标时重置 */
  useEffect(() => {
    if (target !== null) {
      setForce(false);
      setGateHint(false);
      setError(null);
      setBusy(false);
    }
  }, [target]);

  const uninstall = useCallback(async (): Promise<void> => {
    if (target === null || busy) return;
    setBusy(true);
    setGateHint(false);
    setError(null);
    try {
      await api.delete(`/api/v1/plugins/${encodeURIComponent(target.id)}${force ? '?force=1' : ''}`);
      toast.success('插件已卸载', `${target.name}（${target.id}）的贡献与文件已移除`);
      onUninstalled();
    } catch (e) {
      if (isContributionGateError(e)) {
        // 贡献闸：技能/MCP 贡献仍在用，需显式 force（api 层已 toast 原始错误）
        setGateHint(true);
      } else {
        setError(errText(e));
      }
    } finally {
      setBusy(false);
    }
  }, [target, busy, force, onUninstalled]);

  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PackageXIcon className="text-destructive size-5" aria-hidden />
            卸载插件
          </DialogTitle>
          <DialogDescription>
            确定要卸载「{target?.name ?? ''}」（{target?.id ?? ''}）吗？该操作将移除插件贡献的技能与
            MCP 服务器，并删除安装目录下的全部文件（plugin.json / skills/ / scripts/ 等），不可恢复。
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <label className="hover:bg-accent/50 flex cursor-pointer items-center gap-3 rounded-md border p-3">
            <Switch checked={force} onCheckedChange={setForce} aria-label="强制卸载" disabled={busy} />
            <span className="flex flex-col">
              <span className="text-sm font-medium">强制卸载（force）</span>
              <span className="text-muted-foreground text-xs">
                插件的技能 / MCP 贡献仍在使用时，内核默认拒绝卸载；开启后将先摘除贡献再删除（?force=1）。
              </span>
            </span>
          </label>

          {gateHint && (
            <p className="text-destructive flex items-start gap-1.5 text-xs leading-relaxed">
              <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              该插件的技能 / MCP 贡献仍在使用中（403 HARNESS-1007）——请开启「强制卸载」后重试。
            </p>
          )}
          {error !== null && (
            <p className="text-destructive flex items-start gap-1.5 text-xs leading-relaxed">
              <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="destructive" onClick={() => void uninstall()} disabled={busy}>
            {busy ? '卸载中…' : '确认卸载'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
