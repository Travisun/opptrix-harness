<script setup lang="ts">
/**
 * Notifications — 通知中心：列表（含未读过滤/级别筛选）、单条已读、全部已读、
 * 发送测试表单（POST /send，admin）。SSE topics=notifications 实时追加新通知。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue';

import { api, type NotificationItem, type NotificationList } from '../api';
import { connectSse, type SseHandle } from '../sse';

const loading = ref(true);
const error = ref('');
const items = ref<NotificationItem[]>([]);
const unread = ref(0);
const onlyUnread = ref(false);
const level = ref('');
const sseUp = ref(false);
let sse: SseHandle | null = null;

// 发送测试表单
const sending = ref(false);
const form = ref({ title: '', body: '', level: 'info' });

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const q = new URLSearchParams({ limit: '100' });
    if (onlyUnread.value) q.set('unread', '1');
    if (level.value !== '') q.set('level', level.value);
    const res = await api.get<NotificationList>(`/api/v1/notifications?${q.toString()}`);
    items.value = res.items;
    unread.value = res.unread;
  } catch (e) {
    error.value = (e as { message?: string }).message ?? '加载失败';
  } finally {
    loading.value = false;
  }
}

async function markRead(item: NotificationItem): Promise<void> {
  await api.post(`/api/v1/notifications/${encodeURIComponent(item.id)}/read`);
  await load();
}

async function markAll(): Promise<void> {
  await api.post('/api/v1/notifications/read-all');
  await load();
}

async function send(): Promise<void> {
  if (form.value.title === '') return;
  sending.value = true;
  try {
    await api.post('/api/v1/notifications/send', {
      title: form.value.title,
      ...(form.value.body !== '' ? { body: form.value.body } : {}),
      level: form.value.level,
    });
    form.value = { title: '', body: '', level: 'info' };
    await load();
  } finally {
    sending.value = false;
  }
}

function levelClass(l: string): string {
  if (l === 'error') return 'err';
  if (l === 'warn') return 'warn';
  if (l === 'success') return 'ok';
  return 'accent';
}

onMounted(() => {
  void load();
  sse = connectSse(['notifications'], ({ event, data }) => {
    if (event !== 'notification.created') return;
    const rec = data as { id?: string; title?: string; body?: string; level?: string; readAt?: number | null; createdAt?: number };
    if (typeof rec?.id !== 'string') return;
    items.value = [{
      id: rec.id,
      title: rec.title ?? '',
      body: rec.body ?? '',
      level: rec.level ?? 'info',
      data: null,
      readAt: rec.readAt ?? null,
      createdAt: rec.createdAt ?? Date.now(),
    }, ...items.value];
    unread.value += 1;
  }, (up) => (sseUp.value = up));
});
onBeforeUnmount(() => sse?.close());
</script>

<template>
  <section>
    <header class="page-head">
      <h2>通知</h2>
      <span class="badge" :class="unread > 0 ? 'warn' : ''">未读 {{ unread }}</span>
      <span class="badge" :class="sseUp ? 'ok' : ''">{{ sseUp ? '实时' : '离线' }}</span>
      <span class="spacer" />
      <label class="inline"><input v-model="onlyUnread" type="checkbox" @change="load" /> 仅未读</label>
      <select v-model="level" @change="load">
        <option value="">全部级别</option>
        <option value="info">info</option>
        <option value="success">success</option>
        <option value="warn">warn</option>
        <option value="error">error</option>
      </select>
      <button type="button" :disabled="unread === 0" @click="markAll">全部已读</button>
      <button class="ghost" type="button" @click="load">刷新</button>
    </header>

    <form class="panel form" @submit.prevent="send">
      <label><span>标题 *</span><input v-model="form.title" type="text" placeholder="测试通知" /></label>
      <label class="grow"><span>正文</span><input v-model="form.body" type="text" placeholder="来自控制台的手动测试" /></label>
      <label><span>级别</span>
        <select v-model="form.level">
          <option value="info">info</option><option value="success">success</option>
          <option value="warn">warn</option><option value="error">error</option>
        </select>
      </label>
      <button class="primary" type="submit" :disabled="sending"><span v-if="sending" class="spin" /> 发送测试</button>
    </form>

    <div v-if="loading" class="state"><span class="spin" /> 加载中…</div>
    <div v-else-if="error !== ''" class="state error">加载失败：{{ error }} <button type="button" @click="load">重试</button></div>
    <div v-else-if="items.length === 0" class="state">暂无通知</div>

    <ul v-else class="panel list">
      <li v-for="item in items" :key="item.id" :class="{ unread: item.readAt === null }">
        <div class="row">
          <span class="badge" :class="levelClass(item.level)">{{ item.level }}</span>
          <strong>{{ item.title }}</strong>
          <span class="time">{{ new Date(item.createdAt).toISOString().replace('T', ' ').slice(0, 19) }}</span>
          <span class="spacer" />
          <button v-if="item.readAt === null" type="button" @click="markRead(item)">已读</button>
          <span v-else class="dim">已读</span>
        </div>
        <p v-if="item.body !== ''">{{ item.body }}</p>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.page-head { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; flex-wrap: wrap; }
.page-head h2 { margin: 0; font-size: 17px; }
.spacer { flex: 1; }
.inline { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--text-dim); }
select, .page-head button { padding: 5px 10px; font-size: 13px; }
.panel { background: var(--bg-raised); border: 1px solid var(--border); border-radius: var(--radius); }
.form { display: flex; gap: 12px; align-items: flex-end; flex-wrap: wrap; padding: 14px; margin-bottom: 14px; }
.form label { display: flex; flex-direction: column; gap: 4px; }
.form label span { font-size: 12px; color: var(--text-dim); }
.form .grow { flex: 1; min-width: 200px; }
.list { list-style: none; margin: 0; padding: 0; }
.list li { padding: 12px 14px; border-bottom: 1px solid var(--border); }
.list li:last-child { border-bottom: none; }
.list li.unread { background: var(--accent-soft); }
.list .row { display: flex; align-items: center; gap: 10px; }
.list .time { color: var(--text-faint); font-size: 12px; }
.list p { margin: 6px 0 0; color: var(--text-dim); white-space: pre-wrap; word-break: break-word; }
.dim { color: var(--text-faint); font-size: 12px; }
</style>
