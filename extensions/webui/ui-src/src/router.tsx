import { HashRouter, Navigate, Outlet, Route, Routes } from 'react-router-dom';

import { AppShell } from '@/components/layout/AppShell';
import { getToken } from '@/lib/api';
import ApiKeysPage from '@/pages/ApiKeys';
import CronPage from '@/pages/Cron';
import DashboardPage from '@/pages/Dashboard';
import ExtensionsPage from '@/pages/Extensions';
import FilesTasksPage from '@/pages/FilesTasks';
import LogsPage from '@/pages/Logs';
import LoginPage from '@/pages/Login';
import NotificationsPage from '@/pages/Notifications';
import SandboxPage from '@/pages/Sandbox';
import SettingsPage from '@/pages/Settings';
import UpdatePage from '@/pages/Update';
import UsersPage from '@/pages/Users';

/**
 * router — 控制台路由表（HashRouter）。
 *
 * hash 模式是硬约束：内核静态挂载无目录索引（index:false）也无 rewrite 能力，
 * history 深链刷新会 404。
 *
 * 路由完整性契约：主导航 11 条（仪表盘 / 扩展 / 定时任务 / 通知中心 / 文件与任务 /
 * 沙箱 / 用户 / API Keys / 日志 / 设置 / 升级）+ /login + 兜底重定向，
 * 与 src/lib/nav.tsx 的 NAV_GROUPS 单一数据源对齐。
 * 认证守卫：未登录访问任意业务路由 → /login；已登录访问 /login → /。
 */

/** 已认证守卫：无 token 一律去登录页（api.ts 的 401 处理与之呼应） */
function RequireAuth(): React.ReactNode {
  return getToken() !== '' ? <Outlet /> : <Navigate to="/login" replace />;
}

export function AppRoutes(): React.ReactNode {
  return (
    <HashRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route element={<RequireAuth />}>
          <Route element={<AppShell />}>
            <Route index path="/" element={<DashboardPage />} />
            <Route path="/extensions" element={<ExtensionsPage />} />
            <Route path="/cron" element={<CronPage />} />
            <Route path="/notifications" element={<NotificationsPage />} />
            <Route path="/files-tasks" element={<FilesTasksPage />} />
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
    </HashRouter>
  );
}
