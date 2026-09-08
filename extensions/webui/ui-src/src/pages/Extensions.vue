<script setup lang="ts">
/**
 * Extensions — 扩展生命周期管理。三标签：扩展列表（enable/disable/reload/uninstall）、
 * 路由表（/extensions/routes）、服务注册目录（/extensions/registry）。
 * 危险操作（disable/uninstall）先 confirm；第三方扩展首启收到 HARNESS-3012 时
 * 弹信任确认框（展示 detail.permissions 声明能力 + 警示文案），确认后带
 * confirmTrust:true 重试完成人工授信。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue';

import { api, pushToast, type ApiError, type ExtRouteEntry, type ExtSummary } from '../api';
import { connectSse, type SseHandle } from '../sse';

type Tab = 'list' | 'routes' | 'registry';

/** 内核第三方扩展信任闸错误码（EXT_TRUST_REQUIRED → 403） */
const TRUST_REQUIRED_CODE = 'HARNESS-3012';

const tab = ref<Tab>('list');
const loading = ref(true);
const error = ref('');
const list = ref<ExtSummary[]>([]);
const routes = ref<ExtRouteEntry[]>([]);
const registry = ref<Array<Record<string, unknown>>>([]);
/** 进行中的按钮（extId:action），驱动 loading 态 */
const busyKey = ref('');

let sse: SseHandle | null = null;

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const [l, r, g] = await Promise.all([
      api.get<ExtSummary[]>('/api/v1/extensions'),
      api.get<ExtRouteEntry[]>('/api/v1/extensions/routes'),
      api.get<Array<Record<string, unknown>>>('/api/v1/extensions/registry'),
    ]);
    list.value = l;
    routes.value = r;
    registry.value = g;
  } catch (e) {
    error.value = (e as { message?: string }).message ?? '加载失败';
  } finally {
    loading.value = false;
  }
}

/** 从 EXT_TRUST_REQUIRED 错误体 detail 中安全提取声明权限列表 */
function permissionsOf(detail: unknown): string[] {
  if (detail !== null && typeof detail === 'object' && Array.isArray((detail as { permissions?: unknown }).permissions)) {
    return ((detail as { permissions: unknown[] }).permissions).filter((p): p is string => typeof p === 'string');
  }
  return [];
}

/**
 * enable：先普通启用；第三方扩展首启被信任闸拒绝（HARNESS-3012）时弹确认框，
 * 用户确认后带 confirmTrust:true 重试（授信持久化，后续 enable 不再询问）。
 */
async function enableExt(id: string): Promise<void> {
  const path = `/api/v1/extensions/${encodeURIComponent(id)}/enable`;
  try {
    await api.post(path, undefined, { silent: true });
  } catch (e) {
    const apiErr = e as ApiError;
    if (apiErr.code !== TRUST_REQUIRED_CODE) {
      pushToast('error', `[${apiErr.code}] ${apiErr.message}`);
      return;
    }
    const perms = permissionsOf(apiErr.detail);
    const confirmed = window.confirm(
      `启用第三方扩展 "${id}" 需要人工确认信任。\n\n` +
        '该第三方扩展将获得所声明的全部能力，请确认信任来源。\n\n' +
        `声明权限（${perms.length} 项）：${perms.length > 0 ? perms.join('、') : '（未声明）'}`,
    );
    if (!confirmed) return;
    await api.post(path, { confirmTrust: true });
  }
}

async function act(id: string, action: 'enable' | 'disable' | 'reload' | 'uninstall'): Promise<void> {
  if (action === 'disable') {
    if (!window.confirm(`停用扩展 "${id}"？其路由/定时/事件订阅将立即摘除。`)) return;
  }
  if (action === 'uninstall') {
    if (!window.confirm(`卸载扩展 "${id}"？（保留数据文件；purge 需走 CLI）`)) return;
  }
  busyKey.value = `${id}:${action}`;
  try {
    if (action === 'enable') await enableExt(id);
    else await api.post(`/api/v1/extensions/${encodeURIComponent(id)}/${action}`);
    pushToast('success', `扩展 ${id} ${action} 成功`);
    await load();
  } finally {
    busyKey.value = '';
  }
}

function isBusy(id: string, action: string): boolean {
  return busyKey.value === `${id}:${action}`;
}

onMounted(() => {
  void load();
  // notifications 事件可附带扩展生命周期通知；这里仅用于提示有变更，列表手动刷新
  sse = connectSse(['notifications'], () => {});
});
onBeforeUnmount(() => sse?.close());
</script>

