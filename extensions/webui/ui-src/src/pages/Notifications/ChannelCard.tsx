/**
 * Notifications/ChannelCard — 渠道实例卡片（通知中心「渠道管理」Tab）。
 *
 * 展示：type 徽标 / name / enabled Switch（启停切换）/ target 摘要 / 创建时间 /
 * 操作按钮（测试发送、编辑、删除）。纯展示组件：全部行为经回调上抛，由
 * Notifications 页面统一调 REST 与维护列表状态。
 */
import { MailIcon, PencilIcon, SendIcon, TerminalIcon, Trash2Icon, WebhookIcon } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { formatDateTime } from '@/pages/_shared';
import { cn } from '@/lib/utils';

/** 渠道类型（= 驱动注册名，与内核 NOTIFY_CHANNEL_TYPES 一致） */
export type NotificationChannelType = 'webhook' | 'email' | 'console';

/** 渠道实例配置（内核 NotificationChannelConfig 的 UI 视图） */
export interface NotificationChannelConfig {
  id: string;
  type: NotificationChannelType;
  name: string;
  enabled: boolean;
  target: Record<string, unknown>;
  createdAt: number;
}

/** 类型 → 徽标图标 */
function TypeIcon({ type }: { type: NotificationChannelType }): React.ReactNode {
  if (type === 'webhook') return <WebhookIcon className="size-3.5" aria-hidden />;
  if (type === 'email') return <MailIcon className="size-3.5" aria-hidden />;
  return <TerminalIcon className="size-3.5" aria-hidden />;
}

/** 取 target 里的字符串字段（缺省 ''） */
function targetString(target: Record<string, unknown>, key: string): string {
  const v = target[key];
  return typeof v === 'string' ? v : '';
}

/** target → 单行人类可读摘要（密钥类字段永不出现） */
export function targetSummary(channel: NotificationChannelConfig): string {
  const { type, target } = channel;
  if (type === 'webhook') {
    const url = targetString(target, 'url');
    return url === '' ? '未配置 URL' : url;
  }
  if (type === 'email') {
    const smtp = (target.smtp ?? {}) as Record<string, unknown>;
    const host = typeof smtp.host === 'string' ? smtp.host : '';
    const from = targetString(target, 'from');
    const to = targetString(target, 'to');
    const via = host === '' ? 'SMTP 未配置' : `smtp://${host}`;
    return [via, from, to].filter((s) => s !== '').join(' · ');
  }
  return '输出到内核日志（console）';
}

export interface ChannelCardProps {
  channel: NotificationChannelConfig;
  /** 该卡片忙态（toggle/删除/测试进行中，禁用全部操作） */
  busy: boolean;
  onToggle(next: boolean): void;
  onEdit(): void;
  onDelete(): void;
  onTest(): void;
}

export function ChannelCard({ channel, busy, onToggle, onEdit, onDelete, onTest }: ChannelCardProps): React.ReactNode {
  return (
    <Card className={cn('gap-2 py-3', !channel.enabled && 'opacity-75')}>
      <CardContent className="flex flex-col gap-2 px-4">
        {/* 首行：type 徽标 + name + 启停 Switch */}
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <Badge variant="secondary" className="gap-1 font-mono text-[11px]">
              <TypeIcon type={channel.type} />
              {channel.type}
            </Badge>
            <span className="truncate text-sm font-medium" title={channel.name}>
              {channel.name}
            </span>
            {!channel.enabled && (
              <Badge variant="outline" className="text-muted-foreground text-[11px]">
                已停用
              </Badge>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Switch
              checked={channel.enabled}
              onCheckedChange={(v) => onToggle(v)}
              disabled={busy}
              aria-label={`切换渠道 ${channel.name} 启停`}
            />
          </div>
        </div>

        {/* target 摘要（单行截断；不回显密钥） */}
        <p className="text-muted-foreground truncate font-mono text-xs" title={targetSummary(channel)}>
          {targetSummary(channel)}
        </p>

        {/* 末行：创建时间 + 操作 */}
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground/70 text-[11px] tabular-nums">
            创建于 {formatDateTime(channel.createdAt)}
          </span>
          <div className="flex shrink-0 items-center gap-1">
            <Button variant="outline" size="sm" onClick={onTest} disabled={busy}>
              <SendIcon aria-hidden />
              测试
            </Button>
            <Button variant="ghost" size="icon-sm" title="编辑" onClick={onEdit} disabled={busy}>
              <PencilIcon aria-hidden />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              title="删除"
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={onDelete}
              disabled={busy}
            >
              <Trash2Icon aria-hidden />
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
