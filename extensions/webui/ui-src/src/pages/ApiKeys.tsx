import { useCallback, useEffect, useState } from 'react';
import { BanIcon, CopyIcon, KeyRoundIcon, PlusIcon, ShieldAlertIcon } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import {
  copyText,
  errText,
  formatDateTime,
  useMe,
  type ApiKeyCreated,
  type ApiKeyRow,
} from '@/pages/_shared';
import { EmptyState } from '@/pages/_shared';

/**
 * ApiKeys — 当前用户自己的 API Key 管理。
 *
 * - GET /api/v1/auth/api-keys → 列表（name / created / expires / revoked 徽标 / scopes）；
 * - POST /api/v1/auth/api-keys → 创建 Dialog（name / scopes 逗号分隔（* = 全部）/
 *   有效期天数可选）→ 成功 Dialog 一次性展示 ak_ 令牌（大号等宽 + 复制 +
 *   「关闭后无法再次查看」红色警示）；
 * - DELETE /api/v1/auth/api-keys/:id → 吊销（confirm）；
 * - 后端令牌脱敏存储：列表永不回显令牌，明文仅在签发响应出现一次。
 *
 * 注意：api-keys 端点要求会话令牌（ses_*，见 auth 扩展 authRequireSession）——
 * root 令牌直连 / API Key 身份访问会 401，这里先经 /auth/me 识别 tokenType 给出友好空态。
 */

interface NewKeyForm {
  name: string;
  scopesCsv: string;
  expiresInDays: string; // '' = 永不过期
}

const EMPTY_NEW_KEY: NewKeyForm = { name: '', scopesCsv: '*', expiresInDays: '' };

