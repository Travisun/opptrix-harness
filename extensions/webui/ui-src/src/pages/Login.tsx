import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { BoxesIcon, Loader2Icon, ShieldCheckIcon } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
import {
  api,
  getToken,
  setCachedUser,
  setToken,
  type ApiError,
  type LoginResponse,
  type LoginResult,
  type TwoFactorEnrollResult,
} from '@/lib/api';
import { MfaEnrollPanel } from '@/pages/Onboarding';

/**
 * Login — 登录页（含 MFA 二步验证与强制 2FA 绑定流的入口）。
 *
 * POST /api/v1/auth/login 三种 200 响应分支（auth 扩展契约）：
 *   - {mfaRequired, mfaToken}      → 同页第二步：输入 6 位 TOTP
 *     → POST /api/v1/auth/login/2fa {mfaToken, totp} → 200 {token,user} 进仪表盘 / 401 提示重输；
 *   - {enrollmentRequired, enrollToken} → 内嵌强制 2FA 绑定流（复用 Onboarding 的 MfaEnrollPanel：
 *     GET setup → QR → POST enroll → 存 token 进仪表盘）；
 *   - {token, user}                → 直接进仪表盘。
 * 401 → 错误提示停留。mfaToken/enrollToken 仅存内存，不落 localStorage。
 * 已登录访问本页重定向 /；未登录访问任意路由由路由守卫重定向至此。
 */

type LoginPhase = 'credentials' | 'mfa' | 'enroll';

