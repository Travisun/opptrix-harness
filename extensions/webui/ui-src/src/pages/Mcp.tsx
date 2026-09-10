import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  NetworkIcon,
  PencilIcon,
  PlugZapIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
} from 'lucide-react';

import { Pagination } from '@/components/pagination';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
import { toast } from '@/components/ui/toast';
import { mcpApi } from '@/lib/api';
import { cn } from '@/lib/utils';
import { EmptyState, errText } from '@/pages/_shared';
import { ServerCreateDialog } from '@/pages/Mcp/ServerCreateDialog';
import { ServerDetail } from '@/pages/Mcp/ServerDetail';
import { ServerEditDialog } from '@/pages/Mcp/ServerEditDialog';
import { SystemServerCard } from '@/pages/Mcp/SystemServerCard';
import {
  StateBadge,
  TransportBadge,
  serverTarget,
  toastApiError,
  type McpServerSummary,
} from '@/pages/Mcp/shared';

/**
 * Mcp — MCP 管理（双区块：客户端连接 + 系统服务端）。
 *
 * 区块一「MCP 客户端连接」（本系统作为客户端接入外部 MCP server），
 * REST 契约（src/api/mcp.ts，全部 admin/root）：
 * - GET    /api/v1/mcp/servers             服务器列表（配置+运行态）；
 * - POST   /api/v1/mcp/servers             添加（只落盘不连接 → 提示显式「测试连接」）；
 * - PATCH  /api/v1/mcp/servers/:id         启停（enabled Switch；false 即断连）/ 名称 / headers；
 * - DELETE /api/v1/mcp/servers/:id         删除（confirm，先摘配置再断连）；
 * - POST   /api/v1/mcp/servers/:id/connect 测试连接 / 手动（重）连接（失败 500 带原因 → toast）；
 * - 「全部连接」：REST 无 refreshAll 端点，此处对 enabled 列表逐个 connect（批量语义）；
 * - 工具/资源/提示目录与调用在 ServerDetail（GET /tools?serverId=、POST /tools/call、
 *   GET /:id/resources、GET /:id/prompts），点行选中展开。
 *
 * 区块二「系统 MCP 服务端」（SystemServerCard）：/mcp 网关只读状态卡（端点/协议/鉴权/
 * 工具目录，JSON-RPC tools/list 探测，见 SystemServerCard）。
 *
 * 状态机（内核）：never → connect → connected | error；enabled=false 恒为 disabled。
 * 错误形状 {code,message,detail}：404 HARNESS-3004 / 504 HARNESS-2001 / 500 HARNESS-9003。
 */

/** 客户端连接列表客户端分页基数（与其他管理页统一每页 20 条） */
const MCP_PAGE_SIZE = 20;