export default function ApiKeysPage(): React.ReactNode {
  const { me } = useMe();
  const [keys, setKeys] = useState<ApiKeyRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [needSession, setNeedSession] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 创建 Dialog + 一次性令牌展示 Dialog + 吊销确认
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState<NewKeyForm>(EMPTY_NEW_KEY);
  const [created, setCreated] = useState<ApiKeyCreated | null>(null);
  const [copied, setCopied] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<ApiKeyRow | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<{ apiKeys: ApiKeyRow[] }>('/api/v1/auth/api-keys', { silent: true });
      setKeys(res.apiKeys);
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 401) {
        setNeedSession(true); // 非会话身份（root 令牌 / API Key）→ 友好空态
      } else {
        setError(errText(e));
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const submitCreate = async (): Promise<void> => {
    const name = form.name.trim();
    if (name === '' || name.length > 100) {
      toast.error('请输入名称（1-100 个字符）');
      return;
    }
    const scopes = form.scopesCsv
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '');
    if (scopes.length === 0) {
      toast.error('scopes 不能为空（* 表示全部权限）');
      return;
    }
    let expiresInDays: number | undefined;
    if (form.expiresInDays.trim() !== '') {
      const n = Number(form.expiresInDays);
      if (!Number.isInteger(n) || n <= 0 || n > 3650) {
        toast.error('有效期天数须为 1-3650 的整数，留空表示永不过期');
        return;
      }
      expiresInDays = n;
    }
    setBusy(true);
    try {
      const res = await api.post<ApiKeyCreated>('/api/v1/auth/api-keys', {
        name,
        scopes,
        ...(expiresInDays !== undefined ? { expiresInDays } : {}),
      });
      setCreateOpen(false);
      setForm(EMPTY_NEW_KEY);
      setCopied(false);
      setCreated(res); // 先关闭创建框，再弹一次性令牌框
    } catch (e) {
      toast.error('创建失败', errText(e));
    } finally {
      setBusy(false);
    }
  };

  const submitRevoke = async (): Promise<void> => {
    if (revokeTarget === null) return;
    setBusy(true);
    try {
      await api.delete(`/api/v1/auth/api-keys/${revokeTarget.id}`);
      toast.success('已吊销', revokeTarget.name);
      setRevokeTarget(null);
      await load();
    } catch (e) {
      toast.error('吊销失败', errText(e));
      setRevokeTarget(null);
    } finally {
      setBusy(false);
    }
  };

  const copyToken = async (): Promise<void> => {
    if (created === null) return;
    const ok = await copyText(created.token);
    if (ok) {
      setCopied(true);
      toast.success('已复制到剪贴板');
    } else {
      toast.error('复制失败，请手动选择令牌复制');
    }
  };

  // 非会话身份：API Key 管理要求会话登录（root 令牌直连 / ak_ 身份不可管理）
  if (needSession) {
    return (
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold tracking-tight">API Keys</h2>
          <p className="text-muted-foreground text-sm">API Key 的签发、查看与吊销。</p>
        </div>
        <EmptyState
          icon={ShieldAlertIcon}
          title="当前身份无法管理 API Key"
          description="API Key 管理要求会话登录（ses_ 令牌）。请退出后用用户名密码重新登录；root 令牌直连与 API Key 身份均不能签发或吊销 Key。"
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {/* 页头 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold tracking-tight">API Keys</h2>
          <p className="text-muted-foreground text-sm">
            {me?.username !== null && me?.username !== undefined && me.username !== ''
              ? `管理 ${me.username} 的 API Key（令牌仅签发时展示一次）。`
              : '签发、查看与吊销你自己的 API Key（令牌仅签发时展示一次）。'}
          </p>
        </div>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <PlusIcon aria-hidden />
          签发 API Key
        </Button>
      </div>

      {/* 加载态 */}
      {loading && (
        <div className="flex flex-col gap-3">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-16 rounded-lg" />
          ))}
        </div>
      )}

      {/* 错误态 */}
      {!loading && error !== null && (
        <EmptyState icon={KeyRoundIcon} title="API Key 列表加载失败" description={error}>
          <Button size="sm" variant="outline" onClick={() => void load()}>
            重试
          </Button>
        </EmptyState>
      )}

      {/* 列表 */}
      {!loading && error === null && keys !== null && (
        <Card className="gap-0 overflow-hidden py-0">
          <CardContent className="divide-y p-0">
            {keys.length === 0 && (
              <p className="text-muted-foreground py-12 text-center text-sm">
                还没有 API Key——点击右上角「签发 API Key」创建第一个。
              </p>
            )}
            {keys.map((k) => (
              <div key={k.id} className="flex flex-wrap items-center gap-3 px-4 py-3 sm:px-5">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    <span className="truncate">{k.name}</span>
                    <Badge variant={k.revoked ? 'destructive' : 'success'}>
                      {k.revoked ? '已吊销' : '启用中'}
                    </Badge>
                  </p>
                  <p className="text-muted-foreground mt-0.5 text-xs">
                    创建于 {formatDateTime(k.createdAt)} ·{' '}
                    {k.expiresAt === null ? '永不过期' : `过期于 ${formatDateTime(k.expiresAt)}`}
                  </p>
                  <p className="mt-1 flex flex-wrap gap-1">
                    {k.scopes.map((s) => (
                      <Badge key={s} variant="outline" className="font-mono text-[11px]">
                        {s}
                      </Badge>
                    ))}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive"
                  disabled={k.revoked}
                  onClick={() => setRevokeTarget(k)}
                >
                  <BanIcon aria-hidden />
                  吊销
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* 创建 Dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>签发 API Key</DialogTitle>
            <DialogDescription>
              令牌明文（ak_ 开头）只在签发成功后展示一次，之后无法再次查看。
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="key-name">名称</Label>
              <Input
                id="key-name"
                value={form.name}
                onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                placeholder="ci-deploy"
                autoComplete="off"
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="key-scopes">Scopes（逗号分隔）</Label>
              <Input
                id="key-scopes"
                value={form.scopesCsv}
                onChange={(e) => setForm((p) => ({ ...p, scopesCsv: e.target.value }))}
                placeholder="*"
                autoComplete="off"
              />
              <p className="text-muted-foreground text-xs">
                * = 全部权限；多个 scope 用英文逗号分隔，如 files.read, chat.send
              </p>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="key-days">有效期（天，可选）</Label>
              <Input
                id="key-days"
                type="number"
                min={1}
                max={3650}
                value={form.expiresInDays}
                onChange={(e) => setForm((p) => ({ ...p, expiresInDays: e.target.value }))}
                placeholder="留空 = 永不过期"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={busy}>
              取消
            </Button>
            <Button onClick={() => void submitCreate()} disabled={busy}>
              签发
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 一次性令牌展示 Dialog */}
      <Dialog
        open={created !== null}
        onOpenChange={(open) => {
          if (!open) setCreated(null);
        }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>API Key 已签发</DialogTitle>
            <DialogDescription>
              {created?.name ?? ''} 的令牌如下——请立即复制保存。
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <p className="select-all rounded-md border bg-muted/40 p-3 text-left font-mono text-lg leading-relaxed break-all">
              {created?.token ?? ''}
            </p>
            <Alert variant="destructive">
              <ShieldAlertIcon aria-hidden />
              <AlertTitle>关闭后无法再次查看</AlertTitle>
              <AlertDescription>
                令牌仅以哈希落库，本对话框关闭后不可找回；遗失只能吊销重签。
              </AlertDescription>
            </Alert>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => void copyToken()}>
              <CopyIcon aria-hidden />
              {copied ? '已复制' : '复制令牌'}
            </Button>
            <Button variant="destructive" onClick={() => setCreated(null)}>
              我已保存，关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 吊销确认 Dialog */}
      <Dialog
        open={revokeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRevokeTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>确认吊销 API Key</DialogTitle>
            <DialogDescription>
              吊销后「{revokeTarget?.name ?? ''}」立即失效，所有使用该 Key
              的调用将返回 401。此操作不可撤销。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRevokeTarget(null)} disabled={busy}>
              取消
            </Button>
            <Button variant="destructive" onClick={() => void submitRevoke()} disabled={busy}>
              吊销
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
