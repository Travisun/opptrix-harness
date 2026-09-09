import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDownIcon, ChevronRightIcon, RefreshCwIcon, ScrollTextIcon, ShieldXIcon } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Pagination } from '@/components/pagination';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { errCode, errText, formatDateTime, type LogEntry } from '@/pages/_shared';
import { CodeBlock, EmptyState } from '@/pages/_shared';

/**
 * Logs — 内核日志查询（admin）。
 *
 * - GET /api/v1/system/logs?limit=&level= → 表格（时间 / 级别徽标 / scope / message；
 *   data JSON 折叠行点击展开）。后端按 id 倒序返回（最新在前），原样呈现；
 * - 级别过滤 Tabs（全部 / info / warn / error）+ 条数 Select（100 / 200 / 500）；
 * - 「刷新」按钮 + 30s 自动轮询开关（Switch，默认关）；
 * - 日志端点仅 admin/root 可读：normal 角色渲染友好 403 空态。
 */

/** 级别过滤项（'' = 不过滤） */
const LEVEL_FILTERS: Array<{ value: string; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'info', label: 'info' },
  { value: 'warn', label: 'warn' },
  { value: 'error', label: 'error' },
];

/** 条数档位 */
const LIMIT_OPTIONS = [100, 200, 500];

/** 表格客户端分页：每页条数 */
const LOG_PAGE_SIZE = 20;

/** 自动轮询周期（毫秒） */
const POLL_INTERVAL_MS = 30_000;

/** 级别 → 徽标配色（info 蓝 / warn 黄 / error 红 / 其余中性） */
function levelBadgeClass(level: string): string {
  switch (level.toLowerCase()) {
    case 'info':
    case 'notice':
      return 'border-transparent bg-blue-500/15 text-blue-600 dark:text-blue-400';
    case 'warn':
    case 'warning':
      return 'border-transparent bg-amber-500/15 text-amber-600 dark:text-amber-400';
    case 'error':
    case 'fatal':
      return 'border-transparent bg-red-500/15 text-red-600 dark:text-red-400';
    default:
      return 'border-transparent bg-secondary text-secondary-foreground';
  }
}

