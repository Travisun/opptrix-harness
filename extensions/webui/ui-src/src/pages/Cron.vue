<script setup lang="ts">
/**
 * Cron — 定时任务：列表、新建（name/expr/tz）、启停（PATCH enabled）、runNow、
 * 历史抽屉（GET :id/history）、删除（confirm）。
 */
import { onMounted, ref } from 'vue';

import { api, pushToast, type CronJob, type CronRunEntry } from '../api';

const loading = ref(true);
const error = ref('');
const jobs = ref<CronJob[]>([]);

// 新建表单
const form = ref({ name: '', expr: '*/5 * * * *', tz: '' });
const creating = ref(false);
const showForm = ref(false);

// 历史抽屉
const historyFor = ref<CronJob | null>(null);
const history = ref<CronRunEntry[]>([]);
const historyLoading = ref(false);

const busyKey = ref('');

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    jobs.value = await api.get<CronJob[]>('/api/v1/cron');
  } catch (e) {
    error.value = (e as { message?: string }).message ?? '加载失败';
  } finally {
    loading.value = false;
  }
}

async function create(): Promise<void> {
  if (form.value.name === '' || form.value.expr === '') {
    pushToast('error', 'name 与 expr 必填');
    return;
  }
  creating.value = true;
  try {
    await api.post('/api/v1/cron', {
      name: form.value.name,
      expr: form.value.expr,
      ...(form.value.tz !== '' ? { tz: form.value.tz } : {}),
    });
    pushToast('success', '任务已创建');
    showForm.value = false;
    form.value = { name: '', expr: '*/5 * * * *', tz: '' };
    await load();
  } finally {
    creating.value = false;
  }
}

async function toggle(job: CronJob): Promise<void> {
  busyKey.value = `${job.id}:toggle`;
  try {
    await api.patch(`/api/v1/cron/${encodeURIComponent(job.id)}`, { enabled: !job.enabled });
    await load();
  } finally {
    busyKey.value = '';
  }
}

async function runNow(job: CronJob): Promise<void> {
  busyKey.value = `${job.id}:run`;
  try {
    await api.post(`/api/v1/cron/${encodeURIComponent(job.id)}/run`);
    pushToast('success', `已触发 ${job.name}（202，异步执行）`);
  } finally {
    busyKey.value = '';
  }
}

async function remove(job: CronJob): Promise<void> {
  if (!window.confirm(`删除任务 "${job.name}"？执行历史将一并清除。`)) return;
  busyKey.value = `${job.id}:del`;
  try {
    await api.delete(`/api/v1/cron/${encodeURIComponent(job.id)}`);
    pushToast('success', '任务已删除');
    await load();
  } finally {
    busyKey.value = '';
  }
}

async function openHistory(job: CronJob): Promise<void> {
  historyFor.value = job;
  history.value = [];
  historyLoading.value = true;
  try {
    history.value = await api.get<CronRunEntry[]>(`/api/v1/cron/${encodeURIComponent(job.id)}/history?limit=50`);
  } finally {
    historyLoading.value = false;
  }
}

function isBusy(id: string, action: string): boolean {
  return busyKey.value === `${id}:${action}`;
}

function fmt(ms: number | null | undefined): string {
  return typeof ms === 'number' && ms > 0 ? new Date(ms).toISOString().replace('T', ' ').slice(0, 19) : '—';
}

onMounted(() => void load());
</script>

