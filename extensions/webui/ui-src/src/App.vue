<script setup lang="ts">
/**
 * App — 布局壳：左侧导航（内置页 + /api/v1/ui 聚合的扩展菜单）、顶栏（当前用户/退出）、
 * 内容区 router-view、全局 toast 栈。<768px 侧栏折叠为抽屉。
 * 登录页（/login）不套布局。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import {
  api,
  clearToken,
  getCachedUser,
  getToken,
  onToasts,
  pushToast,
  type MeResult,
  type Toast,
  type UiContributionEntry,
} from './api';

interface NavItem {
  label: string;
  to: string;
  icon: string;
  external?: boolean;
}

const BUILTIN_NAV: NavItem[] = [
  { label: '仪表盘', to: '/', icon: '▦' },
  { label: '扩展', to: '/extensions', icon: '⧉' },
  { label: '定时任务', to: '/cron', icon: '⏱' },
  { label: '通知', to: '/notifications', icon: '🔔' },
  { label: '聊天', to: '/chat', icon: '💬' },
  { label: '文件与任务', to: '/files-tasks', icon: '📁' },
  { label: '设置', to: '/settings', icon: '⚙' },
  { label: '升级', to: '/update', icon: '⇪' },
  { label: '沙箱', to: '/sandbox', icon: '▣' },
];

const route = useRoute();
const router = useRouter();

const isLogin = computed(() => route.name === 'login');
const toasts = ref<Toast[]>([]);
const offToasts = onToasts((list) => (toasts.value = list));

// ---- 顶栏当前用户 ----
const me = ref<{ username: string | null; role: string; tokenType: string } | null>(
  getCachedUser() !== null ? { username: getCachedUser()?.username ?? null, role: getCachedUser()?.role ?? '', tokenType: 'session' } : null,
);
const loggingOut = ref(false);

async function refreshMe(): Promise<void> {
  if (getToken() === '') return;
  try {
    const identity = await api.get<MeResult>('/api/v1/auth/me', { silent: true });
    me.value = { username: identity.username, role: identity.role, tokenType: identity.tokenType };
  } catch {
    me.value = null;
  }
}

async function logout(): Promise<void> {
  loggingOut.value = true;
  try {
    await api.post('/api/v1/auth/logout', undefined, { silent: true });
  } catch {
    /* 会话已失效等情况：本地清理照常进行 */
  }
  clearToken();
  loggingOut.value = false;
  me.value = null;
  pushToast('info', '已退出登录');
  await router.push({ name: 'login' });
}

// ---- 扩展 UI 菜单聚合（GET /api/v1/ui；仅取非 webui 的菜单项）----
const extNav = ref<NavItem[]>([]);
const uiCount = ref(0);

async function refreshUiNav(): Promise<void> {
  if (getToken() === '') return;
  try {
    const snapshot = await api.get<UiContributionEntry[]>('/api/v1/ui', { silent: true });
    uiCount.value = snapshot.length;
    extNav.value = snapshot
      .filter((entry) => entry.extId !== 'webui' && entry.menu !== undefined)
      .map((entry) => ({
        label: entry.menu?.label ?? entry.extId,
        to: `/ext/${entry.extId}/ui${entry.pages[0]?.path ?? '/'}`,
        icon: '⬡',
        external: true,
      }));
  } catch {
    extNav.value = [];
  }
}

// ---- 移动端抽屉 ----
const drawerOpen = ref(false);
watch(() => route.fullPath, () => (drawerOpen.value = false));

onMounted(() => {
  refreshMe();
  refreshUiNav();
});
onBeforeUnmount(() => offToasts());
</script>

