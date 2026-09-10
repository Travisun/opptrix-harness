/**
 * Mcp/SystemServerCard — 系统操作 MCP 服务端只读状态卡（/mcp 网关）。
 *
 * 数据源：内核 /mcp（无状态 Streamable HTTP，JSON 响应式）——经 lib/api 的
 * getSystemMcpTools() 直发 JSON-RPC tools/list 探测：
 * - 成功 = 服务端在位（「运行中」徽标）+ 工具目录（折叠 Table：name/description）；
 * - 失败（401/403/404/网络）= 「不可探测」徽标 + 内联 errText，不阻塞上方客户端区块。
 *
 * 只读面：/mcp 的启停与工具目录由内核装配决定（system-tools.ts 单一事实来源），
 * REST 不提供写端点，本卡不发起任何变更请求。
 */
import { useCallback, useEffect, useState } from 'react';
import { RefreshCwIcon, ServerIcon, TriangleAlertIcon, WrenchIcon } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { getSystemMcpTools } from '@/lib/api';
import type { SystemMcpToolWire } from '@/lib/api';
import { cn } from '@/lib/utils';
import { errText } from '@/pages/_shared';

export function SystemServerCard(): React.ReactNode {
  const [tools, setTools] = useState<SystemMcpToolWire[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      setTools(await getSystemMcpTools());
    } catch (e) {
      setError(errText(e)); // 静默探测：不 toast，内联展示即可（服务端可能未装配 /mcp）
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toolCount = tools?.length ?? 0;

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            <ServerIcon className="text-primary size-4" aria-hidden />
            系统 MCP 服务端
            {loading && (
              <Badge variant="secondary" className="gap-1">
                探测中…
              </Badge>
            )}
            {!loading && error === null && (
              <Badge variant="success" className="gap-1">
                运行中
              </Badge>
            )}
            {!loading && error !== null && (
              <Badge variant="destructive" className="gap-1">
                不可探测
              </Badge>
            )}
          </CardTitle>
          <CardDescription>
            本系统的操作面同时以标准 MCP 工具对外暴露（系统操作工具目录），供外部 LLM / 系统经 MCP 协议调用。
          </CardDescription>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          <RefreshCwIcon className={cn(loading && 'animate-spin')} aria-hidden />
          重新探测
        </Button>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {/* 只读状态元信息 */}
        <div className="grid gap-x-4 gap-y-2.5 rounded-lg border p-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <MetaItem label="端点">
            <Badge variant="outline" className="font-mono text-[11px]">
              /mcp
            </Badge>
          </MetaItem>
          <MetaItem label="协议">Streamable HTTP（无状态 · JSON 响应）</MetaItem>
          <MetaItem label="鉴权">Bearer token · root / admin 或 mcp:call scope</MetaItem>
          <MetaItem label="工具总数">
            <span className="inline-flex items-center gap-1.5 font-mono text-xs tabular-nums">
              <WrenchIcon className="text-muted-foreground size-3.5" aria-hidden />
              {loading ? '—' : error !== null ? '—' : toolCount}
            </span>
          </MetaItem>
        </div>

        {/* 探测失败（内联错误，可重试） */}
        {!loading && error !== null && (
          <p className="text-destructive flex items-start gap-1.5 text-xs leading-relaxed">
            <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            工具目录探测失败：{error}（服务端未装配 /mcp、凭据无 mcp:call 权限或网络不可达时出现，不影响上方客户端连接。）
          </p>
        )}

        {/* 加载骨架 */}
        {loading && (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-2/3" />
          </div>
        )}

        {/* 工具目录折叠表（name/description；默认收起，避免长目录淹没页面） */}
        {!loading && error === null && tools !== null && (
          <details className="group rounded-lg border">
            <summary className="text-muted-foreground hover:text-foreground flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2.5 text-sm select-none [&::-webkit-details-marker]:hidden">
              <span className="font-medium">
                工具目录（<span className="tabular-nums">{toolCount}</span> 个系统操作工具）
              </span>
              <span className="text-xs group-open:hidden">展开</span>
              <span className="hidden text-xs group-open:inline">收起</span>
            </summary>
            <div className="border-t">
              {toolCount === 0 ? (
                <p className="text-muted-foreground px-3 py-3 text-xs">目录为空（未注册任何系统工具）。</p>
              ) : (
                <div className="max-h-96 overflow-y-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-64">工具名</TableHead>
                        <TableHead>描述</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {tools.map((tool) => (
                        <TableRow key={tool.name}>
                          <TableCell className="font-mono text-xs break-all">{tool.name}</TableCell>
                          <TableCell className="text-muted-foreground text-xs leading-relaxed break-words">
                            {tool.description ?? '—'}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>
          </details>
        )}
      </CardContent>
    </Card>
  );
}

/** 状态元信息单项（标签 + 内容） */
function MetaItem({ label, children }: { label: string; children: React.ReactNode }): React.ReactNode {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-muted-foreground text-xs">{label}</span>
      <span className="text-sm break-words">{children}</span>
    </div>
  );
}
