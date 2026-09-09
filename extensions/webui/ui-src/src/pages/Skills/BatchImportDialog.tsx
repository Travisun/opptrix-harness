/**
 * Skills/BatchImportDialog — 拖拽批量创建的「待创建清单」确认 + 逐文件进度弹窗。
 *
 * 流程：Skills 页拖入文件 → batchImport.readDroppedFiles 读取/提取 →
 * dragdrop.buildSkillDrafts 产出草稿清单 → 本弹窗二次确认（每文件预览识别出的
 * name/id/description 与来源）→ 逐文件顺序 POST /api/v1/skills（行内
 * ✓ 成功 / ✗ 失败 / 处理中）→ 完成后汇总 toast + onCreated 重载列表。
 *
 * - 失败清单行（dragdrop 已标注 error）原样展示原因、不参与创建；
 * - 创建请求走 silent（单行失败在行内呈现，避免 N 连 toast；汇总一条）；
 * - 创建中禁止关闭弹窗（防重复提交）；全部行失败时确认按钮禁用。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CircleCheckIcon,
  CircleXIcon,
  FileBoxIcon,
  FileTextIcon,
  FileTypeIcon,
  FileUpIcon,
  LoaderCircleIcon,
  SparklesIcon,
  TriangleAlertIcon,
} from 'lucide-react';

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
import { cn } from '@/lib/utils';
import { errText } from '@/pages/_shared';
import type { SkillDraft } from '@/pages/Skills/dragdrop';

/** 正文 UTF-8 字节上限展示口径（与内核 128KB 一致） */
const BODY_LIMIT_BYTES = 128 * 1024;

/** 单行状态：待处理 | 创建中 | 成功 | 失败 */
type RowStatus = 'pending' | 'creating' | 'ok' | 'failed';

/** 来源类别 → 图标 */
function KindIcon({ kind, className }: { kind: SkillDraft['kind']; className?: string }): React.ReactNode {
  if (kind === 'markdown') return <FileTextIcon className={className} aria-hidden />;
  if (kind === 'text') return <FileTypeIcon className={className} aria-hidden />;
  return <FileBoxIcon className={className} aria-hidden />;
}

