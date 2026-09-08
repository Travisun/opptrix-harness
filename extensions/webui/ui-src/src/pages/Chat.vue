<script setup lang="ts">
/**
 * Chat — 频道列表 / 创建频道（admin）、消息流（REST 首屏 + SSE topics=chat:{slug} 实时
 * 追加）、文本消息发送。
 */
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { api, pushToast, type Channel, type ChatMessage } from '../api';
import { connectSse, type SseHandle } from '../sse';

const loading = ref(true);
const error = ref('');
const channels = ref<Channel[]>([]);
const activeSlug = ref('');
const messages = ref<ChatMessage[]>([]);
const msgsLoading = ref(false);
const draft = ref('');
const sending = ref(false);
const sseUp = ref(false);

const showCreate = ref(false);
const createForm = ref({ name: '', slug: '' });
const creating = ref(false);

const msgBox = ref<HTMLElement | null>(null);
let sse: SseHandle | null = null;

async function loadChannels(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    channels.value = await api.get<Channel[]>('/api/v1/channels');
    if (activeSlug.value === '' && channels.value.length > 0) {
      await select(channels.value[0]?.slug ?? '');
    }
  } catch (e) {
    error.value = (e as { message?: string }).message ?? '加载失败';
  } finally {
    loading.value = false;
  }
}

async function select(slug: string): Promise<void> {
  activeSlug.value = slug;
  if (slug === '') return;
  sse?.close();
  messages.value = [];
  msgsLoading.value = true;
  try {
    messages.value = await api.get<ChatMessage[]>(`/api/v1/channels/${encodeURIComponent(slug)}/messages?limit=100`);
    await scrollBottom();
  } finally {
    msgsLoading.value = false;
  }
  sse = connectSse([`chat:${slug}`], ({ event, data }) => {
    if (event !== 'chat.message.created') return;
    const msg = data as ChatMessage;
    if (typeof msg?.id !== 'string') return;
    if (messages.value.some((m) => m.id === msg.id)) return;
    messages.value = [...messages.value, msg];
    void scrollBottom();
  }, (up) => (sseUp.value = up));
}

async function send(): Promise<void> {
  const text = draft.value.trim();
  if (text === '' || activeSlug.value === '') return;
  sending.value = true;
  try {
    await api.post(`/api/v1/channels/${encodeURIComponent(activeSlug.value)}/messages`, { type: 'text', text });
    draft.value = '';
    // 以 REST 回显为准（SSE 也会推本人消息，select 内按 id 去重）
    const fresh = await api.get<ChatMessage[]>(`/api/v1/channels/${encodeURIComponent(activeSlug.value)}/messages?limit=100`);
    messages.value = fresh;
    await scrollBottom();
  } finally {
    sending.value = false;
  }
}

async function createChannel(): Promise<void> {
  if (createForm.value.name === '') return;
  creating.value = true;
  try {
    const body: { name: string; slug?: string } = { name: createForm.value.name };
    if (createForm.value.slug !== '') body.slug = createForm.value.slug;
    const ch = await api.post<Channel>('/api/v1/channels', body);
    pushToast('success', `频道 #${ch.slug} 已创建`);
    showCreate.value = false;
    createForm.value = { name: '', slug: '' };
    await loadChannels();
    await select(ch.slug);
  } finally {
    creating.value = false;
  }
}

async function scrollBottom(): Promise<void> {
  await nextTick();
  msgBox.value?.scrollTo({ top: msgBox.value.scrollHeight });
}

function senderLabel(m: ChatMessage): string {
  const who = m.senderType === 'user' ? m.senderId : `${m.senderType}:${m.senderId}`;
  return who;
}

function textOf(m: ChatMessage): string {
  if (m.content?.type === 'text' && typeof m.content.text === 'string') return m.content.text;
  return JSON.stringify(m.content);
}

watch(activeSlug, () => void scrollBottom());
onMounted(() => void loadChannels());
onBeforeUnmount(() => sse?.close());
</script>

