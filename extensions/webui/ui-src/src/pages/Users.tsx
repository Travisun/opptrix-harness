import { useCallback, useEffect, useState } from 'react';
import { KeyRoundIcon, PlusIcon, ShieldXIcon, Trash2Icon, UserRoundIcon } from 'lucide-react';

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
import { toast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { errCode, errText, formatDateTime, isAdminRole, useMe, type UserRow } from '@/pages/_shared';
import { EmptyState } from '@/pages/_shared';

/**
 * Users — 用户管理（admin 面板）。
 *
 * - GET /api/v1/users → 列表卡（username / role 徽标 / 创建时间；当前登录行标「（我）」）；
 * - POST /api/v1/users → 新建 Dialog（username / password≥8 / role）；
 * - PATCH /api/v1/users/:id → 重置密码 Dialog、改角色（admin↔normal Switch → confirm）；
 * - DELETE /api/v1/users/:id → 删除（confirm；后端规则错误——不能删自己/最后一个 admin——
 *   以 400 透传，api 层 toast 原样呈现）；
 * - 当前身份非 admin → 友好 403 空态。
 */

interface NewUserForm {
  username: string;
  password: string;
  role: 'admin' | 'normal';
}

const EMPTY_NEW_USER: NewUserForm = { username: '', password: '', role: 'normal' };

export default function UsersPage(): React.ReactNode {
  const { me } = useMe();
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 对话框状态：新建 / 重置密码 / 改角色确认 / 删除确认
  const [createOpen, setCreateOpen] = useState(false);
  const [newUser, setNewUser] = useState<NewUserForm>(EMPTY_NEW_USER);
  const [resetTarget, setResetTarget] = useState<UserRow | null>(null);
  const [resetPassword, setResetPassword] = useState('');
  const [roleTarget, setRoleTarget] = useState<UserRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<UserRow | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    setForbidden(false);
    try {
      const res = await api.get<{ users: UserRow[] }>('/api/v1/users', { silent: true });
      setUsers(res.users);
    } catch (e) {
      if (errCode(e) === 'HARNESS-1007') {
        setForbidden(true); // normal 角色：友好 403 空态（silent 已抑制 toast）
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
    if (newUser.username.trim() === '') {
      toast.error('请输入用户名');
      return;
    }
    if (newUser.password.length < 8) {
      toast.error('密码至少 8 个字符');
      return;
    }
    setBusy(true);
    try {
      await api.post('/api/v1/users', newUser);
      toast.success('用户已创建', newUser.username);
      setCreateOpen(false);
      setNewUser(EMPTY_NEW_USER);
      await load();
    } catch (e) {
      // 后端规则错误（重名等）→ 透传呈现
      toast.error('创建失败', errText(e));
    } finally {
      setBusy(false);
    }
  };

  const submitResetPassword = async (): Promise<void> => {
    if (resetTarget === null) return;
    if (resetPassword.length < 8) {
      toast.error('密码至少 8 个字符');
      return;
    }
    setBusy(true);
    try {
      await api.patch(`/api/v1/users/${resetTarget.id}`, { password: resetPassword });
      toast.success('密码已重置', resetTarget.username);
      setResetTarget(null);
      setResetPassword('');
    } catch (e) {
      toast.error('重置失败', errText(e));
    } finally {
      setBusy(false);
    }
  };

  const submitRoleChange = async (): Promise<void> => {
    if (roleTarget === null) return;
    const nextRole = roleTarget.role === 'admin' ? 'normal' : 'admin';
    setBusy(true);
    try {
      await api.patch(`/api/v1/users/${roleTarget.id}`, { role: nextRole });
      toast.success('角色已更新', `${roleTarget.username} → ${nextRole}`);
      setRoleTarget(null);
      await load();
    } catch (e) {
      // 降级最后一个 admin 等后端规则错误 → 透传
      toast.error('角色更新失败', errText(e));
      setRoleTarget(null);
    } finally {
      setBusy(false);
    }
  };

  const submitDelete = async (): Promise<void> => {
    if (deleteTarget === null) return;
    setBusy(true);
    try {
      await api.delete(`/api/v1/users/${deleteTarget.id}`);
      toast.success('用户已删除', deleteTarget.username);
      setDeleteTarget(null);
      await load();
    } catch (e) {
      // 不能删自己 / 最后一个 admin → 后端 400 规则错误透传
      toast.error('删除失败', errText(e));
      setDeleteTarget(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      {/* 页头 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold tracking-tight">用户</h2>
          <p className="text-muted-foreground text-sm">用户账号、角色与密码管理。</p>
        </div>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <PlusIcon aria-hidden />
          新建用户
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

      {/* 非 admin：友好 403 空态 */}
      {!loading && forbidden && (
        <EmptyState
          icon={ShieldXIcon}
          title="需要管理员权限"
          description="用户管理仅对 admin / root 角色开放。如需访问，请联系管理员提升角色后刷新页面。"
        />
      )}

      {/* 错误态（silent 请求，这里给内联重试） */}
      {!loading && !forbidden && error !== null && (
        <EmptyState icon={UserRoundIcon} title="用户列表加载失败" description={error}>
          <Button size="sm" variant="outline" onClick={() => void load()}>
            重试
          </Button>
        </EmptyState>
      )}

      {/* 列表 */}
      {!loading && !forbidden && error === null && users !== null && (
        <Card className="gap-0 overflow-hidden py-0">
          <CardContent className="divide-y p-0">
            {users.length === 0 && (
              <p className="text-muted-foreground py-12 text-center text-sm">暂无用户</p>
            )}
            {users.map((u) => {
              const isSelf = me?.userId === u.id;
              return (
                <div key={u.id} className="flex flex-wrap items-center gap-3 px-4 py-3 sm:px-5">
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                      <span className="truncate">{u.username}</span>
                      {isSelf && (
                        <Badge variant="outline" className="text-muted-foreground font-normal">
                          （我）
                        </Badge>
                      )}
                      <Badge variant={isAdminRole(u.role) ? 'default' : 'secondary'}>
                        {u.role === 'admin' ? 'admin' : u.role === 'root' ? 'root' : 'normal'}
                      </Badge>
                    </p>
                    <p className="text-muted-foreground mt-0.5 font-mono text-xs">
                      创建于 {formatDateTime(u.createdAt)}
                    </p>
                  </div>

                  <div className="flex items-center gap-3">
                    {/* 改角色：admin↔normal Switch（root 行不展示——后端不管理 root 虚拟身份） */}
                    {(u.role === 'admin' || u.role === 'normal') && (
                      <label className="text-muted-foreground flex items-center gap-2 text-xs">
                        admin
                        <Switch
                          checked={u.role === 'admin'}
                          disabled={busy}
                          onCheckedChange={() => setRoleTarget(u)}
                          aria-label={`切换 ${u.username} 的管理员角色`}
                        />
                      </label>
                    )}

                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => {
                        setResetTarget(u);
                        setResetPassword('');
                      }}
                      aria-label={`重置 ${u.username} 的密码`}
                    >
                      <KeyRoundIcon aria-hidden />
                    </Button>

                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="text-destructive hover:text-destructive"
                      disabled={isSelf}
                      onClick={() => setDeleteTarget(u)}
                      aria-label={isSelf ? '不能删除自己' : `删除用户 ${u.username}`}
                    >
                      <Trash2Icon aria-hidden />
                    </Button>
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      {/* 新建用户 Dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新建用户</DialogTitle>
            <DialogDescription>创建可登录控制台的账号（密码至少 8 个字符）。</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="new-username">用户名</Label>
              <Input
                id="new-username"
                value={newUser.username}
                onChange={(e) => setNewUser((p) => ({ ...p, username: e.target.value }))}
                placeholder="alice"
                autoComplete="off"
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="new-password">密码</Label>
              <Input
                id="new-password"
                type="password"
                value={newUser.password}
                onChange={(e) => setNewUser((p) => ({ ...p, password: e.target.value }))}
                placeholder="至少 8 个字符"
                autoComplete="new-password"
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label>角色</Label>
              <Select
                value={newUser.role}
                onValueChange={(v) => setNewUser((p) => ({ ...p, role: v === 'admin' ? 'admin' : 'normal' }))}
              >
                <SelectTrigger className="w-full" aria-label="角色">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="normal">normal — 普通用户</SelectItem>
                  <SelectItem value="admin">admin — 管理员</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={busy}>
              取消
            </Button>
            <Button onClick={() => void submitCreate()} disabled={busy}>
              创建
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 重置密码 Dialog */}
      <Dialog
        open={resetTarget !== null}
        onOpenChange={(open) => {
          if (!open) setResetTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>重置密码</DialogTitle>
            <DialogDescription>
              为用户 {resetTarget?.username ?? ''} 设置新密码（至少 8 个字符）。该用户的其他会话不会被自动注销。
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="reset-password">新密码</Label>
            <Input
              id="reset-password"
              type="password"
              value={resetPassword}
              onChange={(e) => setResetPassword(e.target.value)}
              placeholder="至少 8 个字符"
              autoComplete="new-password"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setResetTarget(null)} disabled={busy}>
              取消
            </Button>
            <Button onClick={() => void submitResetPassword()} disabled={busy}>
              重置
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 改角色确认 Dialog */}
      <Dialog
        open={roleTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRoleTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>确认更改角色</DialogTitle>
            <DialogDescription>
              {roleTarget !== null && (
                <>
                  将把用户 {roleTarget.username} 的角色由{' '}
                  <Badge variant="secondary">{roleTarget.role}</Badge> 改为{' '}
                  <Badge variant="secondary">{roleTarget.role === 'admin' ? 'normal' : 'admin'}</Badge>
                  。{roleTarget.role === 'admin' && '降级最后一个 admin 会被系统拒绝。'}
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRoleTarget(null)} disabled={busy}>
              取消
            </Button>
            <Button onClick={() => void submitRoleChange()} disabled={busy}>
              确认更改
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除用户确认 Dialog */}
      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>确认删除用户</DialogTitle>
            <DialogDescription>
              将永久删除用户 {deleteTarget?.username ?? ''}，并连带注销其全部会话与 API
              Key。此操作不可撤销；不能删除自己与最后一个 admin。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)} disabled={busy}>
              取消
            </Button>
            <Button variant="destructive" onClick={() => void submitDelete()} disabled={busy}>
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
