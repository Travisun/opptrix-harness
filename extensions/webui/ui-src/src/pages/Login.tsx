import { useEffect, useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { BoxesIcon, Loader2Icon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from '@/components/ui/toast';
import { api, getToken, setCachedUser, setToken, type ApiError, type LoginResult } from '@/lib/api';

/**
 * Login — 登录页（本包唯一完整实现的页面）。
 *
 * POST /api/v1/auth/login {username,password} → 存 token（'ui.token'）与用户缓存 → 跳仪表盘；
 * 失败经 toast 提示；已登录访问本页重定向 /。未登录访问任意路由由路由守卫重定向至此。
 */
export default function LoginPage(): React.ReactNode {
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // 已登录直接进控制台（hash 路由下的 /login 自愈）
  useEffect(() => {
    document.title = 'Opptrix Console — 登录';
  }, []);

  if (getToken() !== '') {
    return <Navigate to="/" replace />;
  }

  const handleSubmit = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    const name = username.trim();
    if (name === '' || password === '') {
      toast.error('请输入用户名与密码');
      return;
    }
    setSubmitting(true);
    api
      .post<LoginResult>(
        '/api/v1/auth/login',
        { username: name, password },
        { silent: true },
      )
      .then((result) => {
        setToken(result.token);
        setCachedUser(result.user);
        toast.success('登录成功', `欢迎回来，${result.user.username}`);
        navigate('/', { replace: true });
      })
      .catch((err: unknown) => {
        const apiErr = err as ApiError;
        const message =
          apiErr !== null && typeof apiErr === 'object' && typeof apiErr.message === 'string'
            ? apiErr.message
            : '登录失败，请稍后重试';
        toast.error('登录失败', message);
      })
      .finally(() => {
        setSubmitting(false);
      });
  };

  return (
    <div className="bg-background flex min-h-svh flex-col items-center justify-center p-4">
      <div className="w-full max-w-sm">
        {/* 品牌区 */}
        <div className="mb-6 flex flex-col items-center gap-2">
          <div className="bg-primary text-primary-foreground flex size-11 items-center justify-center rounded-lg shadow-sm">
            <BoxesIcon className="size-6" aria-hidden />
          </div>
          <p className="text-lg font-semibold tracking-tight">Opptrix 控制台</p>
          <p className="text-muted-foreground text-sm">Harness OS 管理台</p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>登录</CardTitle>
            <CardDescription>输入用户名与密码以继续</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
              <div className="flex flex-col gap-2">
                <Label htmlFor="login-username">用户名</Label>
                <Input
                  id="login-username"
                  name="username"
                  autoComplete="username"
                  autoFocus
                  placeholder="用户名"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  disabled={submitting}
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="login-password">密码</Label>
                <Input
                  id="login-password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  placeholder="密码"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={submitting}
                />
              </div>
              <Button type="submit" className="w-full" disabled={submitting}>
                {submitting && <Loader2Icon className="animate-spin" aria-hidden />}
                {submitting ? '登录中…' : '登录'}
              </Button>
            </form>
          </CardContent>
        </Card>

        <p className="text-muted-foreground mt-6 text-center text-xs">
          首次使用请使用部署引导创建的 owner 账号登录
        </p>
      </div>
    </div>
  );
}
