/**
 * ChannelsSection — 渠道凭据与目标配置节（通知中心「渠道配置」Tab）。
 *
 * - GET /api/v1/notifications/channels  读取（admin）→ webhook / SMTP 表单回显
 *   （settings 键 notify.channels.webhook / notify.channels.email；服务端合并缺省，
 *   passSecretRef 只回引用名——密码明文经 kernel secrets 管理，永不进配置/表单值）；
 * - PUT /api/v1/notifications/channels  保存（服务端 zod 白名单校验 + 未知键剥离）；
 * - POST /api/v1/notifications/send     每渠道「测试发送」：以对象形渠道
 *   channels:[{driver, target: 当前表单值}] 直发一条测试通知，成功/失败 toast
 *   展示投递结果（目标值取当前表单，无需先保存）。
 */
import { useCallback, useEffect, useState } from 'react';
import { MailIcon, RefreshCwIcon, SaveIcon, SendIcon, WebhookIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { errText } from '@/pages/_shared';

/** webhook 渠道表单（与内核 WebhookChannelConfig 对齐） */
export interface WebhookChannelForm {
  url: string;
  secret: string;
}

/** SMTP 连接表单（与内核 SmtpChannelConfig 对齐；端口以文本编辑、提交时解析） */
export interface SmtpChannelForm {
  host: string;
  port: string;
  secure: boolean;
  user: string;
  passSecretRef: string;
}

/** email 渠道表单 */
export interface EmailChannelForm {
  smtp: SmtpChannelForm;
  from: string;
  to: string;
}

/** 渠道配置表单（GET /channels 响应的表单视图） */
export interface ChannelsForm {
  webhook: WebhookChannelForm;
  email: EmailChannelForm;
}

const WEBHOOK_DEFAULT: WebhookChannelForm = { url: '', secret: '' };
const SMTP_DEFAULT: SmtpChannelForm = { host: '', port: '587', secure: false, user: '', passSecretRef: '' };
const EMAIL_DEFAULT: EmailChannelForm = { smtp: SMTP_DEFAULT, from: '', to: '' };

/** GET 响应 → 表单形状（数字端口转文本；缺字段以缺省兜底，容忍部分实现） */
function normalizeChannels(raw: unknown): ChannelsForm {
  const r = (raw ?? {}) as {
    webhook?: Partial<WebhookChannelForm>;
    email?: { smtp?: Partial<Record<keyof SmtpChannelForm, unknown>>; from?: unknown; to?: unknown };
  };
  const smtp = { ...SMTP_DEFAULT, ...r.email?.smtp } as Record<keyof SmtpChannelForm, unknown>;
  return {
    webhook: { ...WEBHOOK_DEFAULT, ...r.webhook },
    email: {
      smtp: { ...smtp, port: String(smtp.port ?? SMTP_DEFAULT.port), secure: smtp.secure === true } as SmtpChannelForm,
      from: typeof r.email?.from === 'string' ? r.email.from : EMAIL_DEFAULT.from,
      to: typeof r.email?.to === 'string' ? r.email.to : EMAIL_DEFAULT.to,
    },
  };
}

/** 表单端口文本 → 数字（非法/越界返回 null） */
function parsePort(text: string): number | null {
  const n = Number.parseInt(text.trim(), 10);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}

/** 提交用 email 配置（端口解析 + 空可选项剔除，形状对齐 email 驱动 target） */
function emailTargetOf(form: EmailChannelForm): { smtp: Record<string, unknown>; from: string; to: string } {
  const port = parsePort(form.smtp.port);
  return {
    smtp: {
      host: form.smtp.host.trim(),
      ...(port !== null ? { port } : {}),
      secure: form.smtp.secure,
      ...(form.smtp.user.trim() !== '' ? { user: form.smtp.user.trim() } : {}),
      ...(form.smtp.passSecretRef.trim() !== '' ? { passSecretRef: form.smtp.passSecretRef.trim() } : {}),
    },
    from: form.from.trim(),
    to: form.to.trim(),
  };
}

export default function ChannelsSection(): React.ReactNode {
  const [form, setForm] = useState<ChannelsForm | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /** 测试发送中的渠道（'webhook' | 'email'） */
  const [testing, setTesting] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await api.get<unknown>('/api/v1/notifications/channels');
      setForm(normalizeChannels(res));
    } catch (e) {
      setLoadError(errText(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(async (): Promise<void> => {
    if (form === null) return;
    setSaving(true);
    try {
      const port = parsePort(form.email.smtp.port);
      if (port === null) {
        toast.error('SMTP 端口须为 1-65535 的数字');
        return;
      }
      await api.put('/api/v1/notifications/channels', {
        webhook: { url: form.webhook.url.trim(), secret: form.webhook.secret.trim() },
        email: {
          smtp: {
            host: form.email.smtp.host.trim(),
            port,
            secure: form.email.smtp.secure,
            user: form.email.smtp.user.trim(),
            passSecretRef: form.email.smtp.passSecretRef.trim(),
          },
          from: form.email.from.trim(),
          to: form.email.to.trim(),
        },
      });
      toast.success('渠道配置已保存', 'webhook 与 SMTP 配置已持久化（密码仅存 secrets 引用名）');
      await load();
    } catch (e) {
      toast.error('保存失败', errText(e));
    } finally {
      setSaving(false);
    }
  }, [form, load]);

  const testWebhook = useCallback(async (): Promise<void> => {
    if (form === null) return;
    const url = form.webhook.url.trim();
    if (url === '') {
      toast.error('请先填写 Webhook URL');
      return;
    }
    setTesting('webhook');
    try {
      const secret = form.webhook.secret.trim();
      await api.post('/api/v1/notifications/send', {
        title: '渠道测试（webhook）',
        body: '来自通知中心「渠道配置」的测试发送，target 为当前表单值。',
        level: 'info',
        channels: [{ driver: 'webhook', target: { url, ...(secret !== '' ? { secret } : {}) } }],
      });
      toast.success('webhook 测试通知已发送', '已按当前表单值投递；单渠道结果见通知中心的投递事件');
    } catch (e) {
      toast.error('webhook 测试发送失败', errText(e));
    } finally {
      setTesting(null);
    }
  }, [form]);

  const testEmail = useCallback(async (): Promise<void> => {
    if (form === null) return;
    if (form.email.smtp.host.trim() === '') {
      toast.error('请先填写 SMTP 主机');
      return;
    }
    if (parsePort(form.email.smtp.port) === null) {
      toast.error('SMTP 端口须为 1-65535 的数字');
      return;
    }
    if (form.email.from.trim() === '' || form.email.to.trim() === '') {
      toast.error('请先填写发件人与收件人');
      return;
    }
    setTesting('email');
    try {
      await api.post('/api/v1/notifications/send', {
        title: '渠道测试（email）',
        body: '来自通知中心「渠道配置」的测试发送，target 为当前表单值。',
        level: 'info',
        channels: [{ driver: 'email', target: emailTargetOf(form.email) }],
      });
      toast.success('email 测试通知已发送', '已按当前表单值投递；单渠道结果见通知中心的投递事件');
    } catch (e) {
      toast.error('email 测试发送失败', errText(e));
    } finally {
      setTesting(null);
    }
  }, [form]);

  if (loading) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-64 rounded-lg" />
        <Skeleton className="h-64 rounded-lg" />
      </div>
    );
  }

  if (loadError !== null || form === null) {
    return (
      <Card>
        <CardContent className="flex flex-col items-start gap-3 px-4 py-4">
          <p className="text-destructive text-sm">渠道配置加载失败：{loadError ?? '未知错误'}</p>
          <Button size="sm" variant="outline" onClick={() => void load()}>
            <RefreshCwIcon aria-hidden />
            重试
          </Button>
        </CardContent>
      </Card>
    );
  }

  const updateWebhook = (patch: Partial<WebhookChannelForm>): void =>
    setForm((prev) => (prev === null ? prev : { ...prev, webhook: { ...prev.webhook, ...patch } }));
  const updateSmtp = (patch: Partial<SmtpChannelForm>): void =>
    setForm((prev) =>
      prev === null ? prev : { ...prev, email: { ...prev.email, smtp: { ...prev.email.smtp, ...patch } } },
    );
  const updateEmail = (patch: Partial<Omit<EmailChannelForm, 'smtp'>>): void =>
    setForm((prev) => (prev === null ? prev : { ...prev, email: { ...prev.email, ...patch } }));

  return (
    <div className="flex flex-col gap-4">
      {/* Webhook 渠道 */}
      <Card>
        <CardHeader className="px-4">
          <CardTitle className="flex items-center gap-2 text-base">
            <WebhookIcon className="size-4" aria-hidden />
            Webhook 渠道
          </CardTitle>
          <CardDescription>
            目标 URL 与 HMAC 签名密钥（settings 键 notify.channels.webhook）。secret 留空则不带签名投递。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 px-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="channel-webhook-url">目标 URL</Label>
            <Input
              id="channel-webhook-url"
              value={form.webhook.url}
              onChange={(e) => updateWebhook({ url: e.target.value })}
              placeholder="https://hooks.example.com/opptrix"
              disabled={saving}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="channel-webhook-secret">签名密钥（secret）</Label>
            <Input
              id="channel-webhook-secret"
              type="password"
              value={form.webhook.secret}
              onChange={(e) => updateWebhook({ secret: e.target.value })}
              placeholder="留空 = 不带 x-harness-signature 头"
              disabled={saving}
            />
          </div>
        </CardContent>
        <CardFooter className="justify-end gap-2 px-4">
          <Button size="sm" variant="outline" onClick={() => void testWebhook()} disabled={testing !== null}>
            <SendIcon aria-hidden />
            {testing === 'webhook' ? '发送中…' : '测试发送'}
          </Button>
        </CardFooter>
      </Card>

      {/* SMTP 渠道 */}
      <Card>
        <CardHeader className="px-4">
          <CardTitle className="flex items-center gap-2 text-base">
            <MailIcon className="size-4" aria-hidden />
            SMTP 邮件渠道
          </CardTitle>
          <CardDescription>
            连接与收发件配置（settings 键 notify.channels.email）。密码只保存 secrets 引用名（passSecretRef），
            明文密码请经「系统 → 密钥」写入，永不入库。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 px-4">
          <div className="grid gap-3 sm:grid-cols-[1fr_120px]">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="channel-smtp-host">SMTP 主机</Label>
              <Input
                id="channel-smtp-host"
                value={form.email.smtp.host}
                onChange={(e) => updateSmtp({ host: e.target.value })}
                placeholder="smtp.example.com"
                disabled={saving}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="channel-smtp-port">端口</Label>
              <Input
                id="channel-smtp-port"
                inputMode="numeric"
                value={form.email.smtp.port}
                onChange={(e) => updateSmtp({ port: e.target.value })}
                placeholder="587"
                disabled={saving}
              />
            </div>
          </div>
          <div className="flex items-center justify-between rounded-md border px-3 py-2">
            <div className="flex flex-col">
              <Label htmlFor="channel-smtp-secure" className="text-sm">
                加密（SMTPS / TLS 直连）
              </Label>
              <p className="text-muted-foreground text-xs">
                开启 = 465 端口直连 TLS；关闭 = 587 STARTTLS 惯例
              </p>
            </div>
            <Switch
              id="channel-smtp-secure"
              checked={form.email.smtp.secure}
              onCheckedChange={(checked) => updateSmtp({ secure: checked })}
              disabled={saving}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="channel-smtp-user">认证用户名</Label>
              <Input
                id="channel-smtp-user"
                value={form.email.smtp.user}
                onChange={(e) => updateSmtp({ user: e.target.value })}
                placeholder="留空 = 匿名"
                disabled={saving}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="channel-smtp-passref">密码引用（passSecretRef）</Label>
              <Input
                id="channel-smtp-passref"
                value={form.email.smtp.passSecretRef}
                onChange={(e) => updateSmtp({ passSecretRef: e.target.value })}
                placeholder="secrets 中的引用名，如 smtp.pass"
                disabled={saving}
              />
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="channel-email-from">发件人</Label>
              <Input
                id="channel-email-from"
                value={form.email.from}
                onChange={(e) => updateEmail({ from: e.target.value })}
                placeholder="opptrix@example.com"
                disabled={saving}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="channel-email-to">收件人</Label>
              <Input
                id="channel-email-to"
                value={form.email.to}
                onChange={(e) => updateEmail({ to: e.target.value })}
                placeholder="oncall@example.com（可逗号分隔多个）"
                disabled={saving}
              />
            </div>
          </div>
        </CardContent>
        <CardFooter className="justify-end gap-2 px-4">
          <Button size="sm" variant="outline" onClick={() => void testEmail()} disabled={testing !== null}>
            <SendIcon aria-hidden />
            {testing === 'email' ? '发送中…' : '测试发送'}
          </Button>
        </CardFooter>
      </Card>

      {/* 保存（两渠道整体提交） */}
      <div className="flex justify-end">
        <Button size="sm" onClick={() => void save()} disabled={saving || testing !== null}>
          <SaveIcon aria-hidden />
          {saving ? '保存中…' : '保存渠道配置'}
        </Button>
      </div>
    </div>
  );
}
