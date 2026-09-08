<script setup lang="ts">
/**
 * Dashboard — 系统信息（/system/info）+ 环境体检（/system/doctor）+ counters 展示；
 * SSE topics=notifications 实时未读计数（notification.created 事件驱动）。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

import { api, type DoctorResult, type SystemInfo } from '../api';
import { connectSse, type SseHandle } from '../sse';

const info = ref<SystemInfo | null>(null);
const doctor = ref<DoctorResult | null>(null);
const loading = ref(true);
const error = ref('');

// SSE 实时未读：首屏以 REST unread 为基线，notification.created 事件累加
const unread = ref<number | null>(null);
let sse: SseHandle | null = null;
const sseUp = ref(false);

const uptimeText = computed(() => {
  if (info.value === null) return '';
  const ms = info.value.uptimeMs;
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
});

const counterEntries = computed(() => Object.entries(info.value?.counters ?? {}).filter(([, v]) => typeof v === 'number'));

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const [infoRes, doctorRes, notifyRes] = await Promise.all([
      api.get<SystemInfo>('/api/v1/system/info'),
      api.get<DoctorResult>('/api/v1/system/doctor'),
      api.get<{ unread: number }>('/api/v1/notifications?limit=1'),
    ]);
    info.value = infoRes;
    doctor.value = doctorRes;
    unread.value = notifyRes.unread;
  } catch (e) {
    const err = e as { message?: string };
    error.value = err.message ?? '加载失败';
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  void load();
  sse = connectSse(['notifications'], ({ event, data }) => {
    if (event !== 'notification.created') return;
    if (typeof data === 'object' && data !== null && 'id' in data) {
      unread.value = (unread.value ?? 0) + 1;
    }
  }, (up) => (sseUp.value = up));
});

onBeforeUnmount(() => sse?.close());
</script>

<template>
  <section>
    <header class="page-head">
      <h2>仪表盘</h2>
      <span class="badge" :class="sseUp ? 'ok' : ''">{{ sseUp ? 'SSE 实时已连接' : 'SSE 未连接' }}</span>
      <button class="ghost" type="button" @click="load">刷新</button>
    </header>

    <div v-if="loading" class="state"><span class="spin" /> 加载中…</div>
    <div v-else-if="error !== ''" class="state error">加载失败：{{ error }} <button type="button" @click="load">重试</button></div>

    <template v-else-if="info !== null">
      <div class="cards">
        <div class="card">
          <div class="k">版本 / 环境</div>
          <div class="v">v{{ info.version }} · {{ info.env }}</div>
          <div class="sub">{{ info.name }} · Node {{ info.node }}</div>
        </div>
        <div class="card">
          <div class="k">运行状态</div>
          <div class="v"><span class="badge ok">{{ info.state }}</span></div>
          <div class="sub">已运行 {{ uptimeText }}</div>
        </div>
        <div class="card">
          <div class="k">未读通知</div>
          <div class="v big" :class="unread !== null && unread > 0 ? 'alert' : ''">{{ unread ?? '—' }}</div>
          <div class="sub">SSE topics=notifications 实时</div>
        </div>
        <div class="card">
          <div class="k">时区</div>
          <div class="v">{{ info.timezone }}</div>
          <div class="sub">时间一律 UTC 存储</div>
        </div>
      </div>

      <h3>环境体检（doctor）</h3>
      <div v-if="doctor !== null" class="panel">
        <div class="panel-head">
          <span class="badge" :class="doctor.ok ? 'ok' : 'err'">{{ doctor.ok ? '全部通过' : '存在异常' }}</span>
        </div>
        <table>
          <thead><tr><th>检查项</th><th>结果</th><th>说明</th></tr></thead>
          <tbody>
            <tr v-for="c in doctor.checks" :key="c.id">
              <td><code>{{ c.id }}</code></td>
              <td><span class="badge" :class="c.ok ? 'ok' : 'err'">{{ c.ok ? 'ok' : 'fail' }}</span></td>
              <td class="wrap-cell">{{ c.detail }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-else class="state">doctor 无数据</div>

      <h3>Counters</h3>
      <div v-if="counterEntries.length > 0" class="panel counters">
        <div v-for="[k, v] in counterEntries" :key="k" class="counter">
          <code>{{ k }}</code>
          <strong>{{ v }}</strong>
        </div>
      </div>
      <div v-else class="state">暂无计数</div>
    </template>
    <div v-else class="state">暂无数据</div>
  </section>
</template>

<style scoped>
.page-head { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
.page-head h2 { margin: 0; font-size: 17px; }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; margin-bottom: 20px; }
.card { background: var(--bg-raised); border: 1px solid var(--border); border-radius: var(--radius); padding: 14px 16px; }
.card .k { color: var(--text-dim); font-size: 12.5px; }
.card .v { margin-top: 6px; font-size: 16px; font-weight: 600; }
.card .v.big { font-size: 26px; }
.card .v.alert { color: var(--warn); }
.card .sub { margin-top: 4px; color: var(--text-faint); font-size: 12px; }
.panel { background: var(--bg-raised); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
.panel-head { padding: 10px 12px; border-bottom: 1px solid var(--border); }
.wrap-cell { white-space: normal; word-break: break-all; }
.counters { display: flex; flex-wrap: wrap; gap: 10px; padding: 12px; }
.counter {
  display: flex; align-items: center; gap: 10px;
  background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius);
  padding: 6px 12px;
}
.counter strong { color: var(--accent); }
h3 { font-size: 14.5px; margin: 18px 0 8px; }
</style>