<template>
  <section class="chat">
    <header class="page-head">
      <h2>聊天</h2>
      <span class="badge" :class="sseUp ? 'ok' : ''">{{ sseUp ? 'SSE 实时' : 'SSE 未连接' }}</span>
      <span class="spacer" />
      <button type="button" @click="showCreate = !showCreate">新建频道</button>
      <button class="ghost" type="button" @click="loadChannels">刷新</button>
    </header>

    <form v-if="showCreate" class="panel form" @submit.prevent="createChannel">
      <label><span>频道名 *</span><input v-model="createForm.name" type="text" placeholder="发布通告" /></label>
      <label><span>slug（小写字母/数字/连字符，缺省自动生成）</span><input v-model="createForm.slug" type="text" placeholder="announce" /></label>
      <button class="primary" type="submit" :disabled="creating"><span v-if="creating" class="spin" /> 创建</button>
    </form>

    <div v-if="loading" class="state"><span class="spin" /> 加载中…</div>
    <div v-else-if="error !== ''" class="state error">加载失败：{{ error }} <button type="button" @click="loadChannels">重试</button></div>
    <div v-else-if="channels.length === 0" class="state">暂无频道——先新建一个</div>

    <div v-else class="layout">
      <aside class="channels">
        <button
          v-for="c in channels" :key="c.id" type="button"
          class="channel" :class="{ active: c.slug === activeSlug }"
          @click="select(c.slug)"
        >
          <strong>#{{ c.slug }}</strong>
          <span class="dim">{{ c.name }}</span>
        </button>
      </aside>

      <div class="thread panel">
        <div class="thread-head"><strong>#{{ activeSlug }}</strong><span class="dim">最新 100 条 · 实时追加</span></div>
        <div ref="msgBox" class="msgs">
          <div v-if="msgsLoading" class="state"><span class="spin" /> 加载中…</div>
          <div v-else-if="messages.length === 0" class="state">暂无消息，说点什么吧</div>
          <div v-for="m in messages" :key="m.id" class="msg">
            <span class="sender">{{ senderLabel(m) }}</span>
            <span class="text">{{ textOf(m) }}</span>
            <span class="time">{{ new Date(m.createdAt).toISOString().slice(11, 19) }}</span>
          </div>
        </div>
        <form class="composer" @submit.prevent="send">
          <input v-model="draft" type="text" :placeholder="`发送文本到 #${activeSlug}`" />
          <button class="primary" type="submit" :disabled="sending || draft.trim() === ''"><span v-if="sending" class="spin" /> 发送</button>
        </form>
      </div>
    </div>
  </section>
</template>

<style scoped>
.page-head { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; flex-wrap: wrap; }
.page-head h2 { margin: 0; font-size: 17px; }
.spacer { flex: 1; }
.panel { background: var(--bg-raised); border: 1px solid var(--border); border-radius: var(--radius); }
.form { display: flex; gap: 12px; align-items: flex-end; flex-wrap: wrap; padding: 14px; margin-bottom: 14px; }
.form label { display: flex; flex-direction: column; gap: 4px; }
.form label span { font-size: 12px; color: var(--text-dim); }

.layout { display: grid; grid-template-columns: 220px 1fr; gap: 14px; }
.channels { display: flex; flex-direction: column; gap: 4px; }
.channel {
  display: flex; flex-direction: column; align-items: flex-start; gap: 2px;
  text-align: left; padding: 8px 12px;
}
.channel.active { background: var(--accent-soft); border-color: var(--accent); }
.channel .dim { font-size: 12px; color: var(--text-dim); }

.thread { display: flex; flex-direction: column; height: calc(100vh - 240px); min-height: 320px; overflow: hidden; }
.thread-head { display: flex; gap: 12px; align-items: baseline; padding: 10px 14px; border-bottom: 1px solid var(--border); }
.thread-head .dim { font-size: 12px; color: var(--text-dim); }
.msgs { flex: 1; overflow: auto; padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; }
.msg { display: flex; gap: 10px; align-items: baseline; }
.msg .sender { color: var(--accent); font-size: 12.5px; flex-shrink: 0; }
.msg .text { word-break: break-word; white-space: pre-wrap; }
.msg .time { margin-left: auto; color: var(--text-faint); font-size: 11.5px; flex-shrink: 0; }
.composer { display: flex; gap: 8px; padding: 10px 14px; border-top: 1px solid var(--border); }
.composer input { flex: 1; }

@media (max-width: 768px) {
  .layout { grid-template-columns: 1fr; }
  .channels { flex-direction: row; overflow-x: auto; }
  .channel { flex-shrink: 0; }
  .thread { height: 60vh; }
}
</style>
