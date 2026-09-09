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
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { useNotifications } from '@/features/notifications/NotificationsProvider';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { EmptyState, LevelBadge } from '@/pages/_shared';
import type { NotificationDrivers, NotificationRecord, NotificationRouteRule } from '@/pages/_shared';
import { errText, formatDateTime, parseJsonInput } from '@/pages/_shared';
import {
  ChannelCard,
  type NotificationChannelConfig,
  type NotificationChannelType,
} from '@/pages/Notifications/ChannelCard';

/**
 * Notifications — 通知中心。
 *
 * - GET  /api/v1/notifications?limit=50      列表（未读高亮 / level 徽标 / data 折叠）；
 * - POST /api/v1/notifications/:id/read      单条已读；
 * - POST /api/v1/notifications/read-all      全部已读；
 * - POST /api/v1/notifications/send          发送测试通知（Dialog）；
 * - GET/PUT /api/v1/notifications/routes     路由规则编辑器（match.level + channels 重复组）；
 * - GET  /api/v1/notifications/drivers       可用驱动 chips。
 * - 渠道管理 Tab（多渠道实例）：
 *   GET/POST /api/v1/notifications/channels*  渠道实例 CRUD（webhook/email/console
 *   各可建多份、独立启停），PATCH :id/toggle 切换，DELETE :id 删除；「测试」按钮经
 *   POST /send 以对象形 channels 携带当前 target 直发。
 * 已读操作后调用 NotificationsProvider.refresh() 同步顶栏未读徽标。
 */

const LEVEL_OPTIONS = ['info', 'success', 'warning', 'error'] as const;

/** 渠道类型候选（与内核 NOTIFY_CHANNEL_TYPES 一致） */
const CHANNEL_TYPE_OPTIONS: NotificationChannelType[] = ['webhook', 'email', 'console'];

/** 渠道新建/编辑表单状态（按 type 动态渲染；email 的 smtp 展平为顶层字段） */
interface ChannelFormState {
  type: NotificationChannelType;
  name: string;
  url: string;
  secret: string;
  smtpHost: string;
  smtpPort: string;
  smtpSecure: boolean;
  smtpUser: string;
  smtpPassSecretRef: string;
  from: string;
  to: string;
}

/** 空表单（新建默认 webhook） */
function emptyChannelForm(): ChannelFormState {
  return {
    type: 'webhook',
    name: '',
    url: '',
    secret: '',
    smtpHost: '',
    smtpPort: '587',
    smtpSecure: false,
    smtpUser: '',
    smtpPassSecretRef: '',
    from: '',
    to: '',
  };
}

/** 表单 → 驱动 target（空可选字段省略；console 恒为 {}） */
function channelFormTarget(form: ChannelFormState): Record<string, unknown> {
  if (form.type === 'webhook') {
    return {
      url: form.url.trim(),
      ...(form.secret.trim() !== '' ? { secret: form.secret.trim() } : {}),
    };
  }
  if (form.type === 'email') {
    return {
      smtp: {
        host: form.smtpHost.trim(),
        port: Number.parseInt(form.smtpPort, 10) || 587,
        secure: form.smtpSecure,
        ...(form.smtpUser.trim() !== '' ? { user: form.smtpUser.trim() } : {}),
        ...(form.smtpPassSecretRef.trim() !== '' ? { passSecretRef: form.smtpPassSecretRef.trim() } : {}),
      },
      from: form.from.trim(),
      to: form.to.trim(),
    };
  }
  return {};
}

