<script setup lang="ts">
/**
 * Settings — 设置面：settings 键值视图（当前经 REST 可达的 settings 持久化面：
 * 通知路由规则 / 可用驱动 / LLM providers；通用 /api/v1/settings 键值端点内核尚未提供）+
 * LLM providers 管理（GET/PUT /api/v1/llm/providers；apiKey 输入框标注"仅写入不下发"）。
 */
import { onMounted, ref } from 'vue';

import { api, pushToast, type LlmProvider } from '../api';

const loading = ref(true);
const error = ref('');

// 通知路由规则 + 驱动（settings 持久化：NOTIFY_ROUTES_KEY / 驱动注册表）
const notifyRoutes = ref<unknown>([]);
const drivers = ref<{ notification: string[]; chat: string[] }>({ notification: [], chat: [] });

// LLM providers
const providers = ref<LlmProvider[]>([]);
const providersLoading = ref(false);
const saving = ref(false);
/** 新增/编辑中的 provider 行内表单（name 非空即视为新增一行） */
const draft = ref<LlmProvider>({ name: '', protocol: 'openai-chat', baseUrl: '', apiKey: '', models: [] });

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const [routes, drv, provs] = await Promise.all([
      api.get<unknown>('/api/v1/notifications/routes'),
      api.get<{ notification: string[]; chat: string[] }>('/api/v1/notifications/drivers'),
      api.get<LlmProvider[]>('/api/v1/llm/providers'),
    ]);
    notifyRoutes.value = routes;
    drivers.value = drv;
    providers.value = provs;
  } catch (e) {
    error.value = (e as { message?: string }).message ?? '加载失败';
  } finally {
    loading.value = false;
  }
}

function draftModelsText(p: LlmProvider): string {
  return p.models.join(', ');
}

function onDraftModelsInput(ev: Event): void {
  const target = ev.target as HTMLInputElement;
  draft.value = {
    ...draft.value,
    models: target.value.split(',').map((s) => s.trim()).filter((s) => s !== ''),
  };
}

async function saveProvider(p: LlmProvider): Promise<void> {
  if (p.name === '' || p.baseUrl === '' || p.models.length === 0) {
    pushToast('error', 'provider 需要 name / baseUrl / models（逗号分隔）');
    return;
  }
  saving.value = true;
  try {
    // PUT 为整表覆写：追加/更新后整体提交；明文 apiKey 由内核自动转存 secrets（llm.<name>），
    // GET 返回的行只有 apiKeySecretRef——明文仅写入不下发。
    const merged = [...providers.value.filter((x) => x.name !== p.name), p];
    await api.put('/api/v1/llm/providers', merged);
    pushToast('success', `provider ${p.name} 已保存（apiKey 仅写入，永不下发）`);
    draft.value = { name: '', protocol: 'openai-chat', baseUrl: '', apiKey: '', models: [] };
    await load();
  } finally {
    saving.value = false;
  }
}

async function removeProvider(p: LlmProvider): Promise<void> {
  if (!window.confirm(`移除 provider "${p.name}"？（整表覆写保存）`)) return;
  saving.value = true;
  try {
    await api.put('/api/v1/llm/providers', providers.value.filter((x) => x.name !== p.name));
    await load();
  } finally {
    saving.value = false;
  }
}

onMounted(() => void load());
</script>

