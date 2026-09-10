import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BlocksIcon,
  PackagePlusIcon,
  PackageXIcon,
  RefreshCwIcon,
  SearchIcon,
  TriangleAlertIcon,
  UploadCloudIcon,
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
import { Pagination } from '@/components/pagination';
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { ExtensionCard } from '@/pages/Extensions/ExtensionCard';
import { InstallConfirmDialog } from '@/pages/Extensions/InstallConfirmDialog';
import { TrustDialog } from '@/pages/Extensions/TrustDialog';
import type { TrustDialogTarget } from '@/pages/Extensions/TrustDialog';
import { MAX_EXTENSION_ZIP_BYTES, isDuplicateInstallError } from '@/pages/Extensions/shared';
import { isTrustRequired, trustPermissions } from '@/pages/Extensions/trust';
import type { ExtensionInstallResponse } from '@/pages/Extensions/shared';
import {
  EmptyState,
  formatBytes,
} from '@/pages/_shared';
import type {
  ExtRouteTableEntry,
  ExtSummary,
  ServiceEntry,
  UiSnapshotEntry,
} from '@/pages/_shared';
import { errText } from '@/pages/_shared';

/**
 * Extensions — 扩展管理。
 *
 * - GET    /api/v1/extensions                扩展卡片列表（分类 Tabs：全部 / 内置扩展 /
 *                                            本地扩展；启停 Switch / host / 信任 / lastError 折叠；
 *                                            <md 单列卡片流、元数据换行断行，≥md 双列）；
 * - POST   /api/v1/extensions/install        安装扩展包（工具条按钮 / 页面级拖拽 .zip ≤32MB
 *                                            客户端预检）→ 二次确认 Dialog（manifest 摘要 + 信任提示）
 *                                            → 确认后自动 rescan + 刷新；新扩展 enabled=false，
 *                                            启用走既有信任确认流；
 * - POST   /api/v1/extensions/:id/enable     启用（403 HARNESS-3012 → 信任确认 Dialog，确认后带
 *                                            {confirmTrust:true} 重试授信）；
 * - POST   /api/v1/extensions/:id/disable    停用；
 * - POST   /api/v1/extensions/:id/reload     重载；
 * - POST   /api/v1/extensions/:id/uninstall  卸载（Dialog 确认 + purge 开关，?purge=1）；
 * - POST   /api/v1/extensions/rescan         重扫扩展目录；
 * - GET    /api/v1/extensions/routes         路由表 Tab；
 * - GET    /api/v1/extensions/registry       服务注册 Tab；
 * - GET    /api/v1/ui                        UI 注册 Tab。
 */

type ExtAction = 'enable' | 'disable' | 'reload' | 'uninstall';