<template>
  <section>
    <header class="page-head">
      <h2>扩展</h2>
      <nav class="tabs">
        <button type="button" :class="{ on: tab === 'list' }" @click="tab = 'list'">列表（{{ list.length }}）</button>
        <button type="button" :class="{ on: tab === 'routes' }" @click="tab = 'routes'">路由表（{{ routes.length }}）</button>
        <button type="button" :class="{ on: tab === 'registry' }" @click="tab = 'registry'">服务注册（{{ registry.length }}）</button>
      </nav>
      <span class="spacer" />
      <button class="ghost" type="button" @click="load">刷新</button>
    </header>

    <div v-if="loading" class="state"><span class="spin" /> 加载中…</div>
    <div v-else-if="error !== ''" class="state error">加载失败：{{ error }} <button type="button" @click="load">重试</button></div>

    <!-- 列表 -->
    <div v-else-if="tab === 'list'" class="panel">
      <div v-if="list.length === 0" class="state">暂无扩展</div>
      <table v-else>
        <thead>
          <tr><th>扩展</th><th>版本</th><th>状态</th><th>builtin</th><th>mount</th><th>贡献点</th><th>操作</th></tr>
        </thead>
        <tbody>
          <template v-for="s in list" :key="s.id">
            <tr>
              <td>
                <strong>{{ s.id }}</strong>
                <div v-if="s.lastError !== null" class="err-text">{{ s.lastError }}</div>
              </td>
              <td>{{ s.version }}</td>
              <td><span class="badge" :class="s.enabled ? 'ok' : ''">{{ s.enabled ? 'enabled' : 'disabled' }}</span></td>
              <td><span v-if="s.builtin" class="badge accent">builtin</span></td>
              <td><code>{{ s.mount ?? '—' }}</code></td>
              <td class="dim">
                <template v-if="s.contributions !== undefined">
                  routes {{ s.contributions.routes }} · cron {{ s.contributions.crons }} · events {{ s.contributions.events }} · svc {{ s.contributions.services }}
                </template>
                <template v-else>—</template>
              </td>
              <td class="actions">
                <button v-if="!s.enabled" type="button" :disabled="isBusy(s.id, 'enable')" @click="act(s.id, 'enable')">启用</button>
                <button v-else type="button" class="danger" :disabled="isBusy(s.id, 'disable')" @click="act(s.id, 'disable')">停用</button>
                <button type="button" :disabled="isBusy(s.id, 'reload')" @click="act(s.id, 'reload')">重载</button>
                <button v-if="!s.builtin" type="button" class="danger" :disabled="isBusy(s.id, 'uninstall')" @click="act(s.id, 'uninstall')">卸载</button>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>

    <!-- 路由表 -->
    <div v-else-if="tab === 'routes'" class="panel">
      <div v-if="routes.length === 0" class="state">路由表为空（无已启用扩展声明路由）</div>
      <table v-else>
        <thead><tr><th>扩展</th><th>方法</th><th>声明路径</th><th>auth</th><th>scope</th></tr></thead>
        <tbody>
          <tr v-for="(r, i) in routes" :key="`${r.extId}-${r.method}-${r.path}-${i}`">
            <td>{{ r.extId }}</td>
            <td><span class="badge accent">{{ r.method }}</span></td>
            <td><code>{{ r.path }}</code></td>
            <td>{{ r.auth }}</td>
            <td>{{ r.scope ?? '—' }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- registry -->
    <div v-else class="panel">
      <div v-if="registry.length === 0" class="state">无已注册服务（扩展可经 h.expose 贡献）</div>
      <pre v-else>{{ JSON.stringify(registry, null, 2) }}</pre>
    </div>
  </section>
</template>

<style scoped>
.page-head { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
.page-head h2 { margin: 0; font-size: 17px; }
.spacer { flex: 1; }
.tabs { display: flex; gap: 6px; }
.tabs button { padding: 4px 10px; font-size: 13px; }
.tabs button.on { background: var(--accent-soft); border-color: var(--accent); color: var(--accent); }
.panel { background: var(--bg-raised); border: 1px solid var(--border); border-radius: var(--radius); overflow: auto; }
.dim { color: var(--text-dim); }
.err-text { color: var(--err); font-size: 12px; max-width: 320px; white-space: normal; word-break: break-all; }
.actions { display: flex; gap: 6px; }
.actions button { padding: 3px 10px; font-size: 12.5px; }
</style>
