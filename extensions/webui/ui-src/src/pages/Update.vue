<script setup lang="ts">
/**
 * Update — 升级面：check（GET /api/v1/system/update，网络失败也 200 由 feedOk 表达）、
 * apply（POST /apply，confirm 后提交；202 即返回，重启异步发生）、history 表。
 */
import { onMounted, ref } from 'vue';

import { api, pushToast, type UpdateCheckResult, type UpdateHistoryEntry } from '../api';

const loading = ref(true);
const error = ref('');
const check = ref<UpdateCheckResult | null>(null);
const history = ref<UpdateHistoryEntry[]>([]);
const applying = ref(false);

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const [c, h] = await Promise.all([
      api.get<UpdateCheckResult>('/api/v1/system/update'),
      api.get<UpdateHistoryEntry[]>('/api/v1/system/update/history'),
    ]);
    check.value = c;
    history.value = h;
  } catch (e) {
    error.value = (e as { message?: string }).message ?? '加载失败';
  } finally {
    loading.value = false;
  }
}

async function apply(): Promise<void> {
  if (check.value === null) return;
  const target = check.value.available?.version ?? 'latest';
  if (!window.confirm(`应用升级到 ${target}？提交后内核会异步重启（A/B slot 切换），期间服务短暂不可用。`)) return;
  applying.value = true;
  try {
    const res = await api.post<{ accepted: boolean; slot?: string; version?: string }>('/api/v1/system/update/apply', {});
    pushToast('success', `已受理：slot=${res.slot ?? '?'} version=${res.version ?? '?'}；内核即将重启`);
  } finally {
    applying.value = false;
  }
}

onMounted(() => void load());
</script>

<template>
  <section>
    <header class="page-head">
      <h2>升级</h2>
      <span class="spacer" />
      <button class="ghost" type="button" @click="load">刷新</button>
    </header>

    <div v-if="loading" class="state"><span class="spin" /> 加载中…</div>
    <div v-else-if="error !== ''" class="state error">加载失败：{{ error }} <button type="button" @click="load">重试</button></div>

    <template v-else>
      <div class="panel pad">
        <template v-if="check !== null">
          <div class="row">
            <span class="dim">当前版本：</span>
            <strong>{{ check.currentVersion ?? '未知（首装无记录）' }}</strong>
          </div>
          <div class="row">
            <span class="dim">Feed：</span>
            <span class="badge" :class="check.feedOk ? 'ok' : 'err'">{{ check.feedOk ? '拉取成功' : '拉取失败' }}</span>
            <span v-if="!check.feedOk && check.error !== undefined" class="err-text">{{ check.error }}</span>
          </div>
          <div class="row">
            <span class="dim">可用更新：</span>
            <template v-if="check.available !== null">
              <span class="badge accent">{{ check.available.version }}</span>
              <button type="button" class="primary" :disabled="applying" @click="apply">
                <span v-if="applying" class="spin" /> 应用升级
              </button>
            </template>
            <template v-else>
              <span class="badge ok">已是最新</span>
              <button type="button" :disabled="applying" @click="apply">强制 apply（latest）</button>
            </template>
          </div>
        </template>
        <div v-else class="state">暂无 check 数据</div>
      </div>

      <h3>发布历史</h3>
      <div v-if="history.length === 0" class="state">暂无升级记录</div>
      <div v-else class="panel">
        <table>
          <thead><tr><th>版本</th><th>应用时间 (UTC)</th><th>结果</th></tr></thead>
          <tbody>
            <tr v-for="(h, i) in history" :key="i">
              <td><strong>{{ h.version }}</strong></td>
              <td class="dim">{{ new Date(h.appliedAt).toISOString().replace('T', ' ').slice(0, 19) }}</td>
              <td><span class="badge" :class="h.ok ? 'ok' : 'err'">{{ h.ok ? 'ok' : 'fail' }}</span></td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </section>
</template>

<style scoped>
.page-head { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
.page-head h2 { margin: 0; font-size: 17px; }
.spacer { flex: 1; }
h3 { font-size: 14.5px; margin: 18px 0 8px; }
.panel { background: var(--bg-raised); border: 1px solid var(--border); border-radius: var(--radius); overflow: auto; }
.pad { padding: 14px; display: flex; flex-direction: column; gap: 10px; align-items: flex-start; }
.row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.dim { color: var(--text-dim); }
.err-text { color: var(--err); font-size: 12.5px; }
</style>
