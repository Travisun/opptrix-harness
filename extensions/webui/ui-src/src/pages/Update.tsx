import { useCallback, useEffect, useState } from 'react';
import {
  CircleArrowUpIcon,
  HistoryIcon,
  RefreshCwIcon,
  RocketIcon,
  SatelliteIcon,
  TriangleAlertIcon,
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
import type { UpdateCheckResult, UpdateHistoryEntry } from '@/pages/_shared';
import { errText, formatDateTime } from '@/pages/_shared';

/**
 * Update — 内核升级。
 *
 * - GET  /api/v1/system/update          检查更新（feedOk=false → 空态说明未配置/不可达）；
 * - POST /api/v1/system/update/apply    执行升级（Apply Dialog：版本 + 「将自动重启」警示 → 202
 *                                       → toast「升级进行中，服务即将重启」）；
 * - GET  /api/v1/system/update/history  发布历史表格。
 */

export default function UpdatePage(): React.ReactNode {
  const [check, setCheck] = useState<UpdateCheckResult | null>(null);
  const [history, setHistory] = useState<UpdateHistoryEntry[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [applyOpen, setApplyOpen] = useState(false);
  const [applying, setApplying] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setChecking(true);
    setError(null);
    try {
      const [checkRes, historyRes] = await Promise.all([
        api.get<UpdateCheckResult>('/api/v1/system/update'),
        api.get<UpdateHistoryEntry[]>('/api/v1/system/update/history'),
      ]);
      setCheck(checkRes);
      setHistory(historyRes);
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const apply = useCallback(async (): Promise<void> => {
    setApplying(true);
    try {
      await api.post<{ accepted: boolean; slot: string; version: string }>('/api/v1/system/update/apply', {});
      toast.success('升级进行中，服务即将重启', '下载 / 校验 / 切槽完成后内核会自动重启，稍后请刷新页面确认新版本');
      setApplyOpen(false);
      // 延迟刷新历史（重启前 apply 记录可能已落库）
      setTimeout(() => void load(), 2000);
    } catch (e) {
      toast.error('升级失败', errText(e));
    } finally {
      setApplying(false);
    }
  }, [load]);

  const feedOk = check?.feedOk === true;
  const available = check?.available ?? null;

  return (
    <div className="flex flex-col gap-6">
      {/* 页头 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold tracking-tight">升级</h2>
          <p className="text-muted-foreground text-sm">版本检查、升级执行与历史记录。</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={checking}>
          <RefreshCwIcon className={cn(checking && 'animate-spin')} aria-hidden />
          {checking ? '检查中…' : '检查更新'}
        </Button>
      </div>

      {/* 加载骨架 */}
      {loading && (
        <div className="flex flex-col gap-4">
          <Skeleton className="h-40 rounded-lg" />
          <Skeleton className="h-48 rounded-lg" />
        </div>
      )}

      {/* 错误态 */}
      {!loading && error !== null && (
        <EmptyState icon={TriangleAlertIcon} title="升级信息加载失败" description={error}>
          <Button size="sm" onClick={() => void load()}>
            重试
          </Button>
        </EmptyState>
      )}

      {!loading && error === null && check !== null && (
        <>
          {/* feed 不可用 → 空态说明 */}
          {!feedOk && (
            <EmptyState
              icon={SatelliteIcon}
              title="升级源不可用"
              description={
                <>
                  未配置升级 feed（或 feed 拉取失败），无法检查新版本。
                  {check.error !== undefined && check.error !== '' && (
                    <>
                      <br />
                      <span className="font-mono text-xs break-all">{check.error}</span>
                    </>
                  )}
                </>
              }
            >
              <p className="text-muted-foreground max-w-md text-left text-xs leading-relaxed">
                配置方式：设置升级 feed 相关环境变量（指向提供 channel/version/url/sha256 清单的发布源）后重启内核；
                当前版本仍可正常查看。
              </p>
              <Button size="sm" variant="outline" onClick={() => void load()}>
                <RefreshCwIcon aria-hidden />
                重新检查
              </Button>
            </EmptyState>
          )}

          {/* 版本信息卡 */}
          {feedOk && (
            <Card>
              <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 space-y-0">
                <div className="flex flex-col gap-1.5">
                  <CardTitle className="text-base">版本状态</CardTitle>
                  <CardDescription>
                    {available === null
                      ? '当前已是最新版本'
                      : `发现新版本 ${available.version}（${available.channel} 频道）`}
                  </CardDescription>
                </div>
                <Badge variant={available === null ? 'success' : 'warning'}>
                  {available === null ? '已是最新' : '可升级'}
                </Badge>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <div className="grid gap-3 sm:grid-cols-3">
                  <div className="rounded-md border p-3">
                    <p className="text-muted-foreground text-xs">当前版本</p>
                    <p className="mt-1 font-mono text-sm font-semibold">{check.currentVersion ?? '未知（首装）'}</p>
                  </div>
                  <div className="rounded-md border p-3">
                    <p className="text-muted-foreground text-xs">可用版本</p>
                    <p className="mt-1 font-mono text-sm font-semibold">{available?.version ?? '—'}</p>
                  </div>
                  <div className="rounded-md border p-3">
                    <p className="text-muted-foreground text-xs">发布频道</p>
                    <p className="mt-1 font-mono text-sm font-semibold">{available?.channel ?? '—'}</p>
                  </div>
                </div>
                {available?.notes !== undefined && available.notes !== '' && (
                  <div className="bg-muted/50 rounded-md border p-3">
                    <p className="text-muted-foreground mb-1 text-xs font-medium">发布说明</p>
                    <p className="text-sm leading-relaxed break-words whitespace-pre-wrap">{available.notes}</p>
                  </div>
                )}
                {available !== null && (
                  <Button className="w-fit" onClick={() => setApplyOpen(true)}>
                    <RocketIcon aria-hidden />
                    升级到 {available.version}
                  </Button>
                )}
              </CardContent>
            </Card>
          )}

          {/* 发布历史 */}
          <Card>
            <CardHeader className="flex flex-row items-center gap-2 space-y-0">
              <HistoryIcon className="text-muted-foreground size-4" aria-hidden />
              <CardTitle className="text-base">发布历史</CardTitle>
            </CardHeader>
            <CardContent>
              {history === null ? (
                <p className="text-muted-foreground py-4 text-center text-sm">历史不可用</p>
              ) : history.length === 0 ? (
                <p className="text-muted-foreground py-6 text-center text-sm">暂无升级记录（history.json 尚未生成）</p>
              ) : (
                <div className="overflow-x-auto rounded-lg border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-32">版本</TableHead>
                        <TableHead className="w-24">结果</TableHead>
                        <TableHead className="w-52">执行时间</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {history.map((h, i) => (
                        <TableRow key={`${h.version}:${i}`}>
                          <TableCell className="font-mono text-xs font-medium">v{h.version}</TableCell>
                          <TableCell>
                            <Badge variant={h.ok ? 'success' : 'destructive'}>{h.ok ? '成功' : '失败'}</Badge>
                          </TableCell>
                          <TableCell className="text-muted-foreground text-xs tabular-nums">
                            {formatDateTime(h.appliedAt)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}

      {/* Apply 确认 Dialog */}
      <Dialog open={applyOpen} onOpenChange={(open) => !open && !applying && setApplyOpen(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CircleArrowUpIcon className="size-5" aria-hidden />
              确认执行升级
            </DialogTitle>
            <DialogDescription>
              将内核从 v{check?.currentVersion ?? '?'} 升级到 v{check?.available?.version ?? '?'}（{check?.available?.channel ?? ''} 频道）。
            </DialogDescription>
          </DialogHeader>
          <p className="text-destructive bg-destructive/5 flex items-start gap-2 rounded-md border border-dashed p-3 text-xs leading-relaxed">
            <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            升级完成后服务将自动重启，期间管理台与 API 会短暂不可用；请确认当前没有正在执行的关键任务。
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setApplyOpen(false)} disabled={applying}>
              取消
            </Button>
            <Button onClick={() => void apply()} disabled={applying}>
              <RocketIcon aria-hidden />
              {applying ? '提交中…' : '开始升级'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
