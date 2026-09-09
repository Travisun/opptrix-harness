import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ActivityIcon,
  BlocksIcon,
  CheckCircle2Icon,
  ClockIcon,
  GlobeIcon,
  MessageSquareIcon,
  RefreshCwIcon,
  ServerIcon,
  SettingsIcon,
  TriangleAlertIcon,
  XCircleIcon,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useChatPanel } from '@/features/chat/ChatPanelContext';
import { api, type SystemInfo } from '@/lib/api';
import { cn } from '@/lib/utils';
import type { DoctorCheck, DoctorReport } from '@/pages/_shared';
import { EmptyState } from '@/pages/_shared';
import { errText, formatCount, formatUptime } from '@/pages/_shared';

/**
 * Dashboard — 仪表盘。
 *
 * - GET /api/v1/system/info → 指标卡（版本/env/运行时长/Node/时区/在线状态）+ counters Top 表；
 * - GET /api/v1/system/doctor → 环境体检列表（ok 绿 / warn 黄 / fail 红，detail 全量展示）；
 * - 快捷入口卡：扩展 / 聊天（开右侧聊天面板）/ 设置。
 */

/** 体检单项的中文名（未登记的 id 回退展示原始 id） */
const CHECK_LABELS: Record<string, string> = {
  dataDir: '数据目录',
  diskSpace: '磁盘空间',
  timezone: '时区配置',
  nodeVersion: 'Node 版本',
  memory: '可用内存',
};

/** 体检项状态：detail 以 "warn:" 开头的失败属告警级，其余失败为故障级（内核 doctor 约定） */
function checkLevel(check: DoctorCheck): 'ok' | 'warn' | 'fail' {
  if (check.ok) return 'ok';
  return check.detail.startsWith('warn:') ? 'warn' : 'fail';
}