/** 渠道配置 → 表单（编辑预填；type 不可变更，仅回显） */
function channelToForm(channel: NotificationChannelConfig): ChannelFormState {
  const base = emptyChannelForm();
  base.type = channel.type;
  base.name = channel.name;
  const t = channel.target ?? {};
  if (channel.type === 'webhook') {
    base.url = typeof t.url === 'string' ? t.url : '';
    base.secret = typeof t.secret === 'string' ? t.secret : '';
  } else if (channel.type === 'email') {
    const smtp = (t.smtp ?? {}) as Record<string, unknown>;
    base.smtpHost = typeof smtp.host === 'string' ? smtp.host : '';
    base.smtpPort = typeof smtp.port === 'number' ? String(smtp.port) : '587';
    base.smtpSecure = smtp.secure === true;
    base.smtpUser = typeof smtp.user === 'string' ? smtp.user : '';
    base.smtpPassSecretRef = typeof smtp.passSecretRef === 'string' ? smtp.passSecretRef : '';
    base.from = typeof t.from === 'string' ? t.from : '';
    base.to = typeof t.to === 'string' ? t.to : '';
  }
  return base;
}

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
  /** 渠道管理 Tab：实例列表 / 行级忙态 / 新建·编辑 Dialog / 表单 / 测试发送忙态 */
  const [channels, setChannels] = useState<NotificationChannelConfig[] | null>(null);
  const [channelsLoading, setChannelsLoading] = useState(false);
  const [channelBusyId, setChannelBusyId] = useState<string | null>(null);
  const [channelDialogOpen, setChannelDialogOpen] = useState(false);
  /** null = 新建；非 null = 编辑该渠道（type 锁定） */
  const [editingChannel, setEditingChannel] = useState<NotificationChannelConfig | null>(null);
  const [channelForm, setChannelForm] = useState<ChannelFormState>(emptyChannelForm);
  const [savingChannel, setSavingChannel] = useState(false);
  const [testingChannel, setTestingChannel] = useState(false);

  const loadChannels = useCallback(async (): Promise<void> => {
    setChannelsLoading(true);
    try {
      const res = await api.get<{ items: NotificationChannelConfig[] }>(
        '/api/v1/notifications/channels/list',
        { silent: true },
      );
      setChannels(Array.isArray(res.items) ? res.items : []);
    } catch (e) {
      setChannels([]);
      toast.error('渠道列表加载失败', errText(e));
    } finally {
      setChannelsLoading(false);
    }
  }, []);

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
    void loadChannels();
  }, [load, loadChannels]);

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

  // ---------------------------------------------------------------------------
  // 渠道管理（多渠道实例 CRUD + 测试发送）
  // ---------------------------------------------------------------------------

  /** 测试发送：POST /send 以对象形 channels 携带 target（驱动按类型 zod 校验） */
  const testChannel = useCallback(
    async (type: NotificationChannelType, target: Record<string, unknown>, label: string): Promise<void> => {
      setTestingChannel(true);
      try {
        await api.post('/api/v1/notifications/send', {
          title: `渠道测试通知（${label}）`,
          body: '这是一条渠道测试通知，收到即表示该渠道投递正常。',
          level: 'info',
          channels: [{ driver: type, target }],
        });
        toast.success('测试通知已发送', `投递结果见通知列表的「渠道投递」事件`);
      } catch (e) {
        toast.error('测试发送失败', errText(e));
      } finally {
        setTestingChannel(false);
      }
    },
    [],
  );

  const toggleChannel = useCallback(
    async (channel: NotificationChannelConfig, next: boolean): Promise<void> => {
      setChannelBusyId(channel.id);
      try {
        const updated = await api.patch<NotificationChannelConfig>(
          `/api/v1/notifications/channels/${encodeURIComponent(channel.id)}/toggle`,
          { enabled: next },
        );
        setChannels((prev) => (prev ?? []).map((c) => (c.id === channel.id ? updated : c)));
      } catch (e) {
        toast.error('切换失败', errText(e));
      } finally {
        setChannelBusyId(null);
      }
    },
    [],
  );

  const deleteChannel = useCallback(
    async (channel: NotificationChannelConfig): Promise<void> => {
      setChannelBusyId(channel.id);
      try {
        await api.delete(`/api/v1/notifications/channels/${encodeURIComponent(channel.id)}`);
        setChannels((prev) => (prev ?? []).filter((c) => c.id !== channel.id));
        toast.success('渠道已删除', channel.name);
      } catch (e) {
        toast.error('删除失败', errText(e));
      } finally {
        setChannelBusyId(null);
      }
    },
    [],
  );

  const openCreateChannel = useCallback((): void => {
    setEditingChannel(null);
    setChannelForm(emptyChannelForm());
    setChannelDialogOpen(true);
  }, []);

  const openEditChannel = useCallback((channel: NotificationChannelConfig): void => {
    setEditingChannel(channel);
    setChannelForm(channelToForm(channel));
    setChannelDialogOpen(true);
  }, []);

  /** 新建/编辑提交：按类型做最小前端校验后交 REST（服务端按驱动契约复校） */
  const submitChannel = useCallback(async (): Promise<void> => {
    const form = channelForm;
    const name = form.name.trim();
    if (name === '') {
      toast.error('请填写渠道名称');
      return;
    }
    if (form.type === 'webhook' && form.url.trim() === '') {
      toast.error('请填写 Webhook URL');
      return;
    }
    if (form.type === 'email' && (form.smtpHost.trim() === '' || form.from.trim() === '' || form.to.trim() === '')) {
      toast.error('请填写 SMTP 主机、发件人与收件人');
      return;
    }
    const target = channelFormTarget(form);
    setSavingChannel(true);
    try {
      if (editingChannel === null) {
        await api.post<NotificationChannelConfig>('/api/v1/notifications/channels', {
          type: form.type,
          name,
          target,
        });
        toast.success('渠道已创建', name);
      } else {
        await api.put<NotificationChannelConfig>(
          `/api/v1/notifications/channels/${encodeURIComponent(editingChannel.id)}`,
          { name, target },
        );
        toast.success('渠道已更新', name);
      }
      setChannelDialogOpen(false);
      await loadChannels();
    } catch (e) {
      toast.error('保存失败', errText(e));
    } finally {
      setSavingChannel(false);
    }
  }, [channelForm, editingChannel, loadChannels]);

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

      <Tabs defaultValue="inbox" className="gap-4">
        <TabsList>
          <TabsTrigger value="inbox">
            收件箱
            {unreadCount > 0 && (
              <Badge variant="destructive" className="ml-1.5 px-1.5">
                {unreadCount}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="channels">
            渠道管理
            {channels !== null && channels.length > 0 && (
              <Badge variant="secondary" className="ml-1.5 px-1.5">
                {channels.length}
              </Badge>
            )}
          </TabsTrigger>
        </TabsList>

        {/* 收件箱 Tab：既有通知列表 */}
        <TabsContent value="inbox" className="flex flex-col gap-4">
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
        </TabsContent>

        {/* 渠道管理 Tab：多渠道实例 CRUD + 测试发送 */}
        <TabsContent value="channels" className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-muted-foreground text-sm">
              可创建多个 Webhook / Email / Console 渠道实例并独立启停——所有启用的渠道会自动收到全部通知
              （也可用路由规则按级别精细分流）。
            </p>
            <Button size="sm" onClick={openCreateChannel}>
              <PlusIcon aria-hidden />
              新建渠道
            </Button>
          </div>

          {channelsLoading && (
            <div className="flex flex-col gap-3">
              {Array.from({ length: 2 }, (_, i) => (
                <Skeleton key={i} className="h-24 rounded-lg" />
              ))}
            </div>
          )}

          {!channelsLoading && (channels ?? []).length === 0 && (
            <EmptyState
              icon={WebhookIcon}
              title="暂无渠道实例"
              description="创建 Webhook / Email 渠道后，通知将在路由规则未命中时自动分发到全部启用的渠道。"
            >
              <Button size="sm" variant="outline" onClick={openCreateChannel}>
                <PlusIcon aria-hidden />
                新建渠道
              </Button>
            </EmptyState>
          )}

          {!channelsLoading && (channels ?? []).map((channel) => (
            <ChannelCard
              key={channel.id}
              channel={channel}
              busy={channelBusyId === channel.id || testingChannel}
              onToggle={(next) => void toggleChannel(channel, next)}
              onEdit={() => openEditChannel(channel)}
              onDelete={() => void deleteChannel(channel)}
              onTest={() => void testChannel(channel.type, channel.target ?? {}, channel.name)}
            />
          ))}
        </TabsContent>
      </Tabs>

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

      {/* 渠道新建/编辑 Dialog（type 动态渲染 target 表单；编辑时 type 锁定） */}
      <Dialog open={channelDialogOpen} onOpenChange={setChannelDialogOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editingChannel === null ? '新建渠道' : '编辑渠道'}</DialogTitle>
            <DialogDescription>
              {editingChannel === null
                ? '创建一个通知渠道实例（同一类型可创建多份，独立启停）。'
                : `编辑渠道「${editingChannel.name}」（类型不可变更）。`}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label>类型</Label>
              <Select
                value={channelForm.type}
                onValueChange={(v) =>
                  setChannelForm((prev) => ({ ...prev, type: v as NotificationChannelType }))
                }
                disabled={savingChannel || editingChannel !== null}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="选择渠道类型" />
                </SelectTrigger>
                <SelectContent>
                  {CHANNEL_TYPE_OPTIONS.map((t) => (
                    <SelectItem key={t} value={t}>
                      {t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="channel-name">名称</Label>
              <Input
                id="channel-name"
                value={channelForm.name}
                onChange={(e) => setChannelForm((prev) => ({ ...prev, name: e.target.value }))}
                placeholder="如：运维群 Webhook"
                maxLength={128}
                disabled={savingChannel}
              />
            </div>

            {/* target 表单：按类型动态渲染 */}
            {channelForm.type === 'webhook' && (
              <>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="channel-url">Webhook URL</Label>
                  <Input
                    id="channel-url"
                    value={channelForm.url}
                    onChange={(e) => setChannelForm((prev) => ({ ...prev, url: e.target.value }))}
                    placeholder="https://example.com/hook"
                    disabled={savingChannel}
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="channel-secret">签名密钥（可选）</Label>
                  <Input
                    id="channel-secret"
                    value={channelForm.secret}
                    onChange={(e) => setChannelForm((prev) => ({ ...prev, secret: e.target.value }))}
                    placeholder="留空则不带 HMAC 签名"
                    type="password"
                    disabled={savingChannel}
                  />
                </div>
              </>
            )}

            {channelForm.type === 'email' && (
              <>
                <div className="grid grid-cols-3 gap-2">
                  <div className="col-span-2 flex flex-col gap-2">
                    <Label htmlFor="channel-smtp-host">SMTP 主机</Label>
                    <Input
                      id="channel-smtp-host"
                      value={channelForm.smtpHost}
                      onChange={(e) => setChannelForm((prev) => ({ ...prev, smtpHost: e.target.value }))}
                      placeholder="smtp.example.com"
                      disabled={savingChannel}
                    />
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="channel-smtp-port">端口</Label>
                    <Input
                      id="channel-smtp-port"
                      value={channelForm.smtpPort}
                      onChange={(e) => setChannelForm((prev) => ({ ...prev, smtpPort: e.target.value }))}
                      placeholder="587"
                      inputMode="numeric"
                      disabled={savingChannel}
                    />
                  </div>
                </div>
                <div className="flex items-center justify-between rounded-md border p-2.5">
                  <Label htmlFor="channel-smtp-secure" className="text-sm font-normal">
                    SMTPS（465 直连 TLS；关闭则 STARTTLS/明文）
                  </Label>
                  <Switch
                    id="channel-smtp-secure"
                    checked={channelForm.smtpSecure}
                    onCheckedChange={(v) => setChannelForm((prev) => ({ ...prev, smtpSecure: v }))}
                    disabled={savingChannel}
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="channel-smtp-user">SMTP 用户名（可选）</Label>
                  <Input
                    id="channel-smtp-user"
                    value={channelForm.smtpUser}
                    onChange={(e) => setChannelForm((prev) => ({ ...prev, smtpUser: e.target.value }))}
                    placeholder="留空则匿名"
                    disabled={savingChannel}
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="channel-smtp-passref">SMTP 密码 secrets 引用名（可选）</Label>
                  <Input
                    id="channel-smtp-passref"
                    value={channelForm.smtpPassSecretRef}
                    onChange={(e) => setChannelForm((prev) => ({ ...prev, smtpPassSecretRef: e.target.value }))}
                    placeholder="如 smtp-password（只存引用名，不存明文）"
                    disabled={savingChannel}
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="channel-from">发件人</Label>
                  <Input
                    id="channel-from"
                    value={channelForm.from}
                    onChange={(e) => setChannelForm((prev) => ({ ...prev, from: e.target.value }))}
                    placeholder="harness@example.com"
                    disabled={savingChannel}
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="channel-to">收件人</Label>
                  <Input
                    id="channel-to"
                    value={channelForm.to}
                    onChange={(e) => setChannelForm((prev) => ({ ...prev, to: e.target.value }))}
                    placeholder="ops@example.com（多地址逗号分隔）"
                    disabled={savingChannel}
                  />
                </div>
              </>
            )}

            {channelForm.type === 'console' && (
              <p className="text-muted-foreground text-sm">
                Console 渠道无需配置：通知会以 info 级输出到内核日志（本地开发/无外发渠道时可观测）。
              </p>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => void testChannel(channelForm.type, channelFormTarget(channelForm), channelForm.name.trim() || channelForm.type)}
              disabled={savingChannel || testingChannel}
            >
              <SendIcon aria-hidden />
              {testingChannel ? '发送中…' : '测试发送'}
            </Button>
            <Button variant="outline" onClick={() => setChannelDialogOpen(false)} disabled={savingChannel}>
              取消
            </Button>
            <Button onClick={() => void submitChannel()} disabled={savingChannel || testingChannel}>
              {savingChannel ? '保存中…' : editingChannel === null ? '创建' : '保存'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