export default function LoginPage(): React.ReactNode {
  const navigate = useNavigate();
  const [phase, setPhase] = useState<LoginPhase>('credentials');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // 第二步（MFA）/内嵌绑定流的会话内凭据（仅内存，刷新即失效 → 回到凭据步）
  const [mfaToken, setMfaToken] = useState('');
  const [enrollToken, setEnrollToken] = useState('');
  const [totp, setTotp] = useState('');
  const [totpError, setTotpError] = useState('');
  const totpInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    document.title = 'Opptrix Console — 登录';
  }, []);

  // 已登录直接进控制台（hash 路由下的 /login 自愈）
  if (getToken() !== '') {
    return <Navigate to="/" replace />;
  }

  const enterDashboard = (token: string, user: LoginResult['user'], greeting: string): void => {
    setToken(token);
    setCachedUser(user);
    toast.success('登录成功', `${greeting}，${user.username}`);
    navigate('/', { replace: true });
  };

  const handleSubmit = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    const name = username.trim();
    if (name === '' || password === '') {
      toast.error('请输入用户名与密码');
      return;
    }
    setSubmitting(true);
    api
      .post<LoginResponse>('/api/v1/auth/login', { username: name, password }, { silent: true, skipAuthRedirect: true })
      .then((result) => {
        if ('mfaRequired' in result) {
          // 分支 1：两步验证 → 同页第二步（mfaToken 仅存内存）
          setMfaToken(result.mfaToken);
          setTotp('');
          setTotpError('');
          setPhase('mfa');
          requestAnimationFrame(() => totpInputRef.current?.focus());
          return;
        }
        if ('enrollmentRequired' in result) {
          // 分支 2：账号未绑定 2FA（强制）→ 内嵌绑定流
          setEnrollToken(result.enrollToken);
          setPhase('enroll');
          return;
        }
        // 分支 3：直接签发会话
        enterDashboard(result.token, result.user, '欢迎回来');
      })
      .catch((err: unknown) => {
        toast.error('登录失败', toErrMessage(err, '用户名或密码不正确，请稍后重试'));
      })
      .finally(() => {
        setSubmitting(false);
      });
  };

  const handleMfaSubmit = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    if (totp.length !== 6) {
      toast.error('请输入 6 位动态验证码');
      return;
    }
    setSubmitting(true);
    setTotpError('');
    api
      .post<LoginResult>(
        '/api/v1/auth/login/2fa',
        { mfaToken, totp },
        { silent: true, skipAuthRedirect: true },
      )
      .then((result) => {
        enterDashboard(result.token, result.user, '欢迎回来');
      })
      .catch((err: unknown) => {
        const apiErr = err as ApiError;
        if (apiErr !== null && typeof apiErr === 'object' && apiErr.status === 401) {
          setTotpError('动态验证码不正确或已过期，请输入认证器 App 当前显示的 6 位码');
          setTotp('');
          totpInputRef.current?.focus();
        } else {
          toast.error('验证失败', toErrMessage(err, '请稍后重试'));
        }
      })
      .finally(() => {
        setSubmitting(false);
      });
  };

  const handleEnrolled = (result: TwoFactorEnrollResult): void => {
    // 绑定成功即签发会话 → 直接进仪表盘
    enterDashboard(result.token, result.user, '两步验证绑定成功，欢迎');
  };

  const backToCredentials = (): void => {
    setPhase('credentials');
    setMfaToken('');
    setEnrollToken('');
    setTotp('');
    setTotpError('');
  };

  // ---- 内嵌强制 2FA 绑定流（复用 Onboarding 第 2 步面板） ----
  if (phase === 'enroll') {
    return (
      <LoginLayout subtitle="首次登录需绑定两步验证">
        <MfaEnrollPanel enrollToken={enrollToken} onDone={handleEnrolled} />
        <div className="mt-4 text-center">
          <Button type="button" variant="link" size="sm" onClick={backToCredentials}>
            返回重新登录
          </Button>
        </div>
      </LoginLayout>
    );
  }

  // ---- 第二步：6 位 TOTP（mfaToken 存内存） ----
  if (phase === 'mfa') {
    return (
      <LoginLayout subtitle="两步验证">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldCheckIcon className="text-primary size-5" aria-hidden />
              输入动态验证码
            </CardTitle>
            <CardDescription>打开认证器 App，输入当前显示的 6 位数字</CardDescription>
          </CardHeader>
          <CardContent>
            {totpError !== '' && (
              <Alert variant="destructive" className="mb-4">
                <AlertTitle>验证未通过</AlertTitle>
                <AlertDescription>{totpError}</AlertDescription>
              </Alert>
            )}
            <form onSubmit={handleMfaSubmit} className="flex flex-col gap-4" noValidate>
              <div className="flex flex-col gap-2">
                <Label htmlFor="login-totp">动态验证码</Label>
                <Input
                  id="login-totp"
                  name="totp"
                  ref={totpInputRef}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  autoFocus
                  placeholder="000000"
                  maxLength={6}
                  className="text-center font-mono text-lg tracking-[0.5em]"
                  value={totp}
                  onChange={(e) => setTotp(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  disabled={submitting}
                />
              </div>
              <Button type="submit" className="w-full" disabled={submitting || totp.length !== 6}>
                {submitting && <Loader2Icon className="animate-spin" aria-hidden />}
                {submitting ? '验证中…' : '验证并登录'}
              </Button>
              <Button type="button" variant="ghost" className="w-full" onClick={backToCredentials} disabled={submitting}>
                返回重新登录
              </Button>
            </form>
          </CardContent>
        </Card>
      </LoginLayout>
    );
  }

  // ---- 第一步：用户名 + 密码 ----
  return (
    <LoginLayout subtitle="Harness OS 管理台">
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
        首次使用请运行服务器初始化向导创建 owner 账号
      </p>
    </LoginLayout>
  );
}

// ---------------------------------------------------------------------------
// 页面骨架：品牌区 + 内容（max-w-sm，移动端友好）
// ---------------------------------------------------------------------------

function LoginLayout({
  subtitle,
  children,
}: {
  subtitle: string;
  children: React.ReactNode;
}): React.ReactNode {
  return (
    <div className="bg-background flex min-h-svh flex-col items-center justify-center p-4">
      <div className="w-full max-w-sm">
        {/* 品牌区 */}
        <div className="mb-6 flex flex-col items-center gap-2">
          <div className="bg-primary text-primary-foreground flex size-11 items-center justify-center rounded-lg shadow-sm">
            <BoxesIcon className="size-6" aria-hidden />
          </div>
          <p className="text-lg font-semibold tracking-tight">Opptrix 控制台</p>
          <p className="text-muted-foreground text-sm">{subtitle}</p>
        </div>
        {children}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 局部工具
// ---------------------------------------------------------------------------

function toErrMessage(err: unknown, fallback: string): string {
  const apiErr = err as ApiError | undefined;
  return apiErr !== null && typeof apiErr === 'object' && typeof apiErr.message === 'string' && apiErr.message !== ''
    ? apiErr.message
    : fallback;
}