<template>
  <section>
    <header class="page-head">
      <h2>定时任务</h2>
      <span class="spacer" />
      <button type="button" class="primary" @click="showForm = !showForm">{{ showForm ? '收起表单' : '新建任务' }}</button>
      <button class="ghost" type="button" @click="load">刷新</button>
    </header>

    <form v-if="showForm" class="panel form" @submit.prevent="create">
      <label><span>名称 *</span><input v-model="form.name" type="text" placeholder="daily-report" /></label>
      <label><span>cron 表达式 *（5 段）</span><input v-model="form.expr" type="text" placeholder="*/5 * * * *" /></label>
      <label><span>IANA 时区（缺省内核默认）</span><input v-model="form.tz" type="text" placeholder="Asia/Shanghai" /></label>
      <button class="primary" type="submit" :disabled="creating"><span v-if="creating" class="spin" /> 创建</button>
    </form>

    <div v-if="loading" class="state"><span class="spin" /> 加载中…</div>
    <div v-else-if="error !== ''" class="state error">加载失败：{{ error }} <button type="button" @click="load">重试</button></div>
    <div v-else-if="jobs.length === 0" class="state">暂无定时任务</div>

    <div v-else class="panel">
      <table>
        <thead><tr><th>名称</th><th>表达式</th><th>时区</th><th>归属</th><th>状态</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="job in jobs" :key="job.id">
            <td><strong>{{ job.name }}</strong><div class="dim">id {{ job.id }}</div></td>
            <td><code>{{ job.expr }}</code></td>
            <td>{{ job.tz }}</td>
            <td class="dim">{{ job.extId ?? '内核' }}</td>
            <td><span class="badge" :class="job.enabled ? 'ok' : ''">{{ job.enabled ? '启用' : '停用' }}</span></td>
            <td class="actions">
              <button type="button" :disabled="isBusy(job.id, 'toggle')" @click="toggle(job)">{{ job.enabled ? '停用' : '启用' }}</button>
              <button type="button" :disabled="isBusy(job.id, 'run')" @click="runNow(job)">立即执行</button>
              <button type="button" @click="openHistory(job)">历史</button>
              <button type="button" class="danger" :disabled="isBusy(job.id, 'del')" @click="remove(job)">删除</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 历史抽屉 -->
    <teleport to="body">
      <div v-if="historyFor !== null" class="drawer-scrim" @click.self="historyFor = null">
        <aside class="drawer">
          <header>
            <strong>{{ historyFor.name }} 的执行历史</strong>
            <button class="ghost" type="button" @click="historyFor = null">✕</button>
          </header>
          <div v-if="historyLoading" class="state"><span class="spin" /> 加载中…</div>
          <div v-else-if="history.length === 0" class="state">暂无执行记录</div>
          <table v-else>
            <thead><tr><th>开始（UTC）</th><th>耗时</th><th>结果</th><th>错误</th></tr></thead>
            <tbody>
              <tr v-for="(h, i) in history" :key="i">
                <td>{{ fmt(h.startedAt) }}</td>
                <td>{{ h.durationMs }}ms</td>
                <td><span class="badge" :class="h.ok ? 'ok' : 'err'">{{ h.ok ? 'ok' : 'fail' }}</span></td>
                <td class="err-text">{{ h.error ?? '' }}</td>
              </tr>
            </tbody>
          </table>
        </aside>
      </div>
    </teleport>
  </section>
</template>

<style scoped>
.page-head { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
.page-head h2 { margin: 0; font-size: 17px; }
.spacer { flex: 1; }
.panel { background: var(--bg-raised); border: 1px solid var(--border); border-radius: var(--radius); overflow: auto; }
.form { display: flex; gap: 12px; align-items: flex-end; flex-wrap: wrap; padding: 14px; margin-bottom: 14px; }
.form label { display: flex; flex-direction: column; gap: 4px; }
.form label span { font-size: 12px; color: var(--text-dim); }
.dim { color: var(--text-dim); font-size: 12px; }
.actions { display: flex; gap: 6px; flex-wrap: wrap; }
.actions button { padding: 3px 10px; font-size: 12.5px; }
.err-text { color: var(--err); font-size: 12px; max-width: 220px; white-space: normal; word-break: break-all; }

.drawer-scrim { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.5); z-index: 40; display: flex; justify-content: flex-end; }
.drawer {
  width: min(640px, 92vw); background: var(--bg-raised); border-left: 1px solid var(--border);
  height: 100%; overflow: auto; padding: 16px;
}
.drawer header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
</style>
