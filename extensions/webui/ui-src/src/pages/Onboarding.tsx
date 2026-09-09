import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { Link, useNavigate } from 'react-router-dom';
import QRCode from 'react-qr-code';
import {
  AlertCircleIcon,
  BoxesIcon,
  CheckCircle2Icon,
  CheckIcon,
  CopyIcon,
  EyeIcon,
  EyeOffIcon,
  Loader2Icon,
  RefreshCwIcon,
  ShieldCheckIcon,
} from 'lucide-react';

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
import { Separator } from '@/components/ui/separator';
import { toast } from '@/components/ui/toast';
import {
  getOnboardingStatus,
  getTwoFactorSetup,
  postOnboarding,
  postTwoFactorEnroll,
  setCachedUser,
  setToken,
  type ApiError,
  type TwoFactorEnrollResult,
  type TwoFactorSetupResult,
} from '@/lib/api';

/**
 * Onboarding — 首次初始化向导（/onboarding，公开路由）。
 *
 * 三步 Stepper（shadcn 风格步骤指示）：
 *   1. 验证服务器所有权：root 令牌（<dataDir>/root-token 或首启日志）+ owner 账号密码（≥8 位）
 *      → POST /api/v1/auth/onboarding；401(HARNESS-1006) 停留本步并提示。
 *   2. 绑定两步验证（强制）：GET /api/v1/auth/2fa/setup?enrollToken= → react-qr-code 渲染
 *      otpauth:// 二维码 + 手输 secret + 复制；输入 6 位动态码 → POST /api/v1/auth/2fa/enroll
 *      → 成功即签发会话（存 token）。
 *   3. 完成态 → 自动跳仪表盘。
 *
 * 复用导出：
 *   - MfaEnrollPanel：第 2 步绑定面板，Login 页 enrollmentRequired 分支内嵌复用；
 *   - OnboardingFinishContext：router.tsx 启动探测网关注入「解除强制重定向」的回调
 *     （避免页面 ↔ 路由循环 import）。
 */

/** onboarding 成功后由页面调用，解除 router 启动探测的强制 /onboarding 重定向 */
export const OnboardingFinishContext = createContext<() => void>(() => {});

// ---------------------------------------------------------------------------
// 步骤指示器（Stepper）
// ---------------------------------------------------------------------------

const STEPS = ['验证所有权', '绑定两步验证', '完成'] as const;

