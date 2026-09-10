import { useCallback, useEffect, useState } from 'react';
import {
  EyeIcon,
  PackageOpenIcon,
  PackagePlusIcon,
  RefreshCwIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from 'lucide-react';

import { Pagination } from '@/components/pagination';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
import { pluginsApi } from '@/lib/api';
import { cn } from '@/lib/utils';
import { EmptyState, errText } from '@/pages/_shared';
import { PluginDetailDrawer } from '@/pages/Plugins/DetailDrawer';
import { InstallDialog } from '@/pages/Plugins/InstallDialog';
import { UninstallDialog } from '@/pages/Plugins/UninstallDialog';
import { ContributionChips, SecurityNotice, formatInstalledAt } from '@/pages/Plugins/shared';
import type { InstalledPlugin } from '@/pages/Plugins/shared';

/**
 * Plugins — 插件包管理（/plugins，表格布局）。
 *
 * 与内核 REST（src/api/plugins.ts，全部 admin/root）对齐：
 * - GET  /api/v1/plugins          已安装插件列表（registry.list()）→ 表格
 *                                 （插件 / 版本 / 贡献摘要 badges / 安装时间 / 操作）；
 * - POST /api/v1/plugins/install  安装 zip（InstallDialog；multipart field 'file' ≤64MB，
 *                                 `?overwrite=1` 覆盖）→ 201 后内核已自动 refresh 聚合注入，
 *                                 此处重拉列表即可；安装中反馈（按钮脉冲 + 「安装中…」），
 *                                 成功 toast / 失败内联 errText；
 * - POST /api/v1/plugins/refresh  重新扫描聚合（内核升级 / 手工放包后）→ { plugins }；
 * - GET  /api/v1/plugins/:id      详情（DetailDrawer：贡献明细四段 + 注册的技能 / MCP
 *                                 服务器清单——插件贡献即其「权限声明」面，REST 不暴露
 *                                 独立启停端点，卸载即唯一生命周期写操作）；
 * - DELETE /api/v1/plugins/:id    卸载（UninstallDialog；`?force=1` 摘贡献后删目录，
 *                                 贡献在用未 force → 403 HARNESS-1007）。
 *
 * 插件包格式（plugin.json + skills/ + mcp 声明 + scripts/）：脚本仅在执行沙箱容器内
 * 运行（非宿主）；MCP stdio 服务器进程在本机运行——见页面底部安全提示。
 */

/** 插件列表客户端分页基数（与其他管理页统一每页 20 条） */
const PLUGINS_PAGE_SIZE = 20;

export default function PluginsPage(): React.ReactNode {
  const [plugins, setPlugins] = useState<InstalledPlugin[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** POST /refresh 忙态 */
  const [refreshing, setRefreshing] = useState(false);
  /** 列表分页页码 */
  const [page, setPage] = useState(1);
  /** 安装弹窗 */
  const [installOpen, setInstallOpen] = useState(false);
  /** 详情抽屉目标 */
  const [detailTarget, setDetailTarget] = useState<InstalledPlugin | null>(null);
  /** 卸载确认目标 */
  const [uninstallTarget, setUninstallTarget] = useState<InstalledPlugin | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      setPlugins(await pluginsApi.list());
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** POST /refresh — 重新扫描聚合（应答即最新列表，直接落 state 免二次 GET） */
  const handleRefresh = useCallback(async (): Promise<void> => {
    setRefreshing(true);
    try {
      const res = await pluginsApi.refresh();
      setPlugins(res.plugins);
      toast.success('聚合完成', `共 ${res.plugins.length} 个插件`);
    } catch (e) {
      toast.error('聚合失败', errText(e));
    } finally {
      setRefreshing(false);
    }
  }, []);

  // 客户端分页切片（page 超界收敛）
  const total = (plugins ?? []).length;
  const totalPages = Math.max(1, Math.ceil(total / PLUGINS_PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pagedPlugins = (plugins ?? []).slice((safePage - 1) * PLUGINS_PAGE_SIZE, safePage * PLUGINS_PAGE_SIZE);

  const handleInstalled = useCallback(async (): Promise<void> => {
    setInstallOpen(false);
    await load();
  }, [load]);

  const handleUninstalled = useCallback(async (): Promise<void> => {
    setUninstallTarget(null);
    await load();
  }, [load]);

  return (
    <div className="flex flex-col gap-6">
      {/* 页头 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold tracking-tight">插件管理</h2>
          <p className="text-muted-foreground text-sm">声明式 LLM 插件的安装、聚合刷新、贡献明细查看与卸载。</p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => setInstallOpen(true)}>
            <PackagePlusIcon aria-hidden />
            安装插件
          </Button>
          <Button variant="outline" size="sm" onClick={() => void handleRefresh()} disabled={refreshing}>
            <RefreshCwIcon className={cn(refreshing && 'animate-spin')} aria-hidden />
            {refreshing ? '聚合中…' : '刷新'}
          </Button>
        </div>
      </div>

      {/* 加载骨架 */}
      {loading && (
        <div className="flex flex-col gap-3">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-14 rounded-lg" />
          ))}
        </div>
      )}

      {/* 错误态 */}
      {!loading && error !== null && (
        <EmptyState icon={TriangleAlertIcon} title="插件列表加载失败" description={error}>
          <Button size="sm" onClick={() => void load()}>
            <RefreshCwIcon aria-hidden />
            重试
          </Button>
        </EmptyState>
      )}

      {/* 空态：插件包格式说明 + 上传入口 */}
      {!loading && error === null && total === 0 && (
        <EmptyState
          icon={PackageOpenIcon}
          title="暂无已安装插件"
          description={
            <>
              插件包是一个 zip 压缩包：根部（或单一顶层目录）放一份{' '}
              <span className="font-mono text-xs">plugin.json</span> 清单，技能正文放{' '}
              <span className="font-mono text-xs">skills/</span>、可执行脚本放{' '}
              <span className="font-mono text-xs">scripts/</span>，MCP 服务器与提示词在清单的{' '}
              <span className="font-mono text-xs">mcpServers</span> /{' '}
              <span className="font-mono text-xs">prompts</span> 中声明。安装后由内核聚合注入，
              为 Harness 贡献技能、MCP 服务器、提示词与脚本。
            </>
          }
        >
          <Button size="sm" onClick={() => setInstallOpen(true)}>
            <PackagePlusIcon aria-hidden />
            安装插件包
          </Button>
        </EmptyState>
      )}

      {/* 已装插件表格（客户端分页） */}
      {!loading && error === null && total > 0 && (
        <>
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-56">插件</TableHead>
                  <TableHead className="w-24">版本</TableHead>
                  <TableHead>贡献摘要</TableHead>
                  <TableHead className="w-40">安装时间</TableHead>
                  <TableHead className="w-24 text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pagedPlugins.map((plugin) => (
                  <TableRow key={plugin.id}>
                    <TableCell className="max-w-[220px]">
                      <div className="flex flex-col gap-0.5">
                        <span className="truncate font-medium" title={plugin.name}>
                          {plugin.name}
                        </span>
                        {plugin.description !== '' && (
                          <span className="text-muted-foreground line-clamp-1 text-xs" title={plugin.description}>
                            {plugin.description}
                          </span>
                        )}
                        <span className="text-muted-foreground truncate font-mono text-xs" title={plugin.id}>
                          {plugin.id}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="font-mono text-[11px]">
                        v{plugin.version}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <ContributionChips plugin={plugin} />
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs tabular-nums">
                      {formatInstalledAt(plugin.installedAt)}
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1.5">
                        <Button
                          variant="outline"
                          size="icon-sm"
                          title="查看详情（贡献明细）"
                          aria-label={`查看插件 ${plugin.name} 详情`}
                          onClick={() => setDetailTarget(plugin)}
                        >
                          <EyeIcon aria-hidden />
                        </Button>
                        <Button
                          variant="outline"
                          size="icon-sm"
                          title="卸载"
                          aria-label={`卸载插件 ${plugin.name}`}
                          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                          onClick={() => setUninstallTarget(plugin)}
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
          <Pagination page={safePage} pageSize={PLUGINS_PAGE_SIZE} total={total} onPageChange={setPage} />
        </>
      )}

      {/* 安全提示区 */}
      <SecurityNotice />

      {/* 安装弹窗（zip 上传；安装中反馈 / 成功 toast / 失败内联 errText；201 后父级重拉列表） */}
      <InstallDialog open={installOpen} onOpenChange={setInstallOpen} onInstalled={() => void handleInstalled()} />

      {/* 详情抽屉（贡献明细四段：摘要 / 技能 / MCP / 提示词与脚本） */}
      <PluginDetailDrawer plugin={detailTarget} onClose={() => setDetailTarget(null)} />

      {/* 卸载确认弹窗（?force=1 贡献闸引导） */}
      <UninstallDialog
        target={uninstallTarget}
        onClose={() => setUninstallTarget(null)}
        onUninstalled={() => void handleUninstalled()}
      />
    </div>
  );
}
