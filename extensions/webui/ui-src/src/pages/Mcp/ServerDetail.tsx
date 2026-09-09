/**
 * ServerDetail — 选中服务器的详情区（Tabs：工具 / 资源 / 提示）。
 *
 * 目录加载（serverId 过滤，全部 silent → 行内错误 + 重试，不 toast 刷屏）：
 * - GET /api/v1/mcp/tools?serverId=   工具目录（未连接 → 空数组）；
 * - GET /api/v1/mcp/:id/resources     资源目录（连接期缓存；未连接 → 500 INTERNAL）；
 * - GET /api/v1/mcp/:id/prompts       Prompt 目录（同上）。
 *
 * 状态未连接（never/error/disabled）时不发起目录请求，展示引导连接的空态；
 * 连接成功后由父页面 bump refreshTick 触发重新加载。资源内容读取（resources.read）
 * 不在当前 REST 9 端点内，资源 Tab 的「查看」仅展示目录元数据。
 */
import { useCallback, useEffect, useState } from 'react';
import {
  BlocksIcon,
  EyeIcon,
  MessageSquareQuoteIcon,
  PlayIcon,
  PlugZapIcon,
  RefreshCwIcon,
  BanIcon,
  TriangleAlertIcon,
  WrenchIcon,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { CodeBlock, EmptyState } from '@/pages/_shared';
import {
  MetaRow,
  StateBadge,
  TransportBadge,
  describeApiError,
  jsonPreview,
  serverTarget,
  type McpPromptInfo,
  type McpResourceInfo,
  type McpServerSummary,
  type McpToolRow,
} from '@/pages/Mcp/shared';
import { ToolCallDialog } from '@/pages/Mcp/ToolCallDialog';

/** 目录加载状态：data null = 加载中；error 非 null = 行内错误 */
interface Catalog<T> {
  data: T[] | null;
  error: string | null;
}

/** PromiseSettledResult → 目录状态（rejected 转行内错误文案，带错误码） */
function settle<T>(result: PromiseSettledResult<T[]>): Catalog<T> {
  if (result.status === 'fulfilled') return { data: result.value, error: null };
  return { data: [], error: describeApiError(result.reason) };
}

export function ServerDetail({
  server,
  busyAction,
  refreshTick,
  onConnect,
}: {
  server: McpServerSummary;
  /** 行级忙态动作名（connect 时禁用连接按钮） */
  busyAction: string | undefined;
  /** 父页面 bump 触发目录重载（连接成功后） */
  refreshTick: number;
  onConnect: () => void;
}): React.ReactNode {
  const [tools, setTools] = useState<Catalog<McpToolRow>>({ data: null, error: null });
  const [resources, setResources] = useState<Catalog<McpResourceInfo>>({ data: null, error: null });
  const [prompts, setPrompts] = useState<Catalog<McpPromptInfo>>({ data: null, error: null });
  const [callTool, setCallTool] = useState<McpToolRow | null>(null);
  const [viewResource, setViewResource] = useState<McpResourceInfo | null>(null);

  const connected = server.state === 'connected';

  const reload = useCallback(async (): Promise<void> => {
    const id = encodeURIComponent(server.id);
    setTools({ data: null, error: null });
    setResources({ data: null, error: null });
    setPrompts({ data: null, error: null });
    const [t, r, p] = await Promise.allSettled([
      api.get<McpToolRow[]>(`/api/v1/mcp/tools?serverId=${id}`, { silent: true }),
      api.get<McpResourceInfo[]>(`/api/v1/mcp/${id}/resources`, { silent: true }),
      api.get<McpPromptInfo[]>(`/api/v1/mcp/${id}/prompts`, { silent: true }),
    ]);
    setTools(settle(t));
    setResources(settle(r));
    setPrompts(settle(p));
  }, [server.id]);

  // 目录只在已连接时加载（未连接的 resources/prompts 会 500 not connected）；
  // 连接成功 / 手动刷新 / 切换目标时重新拉取。
  useEffect(() => {
    if (!connected) return;
    void reload();
  }, [connected, reload, refreshTick]);

  return (
    <Card>
      <CardContent className="flex flex-col gap-4 px-4">
        {/* 头部：名称/徽标/目标 + 连接与刷新 */}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="truncate text-sm font-semibold" title={server.name}>
                {server.name}
              </span>
              <TransportBadge transport={server.transport} />
              <StateBadge server={server} />
            </div>
            <p
              className="text-muted-foreground truncate font-mono text-xs"
              title={`${server.id} · ${serverTarget(server)}`}
            >
              {server.id} · {serverTarget(server)}
              {server.timeoutMs !== undefined ? ` · timeout ${server.timeoutMs}ms` : ''}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {server.enabled && (
              <Button variant="outline" size="sm" onClick={onConnect} disabled={busyAction !== undefined}>
                <PlugZapIcon className={cn(busyAction === 'connect' && 'animate-pulse')} aria-hidden />
                {connected ? '重连' : '连接'}
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={() => void reload()} disabled={!connected}>
              <RefreshCwIcon aria-hidden />
              刷新目录
            </Button>
          </div>
        </div>

        {/* 最近连接错误（error 态完整原因） */}
        {server.state === 'error' && server.error !== undefined && (
          <p className="text-destructive flex items-start gap-1.5 text-xs leading-relaxed">
            <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            {server.error}
          </p>
        )}

        <Tabs defaultValue="tools" className="gap-3">
          <TabsList>
            <TabsTrigger value="tools">
              工具
              {tools.data !== null && <Badge variant="secondary" className="ml-1 text-[10px] tabular-nums">{tools.data.length}</Badge>}
            </TabsTrigger>
            <TabsTrigger value="resources">
              资源
              {resources.data !== null && <Badge variant="secondary" className="ml-1 text-[10px] tabular-nums">{resources.data.length}</Badge>}
            </TabsTrigger>
            <TabsTrigger value="prompts">
              提示
              {prompts.data !== null && <Badge variant="secondary" className="ml-1 text-[10px] tabular-nums">{prompts.data.length}</Badge>}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="tools">
            <ToolsCatalog
              server={server}
              catalog={tools}
              busyAction={busyAction}
              onConnect={onConnect}
              onRetry={() => void reload()}
              onCall={setCallTool}
            />
          </TabsContent>

          <TabsContent value="resources">
            <ResourcesCatalog
              server={server}
              catalog={resources}
              busyAction={busyAction}
              onConnect={onConnect}
              onRetry={() => void reload()}
              onView={setViewResource}
            />
          </TabsContent>

          <TabsContent value="prompts">
            <PromptsCatalog server={server} catalog={prompts} busyAction={busyAction} onConnect={onConnect} onRetry={() => void reload()} />
          </TabsContent>
        </Tabs>
      </CardContent>

      <ToolCallDialog
        serverId={server.id}
        serverName={server.name}
        tool={callTool}
        onOpenChange={(open) => !open && setCallTool(null)}
      />

      {/* 资源查看（目录元数据；resources.read 不在当前 REST 面内） */}
      <Dialog open={viewResource !== null} onOpenChange={(open) => !open && setViewResource(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>资源详情</DialogTitle>
            <DialogDescription>连接期缓存的资源目录条目（内容读取暂未开放）。</DialogDescription>
          </DialogHeader>
          {viewResource !== null && (
            <div className="flex flex-col gap-3">
              <MetaRow label="名称">{viewResource.name ?? '—'}</MetaRow>
              <MetaRow label="URI">
                <span className="font-mono text-xs">{viewResource.uri}</span>
              </MetaRow>
              {viewResource.mimeType !== undefined && <MetaRow label="MIME">{viewResource.mimeType}</MetaRow>}
              {viewResource.description !== undefined && <MetaRow label="描述">{viewResource.description}</MetaRow>}
              <p className="text-muted-foreground text-xs leading-relaxed">
                resources.read 不在当前 Dashboard REST 面的 9 个端点内，故仅展示目录元数据。
              </p>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// 三个目录 Tab 的共用渲染分支
// ---------------------------------------------------------------------------

/** 未连接 / 已停用的目录占位（引导先连接） */
function CatalogGuard({
  server,
  busyAction,
  onConnect,
}: {
  server: McpServerSummary;
  busyAction: string | undefined;
  onConnect: () => void;
}): React.ReactNode {
  if (server.state === 'disabled') {
    return (
      <EmptyState icon={BanIcon} title="该服务器已停用" description="enabled=false 的服务器不参与连接；请先在列表中启用。" />
    );
  }
  return (
    <EmptyState
      icon={PlugZapIcon}
      title="该服务器未连接"
      description="工具/资源/提示目录在连接建立时缓存；先连接再查看。"
    >
      <Button size="sm" onClick={onConnect} disabled={busyAction !== undefined}>
        <PlugZapIcon aria-hidden />
        连接
      </Button>
    </EmptyState>
  );
}

/** 目录加载骨架 */
function CatalogSkeleton(): React.ReactNode {
  return (
    <div className="flex flex-col gap-2">
      {Array.from({ length: 3 }, (_, i) => (
        <Skeleton key={i} className="h-10 rounded-md" />
      ))}
    </div>
  );
}

/** 目录错误态（含重试） */
function CatalogError({ label, error, onRetry }: { label: string; error: string; onRetry: () => void }): React.ReactNode {
  return (
    <EmptyState icon={TriangleAlertIcon} title={`${label}目录加载失败`} description={error}>
      <Button size="sm" variant="outline" onClick={onRetry}>
        <RefreshCwIcon aria-hidden />
        重试
      </Button>
    </EmptyState>
  );
}

// ---------------------------------------------------------------------------
// 工具 Tab
// ---------------------------------------------------------------------------

function ToolsCatalog({
  server,
  catalog,
  busyAction,
  onConnect,
  onRetry,
  onCall,
}: {
  server: McpServerSummary;
  catalog: Catalog<McpToolRow>;
  busyAction: string | undefined;
  onConnect: () => void;
  onRetry: () => void;
  onCall: (tool: McpToolRow) => void;
}): React.ReactNode {
  if (server.state !== 'connected') return <CatalogGuard server={server} busyAction={busyAction} onConnect={onConnect} />;
  if (catalog.error !== null) return <CatalogError label="工具" error={catalog.error} onRetry={onRetry} />;
  if (catalog.data === null) return <CatalogSkeleton />;
  if (catalog.data.length === 0) {
    return <EmptyState icon={WrenchIcon} title="暂无工具" description="该 server 未声明任何工具（或未启用 tools 能力）。" />;
  }
  return (
    <div className="overflow-x-auto rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-56">工具名</TableHead>
            <TableHead>描述</TableHead>
            <TableHead className="w-24 text-right">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {catalog.data.map((tool) => (
            <TableRow key={tool.name}>
              <TableCell className="max-w-[240px] truncate font-mono text-xs font-medium" title={tool.name}>
                {tool.name}
              </TableCell>
              <TableCell className="max-w-[420px]">
                <p className="text-muted-foreground truncate text-xs" title={tool.description ?? ''}>
                  {tool.description ?? '—'}
                </p>
              </TableCell>
              <TableCell className="text-right">
                <Button variant="outline" size="sm" onClick={() => onCall(tool)}>
                  <PlayIcon aria-hidden />
                  调用
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 资源 Tab
// ---------------------------------------------------------------------------

function ResourcesCatalog({
  server,
  catalog,
  busyAction,
  onConnect,
  onRetry,
  onView,
}: {
  server: McpServerSummary;
  catalog: Catalog<McpResourceInfo>;
  busyAction: string | undefined;
  onConnect: () => void;
  onRetry: () => void;
  onView: (resource: McpResourceInfo) => void;
}): React.ReactNode {
  if (server.state !== 'connected') return <CatalogGuard server={server} busyAction={busyAction} onConnect={onConnect} />;
  if (catalog.error !== null) return <CatalogError label="资源" error={catalog.error} onRetry={onRetry} />;
  if (catalog.data === null) return <CatalogSkeleton />;
  if (catalog.data.length === 0) {
    return <EmptyState icon={BlocksIcon} title="暂无资源" description="该 server 未暴露任何资源（或未启用 resources 能力）。" />;
  }
  return (
    <div className="overflow-x-auto rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-44">名称</TableHead>
            <TableHead>URI</TableHead>
            <TableHead className="w-32">MIME</TableHead>
            <TableHead className="w-24 text-right">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {catalog.data.map((res) => (
            <TableRow key={res.uri}>
              <TableCell className="max-w-[180px] truncate" title={res.name ?? res.uri}>
                {res.name ?? '—'}
              </TableCell>
              <TableCell className="max-w-[320px] truncate font-mono text-xs" title={res.uri}>
                {res.uri}
              </TableCell>
              <TableCell className="text-muted-foreground font-mono text-xs">{res.mimeType ?? '—'}</TableCell>
              <TableCell className="text-right">
                <Button variant="outline" size="sm" onClick={() => onView(res)}>
                  <EyeIcon aria-hidden />
                  查看
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 提示 Tab
// ---------------------------------------------------------------------------

function PromptsCatalog({
  server,
  catalog,
  busyAction,
  onConnect,
  onRetry,
}: {
  server: McpServerSummary;
  catalog: Catalog<McpPromptInfo>;
  busyAction: string | undefined;
  onConnect: () => void;
  onRetry: () => void;
}): React.ReactNode {
  if (server.state !== 'connected') return <CatalogGuard server={server} busyAction={busyAction} onConnect={onConnect} />;
  if (catalog.error !== null) return <CatalogError label="提示" error={catalog.error} onRetry={onRetry} />;
  if (catalog.data === null) return <CatalogSkeleton />;
  if (catalog.data.length === 0) {
    return <EmptyState icon={MessageSquareQuoteIcon} title="暂无提示" description="该 server 未提供任何 Prompt 模板（或未启用 prompts 能力）。" />;
  }
  return (
    <div className="flex flex-col gap-2">
      {catalog.data.map((prompt) => (
        <div key={prompt.name} className="flex flex-col gap-1.5 rounded-md border p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs font-semibold">{prompt.name}</span>
          </div>
          {prompt.description !== undefined && (
            <p className="text-muted-foreground text-xs leading-relaxed">{prompt.description}</p>
          )}
          {prompt.arguments !== undefined && (
            <>
              <p className="text-muted-foreground text-[10px]">参数声明</p>
              <CodeBlock text={jsonPreview(prompt.arguments)} className="max-h-32" />
            </>
          )}
        </div>
      ))}
    </div>
  );
}