<template>
  <router-view v-if="isLogin" />
  <div v-else class="shell">
    <header class="topbar">
      <button class="ghost burger" type="button" aria-label="菜单" @click="drawerOpen = !drawerOpen">☰</button>
      <span class="brand">Opptrix <strong>Console</strong></span>
      <span class="spacer" />
      <span v-if="me !== null" class="who">
        <span class="badge accent">{{ me.role }}</span>
        <span class="name">{{ me.username ?? me.tokenType }}</span>
      </span>
      <button class="ghost" type="button" :disabled="loggingOut" @click="logout">
        <span v-if="loggingOut" class="spin" /> 退出
      </button>
    </header>

    <div class="body">
      <aside class="sidebar" :class="{ open: drawerOpen }">
        <nav>
          <router-link v-for="item in BUILTIN_NAV" :key="item.to" :to="item.to" class="nav-item" active-class="active">
            <span class="icon">{{ item.icon }}</span>{{ item.label }}
          </router-link>
          <div v-if="extNav.length > 0" class="nav-section">扩展页面（{{ uiCount }} 项贡献）</div>
          <a v-for="item in extNav" :key="item.to" :href="item.to" class="nav-item" target="_self">
            <span class="icon">{{ item.icon }}</span>{{ item.label }}
          </a>
          <div v-if="extNav.length === 0" class="nav-hint">GET /api/v1/ui 暂无扩展菜单贡献</div>
        </nav>
      </aside>
      <div v-if="drawerOpen" class="scrim" @click="drawerOpen = false" />

      <main class="content">
        <router-view />
      </main>
    </div>

    <div class="toasts">
      <div v-for="t in toasts" :key="t.id" class="toast" :class="t.kind">{{ t.text }}</div>
    </div>
  </div>
</template>

<style scoped>
.shell { display: flex; flex-direction: column; min-height: 100vh; }
.topbar {
  display: flex; align-items: center; gap: 12px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-raised);
  position: sticky; top: 0; z-index: 20;
}
.brand { font-size: 15px; letter-spacing: 0.03em; }
.brand strong { color: var(--accent); }
.spacer { flex: 1; }
.who { display: flex; align-items: center; gap: 8px; }
.who .name { color: var(--text-dim); }
.burger { display: none; font-size: 16px; }

.body { display: flex; flex: 1; min-height: 0; }
.sidebar {
  width: 208px; flex-shrink: 0;
  border-right: 1px solid var(--border);
  padding: 12px 8px;
  background: var(--bg-raised);
}
.nav-item {
  display: flex; align-items: center; gap: 10px;
  padding: 8px 12px; margin: 2px 0;
  border-radius: var(--radius);
  color: var(--text-dim);
}
.nav-item:hover { background: var(--bg-hover); color: var(--text); }
.nav-item.active { background: var(--accent-soft); color: var(--accent); }
.nav-item .icon { width: 18px; text-align: center; }
.nav-section {
  margin: 14px 12px 4px; font-size: 12px; color: var(--text-faint);
  border-top: 1px solid var(--border); padding-top: 10px;
}
.nav-hint { margin: 14px 12px; font-size: 12px; color: var(--text-faint); }

.content { flex: 1; padding: 20px 24px; min-width: 0; }

.scrim { display: none; }
.toasts { position: fixed; right: 16px; bottom: 16px; display: flex; flex-direction: column; gap: 8px; z-index: 50; }
.toast {
  padding: 10px 14px; border-radius: var(--radius); max-width: 360px;
  background: var(--bg-raised); border: 1px solid var(--border);
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.4);
}
.toast.success { border-color: var(--ok); }
.toast.error { border-color: var(--err); color: var(--err); }

@media (max-width: 768px) {
  .burger { display: inline-block; }
  .sidebar {
    position: fixed; top: 53px; bottom: 0; left: 0; z-index: 30;
    transform: translateX(-100%); transition: transform 0.2s ease;
  }
  .sidebar.open { transform: translateX(0); }
  .scrim { display: block; position: fixed; inset: 53px 0 0 0; background: rgba(0, 0, 0, 0.5); z-index: 25; }
  .content { padding: 14px; }
}
</style>
