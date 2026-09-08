import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BoxIcon,
  HardDriveIcon,
  LayersIcon,
  PlusIcon,
  RefreshCwIcon,
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
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { toast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { EmptyState } from '@/pages/_shared';
import { WorkspacePanel } from '@/pages/Sandbox/WorkspacePanel';
import type { WorkspaceInfo } from '@/pages/_shared';
import { errText, formatDateTime, isApiError } from '@/pages/_shared';

/**
 * Sandbox — 容器工作区沙箱。
 *
 * - GET    /api/v1/sandbox/workspaces      工作区列表（id/image/status/networkMode/家目录）；
 * - POST   /api/v1/sandbox/workspaces      创建（id/image 可选）；
 * - DELETE /api/v1/sandbox/workspaces/:id  删除（confirm）；
 * - 选中工作区 → 右侧执行面板与文件面板（见 Sandbox/WorkspacePanel.tsx）。
 * 沙箱未启用（409 HARNESS-6001 SANDBOX_DISABLED）→ 友好空态说明开启方式。
 */

const STATUS_META: Record<WorkspaceInfo['status'], { label: string; variant: 'success' | 'secondary' | 'warning' | 'destructive' }> = {
  creating: { label: '创建中', variant: 'secondary' },
  running: { label: '运行中', variant: 'success' },
  stopped: { label: '已停止', variant: 'warning' },
  error: { label: '异常', variant: 'destructive' },
};

export default function SandboxPage(): React.ReactNode {
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[] | null>(null);
  const [disabled, setDisabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** 创建 Dialog */
  const [createOpen, setCreateOpen] = useState(false);
  const [createId, setCreateId] = useState('');
  const [createImage, setCreateImage] = useState('');
  const [creating, setCreating] = useState(false);
  /** 删除确认 */
  const [deleteTarget, setDeleteTarget] = useState<WorkspaceInfo | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setRefreshing(true);
    setError(null);
    try {
      const res = await api.get<WorkspaceInfo[]>('/api/v1/sandbox/workspaces', { silent: true });
      setWorkspaces(res);
      setDisabled(false);
    } catch (e) {
      if (isApiError(e) && e.status === 409 && ['HARNESS-6001', 'SANDBOX_DISABLED'].includes(e.code)) {
        setDisabled(true);
        setWorkspaces([]);
      } else {
        setError(errText(e));
        toast.error('工作区列表加载失败', errText(e));
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleCreate = useCallback(async (): Promise<void> => {
    const id = createId.trim();
    const image = createImage.trim();
    if (id !== '' && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) {
      toast.error('工作区 ID 不合法', '仅允许字母/数字开头，字母、数字、下划线、连字符，最长 128 字符');
      return;
    }
    setCreating(true);
    try {
      await api.post<WorkspaceInfo>('/api/v1/sandbox/workspaces', {
        ...(id === '' ? {} : { id }),
        ...(image === '' ? {} : { image }),
      });
      toast.success('工作区已创建', id === '' ? '自动分配 ID' : id);
      setCreateOpen(false);
      setCreateId('');
      setCreateImage('');
      await load();
    } catch (e) {
      toast.error('创建失败', errText(e));
    } finally {
      setCreating(false);
    }
  }, [createId, createImage, load]);

  const confirmDelete = useCallback(async (): Promise<void> => {
    if (deleteTarget === null) return;
    setDeleting(true);
    try {
      await api.delete(`/api/v1/sandbox/workspaces/${encodeURIComponent(deleteTarget.id)}`);
      toast.success('工作区已删除', deleteTarget.id);
      setSelectedId((prev) => (prev === deleteTarget.id ? null : prev));
      setDeleteTarget(null);
      await load();
    } catch (e) {
      toast.error('删除失败', errText(e));
    } finally {
      setDeleting(false);
    }
  }, [deleteTarget, load]);

  const selected = useMemo(
    () => (workspaces ?? []).find((w) => w.id === selectedId) ?? null,
    [workspaces, selectedId],
  );

  // 加载骨架
  if (loading) {
    return (
      <div className="flex flex-col gap-6">
        <HeaderSlot />
        <Skeleton className="h-64 rounded-lg" />
      </div>
    );
  }

  // 沙箱未启用（SANDBOX_DISABLED 409）→ 友好空态
  if (disabled) {
    return (
      <div className="flex flex-col gap-6">
        <HeaderSlot />
        <EmptyState
          icon={BoxIcon}
          title="沙箱未启用"
          description="沙箱提供基于 Docker 的工作区（执行命令、读写文件）。当前内核未开启此能力。"
        >
          <div className="flex max-w-md flex-col gap-2 text-left">
            <p className="text-muted-foreground text-xs leading-relaxed">
              开启方式：设置环境变量{' '}
              <code className="bg-muted rounded px-1 py-0.5 font-mono text-[11px]">HARNESS_SANDBOX_ENABLED=1</code>{' '}
              后重启内核。需要宿主机安装并运行 Docker（或兼容的 DOCKER_HOST 远端），否则内核会以降级模式运行、所有沙箱操作返回 SANDBOX_DISABLED。
            </p>
          </div>
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <HeaderSlot
        actions={
          <>
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <PlusIcon aria-hidden />
              创建工作区
            </Button>
            <Button variant="outline" size="sm" onClick={() => void load()} disabled={refreshing}>
              <RefreshCwIcon className={cn(refreshing && 'animate-spin')} aria-hidden />
              刷新
            </Button>
          </>
        }
      />

      {/* 错误态 */}
      {error !== null && (
        <EmptyState icon={BoxIcon} title="工作区列表加载失败" description={error}>
          <Button size="sm" onClick={() => void load()}>
            重试
          </Button>
        </EmptyState>
      )}

      {/* 空态 */}
      {error === null && (workspaces ?? []).length === 0 && (
        <EmptyState
          icon={BoxIcon}
          title="暂无工作区"
          description="创建一个容器工作区，在其中执行命令与读写文件（家目录持久化，空闲后自动停机）。"
        >
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <PlusIcon aria-hidden />
            创建工作区
          </Button>
        </EmptyState>
      )}

      {/* 列表（表格 ≥md + 卡片 <md）与详情两栏 */}
      {error === null && (workspaces ?? []).length > 0 && (
        <div className={cn('grid gap-4', selected !== null && 'lg:grid-cols-2')}>
          <div className="flex flex-col gap-3">
            {/* 桌面表格 */}
            <div className="hidden overflow-x-auto rounded-lg border md:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>ID</TableHead>
                    <TableHead>镜像</TableHead>
                    <TableHead className="w-24">状态</TableHead>
                    <TableHead className="w-24">网络</TableHead>
                    <TableHead className="w-44 text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(workspaces ?? []).map((w) => (
                    <TableRow
                      key={w.id}
                      className={cn('cursor-pointer', selectedId === w.id && 'bg-accent/50')}
                      onClick={() => setSelectedId(w.id)}
                    >
                      <TableCell className="max-w-[160px] truncate font-mono text-xs" title={w.id}>
                        {w.id}
                      </TableCell>
                      <TableCell className="max-w-[200px] truncate font-mono text-xs" title={w.image}>
                        {w.image}
                      </TableCell>
                      <TableCell>
                        <Badge variant={STATUS_META[w.status].variant}>{STATUS_META[w.status].label}</Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant={w.networkMode === 'bridge' ? 'outline' : 'secondary'} className="font-mono text-[11px]">
                          {w.networkMode}
                        </Badge>
                      </TableCell>
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        <div className="flex justify-end gap-1.5">
                          <Button variant="outline" size="sm" onClick={() => setSelectedId(w.id)}>
                            打开
                          </Button>
                          <Button
                            variant="outline"
                            size="icon-sm"
                            title="删除"
                            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                            onClick={() => setDeleteTarget(w)}
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

            {/* 移动卡片 */}
            <div className="flex flex-col gap-3 md:hidden">
              {(workspaces ?? []).map((w) => (
                <Card
                  key={w.id}
                  className={cn('cursor-pointer gap-2 py-3', selectedId === w.id && 'border-primary/40')}
                  onClick={() => setSelectedId(w.id)}
                >
                  <CardContent className="flex flex-col gap-1.5 px-4">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-mono text-xs font-semibold">{w.id}</span>
                      <Badge variant={STATUS_META[w.status].variant}>{STATUS_META[w.status].label}</Badge>
                    </div>
                    <p className="text-muted-foreground truncate font-mono text-xs">{w.image}</p>
                    <p className="text-muted-foreground/70 truncate text-[11px]" title={w.homeDir}>
                      家目录：{w.homeDir}
                    </p>
                    <div className="flex items-center justify-between pt-1">
                      <Badge variant="outline" className="font-mono text-[10px]">
                        {w.networkMode}
                      </Badge>
                      <Button
                        variant="outline"
                        size="icon-sm"
                        title="删除"
                        className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeleteTarget(w);
                        }}
                      >
                        <Trash2Icon aria-hidden />
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>

            {/* 选中工作区的元信息 */}
            {selected !== null && (
              <Card className="gap-2 py-3">
                <CardContent className="flex flex-col gap-1 px-4 text-xs">
                  <p className="flex items-center gap-1.5">
                    <HardDriveIcon className="text-muted-foreground size-3.5 shrink-0" aria-hidden />
                    <span className="text-muted-foreground">家目录：</span>
                    <span className="truncate font-mono" title={selected.homeDir}>
                      {selected.homeDir}
                    </span>
                  </p>
                  <p className="text-muted-foreground">
                    容器：{selected.containerId ?? '—（重启后未挂回，执行前需重建容器）'}
                  </p>
                  <p className="text-muted-foreground tabular-nums">
                    创建于 {formatDateTime(selected.createdAt)} · 最近活跃 {formatDateTime(selected.lastActiveAt)}
                  </p>
                </CardContent>
              </Card>
            )}
          </div>

          {/* 选中 → 执行 + 文件面板 */}
          {selected !== null && (
            <WorkspacePanel workspace={selected} onActive={() => void load()} />
          )}
        </div>
      )}

      {/* 创建 Dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>创建工作区</DialogTitle>
            <DialogDescription>
              基于容器镜像创建带持久化家目录的工作区；ID 与镜像留空则使用系统缺省。
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="ws-id">工作区 ID（可选）</Label>
              <Input
                id="ws-id"
                value={createId}
                onChange={(e) => setCreateId(e.target.value)}
                placeholder="留空自动生成（如 my-sandbox）"
                disabled={creating}
                className="font-mono"
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="ws-image">容器镜像（可选）</Label>
              <Input
                id="ws-image"
                value={createImage}
                onChange={(e) => setCreateImage(e.target.value)}
                placeholder="留空使用缺省镜像（如 alpine:3.20）"
                disabled={creating}
                className="font-mono"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={creating}>
              取消
            </Button>
            <Button onClick={() => void handleCreate()} disabled={creating}>
              <LayersIcon aria-hidden />
              {creating ? '创建中…' : '创建'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除确认 */}
      <Dialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除工作区</DialogTitle>
            <DialogDescription>
              确定要删除「{deleteTarget?.id}」吗？容器将被强制移除，家目录数据一并删除，此操作不可恢复。
            </DialogDescription>
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
    </div>
  );
}

/** 页头（actions 可选，供骨架/空态复用） */
function HeaderSlot({ actions }: { actions?: React.ReactNode }): React.ReactNode {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold tracking-tight">沙箱</h2>
        <p className="text-muted-foreground text-sm">容器工作区列表、命令执行与文件浏览。</p>
      </div>
      {actions !== undefined && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
