<script setup lang="ts">
/**
 * FilesTasks — 文件列表 + multipart 上传 + 下载/删除（confirm）；任务列表 + echo 派发
 * + 进度轮询（queued/running 时每秒 GET :id）+ 取消。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue';

import { api, pushToast, type FileRecord, type TaskRecord } from '../api';

// ---- 文件 ----
const files = ref<FileRecord[]>([]);
const filesLoading = ref(true);
const filesError = ref('');
const fileInput = ref<HTMLInputElement | null>(null);
const uploading = ref(false);

async function loadFiles(): Promise<void> {
  filesLoading.value = true;
  filesError.value = '';
  try {
    files.value = await api.get<FileRecord[]>('/api/v1/files?limit=200');
  } catch (e) {
    filesError.value = (e as { message?: string }).message ?? '加载失败';
  } finally {
    filesLoading.value = false;
  }
}

async function upload(): Promise<void> {
  const input = fileInput.value;
  const file = input?.files?.[0];
  if (file === undefined) {
    pushToast('error', '请选择文件');
    return;
  }
  uploading.value = true;
  try {
    const fd = new FormData();
    fd.append('file', file);
    await api.post('/api/v1/files', fd);
    pushToast('success', `已上传 ${file.name}`);
    if (input !== null) input.value = '';
    await loadFiles();
  } finally {
    uploading.value = false;
  }
}

function downloadUrl(f: FileRecord): string {
  return `/api/v1/files/${encodeURIComponent(f.id)}?token=${encodeURIComponent(localStorage.getItem('opptrix.token') ?? '')}`;
}

async function removeFile(f: FileRecord): Promise<void> {
  if (!window.confirm(`删除文件 "${f.origName}"？`)) return;
  await api.delete(`/api/v1/files/${encodeURIComponent(f.id)}`);
  await loadFiles();
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

// ---- 任务 ----
const tasks = ref<TaskRecord[]>([]);
const tasksLoading = ref(true);
const tasksError = ref('');
const dispatching = ref(false);
const dispatchArgs = ref('{"text":"hello from console"}');
const pollTimers = new Map<string, ReturnType<typeof setInterval>>();

async function loadTasks(): Promise<void> {
  tasksLoading.value = true;
  tasksError.value = '';
  try {
    tasks.value = await api.get<TaskRecord[]>('/api/v1/tasks?limit=100');
    syncPolling();
  } catch (e) {
    tasksError.value = (e as { message?: string }).message ?? '加载失败';
  } finally {
    tasksLoading.value = false;
  }
}

/** 对 queued/running 任务逐个秒级轮询进度，终态自动停止 */
function syncPolling(): void {
  const active = new Set(tasks.value.filter((t) => t.status === 'queued' || t.status === 'running').map((t) => t.id));
  for (const [id, timer] of pollTimers) {
    if (!active.has(id)) {
      clearInterval(timer);
      pollTimers.delete(id);
    }
  }
  for (const id of active) {
    if (pollTimers.has(id)) continue;
    const timer = setInterval(async () => {
      try {
        const fresh = await api.get<TaskRecord>(`/api/v1/tasks/${encodeURIComponent(id)}`, { silent: true });
        const idx = tasks.value.findIndex((t) => t.id === id);
        if (fresh !== undefined && idx >= 0) {
          tasks.value[idx] = fresh;
          if (fresh.status !== 'queued' && fresh.status !== 'running') {
            const timer2 = pollTimers.get(id);
            if (timer2 !== undefined) {
              clearInterval(timer2);
              pollTimers.delete(id);
            }
          }
        }
      } catch {
        /* 单次轮询失败静默，下一轮重试 */
      }
    }, 1000);
    pollTimers.set(id, timer);
  }
}

async function dispatch(): Promise<void> {
  let args: unknown;
  try {
    args = dispatchArgs.value.trim() === '' ? undefined : JSON.parse(dispatchArgs.value);
  } catch {
    pushToast('error', 'args 不是合法 JSON');
    return;
  }
  dispatching.value = true;
  try {
    await api.post('/api/v1/tasks/dispatch', { name: 'echo', ...(args !== undefined ? { args } : {}) });
    pushToast('success', '任务已派发（echo）');
    await loadTasks();
  } finally {
    dispatching.value = false;
  }
}

async function cancelTask(t: TaskRecord): Promise<void> {
  if (!window.confirm(`取消任务 ${t.id}？`)) return;
  await api.post(`/api/v1/tasks/${encodeURIComponent(t.id)}/cancel`);
  await loadTasks();
}

const STATUS_CLASS: Record<string, string> = { queued: 'warn', running: 'accent', done: 'ok', failed: 'err', cancelled: '' };