export default function McpPage(): React.ReactNode {
  const [servers, setServers] = useState<McpServerSummary[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  /** 行级忙态：serverId → 动作名（toggle/connect/delete） */
  const [busy, setBusy] = useState<Record<string, string>>({});
  /** 批量连接（refreshAll 语义）进行中 */
  const [connectingAll, setConnectingAll] = useState(false);
  /** 客户端列表分页页码 */
  const [page, setPage] = useState(1);
  /** 详情区选中的 server id */
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** 目录重载信号（连接成功后 bump） */
  const [detailTick, setDetailTick] = useState(0);
  /** 添加 Dialog */
  const [createOpen, setCreateOpen] = useState(false);
  /** 编辑目标 */
  const [editTarget, setEditTarget] = useState<McpServerSummary | null>(null);
  /** 删除确认目标 */
  const [deleteTarget, setDeleteTarget] = useState<McpServerSummary | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setRefreshing(true);
    setError(null);
    try {
      setServers(await mcpApi.listServers());
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

  const sorted = useMemo(() => {
    const list = servers ?? [];
    return [...list].sort((a, b) => a.id.localeCompare(b.id));
  }, [servers]);

  const enabledCount = useMemo(() => (servers ?? []).filter((s) => s.enabled).length, [servers]);

  // 客户端分页切片（page 超界收敛）
  const total = sorted.length;
  const totalPages = Math.max(1, Math.ceil(total / MCP_PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pagedServers = sorted.slice((safePage - 1) * MCP_PAGE_SIZE, safePage * MCP_PAGE_SIZE);

  /** 选中目标解析（列表刷新后目标可能已被删除） */
  const selected = useMemo(
    () => (selectedId === null ? null : ((servers ?? []).find((s) => s.id === selectedId) ?? null)),
    [servers, selectedId],
  );
  useEffect(() => {
    if (selectedId !== null && selected === null) setSelectedId(null);
  }, [selected, selectedId]);

  /** 行级动作忙态包装 */
  const withBusy = useCallback(async (id: string, action: string, run: () => Promise<void>): Promise<void> => {
    setBusy((prev) => ({ ...prev, [id]: action }));
    try {
      await run();
    } finally {
      setBusy((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    }
  }, []);

  /** 启停：PATCH { enabled }（false 时内核立即断连） */
  const toggleEnabled = useCallback(
    (server: McpServerSummary, enabled: boolean): Promise<void> =>
      withBusy(server.id, 'toggle', async () => {
        try {
          await mcpApi.patchServer(server.id, { enabled });
          toast.success(enabled ? '已启用' : '已停用', enabled ? server.name : `${server.name}（既有连接已断开）`);
          await load();
        } catch (e) {
          toastApiError(e, enabled ? '启用失败' : '停用失败');
        }
      }),
    [withBusy, load],
  );

  /** 测试连接 / 手动（重）连接：POST :id/connect 返回 state+toolCount；失败 500 带原因 → toast；
   * 成败均刷新列表（回显最新状态），成功后触发详情目录重载 */
  const connect = useCallback(
    (server: McpServerSummary): Promise<void> =>
      withBusy(server.id, 'connect', async () => {
        try {
          const status = await mcpApi.connectServer(server.id);
          toast.success('连接成功', `${server.name} · 状态 ${status.state} · 缓存工具 ${status.toolCount} 个`);
          setDetailTick((n) => n + 1);
        } catch (e) {
          toastApiError(e, '测试连接失败');
        } finally {
          await load();
        }
      }),
    [withBusy, load],
  );

  /** 批量连接（refreshAll 语义：REST 无该端点 → 对 enabled 逐个 connect） */
  const connectAll = useCallback(async (): Promise<void> => {
    const targets = (servers ?? []).filter((s) => s.enabled);
    if (targets.length === 0) {
      toast.info('没有已启用的服务器', '先在列表中启用（Switch），再执行全部连接');
      return;
    }
    setConnectingAll(true);
    let ok = 0;
    const failed: string[] = [];
    try {
      for (const target of targets) {
        try {
          await mcpApi.connectServer(target.id);
          ok += 1;
        } catch (e) {
          const message = errText(e);
          failed.push(`${target.name}（${message}）`);
        }
      }
    } finally {
      setConnectingAll(false);
      await load();
      setDetailTick((n) => n + 1);
    }
    if (failed.length === 0) {
      toast.success('全部已连接', `${ok} 个已启用服务器连接成功`);
    } else if (ok === 0) {
      toast.error('全部连接失败', failed.slice(0, 2).join('；'));
    } else {
      toast.info(`部分连接失败（成功 ${ok} · 失败 ${failed.length}）`, failed.slice(0, 2).join('；'));
    }
  }, [servers, load]);

  /** 删除（confirm 后）：DELETE 摘配置并断连 */
  const remove = useCallback((): Promise<void> => {
    const target = deleteTarget;
    if (target === null) return Promise.resolve();
    return withBusy(target.id, 'delete', async () => {
      try {
        await mcpApi.removeServer(target.id);
        toast.success('已删除', target.name);
        setDeleteTarget(null);
        if (selectedId === target.id) setSelectedId(null);
        await load();
      } catch (e) {
        toastApiError(e, '删除失败');
      }
    });
  }, [deleteTarget, selectedId, withBusy, load]);

  /** 创建成功：刷新列表、选中新服务器（其目录仍为空，连接后加载） */
  const handleCreated = useCallback(
    async (id: string): Promise<void> => {
      await load();
      setSelectedId(id);
      setDetailTick((n) => n + 1);
    },
    [load],
  );

  /** 编辑保存（PATCH name/headers）：刷新列表即可 */
  const handleSaved = useCallback(async (): Promise<void> => {
    await load();
  }, [load]);

  const rowBusy = (id: string): boolean => busy[id] !== undefined;

  return (
    <div className="flex flex-col gap-6">
      {/* 页头 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold tracking-tight">MCP 管理</h2>
          <p className="text-muted-foreground text-sm">
            客户端连接外部 MCP Server 与系统服务端状态。保存仅落盘配置（不自动连接），需显式「测试连接」建立会话。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <PlusIcon aria-hidden />
            添加服务器
          </Button>
          <Button variant="outline" size="sm" onClick={() => void connectAll()} disabled={connectingAll || enabledCount === 0}>
            <PlugZapIcon className={cn(connectingAll && 'animate-pulse')} aria-hidden />
            {connectingAll ? '连接中…' : '全部连接'}
          </Button>
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={refreshing}>
            <RefreshCwIcon className={cn(refreshing && 'animate-spin')} aria-hidden />
            刷新
          </Button>
        </div>
      </div>

      {/* ------------------------------------------------ 区块一：MCP 客户端连接 */}
      <section className="flex flex-col gap-3">
        <div className="flex flex-col gap-0.5">
          <h3 className="text-sm font-semibold tracking-tight">MCP 客户端连接</h3>
          <p className="text-muted-foreground text-xs">
            本系统作为 MCP 客户端（Host）接入的外部 MCP Server：stdio 子进程或 streamable-http / sse 远端。
          </p>
        </div>

        {/* 加载骨架 */}
        {loading && <Skeleton className="h-72 rounded-lg" />}

        {/* 错误态 */}
        {!loading && error !== null && (
          <EmptyState icon={NetworkIcon} title="服务器列表加载失败" description={error}>
            <Button size="sm" onClick={() => void load()}>
              <RefreshCwIcon aria-hidden />
              重试
            </Button>
          </EmptyState>
        )}

        {/* 空态 */}
        {!loading && error === null && total === 0 && (
          <EmptyState
            icon={NetworkIcon}
            title="暂无 MCP 服务器"
            description="添加一个外部 MCP Server（stdio 子进程或 streamable-http/sse 远端）。保存仅写入配置，创建后请点击「测试连接」。"
          >
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <PlusIcon aria-hidden />
              添加服务器
            </Button>
          </EmptyState>
        )}

        {/* 服务器表格（客户端分页；点行展开工具/资源/提示目录） */}
        {!loading && error === null && total > 0 && (
          <>
            <div className="overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>名称</TableHead>
                    <TableHead className="w-40">传输</TableHead>
                    <TableHead className="w-16">启用</TableHead>
                    <TableHead className="w-32">状态</TableHead>
                    <TableHead className="w-16 text-right">工具</TableHead>
                    <TableHead className="w-36 text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pagedServers.map((server) => (
                    <TableRow
                      key={server.id}
                      data-state={selectedId === server.id ? 'selected' : undefined}
                      className="cursor-pointer"
                      onClick={() => setSelectedId(server.id)}
                    >
                      <TableCell className="max-w-[260px]">
                        <div className="flex flex-col gap-0.5">
                          <span className="truncate font-medium" title={server.name}>
                            {server.name}
                          </span>
                          <span className="text-muted-foreground truncate font-mono text-xs" title={`${server.id} · ${serverTarget(server)}`}>
                            {server.id} · {serverTarget(server)}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <TransportBadge transport={server.transport} />
                      </TableCell>
                      <TableCell>
                        <Switch
                          checked={server.enabled}
                          disabled={rowBusy(server.id)}
                          onCheckedChange={(checked) => void toggleEnabled(server, checked)}
                          onClick={(e) => e.stopPropagation()}
                          aria-label={server.enabled ? `停用 ${server.name}` : `启用 ${server.name}`}
                        />
                      </TableCell>
                      <TableCell>
                        <StateBadge server={server} />
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs tabular-nums">{server.toolCount}</TableCell>
                      <TableCell>
                        <div className="flex justify-end gap-1.5">
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={rowBusy(server.id) || !server.enabled}
                            title={server.state === 'connected' ? '重连（连通性测试）' : '测试连接'}
                            onClick={(e) => {
                              e.stopPropagation();
                              void connect(server);
                            }}
                          >
                            <PlugZapIcon className={cn(busy[server.id] === 'connect' && 'animate-pulse')} aria-hidden />
                            {server.state === 'connected' ? '重连' : '测试'}
                          </Button>
                          <Button
                            variant="outline"
                            size="icon-sm"
                            title="编辑"
                            onClick={(e) => {
                              e.stopPropagation();
                              setEditTarget(server);
                            }}
                          >
                            <PencilIcon aria-hidden />
                          </Button>
                          <Button
                            variant="outline"
                            size="icon-sm"
                            title="删除"
                            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                            disabled={rowBusy(server.id)}
                            onClick={(e) => {
                              e.stopPropagation();
                              setDeleteTarget(server);
                            }}
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
            <Pagination page={safePage} pageSize={MCP_PAGE_SIZE} total={total} onPageChange={setPage} />
          </>
        )}

        {/* 选中服务器 → 详情区（工具/资源/提示 Tabs） */}
        {selected !== null && (
          <ServerDetail
            server={selected}
            busyAction={busy[selected.id]}
            refreshTick={detailTick}
            onConnect={() => void connect(selected)}
          />
        )}
      </section>

      {/* ------------------------------------------------ 区块二：系统 MCP 服务端 */}
      <section className="flex flex-col gap-3">
        <div className="flex flex-col gap-0.5">
          <h3 className="text-sm font-semibold tracking-tight">系统 MCP 服务端</h3>
          <p className="text-muted-foreground text-xs">
            本系统同时作为 MCP 服务端对外暴露系统操作工具（只读状态；启停由内核装配决定）。
          </p>
        </div>
        <SystemServerCard />
      </section>

      {/* 添加服务器（POST 只落盘，创建后提示显式连接） */}
      <ServerCreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        existingIds={sorted.map((s) => s.id)}
        onCreated={handleCreated}
      />

      {/* 编辑（PATCH 仅支持 name/headers；拓扑字段删除后重建） */}
      <ServerEditDialog server={editTarget} onOpenChange={(open) => !open && setEditTarget(null)} onSaved={handleSaved} />

      {/* 删除确认 */}
      <Dialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除 MCP 服务器</DialogTitle>
            <DialogDescription>
              确定要删除「{deleteTarget?.name}」
              {deleteTarget !== null && <span className="font-mono text-xs">（{deleteTarget.id}）</span>}吗？
              将移除其配置并断开既有连接，此操作不可恢复。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              取消
            </Button>
            <Button variant="destructive" onClick={() => void remove()} disabled={deleteTarget !== null && rowBusy(deleteTarget.id)}>
              确认删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