export function BatchImportDialog({
  open,
  drafts,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  /** 待创建清单（error 非空的行 = 失败清单，只展示不创建） */
  drafts: SkillDraft[];
  onOpenChange: (open: boolean) => void;
  /** 批量结束（无论成败）后的回调：父级重载列表 */
  onCreated: () => void;
}): React.ReactNode {
  /** confirm 确认清单 | running 逐文件创建 | done 完成（展示结果） */
  const [phase, setPhase] = useState<'confirm' | 'running' | 'done'>('confirm');
  const [statuses, setStatuses] = useState<RowStatus[]>([]);
  const [rowErrors, setRowErrors] = useState<string[]>([]);

  /** 打开/换一批草稿 → 重置为确认态 */
  useEffect(() => {
    if (open) {
      setPhase('confirm');
      setStatuses(drafts.map(() => 'pending'));
      setRowErrors(drafts.map((d) => d.error ?? ''));
    }
  }, [open, drafts]);

  const creatable = useMemo(() => drafts.map((d) => d.error === undefined || d.error === ''), [drafts]);
  const creatableCount = creatable.filter(Boolean).length;
  const failedInputCount = drafts.length - creatableCount;

  /** 汇总（done 态展示 + toast） */
  const summary = useMemo(() => {
    const ok = statuses.filter((s) => s === 'ok').length;
    const failed = statuses.filter((s) => s === 'failed').length;
    return { ok, failed };
  }, [statuses]);

  const handleClose = useCallback(
    (next: boolean): void => {
      if (phase === 'running') return; // 创建中禁止关闭
      onOpenChange(next);
    },
    [phase, onOpenChange],
  );

  /** 批量创建：逐文件顺序 POST（内核写后自动 refresh，整批结束再回调重载一次） */
  const runBatch = useCallback(async (): Promise<void> => {
    setPhase('running');
    let ok = 0;
    let failed = 0;
    for (let i = 0; i < drafts.length; i += 1) {
      if (!creatable[i]) continue; // 失败清单行：保持 failed 展示
      setStatuses((prev) => prev.map((s, j) => (j === i ? 'creating' : s)));
      const draft = drafts[i];
      try {
        const tagList = draft.tags.filter((t) => t.trim() !== '');
        const trimmedAuthor = draft.author?.trim() ?? '';
        await api.post('/api/v1/skills', {
          id: draft.id,
          name: draft.name,
          description: draft.description,
          body: draft.body,
          ...(tagList.length > 0 ? { tags: tagList } : {}),
          ...(trimmedAuthor !== '' ? { author: trimmedAuthor } : {}),
        }, { silent: true });
        ok += 1;
        setStatuses((prev) => prev.map((s, j) => (j === i ? 'ok' : s)));
      } catch (e) {
        failed += 1;
        setRowErrors((prev) => prev.map((msg, j) => (j === i ? errText(e) : msg)));
        setStatuses((prev) => prev.map((s, j) => (j === i ? 'failed' : s)));
      }
    }
    setPhase('done');
    onCreated();
    if (failed === 0) {
      toast.success('批量导入完成', `成功创建 ${ok} 个技能`);
    } else if (ok === 0) {
      toast.error('批量导入失败', `0 个成功 · ${failed} 个失败，详见清单`);
    } else {
      toast.info('批量导入部分完成', `成功 ${ok} 个 · 失败 ${failed} 个，详见清单`);
    }
  }, [drafts, creatable, onCreated]);

  const done = phase === 'done';

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent
        className="sm:max-w-2xl"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileUpIcon className="text-primary size-5" aria-hidden />
            {done ? '批量导入结果' : '批量创建技能'}
          </DialogTitle>
          <DialogDescription>
            {done
              ? `成功 ${summary.ok} 个 · 失败 ${summary.failed} 个。创建的技能已写入数据卷并刷新到列表。`
              : `共 ${drafts.length} 个文件${creatableCount > 0 ? `，可创建 ${creatableCount} 个技能` : ''}${
                  failedInputCount > 0 ? `，${failedInputCount} 个文件无法识别` : ''
                }。确认后逐个写入数据卷（重复 ID 自动去重）。`}
          </DialogDescription>
        </DialogHeader>

        <div className="flex max-h-96 flex-col gap-2 overflow-y-auto pr-1" aria-label="待创建技能清单">
          {drafts.map((draft, i) => {
            const status = statuses[i] ?? 'pending';
            const rowError = rowErrors[i] ?? '';
            const isFailedInput = !creatable[i];
            return (
              <div
                key={`${draft.fileName}-${i}`}
                className={cn(
                  'flex flex-col gap-1.5 rounded-md border p-2.5',
                  (isFailedInput || status === 'failed') && 'border-destructive/40 bg-destructive/5',
                  status === 'ok' && 'border-emerald-600/30 bg-emerald-600/5',
                )}
              >
                <div className="flex items-center gap-2">
                  <KindIcon kind={draft.kind} className="text-muted-foreground size-4 shrink-0" />
                  <span className="truncate font-mono text-xs" title={draft.fileName}>
                    {draft.fileName}
                  </span>
                  <span className="ml-auto flex shrink-0 items-center gap-1.5">
                    {status === 'pending' && <span className="text-muted-foreground text-xs">待创建</span>}
                    {status === 'creating' && (
                      <>
                        <LoaderCircleIcon className="text-muted-foreground size-3.5 animate-spin" aria-hidden />
                        <span className="text-muted-foreground text-xs">创建中…</span>
                      </>
                    )}
                    {status === 'ok' && (
                      <>
                        <CircleCheckIcon className="size-4 text-emerald-600 dark:text-emerald-400" aria-hidden />
                        <span className="text-xs text-emerald-600 dark:text-emerald-400">已创建</span>
                      </>
                    )}
                    {(status === 'failed' || isFailedInput) && (
                      <>
                        <CircleXIcon className="text-destructive size-4" aria-hidden />
                        <span className="text-destructive text-xs">失败</span>
                      </>
                    )}
                  </span>
                </div>

                {isFailedInput || status === 'failed' ? (
                  <p className="text-destructive flex items-start gap-1.5 text-xs leading-relaxed">
                    <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                    {rowError !== '' ? rowError : (draft.error ?? '创建失败')}
                  </p>
                ) : (
                  <div className="text-muted-foreground flex flex-col gap-0.5 text-xs leading-relaxed">
                    <span>
                      <span className="text-foreground font-medium">{draft.name}</span>
                      <span className="mx-1.5">·</span>
                      ID：<span className="text-foreground font-mono">{draft.id}</span>
                      {draft.truncated && (
                        <span className="ml-1.5" title={`正文超过 128KB（${BODY_LIMIT_BYTES} 字节），已截断`}>
                          （正文已截断）
                        </span>
                      )}
                    </span>
                    <span className="line-clamp-2">{draft.description !== '' ? draft.description : '（无描述）'}</span>
                    <span>
                      来源：{draft.sourceNote}
                      {draft.tags.length > 0 && <> · 标签:{draft.tags.join('、')}</>}
                    </span>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <DialogFooter>
          {done ? (
            <Button onClick={() => handleClose(false)}>完成</Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => handleClose(false)} disabled={phase === 'running'}>
                取消
              </Button>
              <Button onClick={() => void runBatch()} disabled={phase === 'running' || creatableCount === 0}>
                <SparklesIcon aria-hidden />
                {phase === 'running' ? `创建中…（${summary.ok + summary.failed}/${creatableCount}）` : `创建 ${creatableCount} 个技能`}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
