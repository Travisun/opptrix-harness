import { createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router';

import { clearToken, getToken } from './api';

/**
 * 路由表（hash 模式，见 vite.config.ts 注释）。
 * 全局前置守卫：无 token 一律去 /login（登录页自身除外）。
 */
const routes: RouteRecordRaw[] = [
  { path: '/login', name: 'login', component: () => import('./pages/Login.vue'), meta: { title: '登录' } },
  { path: '/', name: 'dashboard', component: () => import('./pages/Dashboard.vue'), meta: { title: '仪表盘' } },
  { path: '/extensions', name: 'extensions', component: () => import('./pages/Extensions.vue'), meta: { title: '扩展' } },
  { path: '/cron', name: 'cron', component: () => import('./pages/Cron.vue'), meta: { title: '定时任务' } },
  { path: '/notifications', name: 'notifications', component: () => import('./pages/Notifications.vue'), meta: { title: '通知' } },
  { path: '/chat', name: 'chat', component: () => import('./pages/Chat.vue'), meta: { title: '聊天' } },
  { path: '/files-tasks', name: 'files-tasks', component: () => import('./pages/FilesTasks.vue'), meta: { title: '文件与任务' } },
  { path: '/settings', name: 'settings', component: () => import('./pages/Settings.vue'), meta: { title: '设置' } },
  { path: '/update', name: 'update', component: () => import('./pages/Update.vue'), meta: { title: '升级' } },
  { path: '/sandbox', name: 'sandbox', component: () => import('./pages/Sandbox.vue'), meta: { title: '沙箱' } },
  { path: '/:pathMatch(.*)*', redirect: '/' },
];

export const router = createRouter({
  history: createWebHashHistory(),
  routes,
});

router.beforeEach((to) => {
  if (to.name !== 'login' && getToken() === '') return { name: 'login' };
  if (to.name === 'login' && getToken() !== '') return { name: 'dashboard' };
  document.title = `Opptrix Console — ${String(to.meta.title ?? '')}`;
  return true;
});

router.onError(() => {
  // 懒加载 chunk 失败（产物更新后旧 hash 引用失效）：清凭据回登录页兜底
  clearToken();
  location.hash = '#/login';
});
