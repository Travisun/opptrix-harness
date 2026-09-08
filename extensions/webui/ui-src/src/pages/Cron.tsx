import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  CalendarClockIcon,
  HistoryIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  RefreshCwIcon,
  TimerOffIcon,
  Trash2Icon,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { EmptyState, CodeBlock } from '@/pages/_shared';
import type { CronJobRecord, CronRunEntry } from '@/pages/_shared';
import { errText, formatDateTime, formatDuration, isValidTimezone, parseJsonInput } from '@/pages/_shared';

/**
 * Cron — 定时任务管理。
 *
 * - GET    /api/v1/cron             任务列表（name/expr/tz/nextRun/lastRun/enabled）；
 * - POST   /api/v1/cron             新建（name/expr/tz 缺省 UTC/payload JSON 校验）；
 * - PATCH  /api/v1/cron/:id         编辑（name/expr/tz/payload）与启停（enabled）；
 * - DELETE /api/v1/cron/:id         删除（confirm）；
 * - POST   /api/v1/cron/:id/run     立即触发（202 → toast）；
 * - GET    /api/v1/cron/:id/history 执行历史（Sheet 表格）。
 * nextRun === null → 「永不触发」警示徽标（表达式无效或已停用）。
 */

/** 新建/编辑共用的表单草稿 */
interface JobDraft {
  name: string;
  expr: string;
  tz: string;
  payloadText: string;
}

const EMPTY_DRAFT: JobDraft = { name: '', expr: '', tz: 'UTC', payloadText: '' };

/** 草稿 → 请求体（payload JSON 校验失败返回 null 并 toast） */
function draftToBody(draft: JobDraft): { name: string; expr: string; tz: string; payload?: unknown } | null {
  const name = draft.name.trim();
  const expr = draft.expr.trim();
  const tz = draft.tz.trim() === '' ? 'UTC' : draft.tz.trim();
  if (name === '') {
    toast.error('请填写任务名称');
    return null;
  }
  if (expr === '') {
    toast.error('请填写 cron 表达式', '例如 "0 * * * *" 或 "@hourly"');
    return null;
  }
  if (!isValidTimezone(tz)) {
    toast.error('时区不合法', `"${tz}" 不是可识别的 IANA 时区（例如 UTC、Asia/Shanghai）`);
    return null;
  }
  const parsed = parseJsonInput(draft.payloadText);
  if (!parsed.ok) {
    toast.error('payload 不是合法 JSON', parsed.message);
    return null;
  }
  return parsed.value === undefined ? { name, expr, tz } : { name, expr, tz, payload: parsed.value };
}