function Stepper({ current }: { current: number }): ReactNode {
  return (
    <ol className="flex w-full max-w-md items-center" aria-label="初始化步骤">
      {STEPS.map((label, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <li key={label} className="flex items-center gap-2">
            <span
              aria-current={active ? 'step' : undefined}
              className={
                done
                  ? 'bg-primary text-primary-foreground flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-medium'
                  : active
                    ? 'border-primary text-primary flex size-7 shrink-0 items-center justify-center rounded-full border-2 bg-background text-xs font-medium'
                    : 'border-border text-muted-foreground flex size-7 shrink-0 items-center justify-center rounded-full border bg-background text-xs font-medium'
              }
            >
              {done ? <CheckIcon className="size-3.5" aria-hidden /> : i + 1}
            </span>
            <span
              className={
                active
                  ? 'text-foreground hidden text-xs font-medium whitespace-nowrap sm:inline'
                  : 'text-muted-foreground hidden text-xs whitespace-nowrap sm:inline'
              }
            >
              {label}
            </span>
            {i < STEPS.length - 1 && (
              <span
                aria-hidden
                className={done ? 'bg-primary mx-1 h-px w-6 flex-1 sm:w-10' : 'bg-border mx-1 h-px w-6 flex-1 sm:w-10'}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}

// ---------------------------------------------------------------------------
// 页面骨架：品牌区 + Stepper + 内容卡 + 安全说明（移动端友好）
// ---------------------------------------------------------------------------

function OnboardingLayout({ step, children }: { step: number | null; children: ReactNode }): ReactNode {
  return (
    <div className="bg-background flex min-h-svh flex-col items-center justify-center gap-6 p-4">
      <div className="flex flex-col items-center gap-2">
        <div className="bg-primary text-primary-foreground flex size-11 items-center justify-center rounded-lg shadow-sm">
          <BoxesIcon className="size-6" aria-hidden />
        </div>
        <p className="text-lg font-semibold tracking-tight">Opptrix Harness OS</p>
        <p className="text-muted-foreground text-sm">首次初始化向导</p>
      </div>
      {step !== null && <Stepper current={step} />}
      <div className="w-full max-w-md">{children}</div>
      <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
        <ShieldCheckIcon className="size-3.5" aria-hidden />
        两步验证为强制项，用于保护管理员账户
      </p>
    </div>
  );
}

function toErrMessage(err: unknown, fallback: string): string {
  const apiErr = err as ApiError | undefined;
  return apiErr !== null && typeof apiErr === 'object' && typeof apiErr.message === 'string' && apiErr.message !== ''
    ? apiErr.message
    : fallback;
}

// ---------------------------------------------------------------------------
// 可复用绑定面板：GET setup → 二维码/手输 secret → 6 位码 → POST enroll
// （Onboarding 第 2 步与 Login 页 enrollmentRequired 分支共用）
// ---------------------------------------------------------------------------

export function MfaEnrollPanel({
  enrollToken,
  onDone,
}: {
  enrollToken: string;
  onDone: (result: TwoFactorEnrollResult) => void;
}): ReactNode {
  const [setup, setSetup] = useState<TwoFactorSetupResult | null>(null);
  const [setupLoading, setSetupLoading] = useState(true);
  const [setupError, setSetupError] = useState('');
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [copied, setCopied] = useState(false);
  const codeInputRef = useRef<HTMLInputElement>(null);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const loadSetup = useCallback((): void => {
    setSetupLoading(true);
    setSetupError('');
    getTwoFactorSetup(enrollToken)
      .then((s) => {
        setSetup(s);
        // 二维码就绪后聚焦验证码输入（自动滚动进视野）
        requestAnimationFrame(() => codeInputRef.current?.focus());
      })
      .catch((err: unknown) => {
        setSetupError(toErrMessage(err, '无法获取绑定信息，请检查网络后重试'));
      })
      .finally(() => {
        setSetupLoading(false);
      });
  }, [enrollToken]);

  useEffect(() => {
    loadSetup();
    return () => {
      if (copiedTimerRef.current !== undefined) clearTimeout(copiedTimerRef.current);
    };
  }, [loadSetup]);

  const handleCopySecret = (): void => {
    if (setup === null) return;
    navigator.clipboard
      .writeText(setup.secret)
      .then(() => {
        setCopied(true);
        if (copiedTimerRef.current !== undefined) clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = setTimeout(() => setCopied(false), 1500);
        toast.success('已复制', '密钥已复制到剪贴板');
      })
      .catch(() => {
        toast.error('复制失败', '请手动选择密钥文本复制');
      });
  };

  const handleEnroll = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    if (code.length !== 6) {
      toast.error('请输入 6 位动态验证码');
      return;
    }
    setSubmitting(true);
    setCodeError('');
    postTwoFactorEnroll({ enrollToken, code })
      .then((result) => {
        toast.success('两步验证绑定成功', '管理员账户已就绪');
        onDone(result);
      })
      .catch((err: unknown) => {
        const apiErr = err as ApiError;
        if (apiErr !== null && typeof apiErr === 'object' && apiErr.status === 400) {
          setCodeError('动态验证码不正确，请输入认证器 App 当前显示的 6 位码');
          setCode('');
          codeInputRef.current?.focus();
        } else {
          toast.error('绑定失败', toErrMessage(err, '请稍后重试'));
        }
      })
      .finally(() => {
        setSubmitting(false);
      });
  };

  if (setupLoading) {
    return (
      <Card>
        <CardContent className="text-muted-foreground flex flex-col items-center gap-3 py-10 text-sm">
          <Loader2Icon className="animate-spin" aria-hidden />
          正在生成绑定二维码…
        </CardContent>
      </Card>
    );
  }

  if (setupError !== '') {
    return (
      <Card>
        <CardContent className="flex flex-col gap-4 py-8">
          <Alert variant="destructive">
            <AlertCircleIcon />
            <AlertTitle>获取绑定信息失败</AlertTitle>
            <AlertDescription>{setupError}</AlertDescription>
          </Alert>
          <Button variant="outline" onClick={loadSetup} className="w-full">
            <RefreshCwIcon aria-hidden />
            重试
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>绑定两步验证（强制）</CardTitle>
        <CardDescription>使用认证器 App 扫描二维码，或手动输入密钥</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-5">
          {/* otpauth:// 二维码（白底保证暗色主题下可扫） */}
          <div className="flex flex-col items-center gap-3">
            <div className="rounded-lg border bg-white p-3 shadow-xs">
              <QRCode value={setup?.uri ?? ''} size={168} bgColor="#ffffff" fgColor="#000000" title="两步验证绑定二维码" />
            </div>
            <p className="text-muted-foreground text-center text-xs">
              使用 Google Authenticator、1Password 等认证器 App 扫码
            </p>
          </div>

          <div className="flex items-center gap-2">
            <Separator className="flex-1" />
            <span className="text-muted-foreground text-xs">或手动输入密钥</span>
            <Separator className="flex-1" />
          </div>

          {/* 手输 secret + 复制 */}
          <div className="flex flex-col gap-2">
            <Label htmlFor="mfa-secret">密钥（Secret）</Label>
            <div className="flex items-center gap-2">
              <code
                id="mfa-secret"
                className="border-input bg-muted/50 min-w-0 flex-1 truncate rounded-md border px-3 py-2 font-mono text-sm break-all"
              >
                {setup?.secret ?? ''}
              </code>
              <Button type="button" variant="outline" size="icon" onClick={handleCopySecret} aria-label="复制密钥">
                {copied ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
              </Button>
            </div>
          </div>

          {codeError !== '' && (
            <Alert variant="destructive">
              <AlertCircleIcon />
              <AlertDescription>{codeError}</AlertDescription>
            </Alert>
          )}

          <form onSubmit={handleEnroll} className="flex flex-col gap-4" noValidate>
            <div className="flex flex-col gap-2">
              <Label htmlFor="mfa-code">动态验证码</Label>
              <Input
                id="mfa-code"
                name="code"
                ref={codeInputRef}
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="000000"
                maxLength={6}
                className="text-center font-mono text-lg tracking-[0.5em]"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                disabled={submitting}
              />
              <p className="text-muted-foreground text-xs">输入认证器 App 当前显示的 6 位数字</p>
            </div>
            <Button type="submit" className="w-full" disabled={submitting || code.length !== 6}>
              {submitting && <Loader2Icon className="animate-spin" aria-hidden />}
              {submitting ? '绑定中…' : '绑定并完成初始化'}
            </Button>
          </form>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// 默认导出：三步向导页
// ---------------------------------------------------------------------------

type Phase = 'checking' | 'initialized' | 'account' | 'enroll' | 'done';

export default function OnboardingPage(): ReactNode {
  const navigate = useNavigate();
  const finishOnboarding = useContext(OnboardingFinishContext);
  const [phase, setPhase] = useState<Phase>('checking');
  const [checkError, setCheckError] = useState('');
  const [enrollToken, setEnrollToken] = useState('');

  // 第 1 步表单状态
  const [rootToken, setRootToken] = useState('');
  const [showRootToken, setShowRootToken] = useState(false);
  const [username, setUsername] = useState('owner');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    document.title = 'Dashboard — 初始化向导';
  }, []);

  /** 第 0 步探测：needsOnboarding=false → 「系统已初始化」+ 去登录 */
  const probe = useCallback((): void => {
    setCheckError('');
    setPhase('checking');
    getOnboardingStatus()
      .then((s) => {
        setPhase(s.needsOnboarding === true ? 'account' : 'initialized');
      })
      .catch((err: unknown) => {
        setCheckError(toErrMessage(err, '无法连接服务器，请确认服务已启动后重试'));
      });
  }, []);

  useEffect(() => {
    probe();
  }, [probe]);

  // 完成态 → 自动跳仪表盘
  useEffect(() => {
    if (phase !== 'done') return;
    const timer = setTimeout(() => navigate('/', { replace: true }), 1200);
    return () => clearTimeout(timer);
  }, [phase, navigate]);

  const handleAccountSubmit = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    const name = username.trim() === '' ? 'owner' : username.trim();
    if (rootToken === '') {
      toast.error('请输入 root 令牌');
      return;
    }
    if (password.length < 8) {
      toast.error('密码过短', '管理员密码至少需要 8 位');
      return;
    }
    setSubmitting(true);
    postOnboarding({ rootToken, username: name, password })
      .then((r) => {
        setEnrollToken(r.enrollToken);
        setPhase('enroll');
      })
      .catch((err: unknown) => {
        const apiErr = err as ApiError;
        if (apiErr !== null && typeof apiErr === 'object' && apiErr.code === 'HARNESS-1006') {
          toast.error('root 令牌验证失败', '请核对服务器 <dataDir>/root-token 文件内容（或首启日志）后重试');
        } else if (apiErr !== null && typeof apiErr === 'object' && apiErr.status === 401) {
          toast.error('root 令牌验证失败', toErrMessage(err, '令牌不正确'));
        } else {
          toast.error('初始化失败', toErrMessage(err, '请稍后重试'));
        }
      })
      .finally(() => {
        setSubmitting(false);
      });
  };

  const handleEnrolled = (result: TwoFactorEnrollResult): void => {
    setToken(result.token);
    setCachedUser(result.user);
    finishOnboarding(); // 解除路由网关的强制重定向，再进入仪表盘
    setPhase('done');
  };

  // ---- 探测中（第 0 步 loading） ----
  if (phase === 'checking' && checkError === '') {
    return (
      <OnboardingLayout step={null}>
        <Card>
          <CardContent className="text-muted-foreground flex flex-col items-center gap-3 py-10 text-sm">
            <Loader2Icon className="animate-spin" aria-hidden />
            正在检查系统初始化状态…
          </CardContent>
        </Card>
      </OnboardingLayout>
    );
  }

  // ---- 探测失败（三态之错误态） ----
  if (checkError !== '') {
    return (
      <OnboardingLayout step={null}>
        <Card>
          <CardContent className="flex flex-col gap-4 py-8">
            <Alert variant="destructive">
              <AlertCircleIcon />
              <AlertTitle>初始化状态检查失败</AlertTitle>
              <AlertDescription>{checkError}</AlertDescription>
            </Alert>
            <Button variant="outline" onClick={probe} className="w-full">
              <RefreshCwIcon aria-hidden />
              重试
            </Button>
          </CardContent>
        </Card>
      </OnboardingLayout>
    );
  }

  // ---- 已初始化：去登录 ----
  if (phase === 'initialized') {
    return (
      <OnboardingLayout step={null}>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CheckCircle2Icon className="text-emerald-600 dark:text-emerald-400 size-5" aria-hidden />
              系统已初始化
            </CardTitle>
            <CardDescription>本系统已完成首次初始化，无需重复引导。</CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild className="w-full">
              <Link to="/login">前往登录</Link>
            </Button>
          </CardContent>
        </Card>
      </OnboardingLayout>
    );
  }

  // ---- 第 3 步完成态（自动跳仪表盘） ----
  if (phase === 'done') {
    return (
      <OnboardingLayout step={STEPS.length - 1}>
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
            <CheckCircle2Icon className="text-emerald-600 dark:text-emerald-400 size-10" aria-hidden />
            <p className="text-base font-medium">初始化完成</p>
            <p className="text-muted-foreground text-sm">两步验证已绑定，即将进入 Dashboard…</p>
            <Loader2Icon className="text-muted-foreground size-4 animate-spin" aria-hidden />
          </CardContent>
        </Card>
      </OnboardingLayout>
    );
  }

  // ---- 第 2 步：强制绑定两步验证（与 Login 内嵌流共用面板） ----
  if (phase === 'enroll') {
    return (
      <OnboardingLayout step={1}>
        <MfaEnrollPanel enrollToken={enrollToken} onDone={handleEnrolled} />
      </OnboardingLayout>
    );
  }

  // ---- 第 1 步：验证服务器所有权 ----
  return (
    <OnboardingLayout step={0}>
      <Card>
        <CardHeader>
          <CardTitle>验证服务器所有权</CardTitle>
          <CardDescription>
            输入 root 令牌以创建管理员账号。内容见服务器 <code className="font-mono text-xs">&lt;dataDir&gt;/root-token</code>{' '}
            文件或首启日志
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleAccountSubmit} className="flex flex-col gap-4" noValidate>
            <div className="flex flex-col gap-2">
              <Label htmlFor="ob-root-token">root 令牌</Label>
              <div className="relative">
                <Input
                  id="ob-root-token"
                  name="rootToken"
                  type={showRootToken ? 'text' : 'password'}
                  autoComplete="off"
                  autoFocus
                  placeholder="服务器 root 令牌"
                  className="pr-10 font-mono"
                  value={rootToken}
                  onChange={(e) => setRootToken(e.target.value)}
                  disabled={submitting}
                />
                <button
                  type="button"
                  onClick={() => setShowRootToken((v) => !v)}
                  aria-label={showRootToken ? '隐藏 root 令牌' : '显示 root 令牌'}
                  className="text-muted-foreground hover:text-foreground absolute inset-y-0 right-0 flex w-9 cursor-pointer items-center justify-center outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {showRootToken ? <EyeOffIcon className="size-4" aria-hidden /> : <EyeIcon className="size-4" aria-hidden />}
                </button>
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="ob-username">管理员用户名</Label>
              <Input
                id="ob-username"
                name="username"
                autoComplete="username"
                placeholder="owner"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                disabled={submitting}
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="ob-password">管理员密码</Label>
              <Input
                id="ob-password"
                name="password"
                type="password"
                autoComplete="new-password"
                placeholder="至少 8 位"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={submitting}
              />
              <p className="text-muted-foreground text-xs">密码至少 8 位，用于登录 Dashboard</p>
            </div>

            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting && <Loader2Icon className="animate-spin" aria-hidden />}
              {submitting ? '验证中…' : '验证并继续'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </OnboardingLayout>
  );
}