export default function DashboardPage(): React.ReactNode {
  const chat = useChatPanel();
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [doctor, setDoctor] = useState<DoctorReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setRefreshing(true);
    setError(null);
    try {
      const [infoRes, doctorRes] = await Promise.all([
        api.get<SystemInfo>('/api/v1/system/info'),
        api.get<DoctorReport>('/api/v1/system/doctor'),
      ]);
      setInfo(infoRes);
      setDoctor(doctorRes);
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

  const counters: Array<[string, number]> =
    info?.counters === undefined || info.counters === null
      ? []
      : (Object.entries(info.counters) as Array<[string, number]>)
          .filter(([, v]) => typeof v === 'number')
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10);

  const online = info !== null && info.state === 'ready';

  return (
    <div className="flex flex-col gap-6">
      {/* 页头 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold tracking-tight">仪表盘</h2>
          <p className="text-muted-foreground text-sm">系统运行状态、关键指标与环境体检总览。</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={refreshing}>
          <RefreshCwIcon className={cn(refreshing && 'animate-spin')} aria-hidden />
          刷新
        </Button>
      </div>

      {/* 加载态 */}
      {loading && (
        <div className="flex flex-col gap-6">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-24 rounded-lg" />
            ))}
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <Skeleton className="h-64 rounded-lg" />
            <Skeleton className="h-64 rounded-lg" />
          </div>
        </div>
      )}

      {/* 错误态（api 层已 toast，这里给内联重试） */}
      {!loading && error !== null && (
        <EmptyState icon={ServerIcon} title="仪表盘数据加载失败" description={error}>
          <Button size="sm" onClick={() => void load()}>
            <RefreshCwIcon aria-hidden />
            重试
          </Button>
        </EmptyState>
      )}

      {!loading && error === null && info !== null && (
        <>
          {/* 指标卡 */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <MetricCard label="在线状态" value={online ? '在线' : (info.state ?? '—')} icon={ActivityIcon}>
              <Badge variant={online ? 'success' : 'warning'} className="w-fit">
                {online ? '运行正常' : '非就绪'}
              </Badge>
            </MetricCard>
            <MetricCard label="版本" value={info.version} icon={ServerIcon} mono />
            <MetricCard label="环境" value={info.env} icon={GlobeIcon} mono />
            <MetricCard label="运行时长" value={formatUptime(info.uptimeMs)} icon={ClockIcon} />
            <MetricCard label="Node" value={`v${info.node}`} icon={ServerIcon} mono />
            <MetricCard label="时区" value={info.timezone} icon={GlobeIcon} mono />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            {/* counters Top 表 */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">计数器 Top 10</CardTitle>
                <CardDescription>内核运行计数快照（api.requests 按路由累计）</CardDescription>
              </CardHeader>
              <CardContent>
                {counters.length === 0 ? (
                  <p className="text-muted-foreground py-6 text-center text-sm">暂无计数数据</p>
                ) : (
                  <div className="flex flex-col gap-2.5">
                    {counters.map(([key, value]) => {
                      const max = counters[0]?.[1] ?? 1;
                      return (
                        <div key={key} className="flex flex-col gap-1">
                          <div className="flex items-baseline justify-between gap-3">
                            <span className="min-w-0 truncate font-mono text-xs" title={key}>
                              {key}
                            </span>
                            <span className="text-sm font-medium tabular-nums">{formatCount(value)}</span>
                          </div>
                          <div className="bg-muted h-1.5 overflow-hidden rounded-full">
                            <div
                              className="bg-primary/70 h-full rounded-full"
                              style={{ width: `${Math.max(4, Math.round((value / max) * 100))}%` }}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* 环境体检 */}
            <Card>
              <CardHeader className="flex flex-row items-start justify-between space-y-0">
                <div className="flex flex-col gap-1.5">
                  <CardTitle className="text-base">环境体检</CardTitle>
                  <CardDescription>目录 / 磁盘 / 时区 / Node / 内存自检</CardDescription>
                </div>
                {doctor !== null && (
                  <Badge variant={doctor.ok ? 'success' : 'warning'}>
                    {doctor.ok ? '全部通过' : '存在问题'}
                  </Badge>
                )}
              </CardHeader>
              <CardContent>
                {doctor === null ? (
                  <p className="text-muted-foreground py-6 text-center text-sm">体检数据不可用</p>
                ) : (
                  <ul className="flex flex-col gap-3">
                    {doctor.checks.map((check) => {
                      const level = checkLevel(check);
                      return (
                        <li key={check.id} className="flex items-start gap-2.5">
                          {level === 'ok' && (
                            <CheckCircle2Icon className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
                          )}
                          {level === 'warn' && (
                            <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-amber-500" aria-hidden />
                          )}
                          {level === 'fail' && <XCircleIcon className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />}
                          <div className="min-w-0 flex-1">
                            <p className="flex flex-wrap items-center gap-2 text-sm leading-snug font-medium">
                              {CHECK_LABELS[check.id] ?? check.id}
                              {level !== 'ok' && (
                                <Badge variant={level === 'warn' ? 'warning' : 'destructive'}>
                                  {level === 'warn' ? '告警' : '失败'}
                                </Badge>
                              )}
                            </p>
                            <p className="text-muted-foreground mt-0.5 font-mono text-xs leading-relaxed break-words">
                              {check.detail}
                            </p>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </CardContent>
            </Card>
          </div>

          {/* 快捷入口 */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">快捷入口</CardTitle>
              <CardDescription>常用管理功能的快速跳转</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-3">
              <QuickLink
                to="/extensions"
                icon={BlocksIcon}
                title="扩展管理"
                description="启用 / 重载 / 卸载扩展，查看贡献点"
              />
              <button
                type="button"
                onClick={() => chat.setDesktopOpen(true)}
                className="bg-card hover:border-primary/40 hover:bg-accent/50 flex flex-col items-start gap-1 rounded-lg border p-4 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <MessageSquareIcon className="text-muted-foreground size-5" aria-hidden />
                <span className="text-sm font-medium">打开聊天</span>
                <span className="text-muted-foreground text-xs leading-relaxed">展开右侧聊天面板与助手对话</span>
              </button>
              <QuickLink
                to="/settings"
                icon={SettingsIcon}
                title="系统设置"
                description="外观主题 / 偏好与系统参数"
              />
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

/** 指标卡（label + 值 + 可选附加内容） */
function MetricCard({
  label,
  value,
  icon: Icon,
  mono = false,
  children,
}: {
  label: string;
  value: string;
  icon: typeof ActivityIcon;
  mono?: boolean;
  children?: React.ReactNode;
}): React.ReactNode {
  return (
    <Card className="gap-2 py-4">
      <CardContent className="flex flex-col gap-1 px-4">
        <div className="text-muted-foreground flex items-center gap-1.5 text-xs">
          <Icon className="size-3.5" aria-hidden />
          {label}
        </div>
        <p className={cn('truncate text-lg leading-tight font-semibold', mono && 'font-mono text-sm')} title={value}>
          {value}
        </p>
        {children}
      </CardContent>
    </Card>
  );
}

/** 快捷入口卡（Link 包裹的图标卡） */
function QuickLink({
  to,
  icon: Icon,
  title,
  description,
}: {
  to: string;
  icon: typeof BlocksIcon;
  title: string;
  description: string;
}): React.ReactNode {
  return (
    <Link
      to={to}
      className="bg-card hover:border-primary/40 hover:bg-accent/50 flex flex-col items-start gap-1 rounded-lg border p-4 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Icon className="text-muted-foreground size-5" aria-hidden />
      <span className="text-sm font-medium">{title}</span>
      <span className="text-muted-foreground text-xs leading-relaxed">{description}</span>
    </Link>
  );
}
