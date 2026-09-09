import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import {
  BanIcon,
  DownloadIcon,
  FileIcon,
  FolderKanbanIcon,
  RocketIcon,
  Trash2Icon,
  UploadCloudIcon,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { connectSse, type SseStream } from '@/lib/sse';
import { CodeBlock, EmptyState } from '@/pages/_shared';
import type { FileRecord, TaskRecord } from '@/pages/_shared';
import {
  downloadWithToken,
  errText,
  formatBytes,
  formatDateTime,
  parseJsonInput,
} from '@/pages/_shared';

/**
 * FilesTasks — 文件与任务。
 *
 * 上半「文件」：
 * - POST   /api/v1/files        multipart 上传（input file + 拖拽区，field 'file'）；
 * - GET    /api/v1/files        列表（名称/大小/时间/可见性）；
 * - GET    /api/v1/files/:id    下载（?token= 的 <a download>）；
 * - DELETE /api/v1/files/:id    删除（confirm）。
 * 下半「任务」：
 * - GET  /api/v1/tasks          列表（status badge / 进度条）；
 * - POST /api/v1/tasks/dispatch 派发内置 echo 任务（args JSON 校验）；
 * - POST /api/v1/tasks/:id/cancel 取消；
 * - SSE topics=tasks：task.progress 帧实时更新进度（断连徽标 + 重放缺口全量对账）。
 */

/** 任务状态徽标配色 */
function statusVariant(status: TaskRecord['status']): 'secondary' | 'destructive' | 'success' | 'outline' {
  switch (status) {
    case 'running':
      return 'secondary';
    case 'done':
      return 'success';
    case 'failed':
      return 'destructive';
    default:
      return 'outline';
  }
}

const STATUS_LABELS: Record<TaskRecord['status'], string> = {
  queued: '排队中',
  running: '运行中',
  done: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

export default function FilesTasksPage(): React.ReactNode {
  return (
    <div className="flex flex-col gap-8">
      <FilesSection />
      <TasksSection />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 文件区
// ---------------------------------------------------------------------------

function FilesSection(): React.ReactNode {
  const [files, setFiles] = useState<FileRecord[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<FileRecord | null>(null);
  const [deleting, setDeleting] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      const res = await api.get<FileRecord[]>('/api/v1/files?limit=200');
      setFiles(res);
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const upload = useCallback(
    async (file: File): Promise<void> => {
      setUploading(true);
      try {
        const form = new FormData();
        form.append('file', file);
        await api.post<FileRecord>('/api/v1/files', form);
        toast.success('上传成功', file.name);
        await load();
      } catch (e) {
        toast.error('上传失败', errText(e));
      } finally {
        setUploading(false);
      }
    },
    [load],
  );

  const handleDrop = useCallback(
    (e: DragEvent<HTMLDivElement>): void => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer.files[0];
      if (file !== undefined) void upload(file);
    },
    [upload],
  );

  const confirmDelete = useCallback(async (): Promise<void> => {
    if (deleteTarget === null) return;
    setDeleting(true);
    try {
      await api.delete(`/api/v1/files/${encodeURIComponent(deleteTarget.id)}`);
      toast.success('已删除', deleteTarget.origName);
      setDeleteTarget(null);
      await load();
    } catch (e) {
      toast.error('删除失败', errText(e));
    } finally {
      setDeleting(false);
    }
  }, [deleteTarget, load]);

  return (
    <section className="flex flex-col gap-4" aria-label="文件">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h3 className="text-base font-semibold tracking-tight">文件库</h3>
          <p className="text-muted-foreground text-sm">上传与管理扩展/内核共享的文件。</p>
        </div>
      </div>

      {/* 上传区（input file + 拖拽） */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => void handleDrop(e)}
        className={cn(
          'flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed p-6 text-center transition-colors',
          dragOver && 'border-primary bg-primary/5',
        )}
      >
        <UploadCloudIcon className={cn('text-muted-foreground size-7', uploading && 'animate-bounce')} aria-hidden />
        <p className="text-sm font-medium">{uploading ? '上传中…' : '拖拽文件到此处，或'}</p>
        <Button size="sm" variant="outline" onClick={() => inputRef.current?.click()} disabled={uploading}>
          选择文件
        </Button>
        <input
          ref={inputRef}
          type="file"
          className="hidden"
          disabled={uploading}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file !== undefined) void upload(file);
            e.target.value = ''; // 允许重复选择同一文件
          }}
        />
      </div>

      {/* 列表三态 */}
      {loading && <Skeleton className="h-40 rounded-lg" />}
      {!loading && error !== null && (
        <EmptyState icon={FileIcon} title="文件列表加载失败" description={error}>
          <Button size="sm" onClick={() => void load()}>
            重试
          </Button>
        </EmptyState>
      )}
      {!loading && error === null && (files ?? []).length === 0 && (
        <EmptyState icon={FileIcon} title="暂无文件" description="上传的文件会保存在内核文件库，可在列表中下载或删除。" />
      )}
      {!loading && error === null && (files ?? []).length > 0 && (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-muted/50 border-b">
                <th className="text-muted-foreground px-3 py-2 text-left font-medium">名称</th>
                <th className="text-muted-foreground w-24 px-3 py-2 text-left font-medium">大小</th>
                <th className="text-muted-foreground w-24 px-3 py-2 text-left font-medium">可见性</th>
                <th className="text-muted-foreground w-44 px-3 py-2 text-left font-medium">上传时间</th>
                <th className="w-28 px-3 py-2 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {(files ?? []).map((f) => (
                <tr key={f.id} className="hover:bg-accent/40 border-b last:border-b-0">
                  <td className="max-w-[260px] px-3 py-2">
                    <span className="block truncate font-medium" title={`${f.origName}（${f.mime}）`}>
                      {f.origName}
                    </span>
                  </td>
                  <td className="text-muted-foreground px-3 py-2 tabular-nums">{formatBytes(f.size)}</td>
                  <td className="px-3 py-2">
                    <Badge variant={f.visibility === 'public' ? 'secondary' : 'outline'}>
                      {f.visibility === 'public' ? '公开' : '私有'}
                    </Badge>
                  </td>
                  <td className="text-muted-foreground px-3 py-2 text-xs tabular-nums">{formatDateTime(f.createdAt)}</td>
                  <td className="px-3 py-2">
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        title="下载"
                        onClick={() => downloadWithToken(`/api/v1/files/${encodeURIComponent(f.id)}`, f.origName)}
                      >
                        <DownloadIcon aria-hidden />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        title="删除"
                        className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                        onClick={() => setDeleteTarget(f)}
                      >
                        <Trash2Icon aria-hidden />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 删除确认 */}
      <Dialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除文件</DialogTitle>
            <DialogDescription>确定要删除「{deleteTarget?.origName}」吗？引用该文件的扩展将无法再读取。</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              取消
            </Button>
            <Button variant="destructive" onClick={() => void confirmDelete()} disabled={deleting}>
              {deleting ? '删除中…' : '确认删除'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

// ---------------------------------------------------------------------------
// 任务区
// ---------------------------------------------------------------------------

function TasksSection(): React.ReactNode {
  const [tasks, setTasks] = useState<TaskRecord[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [connected, setConnected] = useState(false);
  /** 派发表单 */
  const [argsText, setArgsText] = useState('');
  const [dispatching, setDispatching] = useState(false);
  /** 行级忙态 */
  const [cancelBusyId, setCancelBusyId] = useState<string | null>(null);
  /** SSE 进度事件后的对账刷新定时器 */
  const reconcileTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** SSE 连接句柄（卸载时关闭） */
  const streamRef = useRef<SseStream | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setRefreshing(true);
    setError(null);
    try {
      const res = await api.get<TaskRecord[]>('/api/v1/tasks?limit=100');
      setTasks(res);
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

  // SSE topics=tasks：task.progress 帧增量更新进度 + 防抖对账终态
  useEffect(() => {
    const scheduleReconcile = (): void => {
      if (reconcileTimer.current !== null) clearTimeout(reconcileTimer.current);
      reconcileTimer.current = setTimeout(() => void load(), 1500);
    };
    streamRef.current = connectSse({
      topics: ['tasks'],
      onEvent: (e) => {
        if (e.event !== 'task.progress') return;
        const payload = e.data as { id?: unknown; pct?: unknown; msg?: unknown };
        if (typeof payload.id !== 'string' || typeof payload.pct !== 'number') return;
        const taskId: string = payload.id;
        const pct: number = payload.pct;
        const msg: string | null = typeof payload.msg === 'string' ? payload.msg : null;
        setTasks((prev) =>
          (prev ?? []).map((t) =>
            t.id === taskId
              ? { ...t, status: t.status === 'queued' ? 'running' : t.status, progress: pct, progressMsg: msg }
              : t,
          ),
        );
        scheduleReconcile(); // 终态（done/failed）没有专属 SSE 帧，稍后对账
      },
      onReplayGap: () => {
        void load(); // 游标失效：全量对账
      },
      onStateChange: setConnected,
    });
    return () => {
      streamRef.current?.close();
      streamRef.current = null;
      if (reconcileTimer.current !== null) clearTimeout(reconcileTimer.current);
    };
  }, [load]);

  const dispatch = useCallback(async (): Promise<void> => {
    const parsed = parseJsonInput(argsText);
    if (!parsed.ok) {
      toast.error('args 不是合法 JSON', parsed.message);
      return;
    }
    setDispatching(true);
    try {
      await api.post<TaskRecord>('/api/v1/tasks/dispatch', {
        name: 'echo',
        ...(parsed.value === undefined ? {} : { args: parsed.value }),
      });
      toast.success('任务已派发', 'echo 任务通常瞬时完成，列表即将刷新');
      setArgsText('');
      await load();
    } catch (e) {
      toast.error('派发失败', errText(e));
    } finally {
      setDispatching(false);
    }
  }, [argsText, load]);

  const cancelTask = useCallback(
    async (task: TaskRecord): Promise<void> => {
      setCancelBusyId(task.id);
      try {
        await api.post(`/api/v1/tasks/${encodeURIComponent(task.id)}/cancel`);
        toast.success('已请求取消', task.id);
        await load();
      } catch (e) {
        toast.error('取消失败', errText(e));
      } finally {
        setCancelBusyId(null);
      }
    },
    [load],
  );

  const sorted = tasks ?? [];

  return (
    <section className="flex flex-col gap-4" aria-label="任务">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h3 className="text-base font-semibold tracking-tight">后台任务</h3>
          <p className="text-muted-foreground flex items-center gap-2 text-sm">
            异步任务的派发、进度与取消
            <Badge variant={connected ? 'success' : 'outline'} className="gap-1">
              <span className={cn('size-1.5 rounded-full', connected ? 'bg-emerald-500' : 'bg-muted-foreground/40')} />
              {connected ? '实时' : '离线'}
            </Badge>
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={refreshing}>
          刷新
        </Button>
      </div>

      {/* 派发 echo 表单 */}
      <Card className="gap-3 py-4">
        <CardHeader className="px-4">
          <CardTitle className="text-sm">派发 echo 任务</CardTitle>
          <CardDescription>v1 仅开放内置 echo 类型；args 为可选 JSON 负载。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 px-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <div className="flex-1 flex flex-col gap-2">
              <Label htmlFor="task-args">args（可选，JSON）</Label>
              <Textarea
                id="task-args"
                value={argsText}
                onChange={(e) => setArgsText(e.target.value)}
                placeholder='{"hello": "world"}'
                className="min-h-14 font-mono text-xs"
                disabled={dispatching}
              />
            </div>
            <Button onClick={() => void dispatch()} disabled={dispatching} className="shrink-0">
              <RocketIcon aria-hidden />
              {dispatching ? '派发中…' : '派发任务'}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* 列表三态 */}
      {loading && <Skeleton className="h-40 rounded-lg" />}
      {!loading && error !== null && (
        <EmptyState icon={FolderKanbanIcon} title="任务列表加载失败" description={error}>
          <Button size="sm" onClick={() => void load()}>
            重试
          </Button>
        </EmptyState>
      )}
      {!loading && error === null && sorted.length === 0 && (
        <EmptyState icon={FolderKanbanIcon} title="暂无任务" description="派发一个 echo 任务试试，进度将通过 SSE 实时推送。" />
      )}
      {!loading && error === null && sorted.length > 0 && (
        <div className="flex flex-col gap-2">
          {sorted.map((t) => {
            const active = t.status === 'queued' || t.status === 'running';
            return (
              <Card key={t.id} className="gap-2 py-3">
                <CardContent className="flex flex-col gap-2 px-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <Badge variant={statusVariant(t.status)}>{STATUS_LABELS[t.status]}</Badge>
                      <span className="text-sm font-medium">echo</span>
                      <span className="text-muted-foreground truncate font-mono text-xs" title={t.id}>
                        {t.id}
                      </span>
                      {t.extId !== '' && <Badge variant="outline" className="font-mono text-[10px]">{t.extId}</Badge>}
                    </div>
                    {active && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void cancelTask(t)}
                        disabled={cancelBusyId === t.id}
                      >
                        <BanIcon aria-hidden />
                        {cancelBusyId === t.id ? '取消中…' : '取消'}
                      </Button>
                    )}
                  </div>
                  {/* 进度条 */}
                  <div className="flex items-center gap-3">
                    <div className="bg-muted h-2 flex-1 overflow-hidden rounded-full">
                      <div
                        className={cn('h-full rounded-full transition-all', t.status === 'failed' ? 'bg-destructive' : 'bg-primary')}
                        style={{ width: `${Math.min(100, Math.max(t.status === 'done' ? 100 : 0, t.progress))}%` }}
                      />
                    </div>
                    <span className="text-muted-foreground w-12 text-right text-xs tabular-nums">{Math.round(t.progress)}%</span>
                  </div>
                  {t.progressMsg !== null && t.progressMsg !== '' && (
                    <p className="text-muted-foreground text-xs">{t.progressMsg}</p>
                  )}
                  {t.error !== null && <CodeBlock text={t.error} className="max-h-20" />}
                  {t.status === 'done' && t.result !== null && t.result !== undefined && (
                    <CodeBlock text={JSON.stringify(t.result, null, 2)} className="max-h-24" />
                  )}
                  <p className="text-muted-foreground/70 text-[11px] tabular-nums">
                    创建于 {formatDateTime(t.createdAt)}
                    {t.finishedAt !== null && ` · 结束于 ${formatDateTime(t.finishedAt)}`}
                  </p>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </section>
  );
}
