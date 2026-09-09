import { useCallback, useEffect, useState } from 'react';
import {
  BellIcon,
  CheckCheckIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  PlusIcon,
  RefreshCwIcon,
  SendIcon,
  Trash2Icon,
  WebhookIcon,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { useNotifications } from '@/features/notifications/NotificationsProvider';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { EmptyState, LevelBadge } from '@/pages/_shared';
import type { NotificationDrivers, NotificationRecord, NotificationRouteRule } from '@/pages/_shared';
import { errText, formatDateTime, parseJsonInput } from '@/pages/_shared';

/**
 * Notifications — 通知中心。
 *
 * - GET  /api/v1/notifications?limit=50      列表（未读高亮 / level 徽标 / data 折叠）；
 * - POST /api/v1/notifications/:id/read      单条已读；
 * - POST /api/v1/notifications/read-all      全部已读；
 * - POST /api/v1/notifications/send          发送测试通知（Dialog）；
 * - GET/PUT /api/v1/notifications/routes     路由规则编辑器（match.level + channels 重复组）；
 * - GET  /api/v1/notifications/drivers       可用驱动 chips。
 * 已读操作后调用 NotificationsProvider.refresh() 同步顶栏未读徽标。
 */

const LEVEL_OPTIONS = ['info', 'success', 'warning', 'error'] as const;

/** 驱动选择候选：drivers.notification + 已有规则中出现过的 driver（保证回显不丢项） */
function driverOptions(drivers: NotificationDrivers | null, rules: NotificationRouteRule[]): string[] {
  const set = new Set<string>(drivers?.notification ?? []);
  for (const rule of rules) for (const ch of rule.channels) if (ch.driver !== '') set.add(ch.driver);
  return [...set];
}

export default function NotificationsPage(): React.ReactNode {
  const notifier = useNotifications();
  const [items, setItems] = useState<NotificationRecord[] | null>(null);
  const [drivers, setDrivers] = useState<NotificationDrivers | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  /** 行级忙态 */
  const [busyId, setBusyId] = useState<string | null>(null);
  const [readAllBusy, setReadAllBusy] = useState(false);
  /** 展开data 的条目 */
  const [expandedId, setExpandedId] = useState<string | null>(null);
  /** 发送测试 Dialog */
  const [sendOpen, setSendOpen] = useState(false);
  const [sendTitle, setSendTitle] = useState('');
  const [sendBody, setSendBody] = useState('');
  const [sendLevel, setSendLevel] = useState<string>('info');
  const [sending, setSending] = useState(false);
  /** 路由规则 Dialog */
  const [routesOpen, setRoutesOpen] = useState(false);
  const [rules, setRules] = useState<NotificationRouteRule[]>([]);
  const [routesLoading, setRoutesLoading] = useState(false);
  const [savingRoutes, setSavingRoutes] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setRefreshing(true);
    setError(null);
    try {
      const [listRes, driversRes] = await Promise.all([
        api.get<{ items: NotificationRecord[]; unread: number }>('/api/v1/notifications?limit=50'),
        api.get<NotificationDrivers>('/api/v1/notifications/drivers'),
      ]);
      setItems(listRes.items);
      setDrivers(driversRes);
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

  const markRead = useCallback(
    async (item: NotificationRecord): Promise<void> => {
      setBusyId(item.id);
      try {
        await api.post(`/api/v1/notifications/${encodeURIComponent(item.id)}/read`);
        setItems((prev) => (prev ?? []).map((it) => (it.id === item.id ? { ...it, readAt: Date.now() } : it)));
        void notifier.refresh();
      } catch (e) {
        toast.error('标记已读失败', errText(e));
      } finally {
        setBusyId(null);
      }
    },
    [notifier],
  );

  const markAllRead = useCallback(async (): Promise<void> => {
    setReadAllBusy(true);
    try {
      const res = await api.post<{ updated: number }>('/api/v1/notifications/read-all');
      toast.success('全部已读', `共更新 ${res.updated} 条`);
      await load();
      void notifier.refresh();
    } catch (e) {
      toast.error('操作失败', errText(e));
    } finally {
      setReadAllBusy(false);
    }
  }, [load, notifier]);

  const handleSend = useCallback(async (): Promise<void> => {
    const title = sendTitle.trim();
    if (title === '') {
      toast.error('请填写通知标题');
      return;
    }
    setSending(true);
    try {
      await api.post('/api/v1/notifications/send', { title, body: sendBody, level: sendLevel });
      toast.success('测试通知已发送', '站内通知即时可见，渠道投递按路由规则执行');
      setSendOpen(false);
      setSendTitle('');
      setSendBody('');
      setSendLevel('info');
      await load();
      void notifier.refresh();
    } catch (e) {
      toast.error('发送失败', errText(e));
    } finally {
      setSending(false);
    }
  }, [sendTitle, sendBody, sendLevel, load, notifier]);

  const openRoutes = useCallback(async (): Promise<void> => {
    setRoutesOpen(true);
    setRoutesLoading(true);
    try {
      const res = await api.get<unknown>('/api/v1/notifications/routes', { silent: true });
      setRules(Array.isArray(res) ? (res as NotificationRouteRule[]) : []);
    } catch {
      // 未配置过路由（部分实现返回 404/空）：按空规则数组处理
      setRules([]);
    } finally {
      setRoutesLoading(false);
    }
  }, []);

  const saveRoutes = useCallback(async (): Promise<void> => {
    // 提交前对每条 target 做 JSON 校验（空串 → null）
    const normalized: NotificationRouteRule[] = [];
    for (const rule of rules) {
      const channels: Array<{ driver: string; target: unknown }> = [];
      for (const ch of rule.channels) {
        if (ch.driver.trim() === '') {
          toast.error('请为每个渠道选择 driver');
          return;
        }
        const parsed = parseJsonInput(typeof ch.target === 'string' ? (ch.target as string) : '');
        if (!parsed.ok) {
          toast.error('target 不是合法 JSON', parsed.message);
          return;
        }
        channels.push({ driver: ch.driver.trim(), target: parsed.value ?? null });
      }
      if (channels.length === 0) {
        toast.error('每条规则至少需要一个投递渠道');
        return;
      }
      normalized.push({ match: { level: rule.match.level ?? 'any' }, channels });
    }
    setSavingRoutes(true);
    try {
      await api.put('/api/v1/notifications/routes', normalized);
      toast.success('路由规则已保存');
      setRoutesOpen(false);
    } catch (e) {
      toast.error('保存失败', errText(e));
    } finally {
      setSavingRoutes(false);
    }
  }, [rules]);

  const unreadCount = (items ?? []).filter((it) => it.readAt === null || it.readAt === undefined).length;

  return (
    <div className="flex flex-col gap-6">
      {/* 页头 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold tracking-tight">通知中心</h2>
          <p className="text-muted-foreground text-sm">
            收件箱与投递渠道配置
            {unreadCount > 0 && (
              <Badge variant="destructive" className="ml-2">
                {unreadCount} 条未读
              </Badge>
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => void openRoutes()}>
            <WebhookIcon aria-hidden />
            路由规则
          </Button>
          <Button size="sm" variant="outline" onClick={() => setSendOpen(true)}>
            <SendIcon aria-hidden />
            发送测试
          </Button>
          <Button size="sm" variant="outline" onClick={() => void markAllRead()} disabled={readAllBusy || unreadCount === 0}>
            <CheckCheckIcon className={cn(readAllBusy && 'animate-pulse')} aria-hidden />
            全部已读
          </Button>
          <Button variant="outline" size="icon-sm" title="刷新" onClick={() => void load()} disabled={refreshing}>
            <RefreshCwIcon className={cn(refreshing && 'animate-spin')} aria-hidden />
          </Button>
        </div>
      </div>

      {/* 驱动 chips */}
      {drivers !== null && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted-foreground">可用通知渠道：</span>
          {drivers.notification.length === 0 && <span className="text-muted-foreground italic">暂无（可安装提供 notify:driver 的扩展）</span>}
          {drivers.notification.map((d) => (
            <Badge key={d} variant="secondary" className="font-mono text-[11px]">
              {d}
            </Badge>
          ))}
          {drivers.chat.length > 0 && (
            <>
              <span className="text-muted-foreground ml-2">聊天渠道：</span>
              {drivers.chat.map((d) => (
                <Badge key={d} variant="outline" className="font-mono text-[11px]">
                  {d}
                </Badge>
              ))}
            </>
          )}
        </div>
      )}

      {/* 加载骨架 */}
      {loading && (
        <div className="flex flex-col gap-3">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-20 rounded-lg" />
          ))}
        </div>
      )}

      {/* 错误态 */}
      {!loading && error !== null && (
        <EmptyState icon={BellIcon} title="通知列表加载失败" description={error}>
          <Button size="sm" onClick={() => void load()}>
            <RefreshCwIcon aria-hidden />
            重试
          </Button>
        </EmptyState>
      )}

      {/* 空态 */}
      {!loading && error === null && (items ?? []).length === 0 && (
        <EmptyState icon={BellIcon} title="暂无通知" description="系统与扩展产生的事件通知会出现在这里。">
          <Button size="sm" variant="outline" onClick={() => setSendOpen(true)}>
            <SendIcon aria-hidden />
            发送测试通知
          </Button>
        </EmptyState>
      )}

      {/* 通知列表 */}
      {!loading && error === null && (items ?? []).length > 0 && (
        <div className="flex flex-col gap-2">
          {(items ?? []).map((item) => {
            const unread = item.readAt === null || item.readAt === undefined;
            const expanded = expandedId === item.id;
            const dataText =
              item.data === null || item.data === undefined ? '' : JSON.stringify(item.data, null, 2);
            return (
              <Card
                key={item.id}
                className={cn('gap-2 py-3', unread && 'border-primary/30 bg-primary/[0.03]')}
              >
                <CardContent className="flex flex-col gap-2 px-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-start gap-2">
                      {unread && <span className="bg-primary mt-1.5 size-2 shrink-0 rounded-full" aria-label="未读" />}
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className={cn('truncate text-sm', unread ? 'font-semibold' : 'font-medium')} title={item.title}>
                            {item.title}
                          </span>
                          <LevelBadge level={item.level} />
                        </div>
                        {item.body !== '' && (
                          <p className="text-muted-foreground mt-1 text-xs leading-relaxed break-words">{item.body}</p>
                        )}
                        <p className="text-muted-foreground/70 mt-1 text-[11px] tabular-nums">
                          {formatDateTime(item.createdAt)}
                          {unread ? ' · 未读' : ` · 已读于 ${formatDateTime(item.readAt)}`}
                        </p>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      {dataText !== '' && (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          title={expanded ? '收起 data' : '展开 data'}
                          onClick={() => setExpandedId(expanded ? null : item.id)}
                        >
                          {expanded ? <ChevronDownIcon aria-hidden /> : <ChevronRightIcon aria-hidden />}
                        </Button>
                      )}
                      {unread && (
                        <Button variant="outline" size="sm" onClick={() => void markRead(item)} disabled={busyId === item.id}>
                          <CheckIcon aria-hidden />
                          {busyId === item.id ? '处理中…' : '已读'}
                        </Button>
                      )}
                    </div>
                  </div>
                  {expanded && dataText !== '' && (
                    <pre className="bg-muted text-muted-foreground max-h-40 overflow-auto rounded-md p-2.5 font-mono text-xs break-all whitespace-pre-wrap">
                      {dataText}
                    </pre>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* 发送测试 Dialog */}
      <Dialog open={sendOpen} onOpenChange={setSendOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>发送测试通知</DialogTitle>
            <DialogDescription>创建一条站内通知并按路由规则尝试渠道投递。</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="ntf-title">标题</Label>
              <Input id="ntf-title" value={sendTitle} onChange={(e) => setSendTitle(e.target.value)} placeholder="测试通知" maxLength={256} disabled={sending} />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="ntf-body">正文（可选）</Label>
              <Textarea id="ntf-body" value={sendBody} onChange={(e) => setSendBody(e.target.value)} placeholder="通知正文…" disabled={sending} />
            </div>
            <div className="flex flex-col gap-2">
              <Label>级别</Label>
              <Select value={sendLevel} onValueChange={setSendLevel} disabled={sending}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="选择级别" />
                </SelectTrigger>
                <SelectContent>
                  {LEVEL_OPTIONS.map((lv) => (
                    <SelectItem key={lv} value={lv}>
                      {lv}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSendOpen(false)} disabled={sending}>
              取消
            </Button>
            <Button onClick={() => void handleSend()} disabled={sending}>
              <SendIcon aria-hidden />
              {sending ? '发送中…' : '发送'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 路由规则编辑 Dialog */}
      <Dialog open={routesOpen} onOpenChange={setRoutesOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>投递路由规则</DialogTitle>
            <DialogDescription>
              按级别匹配将通知投递到渠道：level 选「any」匹配全部；每条规则可配置多个渠道（driver + target JSON）。
            </DialogDescription>
          </DialogHeader>
          {routesLoading ? (
            <div className="flex flex-col gap-2">
              <Skeleton className="h-24 rounded-md" />
              <Skeleton className="h-24 rounded-md" />
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {rules.length === 0 && (
                <p className="text-muted-foreground text-sm">尚未配置路由规则——所有通知只进站内收件箱。</p>
              )}
              {rules.map((rule, ri) => (
                <div key={ri} className="rounded-md border p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-xs font-semibold">规则 {ri + 1}</span>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      title="删除规则"
                      className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                      onClick={() => setRules((prev) => prev.filter((_, i) => i !== ri))}
                    >
                      <Trash2Icon aria-hidden />
                    </Button>
                  </div>
                  <div className="flex flex-col gap-2.5">
                    <div className="flex items-center gap-2">
                      <Label className="w-24 shrink-0 text-xs">匹配级别</Label>
                      <Select
                        value={rule.match.level ?? 'any'}
                        onValueChange={(v) =>
                          setRules((prev) => prev.map((r, i) => (i === ri ? { ...r, match: { level: v } } : r)))
                        }
                      >
                        <SelectTrigger className="h-8 w-40">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="any">any（全部）</SelectItem>
                          {LEVEL_OPTIONS.map((lv) => (
                            <SelectItem key={lv} value={lv}>
                              {lv}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    {rule.channels.map((ch, ci) => (
                      <div key={ci} className="rounded border border-dashed p-2.5">
                        <div className="flex items-center gap-2">
                          <Label className="w-24 shrink-0 text-xs">渠道 driver</Label>
                          <Select
                            value={ch.driver}
                            onValueChange={(v) =>
                              setRules((prev) =>
                                prev.map((r, i) =>
                                  i === ri
                                    ? { ...r, channels: r.channels.map((c, j) => (j === ci ? { ...c, driver: v } : c)) }
                                    : r,
                                ),
                              )
                            }
                          >
                            <SelectTrigger className="h-8 w-40">
                              <SelectValue placeholder="选择 driver" />
                            </SelectTrigger>
                            <SelectContent>
                              {driverOptions(drivers, rules).map((d) => (
                                <SelectItem key={d} value={d}>
                                  {d}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            title="删除渠道"
                            className="text-destructive ml-auto hover:bg-destructive/10 hover:text-destructive"
                            onClick={() =>
                              setRules((prev) =>
                                prev.map((r, i) => (i === ri ? { ...r, channels: r.channels.filter((_, j) => j !== ci) } : r)),
                              )
                            }
                          >
                            <Trash2Icon aria-hidden />
                          </Button>
                        </div>
                        <div className="mt-2 flex flex-col gap-1">
                          <Label className="text-muted-foreground text-xs">target（JSON，可为空）</Label>
                          <Textarea
                            value={typeof ch.target === 'string' ? (ch.target as string) : ch.target === null || ch.target === undefined ? '' : JSON.stringify(ch.target, null, 2)}
                            onChange={(e) =>
                              setRules((prev) =>
                                prev.map((r, i) =>
                                  i === ri
                                    ? { ...r, channels: r.channels.map((c, j) => (j === ci ? { ...c, target: e.target.value } : c)) }
                                    : r,
                                ),
                              )
                            }
                            placeholder="{}"
                            className="min-h-14 font-mono text-xs"
                          />
                        </div>
                      </div>
                    ))}
                    <Button
                      variant="outline"
                      size="sm"
                      className="w-fit"
                      onClick={() =>
                        setRules((prev) =>
                          prev.map((r, i) => (i === ri ? { ...r, channels: [...r.channels, { driver: '', target: '' }] } : r)),
                        )
                      }
                    >
                      <PlusIcon aria-hidden />
                      添加渠道
                    </Button>
                  </div>
                </div>
              ))}
              <Button
                variant="outline"
                size="sm"
                className="w-fit"
                onClick={() => setRules((prev) => [...prev, { match: { level: 'any' }, channels: [{ driver: '', target: '' }] }])}
              >
                <PlusIcon aria-hidden />
                添加规则
              </Button>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setRoutesOpen(false)} disabled={savingRoutes}>
              取消
            </Button>
            <Button onClick={() => void saveRoutes()} disabled={savingRoutes || routesLoading}>
              {savingRoutes ? '保存中…' : '保存规则'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