onMounted(() => {
  void loadFiles();
  void loadTasks();
});
onBeforeUnmount(() => {
  for (const timer of pollTimers.values()) clearInterval(timer);
  pollTimers.clear();
});
</script>

<template>
  <section>
    <header class="page-head">
      <h2>文件与任务</h2>
      <span class="spacer" />
      <button class="ghost" type="button" @click="loadFiles(); loadTasks()">刷新</button>
    </header>

    <h3>文件存储（POST multipart 字段 file；private 下载仅 root/admin）</h3>
    <div class="panel upload">
      <input ref="fileInput" type="file" />
      <button class="primary" type="button" :disabled="uploading" @click="upload"><span v-if="uploading" class="spin" /> 上传</button>
    </div>

    <div v-if="filesLoading" class="state"><span class="spin" /> 加载中…</div>
    <div v-else-if="filesError !== ''" class="state error">{{ filesError }} <button type="button" @click="loadFiles">重试</button></div>
    <div v-else-if="files.length === 0" class="state">暂无文件</div>
    <div v-else class="panel">
      <table>
        <thead><tr><th>文件名</th><th>大小</th><th>mime</th><th>可见性</th><th>来源</th><th>上传时间 (UTC)</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="f in files" :key="f.id">
            <td><a :href="downloadUrl(f)" target="_blank">{{ f.origName }}</a><div class="dim">{{ f.id }}</div></td>
            <td>{{ fmtSize(f.size) }}</td>
            <td><code>{{ f.mime }}</code></td>
            <td>{{ f.visibility }}</td>
            <td class="dim">{{ f.extId ?? 'rest' }}</td>
            <td class="dim">{{ new Date(f.createdAt).toISOString().replace('T', ' ').slice(0, 19) }}</td>
            <td><button type="button" class="danger" @click="removeFile(f)">删除</button></td>
          </tr>
        </tbody>
      </table>
    </div>

    <h3>长任务（v1 内置 echo 执行器；queued/running 自动轮询进度）</h3>
    <form class="panel upload" @submit.prevent="dispatch">
      <input v-model="dispatchArgs" type="text" style="flex:1" placeholder='args JSON，如 {"text":"hi"}' />
      <button class="primary" type="submit" :disabled="dispatching"><span v-if="dispatching" class="spin" /> 派发 echo</button>
    </form>

    <div v-if="tasksLoading" class="state"><span class="spin" /> 加载中…</div>
    <div v-else-if="tasksError !== ''" class="state error">{{ tasksError }} <button type="button" @click="loadTasks">重试</button></div>
    <div v-else-if="tasks.length === 0" class="state">暂无任务</div>
    <div v-else class="panel">
      <table>
        <thead><tr><th>任务</th><th>状态</th><th>进度</th><th>结果 / 错误</th><th>创建时间 (UTC)</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="t in tasks" :key="t.id">
            <td><code>{{ t.name }}</code><div class="dim">{{ t.id }} · {{ t.extId === '' ? '内核' : t.extId }}</div></td>
            <td><span class="badge" :class="STATUS_CLASS[t.status] ?? ''">{{ t.status }}</span></td>
            <td>
              <div class="bar"><div class="fill" :style="{ width: `${Math.min(100, Math.max(0, t.progress))}%` }" /></div>
              <span v-if="t.progressMsg !== null" class="dim">{{ t.progressMsg }}</span>
            </td>
            <td class="wrap">
              <span v-if="t.error !== null" class="err-text">{{ t.error }}</span>
              <code v-else-if="t.result !== null" class="dim">{{ JSON.stringify(t.result).slice(0, 80) }}</code>
              <span v-else class="dim">—</span>
            </td>
            <td class="dim">{{ new Date(t.createdAt).toISOString().replace('T', ' ').slice(0, 19) }}</td>
            <td>
              <button v-if="t.status === 'queued' || t.status === 'running'" type="button" class="danger" @click="cancelTask(t)">取消</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>

<style scoped>
.page-head { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
.page-head h2 { margin: 0; font-size: 17px; }
.spacer { flex: 1; }
h3 { font-size: 14.5px; margin: 18px 0 8px; }
.panel { background: var(--bg-raised); border: 1px solid var(--border); border-radius: var(--radius); overflow: auto; }
.upload { display: flex; gap: 10px; align-items: center; padding: 12px 14px; margin-bottom: 12px; flex-wrap: wrap; }
.dim { color: var(--text-dim); font-size: 12px; }
.wrap { max-width: 260px; white-space: normal; word-break: break-all; }
.err-text { color: var(--err); font-size: 12.5px; }
.bar { width: 120px; height: 6px; background: var(--bg); border: 1px solid var(--border); border-radius: 4px; overflow: hidden; }
.fill { height: 100%; background: var(--accent); transition: width 0.4s ease; }
</style>