<template>
  <section>
    <header class="page-head">
      <h2>设置</h2>
      <span class="spacer" />
      <button class="ghost" type="button" @click="load">刷新</button>
    </header>

    <div v-if="loading" class="state"><span class="spin" /> 加载中…</div>
    <div v-else-if="error !== ''" class="state error">加载失败：{{ error }} <button type="button" @click="load">重试</button></div>

    <template v-else>
      <h3>settings 键值视图（经 REST 可达的 settings 持久化面）</h3>
      <div class="grid">
        <div class="panel pad">
          <div class="k">notify.routes（默认渠道路由规则）</div>
          <pre>{{ JSON.stringify(notifyRoutes, null, 2) }}</pre>
        </div>
        <div class="panel pad">
          <div class="k">可用驱动（drivers）</div>
          <p class="dim">notification: <code>{{ drivers.notification.join(', ') }}</code></p>
          <p class="dim">chat: <code>{{ drivers.chat.join(', ') }}</code></p>
        </div>
      </div>
      <p class="note">通用 settings 键值端点（/api/v1/settings）内核尚未提供；此处展示 settings 层已暴露的配置面。</p>

      <h3>LLM Providers（GET/PUT /api/v1/llm/providers，admin）</h3>
      <div class="panel">
        <table>
          <thead><tr><th>名称</th><th>协议</th><th>baseUrl</th><th>模型</th><th>密钥</th><th>操作</th></tr></thead>
          <tbody>
            <tr v-for="p in providers" :key="p.name">
              <td><strong>{{ p.name }}</strong></td>
              <td><code>{{ p.protocol }}</code></td>
              <td class="wrap">{{ p.baseUrl }}</td>
              <td class="wrap dim">{{ p.models.join(', ') }}</td>
              <td>
                <span v-if="p.apiKeySecretRef !== undefined" class="badge ok">secretRef: {{ p.apiKeySecretRef }}</span>
                <span v-else class="badge warn">未配置</span>
              </td>
              <td><button type="button" class="danger" :disabled="saving" @click="removeProvider(p)">移除</button></td>
            </tr>
            <tr v-if="providers.length === 0">
              <td colspan="6" class="state" style="padding:16px">暂无 provider</td>
            </tr>
          </tbody>
        </table>
      </div>

      <form class="panel pad newp" @submit.prevent="saveProvider(draft)">
        <div class="k">新增 / 更新 provider</div>
        <div class="fields">
          <label><span>名称 *</span><input v-model="draft.name" type="text" placeholder="openai-main" /></label>
          <label><span>协议 *</span>
            <select v-model="draft.protocol">
              <option value="openai-chat">openai-chat</option>
              <option value="openai-responses">openai-responses</option>
              <option value="anthropic-messages">anthropic-messages</option>
            </select>
          </label>
          <label class="grow"><span>baseUrl *</span><input v-model="draft.baseUrl" type="text" placeholder="https://api.openai.com/v1" /></label>
          <label class="grow"><span>模型 *（逗号分隔）</span>
            <input :value="draftModelsText(draft)" type="text" placeholder="gpt-4o, gpt-4o-mini" @input="onDraftModelsInput" />
          </label>
          <label class="grow"><span>apiKey（仅写入不下发；明文自动转存 secrets）</span>
            <input v-model="draft.apiKey" type="password" autocomplete="off" placeholder="sk-…" />
          </label>
        </div>
        <button class="primary" type="submit" :disabled="saving"><span v-if="saving" class="spin" /> 保存（整表覆写）</button>
      </form>
    </template>
  </section>
</template>

<style scoped>
.page-head { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
.page-head h2 { margin: 0; font-size: 17px; }
.spacer { flex: 1; }
h3 { font-size: 14.5px; margin: 18px 0 8px; }
.panel { background: var(--bg-raised); border: 1px solid var(--border); border-radius: var(--radius); }
.pad { padding: 14px; }
.pad .k { color: var(--text-dim); font-size: 12.5px; margin-bottom: 8px; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px; }
.dim { color: var(--text-dim); }
.wrap { max-width: 260px; white-space: normal; word-break: break-all; }
.note { color: var(--text-faint); font-size: 12.5px; }
.newp { margin-top: 10px; display: flex; flex-direction: column; gap: 10px; align-items: flex-start; }
.fields { display: flex; gap: 12px; flex-wrap: wrap; width: 100%; }
.fields label { display: flex; flex-direction: column; gap: 4px; min-width: 160px; }
.fields label span { font-size: 12px; color: var(--text-dim); }
.fields .grow { flex: 1; }
</style>