export default function ExtensionsPage(): React.ReactNode {
  const [extensions, setExtensions] = useState<ExtSummary[] | null>(null);
  const [routes, setRoutes] = useState<ExtRouteTableEntry[] | null>(null);
  const [registry, setRegistry] = useState<ServiceEntry[] | null>(null);
  const [uiRegistry, setUiRegistry] = useState<UiSnapshotEntry[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rescanning, setRescanning] = useState(false);
  /** 行级操作忙态：extId → action */
  const [busy, setBusy] = useState<Record<string, ExtAction>>({});
  /** 信任确认 Dialog 目标 */
  const [trustTarget, setTrustTarget] = useState<{ ext: ExtSummary; permissions: string[] } | null>(null);
  /** 卸载确认 Dialog 目标 */
  const [uninstallTarget, setUninstallTarget] = useState<ExtSummary | null>(null);
  const [purge, setPurge] = useState(false);

  // ---- 扩展包安装（工具条按钮 / 页面级拖拽 → POST install → 二次确认 → rescan） ----
  const fileInputRef = useRef<HTMLInputElement>(null);
  /** 拖拽悬停高亮 */
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  /** POST install 忙态 */
  const [installing, setInstalling] = useState(false);
  /** 二次确认 Dialog 的数据源（安装返回的 manifest 摘要） */
  const [installResult, setInstallResult] = useState<ExtensionInstallResponse | null>(null);
  /** 确认后 rescan + 刷新忙态 */
  const [confirming, setConfirming] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      const [extRes, routesRes, registryRes, uiRes] = await Promise.all([
        api.get<ExtSummary[]>('/api/v1/extensions'),
        api.get<ExtRouteTableEntry[]>('/api/v1/extensions/routes'),
        api.get<ServiceEntry[]>('/api/v1/extensions/registry'),
        api.get<UiSnapshotEntry[]>('/api/v1/ui'),
      ]);
      setExtensions(extRes);
      setRoutes(routesRes);
      setRegistry(registryRes);
      setUiRegistry(uiRes);
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** 行级动作包装：忙态 + 成功提示 + 刷新（信任闸与卸载的分支在外层处理） */
  const runAction = useCallback(
    async (ext: ExtSummary, action: ExtAction, opts?: { confirmTrust?: boolean; purge?: boolean }): Promise<boolean> => {
      setBusy((prev) => ({ ...prev, [ext.id]: action }));
      try {
        switch (action) {
          case 'enable':
            await api.post(`/api/v1/extensions/${encodeURIComponent(ext.id)}/enable`, opts?.confirmTrust === true ? { confirmTrust: true } : undefined);
            toast.success('启用成功', ext.manifest?.displayName ?? ext.id);
            break;
          case 'disable':
            await api.post(`/api/v1/extensions/${encodeURIComponent(ext.id)}/disable`);
            toast.success('已停用', ext.manifest?.displayName ?? ext.id);
            break;
          case 'reload':
            await api.post(`/api/v1/extensions/${encodeURIComponent(ext.id)}/reload`);
            toast.success('已重载', ext.manifest?.displayName ?? ext.id);
            break;
          case 'uninstall':
            await api.post(
              `/api/v1/extensions/${encodeURIComponent(ext.id)}/uninstall${opts?.purge === true ? '?purge=1' : ''}`,
            );
            toast.success('已卸载', opts?.purge === true ? '持久化数据已一并清除' : ext.id);
            break;
        }
        return true;
      } catch (e) {
        if (action === 'enable' && opts?.confirmTrust !== true && isTrustRequired(e)) {
          // 信任闸：打开确认 Dialog（api 层已 toast 错误本身）
          setTrustTarget({ ext, permissions: trustPermissions(e) });
          return false;
        }
        toast.error('操作失败', errText(e));
        return false;
      } finally {
        setBusy((prev) => {
          const next = { ...prev };
          delete next[ext.id];
          return next;
        });
      }
    },
    [],
  );

  const handleToggle = useCallback(
    async (ext: ExtSummary, enabled: boolean): Promise<void> => {
      const ok = await runAction(ext, enabled ? 'enable' : 'disable');
      if (ok) await load();
    },
    [runAction, load],
  );

  const handleRescan = useCallback(async (): Promise<void> => {
    setRescanning(true);
    try {
      const res = await api.post<{ ok: boolean; discovered: string[] }>('/api/v1/extensions/rescan');
      toast.success(
        '重扫完成',
        res.discovered.length > 0 ? `新发现 ${res.discovered.length} 个扩展：${res.discovered.join('、')}` : '未发现新扩展目录',
      );
      await load();
    } catch (e) {
      toast.error('重扫失败', errText(e));
    } finally {
      setRescanning(false);
    }
  }, [load]);

  const confirmUninstall = useCallback(async (): Promise<void> => {
    if (uninstallTarget === null) return;
    const ok = await runAction(uninstallTarget, 'uninstall', { purge });
    setUninstallTarget(null);
    setPurge(false);
    if (ok) await load();
  }, [uninstallTarget, purge, runAction, load]);

  const confirmTrust = useCallback(async (): Promise<void> => {
    if (trustTarget === null) return;
    const ok = await runAction(trustTarget.ext, 'enable', { confirmTrust: true });
    setTrustTarget(null);
    if (ok) await load();
  }, [trustTarget, runAction, load]);

  // ---------------------------------------------------------------- 安装扩展包

  /** 上传并安装 zip（≤32MB 客户端预检；成功 → 打开二次确认 Dialog） */
  const installZip = useCallback(async (file: File): Promise<void> => {
    setInstalling(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await api.post<ExtensionInstallResponse>('/api/v1/extensions/install', form, { silent: true });
      setInstallResult(res);
    } catch (e) {
      if (isDuplicateInstallError(e)) {
        // 内核 400 'extension id already installed, use overwrite' 的引导文案
        toast.error('安装失败', '该扩展 id 已安装，可开启覆盖重装');
      } else {
        toast.error('安装失败', errText(e));
      }
    } finally {
      setInstalling(false);
    }
  }, []);

  /** 选/拖到的 zip 预检：.zip 扩展名 + 32MB 上限（与内核一致） */
  const acceptFile = useCallback(
    (candidate: File | undefined): void => {
      if (candidate === undefined) return;
      if (!candidate.name.toLowerCase().endsWith('.zip')) {
        toast.error('无法安装', '仅支持 .zip 扩展包（包内需含 manifest.json）');
        return;
      }
      if (candidate.size > MAX_EXTENSION_ZIP_BYTES) {
        toast.error('无法安装', `超过 32MB 上限（当前 ${formatBytes(candidate.size)}，内核将拒绝 413）`);
        return;
      }
      void installZip(candidate);
    },
    [installZip],
  );

  /** 二次确认：自动 rescan → 刷新列表（新扩展 enabled=false，启用走既有信任确认流） */
  const confirmInstall = useCallback(async (): Promise<void> => {
    if (installResult === null) return;
    setConfirming(true);
    try {
      await api.post('/api/v1/extensions/rescan');
      await load();
      toast.success('已扫描并刷新列表', `「${installResult.manifest.displayName ?? installResult.id}」默认停用，启用时需信任确认`);
      setInstallResult(null);
    } catch (e) {
      toast.error('扫描失败', errText(e));
    } finally {
      setConfirming(false);
    }
  }, [installResult, load]);

  /** 页面级拖拽（depth 计数避免子元素 dragleave 闪烁） */
  const onDragEnter = useCallback((e: React.DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  }, []);
  const onDragOver = useCallback((e: React.DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    setDragging(true);
  }, []);
  const onDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  }, []);
  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>): void => {
      e.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      acceptFile(e.dataTransfer.files?.[0]);
    },
    [acceptFile],
  );

  // ---------------------------------------------------------------- 列表与分类

  const sorted = useMemo(() => {
    const list = extensions ?? [];
    return [...list].sort((a, b) => (a.host === b.host ? a.id.localeCompare(b.id) : a.host === 'builtin' ? -1 : 1));
  }, [extensions]);
  const builtinExts = useMemo(() => sorted.filter((ext) => ext.host === 'builtin'), [sorted]);
  const communityExts = useMemo(() => sorted.filter((ext) => ext.host === 'community'), [sorted]);

  const renderCardGrid = (items: ExtSummary[]): React.ReactNode =>
    items.length === 0 ? (
      <EmptyState
        icon={PackageXIcon}
        title="该分类暂无扩展"
        description="内置扩展随镜像交付；本地扩展经「安装扩展包」上传 zip 或放入数据卷扩展目录后重扫发现。"
      />
    ) : (
      /* <md 单列卡片流；≥md 保持双列网格 */
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {items.map((ext) => (
          <ExtensionCard
            key={ext.id}
            ext={ext}
            busyAction={busy[ext.id]}
            onToggle={(enabled) => void handleToggle(ext, enabled)}
            onReload={() => void runAction(ext, 'reload').then((ok) => ok && void load())}
            onUninstall={() => setUninstallTarget(ext)}
          />
        ))}
      </div>
    );

  return (
    <div
      className="flex flex-col gap-6"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {/* 拖拽悬停高亮层（pointer-events-none：drop 事件仍落在页面根节点） */}
      {dragging && (
        <div className="bg-background/80 pointer-events-none fixed inset-0 z-50 flex items-center justify-center p-6">
          <div className="flex w-full max-w-md flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-primary bg-background/95 p-10 text-center">
            <UploadCloudIcon className="text-primary size-8" aria-hidden />
            <p className="text-sm font-medium">松开以安装扩展包</p>
            <p className="text-muted-foreground text-xs">.zip ≤ 32MB，包内需含 manifest.json</p>
          </div>
        </div>
      )}

      {/* 页头 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold tracking-tight">系统扩展</h2>
          <p className="text-muted-foreground text-sm">系统扩展的启停、重载、卸载与贡献点查看。</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => fileInputRef.current?.click()} disabled={installing}>
            <PackagePlusIcon className={cn(installing && 'animate-pulse')} aria-hidden />
            {installing ? '安装中…' : '安装扩展包'}
          </Button>
          <Button variant="outline" size="sm" onClick={() => void handleRescan()} disabled={rescanning}>
            <SearchIcon className={cn(rescanning && 'animate-pulse')} aria-hidden />
            {rescanning ? '扫描中…' : '重新扫描'}
          </Button>
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCwIcon className={cn(loading && 'animate-spin')} aria-hidden />
            刷新
          </Button>
        </div>
      </div>

      {/* 隐藏的 zip 选择器（工具条「安装扩展包」按钮触发） */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".zip"
        className="hidden"
        disabled={installing}
        onChange={(e) => {
          acceptFile(e.target.files?.[0]);
          e.target.value = ''; // 允许重复选择同一文件
        }}
      />

      {/* 加载骨架 */}
      {loading && (
        <div className="grid gap-3 md:grid-cols-2">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-36 rounded-lg" />
          ))}
        </div>
      )}

      {/* 错误态 */}
      {!loading && error !== null && (
        <EmptyState icon={TriangleAlertIcon} title="扩展清单加载失败" description={error}>
          <Button size="sm" onClick={() => void load()}>
            <RefreshCwIcon aria-hidden />
            重试
          </Button>
        </EmptyState>
      )}

      {/* 空态 */}
      {!loading && error === null && sorted.length === 0 && (
        <EmptyState
          icon={PackageXIcon}
          title="暂无扩展"
          description="扩展目录（HARNESS_EXTENSIONS_DIR）下还没有已注册的扩展，点击「重新扫描」尝试发现，或用「安装扩展包」上传 zip。"
        >
          <Button size="sm" variant="outline" onClick={() => fileInputRef.current?.click()}>
            <PackagePlusIcon aria-hidden />
            安装扩展包
          </Button>
          <Button size="sm" variant="outline" onClick={() => void handleRescan()}>
            <SearchIcon aria-hidden />
            重新扫描
          </Button>
        </EmptyState>
      )}

      {/* 扩展卡片列表 — 分类 Tabs（全部 / 内置扩展 / 本地扩展；TabsList 窄屏可换行） */}
      {!loading && error === null && sorted.length > 0 && (
        <Tabs defaultValue="all" className="gap-3">
          <TabsList className="h-auto flex-wrap justify-start">
            <TabsTrigger value="all">全部（{sorted.length}）</TabsTrigger>
            <TabsTrigger value="builtin">内置扩展（{builtinExts.length}）</TabsTrigger>
            <TabsTrigger value="community">本地扩展（{communityExts.length}）</TabsTrigger>
          </TabsList>
          <TabsContent value="all">{renderCardGrid(sorted)}</TabsContent>
          <TabsContent value="builtin">{renderCardGrid(builtinExts)}</TabsContent>
          <TabsContent value="community">{renderCardGrid(communityExts)}</TabsContent>
        </Tabs>
      )}

      {/* 贡献点 Tabs */}
      {!loading && error === null && (extensions?.length ?? 0) > 0 && (
        <Tabs defaultValue="routes" className="gap-3">
          <TabsList>
            <TabsTrigger value="routes">路由表</TabsTrigger>
            <TabsTrigger value="registry">服务注册</TabsTrigger>
            <TabsTrigger value="ui">UI 注册</TabsTrigger>
          </TabsList>

          <TabsContent value="routes">
            <RoutesTab routes={routes} onRefresh={() => void load()} />
          </TabsContent>
          <TabsContent value="registry">
            <RegistryTab registry={registry} onRefresh={() => void load()} />
          </TabsContent>
          <TabsContent value="ui">
            <UiTab entries={uiRegistry} onRefresh={() => void load()} />
          </TabsContent>
        </Tabs>
      )}

      {/* 安装二次确认 Dialog（manifest 摘要 + 信任提示 → 确认后 rescan + 刷新） */}
      <InstallConfirmDialog
        result={installResult}
        confirming={confirming}
        onOpenChange={(open) => {
          if (!open) setInstallResult(null);
        }}
        onConfirm={() => void confirmInstall()}
      />

      {/* 信任确认 Dialog（403 HARNESS-3012 → 安全披露 → 确认后带 {confirmTrust:true} 重试授信） */}
      <TrustDialog
        target={
          trustTarget === null
            ? null
            : ({
                extId: trustTarget.ext.id,
                displayName: trustTarget.ext.manifest?.displayName,
                version: trustTarget.ext.version,
                host: trustTarget.ext.host,
                source: trustTarget.ext.dir ?? '本地扩展目录（数据卷 extensions/）',
                permissions: trustTarget.permissions,
              } satisfies TrustDialogTarget)
        }
        busy={trustTarget !== null && busy[trustTarget.ext.id] === 'enable'}
        onOpenChange={(open) => {
          if (!open) setTrustTarget(null);
        }}
        onConfirm={() => void confirmTrust()}
      />

      {/* 卸载确认 Dialog */}
      <Dialog open={uninstallTarget !== null} onOpenChange={(open) => !open && setUninstallTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>卸载扩展</DialogTitle>
            <DialogDescription>
              确定要卸载「{uninstallTarget?.manifest?.displayName ?? uninstallTarget?.id}」吗？该操作会停止扩展并从扩展目录登记中移除。
            </DialogDescription>
          </DialogHeader>
          <label className="hover:bg-accent/50 flex cursor-pointer items-center gap-3 rounded-md border p-3">
            <Switch checked={purge} onCheckedChange={setPurge} aria-label="同时清除持久化数据" />
            <span className="flex flex-col">
              <span className="text-sm font-medium">同时清除持久化数据（purge）</span>
              <span className="text-muted-foreground text-xs">删除该扩展在数据库中的数据记录，不可恢复。</span>
            </span>
          </label>
          <DialogFooter>
            <Button variant="outline" onClick={() => setUninstallTarget(null)}>
              取消
            </Button>
            <Button variant="destructive" onClick={() => void confirmUninstall()}>
              确认卸载
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** 路由表 Tab（<md 横向滚动；长路径 break-all 断行；客户端分页 20/页） */
const TAB_PAGE_SIZE = 20;

function RoutesTab({ routes, onRefresh }: { routes: ExtRouteTableEntry[] | null; onRefresh: () => void }): React.ReactNode {
  const [page, setPage] = useState(1);
  if (routes === null) return <TabSkeleton onRefresh={onRefresh} />;
  if (routes.length === 0) {
    return <EmptyState icon={BlocksIcon} title="暂无注册路由" description="当前启用的扩展没有注册任何 HTTP 路由。" />;
  }
  const totalPages = Math.max(1, Math.ceil(routes.length / TAB_PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const paged = routes.slice((safePage - 1) * TAB_PAGE_SIZE, safePage * TAB_PAGE_SIZE);
  return (
    <div className="overflow-hidden rounded-lg border">
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-24">方法</TableHead>
              <TableHead>路径</TableHead>
              <TableHead className="w-24">鉴权</TableHead>
              <TableHead className="w-44">扩展</TableHead>
              <TableHead className="w-28">超时</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {paged.map((r) => (
              <TableRow key={`${r.extId}:${r.method}:${r.path}`}>
                <TableCell>
                  <Badge variant={r.method === 'GET' ? 'secondary' : r.method === 'DELETE' ? 'destructive' : 'outline'} className="font-mono">
                    {r.method}
                  </Badge>
                </TableCell>
                <TableCell className="min-w-[180px] break-all font-mono text-xs" title={r.path}>
                  {r.path}
                </TableCell>
                <TableCell>
                  <Badge variant={r.auth === 'public' ? 'outline' : r.auth === 'admin' ? 'warning' : 'secondary'}>{r.auth}</Badge>
                </TableCell>
                <TableCell className="break-all font-mono text-xs">{r.extId}</TableCell>
                <TableCell className="text-muted-foreground tabular-nums text-xs">
                  {r.timeoutMs !== undefined ? `${r.timeoutMs} ms` : '默认'}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <Pagination
        page={safePage}
        pageSize={TAB_PAGE_SIZE}
        total={routes.length}
        onPageChange={setPage}
        className="border-t"
      />
    </div>
  );
}

/** 服务注册 Tab（长服务全名 break-all 断行；客户端分页 20/页） */
function RegistryTab({ registry, onRefresh }: { registry: ServiceEntry[] | null; onRefresh: () => void }): React.ReactNode {
  const [page, setPage] = useState(1);
  if (registry === null) return <TabSkeleton onRefresh={onRefresh} />;
  if (registry.length === 0) {
    return <EmptyState icon={BlocksIcon} title="暂无服务注册" description="当前启用的扩展没有通过 h.expose 暴露任何服务。" />;
  }
  const totalPages = Math.max(1, Math.ceil(registry.length / TAB_PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const paged = registry.slice((safePage - 1) * TAB_PAGE_SIZE, safePage * TAB_PAGE_SIZE);
  return (
    <div className="overflow-hidden rounded-lg border">
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>服务全名</TableHead>
              <TableHead>方法</TableHead>
              <TableHead className="w-28">状态</TableHead>
              <TableHead className="w-44">扩展</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {paged.map((s) => (
              <TableRow key={s.service}>
                <TableCell className="break-all font-mono text-xs">{s.service}</TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    {s.methods.map((m) => (
                      <Badge key={m} variant="outline" className="font-mono text-[11px]">
                        {m}
                      </Badge>
                    ))}
                  </div>
                </TableCell>
                <TableCell>
                  <Badge variant={s.status === 'active' ? 'success' : 'warning'}>{s.status === 'active' ? '活跃' : '已挂起'}</Badge>
                </TableCell>
                <TableCell className="break-all font-mono text-xs">{s.extId}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <Pagination
        page={safePage}
        pageSize={TAB_PAGE_SIZE}
        total={registry.length}
        onPageChange={setPage}
        className="border-t"
      />
    </div>
  );
}

/** UI 注册 Tab */
function UiTab({ entries, onRefresh }: { entries: UiSnapshotEntry[] | null; onRefresh: () => void }): React.ReactNode {
  if (entries === null) return <TabSkeleton onRefresh={onRefresh} />;
  if (entries.length === 0) {
    return <EmptyState icon={BlocksIcon} title="暂无 UI 注册" description="当前启用的扩展没有贡献任何 UI 片段（菜单 / 页面 / 小部件 / 渲染器）。" />;
  }
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {entries.map((e) => (
        <Card key={e.extId} className="gap-3 py-4">
          <CardContent className="flex flex-col gap-2.5 px-4">
            <p className="break-all font-mono text-xs font-semibold">{e.extId}</p>
            {e.menu !== undefined && (
              <p className="text-muted-foreground text-xs">
                菜单：<span className="text-foreground font-medium">{e.menu.label}</span>
              </p>
            )}
            {e.pages.length > 0 && (
              <div className="flex flex-col gap-1">
                <span className="text-muted-foreground text-xs">页面</span>
                {e.pages.map((p) => (
                  <p key={p.path} className="break-all text-xs" title={`${p.path} → ${p.entry}`}>
                    <span className="font-medium">{p.title}</span>
                    <span className="text-muted-foreground font-mono"> · {p.path}</span>
                  </p>
                ))}
              </div>
            )}
            {e.widgets.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {e.widgets.map((w) => (
                  <Badge key={w.id} variant="secondary" className="text-[11px]">
                    {w.title}
                  </Badge>
                ))}
              </div>
            )}
            {e.renderers.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {e.renderers.map((r) => (
                  <Badge key={r} variant="outline" className="font-mono text-[11px]">
                    {r}
                  </Badge>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

/** Tab 数据未就绪的骨架 */
function TabSkeleton({ onRefresh }: { onRefresh: () => void }): React.ReactNode {
  return (
    <div className="flex flex-col gap-3">
      <Skeleton className="h-32 rounded-lg" />
      <Button variant="outline" size="sm" className="w-fit" onClick={onRefresh}>
        <RefreshCwIcon aria-hidden />
        重新加载
      </Button>
    </div>
  );
}