export default function CronPage(): React.ReactNode {
  const [jobs, setJobs] = useState<CronJobRecord[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  /** 行级忙态：jobId → 动作名 */
  const [busy, setBusy] = useState<Record<string, string>>({});
  /** 新建 Dialog */
  const [createOpen, setCreateOpen] = useState(false);
  const [draft, setDraft] = useState<JobDraft>(EMPTY_DRAFT);
  const [submitting, setSubmitting] = useState(false);
  /** 编辑 Dialog */
  const [editTarget, setEditTarget] = useState<CronJobRecord | null>(null);
  const [editDraft, setEditDraft] = useState<JobDraft>(EMPTY_DRAFT);
  /** 删除确认 */
  const [deleteTarget, setDeleteTarget] = useState<CronJobRecord | null>(null);
  /** 历史 Sheet */
  const [historyTarget, setHistoryTarget] = useState<CronJobRecord | null>(null);
  const [history, setHistory] = useState<CronRunEntry[] | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setRefreshing(true);
    setError(null);
    try {
      const res = await api.get<CronJobRecord[]>('/api/v1/cron');
      setJobs(res);
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** 行级动作：runNow / toggle(enabled) */
  const rowAction = useCallback(
    async (job: CronJobRecord, action: 'run' | 'enable' | 'disable'): Promise<void> => {
      setBusy((prev) => ({ ...prev, [job.id]: action }));
      try {
        if (action === 'run') {
          await api.post(`/api/v1/cron/${encodeURIComponent(job.id)}/run`);
          toast.success('已触发', `「${job.name}」已提交执行（异步运行，可稍后查看历史）`);
        } else {
          await api.patch(`/api/v1/cron/${encodeURIComponent(job.id)}`, { enabled: action === 'enable' });
          toast.success(action === 'enable' ? '已启用' : '已停用', job.name);
        }
        await load();
      } catch (e) {
        toast.error('操作失败', errText(e));
      } finally {
        setBusy((prev) => {
          const next = { ...prev };
          delete next[job.id];
          return next;
        });
      }
    },
    [load],
  );

  const handleCreate = useCallback(
    async (e: FormEvent<HTMLFormElement>): Promise<void> => {
      e.preventDefault();
      const body = draftToBody(draft);
      if (body === null) return;
      setSubmitting(true);
      try {
        await api.post<CronJobRecord>('/api/v1/cron', body);
        toast.success('创建成功', body.name);
        setCreateOpen(false);
        setDraft(EMPTY_DRAFT);
        await load();
      } catch (err) {
        toast.error('创建失败', errText(err));
      } finally {
        setSubmitting(false);
      }
    },
    [draft, load],
  );

  const openEdit = useCallback((job: CronJobRecord): void => {
    setEditTarget(job);
    setEditDraft({
      name: job.name,
      expr: job.expr,
      tz: job.tz,
      payloadText: job.payload === null || job.payload === undefined ? '' : JSON.stringify(job.payload, null, 2),
    });
  }, []);

  const handleEdit = useCallback(
    async (e: FormEvent<HTMLFormElement>): Promise<void> => {
      e.preventDefault();
      if (editTarget === null) return;
      const body = draftToBody(editDraft);
      if (body === null) return;
      const payloadParsed = parseJsonInput(editDraft.payloadText);
      if (!payloadParsed.ok) {
        toast.error('payload 不是合法 JSON', payloadParsed.message);
        return;
      }
      setSubmitting(true);
      try {
        // PATCH 只更新给出的字段：payload 文本留空 → 显式传 null 以清除负载
        await api.patch<CronJobRecord>(`/api/v1/cron/${encodeURIComponent(editTarget.id)}`, {
          ...body,
          payload: payloadParsed.value ?? null,
        });
        toast.success('已保存', body.name);
        setEditTarget(null);
        await load();
      } catch (err) {
        toast.error('保存失败', errText(err));
      } finally {
        setSubmitting(false);
      }
    },
    [editTarget, editDraft, load],
  );

  const handleDelete = useCallback(async (): Promise<void> => {
    if (deleteTarget === null) return;
    setBusy((prev) => ({ ...prev, [deleteTarget.id]: 'delete' }));
    try {
      await api.delete(`/api/v1/cron/${encodeURIComponent(deleteTarget.id)}`);
      toast.success('已删除', deleteTarget.name);
      setDeleteTarget(null);
      await load();
    } catch (e) {
      toast.error('删除失败', errText(e));
    } finally {
      setBusy((prev) => {
        const next = { ...prev };
        delete next[deleteTarget.id];
        return next;
      });
    }
  }, [deleteTarget, load]);

  const openHistory = useCallback(async (job: CronJobRecord): Promise<void> => {
    setHistoryTarget(job);
    setHistory(null);
    setHistoryLoading(true);
    try {
      const res = await api.get<CronRunEntry[]>(`/api/v1/cron/${encodeURIComponent(job.id)}/history?limit=50`);
      setHistory(res);
    } catch (e) {
      toast.error('历史加载失败', errText(e));
      setHistory([]);
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  const sorted = useMemo(() => {
    const list = jobs ?? [];
    return [...list].sort((a, b) => a.createdAt - b.createdAt);
  }, [jobs]);

  return (
    <div className="flex flex-col gap-6">
      {/* 页头 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold tracking-tight">定时任务</h2>
          <p className="text-muted-foreground text-sm">任务的创建、启停、手动触发与运行历史。</p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <PlusIcon aria-hidden />
            新建任务
          </Button>
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={refreshing}>
            <RefreshCwIcon className={cn(refreshing && 'animate-spin')} aria-hidden />
            刷新
          </Button>
        </div>
      </div>

      {/* 加载骨架 */}
      {loading && <Skeleton className="h-72 rounded-lg" />}

      {/* 错误态 */}
      {!loading && error !== null && (
        <EmptyState icon={CalendarClockIcon} title="任务列表加载失败" description={error}>
          <Button size="sm" onClick={() => void load()}>
            <RefreshCwIcon aria-hidden />
            重试
          </Button>
        </EmptyState>
      )}

      {/* 空态 */}
      {!loading && error === null && sorted.length === 0 && (
        <EmptyState
          icon={CalendarClockIcon}
          title="暂无定时任务"
          description="创建一个 cron 任务，按表达式周期性触发（扩展也可以注册自己的任务）。"
        >
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <PlusIcon aria-hidden />
            新建任务
          </Button>
        </EmptyState>
      )}

      {/* 桌面表格（≥md） */}
      {!loading && error === null && sorted.length > 0 && (
        <>
          <div className="hidden overflow-x-auto rounded-lg border md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>名称</TableHead>
                  <TableHead>表达式</TableHead>
                  <TableHead className="w-32">时区</TableHead>
                  <TableHead className="w-44">下次触发</TableHead>
                  <TableHead className="w-44">上次运行</TableHead>
                  <TableHead className="w-20">启用</TableHead>
                  <TableHead className="w-64 text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sorted.map((job) => (
                  <TableRow key={job.id}>
                    <TableCell className="max-w-[180px] truncate font-medium" title={job.name}>
                      {job.name}
                      {job.extId !== null && (
                        <Badge variant="outline" className="ml-2 font-mono text-[10px]">
                          {job.extId}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{job.expr}</TableCell>
                    <TableCell className="font-mono text-xs">{job.tz}</TableCell>
                    <TableCell>
                      {job.enabled && job.nextRun === null ? (
                        <Badge variant="warning" className="gap-1">
                          <TimerOffIcon className="size-3" aria-hidden />
                          永不触发
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground text-xs tabular-nums">{formatDateTime(job.nextRun)}</span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs tabular-nums">{formatDateTime(job.lastRun)}</TableCell>
                    <TableCell>
                      <Switch
                        checked={job.enabled}
                        disabled={busy[job.id] !== undefined}
                        onCheckedChange={(checked) => void rowAction(job, checked ? 'enable' : 'disable')}
                        aria-label={job.enabled ? `停用 ${job.name}` : `启用 ${job.name}`}
                      />
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1.5">
                        <Button variant="outline" size="icon-sm" title="立即运行" onClick={() => void rowAction(job, 'run')} disabled={busy[job.id] !== undefined}>
                          <PlayIcon className={cn(busy[job.id] === 'run' && 'animate-pulse')} aria-hidden />
                        </Button>
                        <Button variant="outline" size="icon-sm" title="运行历史" onClick={() => void openHistory(job)}>
                          <HistoryIcon aria-hidden />
                        </Button>
                        <Button variant="outline" size="icon-sm" title="编辑" onClick={() => openEdit(job)}>
                          <PencilIcon aria-hidden />
                        </Button>
                        <Button
                          variant="outline"
                          size="icon-sm"
                          title="删除"
                          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                          onClick={() => setDeleteTarget(job)}
                          disabled={busy[job.id] !== undefined}
                        >
                          <Trash2Icon aria-hidden />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {/* 移动卡片列表（<md） */}
          <div className="flex flex-col gap-3 md:hidden">
            {sorted.map((job) => (
              <Card key={job.id} className="gap-3 py-4">
                <CardContent className="flex flex-col gap-3 px-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold">{job.name}</p>
                      <p className="text-muted-foreground mt-0.5 font-mono text-xs">
                        {job.expr} · {job.tz}
                      </p>
                    </div>
                    <Switch
                      checked={job.enabled}
                      disabled={busy[job.id] !== undefined}
                      onCheckedChange={(checked) => void rowAction(job, checked ? 'enable' : 'disable')}
                      aria-label={job.enabled ? `停用 ${job.name}` : `启用 ${job.name}`}
                    />
                  </div>
                  <div className="text-muted-foreground flex flex-col gap-1 text-xs">
                    <span>
                      下次触发：
                      {job.enabled && job.nextRun === null ? (
                        <Badge variant="warning" className="ml-1 gap-1">
                          <TimerOffIcon className="size-3" aria-hidden />
                          永不触发
                        </Badge>
                      ) : (
                        formatDateTime(job.nextRun)
                      )}
                    </span>
                    <span>上次运行：{formatDateTime(job.lastRun)}</span>
                  </div>
                  <div className="flex flex-wrap gap-2 border-t pt-3">
                    <Button variant="outline" size="sm" onClick={() => void rowAction(job, 'run')} disabled={busy[job.id] !== undefined}>
                      <PlayIcon aria-hidden />
                      运行
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => void openHistory(job)}>
                      <HistoryIcon aria-hidden />
                      历史
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => openEdit(job)}>
                      <PencilIcon aria-hidden />
                      编辑
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                      onClick={() => setDeleteTarget(job)}
                      disabled={busy[job.id] !== undefined}
                    >
                      <Trash2Icon aria-hidden />
                      删除
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </>
      )}

      {/* 新建 Dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新建定时任务</DialogTitle>
            <DialogDescription>使用 5 字段 cron 表达式（或 @daily 等别名）定义触发计划。</DialogDescription>
          </DialogHeader>
          <form onSubmit={(e) => void handleCreate(e)} className="flex flex-col gap-4" noValidate>
            <JobFormFields draft={draft} onDraftChange={setDraft} submitting={submitting} />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setCreateOpen(false)} disabled={submitting}>
                取消
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting ? '创建中…' : '创建'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* 编辑 Dialog */}
      <Dialog open={editTarget !== null} onOpenChange={(open) => !open && setEditTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>编辑任务</DialogTitle>
            <DialogDescription>修改后立即重排下次触发时间（payload 留空表示清除）。</DialogDescription>
          </DialogHeader>
          <form onSubmit={(e) => void handleEdit(e)} className="flex flex-col gap-4" noValidate>
            <JobFormFields draft={editDraft} onDraftChange={setEditDraft} submitting={submitting} />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setEditTarget(null)} disabled={submitting}>
                取消
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting ? '保存中…' : '保存'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* 删除确认 */}
      <Dialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除定时任务</DialogTitle>
            <DialogDescription>
              确定要删除「{deleteTarget?.name}」吗？其执行历史将不再可查，此操作不可恢复。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              取消
            </Button>
            <Button variant="destructive" onClick={() => void handleDelete()}>
              确认删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 历史 Sheet */}
      <Sheet open={historyTarget !== null} onOpenChange={(open) => !open && setHistoryTarget(null)}>
        <SheetContent side="right" className="flex w-full flex-col gap-4 overflow-y-auto sm:max-w-lg">
          <SheetHeader>
            <SheetTitle>运行历史</SheetTitle>
            <SheetDescription>
              「{historyTarget?.name}」最近 50 次执行（最新在前）
            </SheetDescription>
          </SheetHeader>
          {historyLoading && (
            <div className="flex flex-col gap-2">
              {Array.from({ length: 5 }, (_, i) => (
                <Skeleton key={i} className="h-10 rounded-md" />
              ))}
            </div>
          )}
          {!historyLoading && (history === null || history.length === 0) && (
            <p className="text-muted-foreground py-8 text-center text-sm">暂无执行记录（可点击「立即运行」触发一次）</p>
          )}
          {!historyLoading && history !== null && history.length > 0 && (
            <div className="flex flex-col gap-2">
              {history.map((run, i) => (
                <div key={`${run.startedAt}:${i}`} className="rounded-md border p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <Badge variant={run.ok ? 'success' : 'destructive'}>{run.ok ? '成功' : '失败'}</Badge>
                      <span className="text-muted-foreground text-xs tabular-nums">{formatDateTime(run.startedAt)}</span>
                    </div>
                    <span className="text-muted-foreground text-xs tabular-nums">{formatDuration(run.durationMs)}</span>
                  </div>
                  {!run.ok && run.error !== null && (
                    <CodeBlock text={run.error} className="mt-2 max-h-24" />
                  )}
                </div>
              ))}
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

/** 新建/编辑共用字段：name / expr / tz / payload(JSON) */
function JobFormFields({
  draft,
  onDraftChange,
  submitting,
}: {
  draft: JobDraft;
  onDraftChange: (next: JobDraft) => void;
  submitting: boolean;
}): React.ReactNode {
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label htmlFor="cron-name">任务名称</Label>
          <Input
            id="cron-name"
            value={draft.name}
            onChange={(e) => onDraftChange({ ...draft, name: e.target.value })}
            placeholder="例如 每小时巡检"
            disabled={submitting}
            maxLength={128}
            required
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="cron-expr">cron 表达式</Label>
          <Input
            id="cron-expr"
            value={draft.expr}
            onChange={(e) => onDraftChange({ ...draft, expr: e.target.value })}
            placeholder="0 * * * * 或 @hourly"
            disabled={submitting}
            className="font-mono"
            required
          />
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="cron-tz">时区（IANA，缺省 UTC）</Label>
        <Input
          id="cron-tz"
          value={draft.tz}
          onChange={(e) => onDraftChange({ ...draft, tz: e.target.value })}
          placeholder="UTC"
          disabled={submitting}
          className="font-mono"
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="cron-payload">payload（可选，JSON）</Label>
        <Textarea
          id="cron-payload"
          value={draft.payloadText}
          onChange={(e) => onDraftChange({ ...draft, payloadText: e.target.value })}
          placeholder='{"key": "value"}'
          disabled={submitting}
          className="min-h-20 font-mono text-xs"
        />
      </div>
    </>
  );
}
