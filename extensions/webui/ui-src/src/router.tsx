import { useEffect, useState, type ReactNode } from 'react';
import { HashRouter, Navigate, Outlet, Route, Routes } from 'react-router-dom';
import { BoxesIcon, Loader2Icon } from 'lucide-react';

import { AppShell } from '@/components/layout/AppShell';
import { getOnboardingStatus, getToken } from '@/lib/api';
import ApiKeysPage from '@/pages/ApiKeys';
import CronPage from '@/pages/Cron';
import DashboardPage from '@/pages/Dashboard';
import ExtensionsPage from '@/pages/Extensions';
import FilesTasksPage from '@/pages/FilesTasks';
import SkillsPage from '@/pages/Skills';
import McpPage from '@/pages/Mcp';
import PluginsPage from '@/pages/Plugins';
import LogsPage from '@/pages/Logs';
import LoginPage from '@/pages/Login';
import NotificationsPage from '@/pages/Notifications';
import OnboardingPage, { OnboardingFinishContext } from '@/pages/Onboarding';
import SandboxPage from '@/pages/Sandbox';
import SettingsPage from '@/pages/Settings';
import UpdatePage from '@/pages/Update';
import UsersPage from '@/pages/Users';

/**
 * router — Dashboard 路由表（HashRouter）。
 *
 * hash 模式是硬约束：内核静态挂载无目录索引（index:false）也无 rewrite 能力，
 * history 深链刷新会 404。
 *
 * 路由完整性契约：主导航 11 条（仪表盘 / 扩展 / 定时任务 / 通知中心 / 文件与任务 /
 * 沙箱 / 用户 / API Keys / 日志 / 设置 / 升级）+ /login + /onboarding（公开）+ 兜底重定向，
 * 与 src/lib/nav.tsx 的 NAV_GROUPS 单一数据源对齐（/onboarding 为引导专用，不入主导航）。
 * 认证守卫：未登录访问任意业务路由 → /login；已登录访问 /login → /。
 *
 * 启动探测（OnboardingGate）：挂载后（已登录除外）调 GET /api/v1/auth/onboarding/status，
 * needsOnboarding=true 且本地无 token → 全部路由强制重定向 /onboarding（首次初始化向导），
 * 向导完成后经 OnboardingFinishContext 解除强制，进入仪表盘。探测期间渲染品牌闪屏，
 * 探测失败按「无需引导」处理（保持既有行为，不因探测故障锁死 Dashboard）。
 */

/** 已认证守卫：无 token 一律去登录页（api.ts 的 401 处理与之呼应） */
function RequireAuth(): ReactNode {
  return getToken() !== '' ? <Outlet /> : <Navigate to="/login" replace />;
}

/** 启动探测闪屏（探测期间无路由可渲染，防内容闪烁） */
function ProbeSplash(): ReactNode {
  return (
    <div className="bg-background flex min-h-svh flex-col items-center justify-center gap-3 p-4">
      <div className="bg-primary text-primary-foreground flex size-11 items-center justify-center rounded-lg shadow-sm">
        <BoxesIcon className="size-6" aria-hidden />
      </div>
      <p className="text-muted-foreground flex items-center gap-2 text-sm">
        <Loader2Icon className="size-4 animate-spin" aria-hidden />
        正在检查系统状态…
      </p>
    </div>
  );
}

/**
 * 启动探测网关：needsOnboarding=true 且未登录 → 仅渲染 /onboarding（其余全重定向）。
 * OnboardingFinishContext 供向导成功后解除强制（避免页面 ↔ 路由循环 import）。
 */
function OnboardingGate({ children }: { children: ReactNode }): ReactNode {
  const [phase, setPhase] = useState<'probing' | 'ready'>('probing');
  const [needsOnboarding, setNeedsOnboarding] = useState(false);

  useEffect(() => {
    if (getToken() !== '') {
      // 已登录（含 root token 直连场景）：无需引导探测
      setPhase('ready');
      return;
    }
    let alive = true;
    getOnboardingStatus()
      .then((s) => {
        if (alive) setNeedsOnboarding(s.needsOnboarding === true);
      })
      .catch(() => {
        if (alive) setNeedsOnboarding(false); // 探测失败不锁死 Dashboard
      })
      .finally(() => {
        if (alive) setPhase('ready');
      });
    return () => {
      alive = false;
    };
  }, []);

  if (phase === 'probing') {
    return <ProbeSplash />;
  }

  const forceOnboarding = needsOnboarding && getToken() === '';

  return (
    <OnboardingFinishContext.Provider value={() => setNeedsOnboarding(false)}>
      {forceOnboarding ? (
        <Routes>
          <Route path="/onboarding" element={<OnboardingPage />} />
          <Route path="*" element={<Navigate to="/onboarding" replace />} />
        </Routes>
      ) : (
        children
      )}
    </OnboardingFinishContext.Provider>
  );
}

export function AppRoutes(): ReactNode {
  return (
    <HashRouter>
      <OnboardingGate>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/onboarding" element={<OnboardingPage />} />
          <Route element={<RequireAuth />}>
            <Route element={<AppShell />}>
              <Route index path="/" element={<DashboardPage />} />
              <Route path="/extensions" element={<ExtensionsPage />} />
              <Route path="/cron" element={<CronPage />} />
              <Route path="/notifications" element={<NotificationsPage />} />
              <Route path="/files-tasks" element={<FilesTasksPage />} />
              <Route path="/skills" element={<SkillsPage />} />
              <Route path="/mcp" element={<McpPage />} />
              <Route path="/plugins" element={<PluginsPage />} />
              <Route path="/sandbox" element={<SandboxPage />} />
              <Route path="/users" element={<UsersPage />} />
              <Route path="/api-keys" element={<ApiKeysPage />} />
              <Route path="/logs" element={<LogsPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/update" element={<UpdatePage />} />
            </Route>
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </OnboardingGate>
    </HashRouter>
  );
}