export default function LogsPage(): React.ReactNode {
  const [rows, setRows] = useState<LogEntry[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  const [levelFilter, setLevelFilter] = useState('all'); // Tabs 值；'all' = 不过滤
  const [limit, setLimit] = useState(200);
  const [auto, setAuto] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null); // 展开的 data 行（按行内容 key）
  /** 客户端分页（一次性拉取后前端切片） */
  const [page, setPage] = useState(1);

  const loadRef = useRef<() => Promise<void>>(() => Promise.resolve());

  const load = useCallback(
    async (opts: { silent?: boolean } = {}): Promise<void> => {
      if (opts.silent === true) setRefreshing(true);
      else setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({ limit: String(limit) });
        if (levelFilter !== 'all') params.set('level', levelFilter);
        const res = await api.get<{ items: LogEntry[] }>(`/api/v1/system/logs?${params.toString()}`, {
          silent: true,
        });
        setRows(res.items);
        setForbidden(false);
      } catch (e) {
        if (errCode(e) === 'HARNESS-1007') setForbidden(true);
        else setError(errText(e));
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [levelFilter, limit],
  );

  // level/limit 变化即重新拉取；loadRef 供轮询免依赖闭包
  useEffect(() => {
    void load();
  }, [load]);

  // 级别过滤 / 条数档位变化后回到第一页
  useEffect(() => {
    setPage(1);
  }, [levelFilter, limit]);

  useEffect(() => {
    loadRef.current = () => load({ silent: true });
  }, [load]);

  // 30s 自动轮询（默认关）
  useEffect(() => {
    if (!auto) return;
    const timer = setInterval(() => void loadRef.current(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [auto]);

  const showForbidden = forbidden;

  // 客户端分页：page 越界（过滤/刷新后变少）时收敛到有效页
  const logTotal = (rows ?? []).length;
  const logTotalPages = Math.max(1, Math.ceil(logTotal / LOG_PAGE_SIZE));
  const safePage = Math.min(page, logTotalPages);
  const pagedRows = (rows ?? []).slice((safePage - 1) * LOG_PAGE_SIZE, safePage * LOG_PAGE_SIZE);

  return (
    <div className="flex flex-col gap-6">
      {/* 页头 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold tracking-tight">日志</h2>
          <p className="text-muted-foreground text-sm">内核运行日志（SQLite 日志汇，最新在前）。</p>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={auto} onCheckedChange={setAuto} aria-label="30 秒自动刷新" />
            <span className="text-muted-foreground text-xs whitespace-nowrap">30s 自动刷新</span>
          </label>
          <div className="flex items-center gap-2">
            <Label className="text-muted-foreground text-xs">条数</Label>
            <Select value={String(limit)} onValueChange={(v) => setLimit(Number(v))}>
              <SelectTrigger size="sm" className="w-24" aria-label="日志条数">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LIMIT_OPTIONS.map((n) => (
                  <SelectItem key={n} value={String(n)}>
                    {n} 条
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button variant="outline" size="sm" onClick={() => void load({ silent: true })} disabled={refreshing}>
            <RefreshCwIcon className={cn(refreshing && 'animate-spin')} aria-hidden />
            刷新
          </Button>
        </div>
      </div>

      {/* 级别过滤 Tabs */}
      <Tabs value={levelFilter} onValueChange={setLevelFilter}>
        <TabsList>
          {LEVEL_FILTERS.map((f) => (
            <TabsTrigger key={f.value} value={f.value}>
              {f.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {/* 加载态 */}
      {loading && (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-10 rounded-md" />
          ))}
        </div>
      )}

      {/* 非 admin：友好 403 空态 */}
      {!loading && showForbidden && (
        <EmptyState
          icon={ShieldXIcon}
          title="需要管理员权限"
          description="日志查询仅对 admin / root 角色开放。如需访问，请联系管理员提升角色后刷新页面。"
        />
      )}

      {/* 错误态 */}
      {!loading && !showForbidden && error !== null && (
        <EmptyState icon={ScrollTextIcon} title="日志加载失败" description={error}>
          <Button size="sm" variant="outline" onClick={() => void load()}>
            重试
          </Button>
        </EmptyState>
      )}

      {/* 表格 */}
      {!loading && !showForbidden && error === null && rows !== null && (
        <Card className="gap-0 overflow-hidden py-0">
          <CardContent className="p-0">
            {rows.length === 0 ? (
              <p className="text-muted-foreground py-12 text-center text-sm">
                当前过滤条件下没有日志。
              </p>
            ) : (
              <>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-8" aria-label="展开" />
                      <TableHead className="w-44">时间</TableHead>
                      <TableHead className="w-20">级别</TableHead>
                      <TableHead className="w-36">Scope</TableHead>
                      <TableHead>消息</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pagedRows.map((row, i) => {
                      const hasData = row.data !== null && row.data !== undefined;
                      const rowKey = `${row.ts}|${row.scope}|${row.message}`;
                      const isOpen = expanded === rowKey;
                      return (
                        <LogRowGroup
                          key={`${rowKey}-${i}`}
                          row={row}
                          hasData={hasData}
                          open={isOpen}
                          onToggle={() => setExpanded(isOpen ? null : rowKey)}
                        />
                      );
                    })}
                  </TableBody>
                </Table>
                <Pagination
                  page={safePage}
                  pageSize={LOG_PAGE_SIZE}
                  total={logTotal}
                  onPageChange={setPage}
                  className="border-t"
                />
              </>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/** 单条日志：主行 + 可展开的 data JSON 行（折叠结构须成组渲染在 tbody 内） */
function LogRowGroup({
  row,
  hasData,
  open,
  onToggle,
}: {
  row: LogEntry;
  hasData: boolean;
  open: boolean;
  onToggle: () => void;
}): React.ReactNode {
  let dataText = '';
  if (hasData) {
    try {
      dataText = JSON.stringify(row.data, null, 2);
    } catch {
      dataText = String(row.data);
    }
  }
  return (
    <>
      <TableRow className={cn(hasData && 'cursor-pointer')} onClick={hasData ? onToggle : undefined}>
        <TableCell>
          {hasData && (
            <Button
              variant="ghost"
              size="icon-sm"
              className="size-6"
              aria-label={open ? '收起 data' : '展开 data'}
              onClick={(e) => {
                e.stopPropagation();
                onToggle();
              }}
            >
              {open ? <ChevronDownIcon aria-hidden /> : <ChevronRightIcon aria-hidden />}
            </Button>
          )}
        </TableCell>
        <TableCell className="text-muted-foreground font-mono text-xs whitespace-nowrap">
          {formatDateTime(row.ts)}
        </TableCell>
        <TableCell>
          <Badge className={levelBadgeClass(row.level)}>{row.level}</Badge>
        </TableCell>
        <TableCell className="text-muted-foreground max-w-36 truncate font-mono text-xs" title={row.scope}>
          {row.scope === '' ? '—' : row.scope}
        </TableCell>
        <TableCell className="max-w-md whitespace-pre-wrap break-words">{row.message}</TableCell>
      </TableRow>
      {open && hasData && (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={5} className="bg-muted/30 p-3">
            <CodeBlock text={dataText} className="max-h-64" />
          </TableCell>
        </TableRow>
      )}
    </>
  );
}
