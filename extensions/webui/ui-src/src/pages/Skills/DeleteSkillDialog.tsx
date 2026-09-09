/**
 * Skills/DeleteSkillDialog — 删除技能确认弹窗（admin；仅数据卷来源技能可删）。
 *
 * - DELETE /api/v1/skills/:id（内核 admin 门禁；仅 data 源可删——builtin 源与扩展
 *   贡献一律 403，调用方已在列表侧按 `source === 'data'` 隐藏删除入口）；
 * - 删除成功后内核自动 refresh，回调 onDeleted（父级重载列表）。
 */
import { useCallback, useEffect, useState } from 'react';
import { Trash2Icon, TriangleAlertIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { toast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { errText } from '@/pages/_shared';
import type { SkillEntryView } from './shared';

export function DeleteSkillDialog({
  target,
  onClose,
  onDeleted,
}: {
  /** 删除目标（null = 关闭） */
  target: SkillEntryView | null;
  onClose: () => void;
  /** 删除成功后的回调：父级重载列表 */
  onDeleted: () => void;
}): React.ReactNode {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** 打开/切换目标时重置 */
  useEffect(() => {
    if (target !== null) {
      setBusy(false);
      setError(null);
    }
  }, [target]);

  const remove = useCallback(async (): Promise<void> => {
    if (target === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.delete(`/api/v1/skills/${encodeURIComponent(target.id)}`);
      toast.success('技能已删除', `${target.name}（${target.id}）的数据卷目录已移除`);
      onDeleted();
    } catch (e) {
      setError(errText(e)); // api 层已 toast 错误本身，这里补内联展示
    } finally {
      setBusy(false);
    }
  }, [target, busy, onDeleted]);

  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Trash2Icon className="text-destructive size-5" aria-hidden />
            删除技能
          </DialogTitle>
          <DialogDescription>
            确定要删除技能「{target?.name ?? ''}」（{target?.id ?? ''}）吗？将删除数据卷目录{' '}
            <code className="bg-muted rounded px-1 py-0.5 font-mono text-xs break-all">{target?.sourceRef ?? ''}</code>{' '}
            下的全部文件（SKILL.md 与附属文件），不可恢复。
          </DialogDescription>
        </DialogHeader>

        {error !== null && (
          <p className="text-destructive flex items-start gap-1.5 text-xs leading-relaxed">
            <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            {error}
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="destructive" onClick={() => void remove()} disabled={busy}>
            {busy ? '删除中…' : '确认删除'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
