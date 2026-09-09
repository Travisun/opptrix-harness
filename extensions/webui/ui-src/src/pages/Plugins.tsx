import { useCallback, useEffect, useState } from 'react';
import {
  PackageOpenIcon,
  PackagePlusIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { EmptyState, errText } from '@/pages/_shared';
import { InstallDialog } from '@/pages/Plugins/InstallDialog';
import { PluginCard } from '@/pages/Plugins/PluginCard';
import { PluginDetailDrawer } from '@/pages/Plugins/DetailDrawer';
import { UninstallDialog } from '@/pages/Plugins/UninstallDialog';
import { SecurityNotice } from '@/pages/Plugins/shared';
import type { InstalledPlugin } from '@/pages/Plugins/shared';

/**
 * Plugins — 插件包管理（/plugins）。
 *
 * 与内核 REST（src/api/plugins.ts，全部 admin/root）对齐：
 * - GET  /api/v1/plugins          已安装插件列表（registry.list()）；
 * - POST /api/v1/plugins/install  安装 zip（InstallDialog；multipart field 'file' ≤64MB，
 *                                 `?overwrite=1` 覆盖）→ 201 后内核已自动 refresh 聚合注入，
 *                                 此处重拉列表即可；
 * - POST /api/v1/plugins/refresh  重新扫描聚合（内核升级 / 手工放包后）→ { plugins }；
 * - GET  /api/v1/plugins/:id      详情（DetailDrawer）；
 * - DELETE /api/v1/plugins/:id    卸载（UninstallDialog；`?force=1` 摘贡献后删目录，
 *                                 贡献在用未 force → 403 HARNESS-1007）。
 *
 * 插件包格式（plugin.json + skills/ + mcp 声明 + scripts/）：脚本仅在执行沙箱容器内
 * 运行（非宿主）；MCP stdio 服务器进程在本机运行——见页面底部安全提示。
 */
export default function PluginsPage(): React.ReactNode {
  const [plugins, setPlugins] = useState<InstalledPlugin[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** POST /refresh 忙态 */
  const [refreshing, setRefreshing] = useState(false);
  /** 安装弹窗 */
  const [installOpen, setInstallOpen] = useState(false);
  /** 详情抽屉目标 */
  const [detailTarget, setDetailTarget] = useState<InstalledPlugin | null>(null);
  /** 卸载确认目标 */
  const [uninstallTarget, setUninstallTarget] = useState<InstalledPlugin | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      setPlugins(await api.get<InstalledPlugin[]>('/api/v1/plugins'));
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
      const res = await api.post<{ plugins: InstalledPlugin[] }>('/api/v1/plugins/refresh');
      setPlugins(res.plugins);
      toast.success('聚合完成', `共 ${res.plugins.length} 个插件`);
    } catch (e) {
      toast.error('聚合失败', errText(e));
    } finally {
      setRefreshing(false);
    }
  }, []);

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
          <h2 className="text-lg font-semibold tracking-tight">插件包</h2>
          <p className="text-muted-foreground text-sm">声明式插件包的安装、聚合刷新、贡献明细查看与卸载。</p>
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
        <div className="grid gap-3 md:grid-cols-2">
          {Array.from({ length: 2 }, (_, i) => (
            <Skeleton key={i} className="h-44 rounded-lg" />
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
      {!loading && error === null && (plugins ?? []).length === 0 && (
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

      {/* 插件卡片列表（<md 单列，≥md 双列） */}
      {!loading && error === null && (plugins ?? []).length > 0 && (
        <div className="grid gap-3 md:grid-cols-2">
          {(plugins ?? []).map((plugin) => (
            <PluginCard
              key={plugin.id}
              plugin={plugin}
              onDetail={() => setDetailTarget(plugin)}
              onUninstall={() => setUninstallTarget(plugin)}
            />
          ))}
        </div>
      )}

      {/* 安全提示区 */}
      <SecurityNotice />

      {/* 安装弹窗（201 后父级重拉列表；内核在 install 内已完成聚合注入） */}
      <InstallDialog open={installOpen} onOpenChange={setInstallOpen} onInstalled={() => void handleInstalled()} />

      {/* 详情抽屉（贡献明细四段） */}
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
