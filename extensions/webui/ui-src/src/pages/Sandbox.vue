<script setup lang="ts">
/**
 * Sandbox — 工作区列表/创建/删除（confirm）、exec 终端样式输出、文件列表
 * （GET files?list=1）。Docker 未启用时 API 返回 SANDBOX_DISABLED，页面以错误态呈现。
 */
import { onMounted, ref } from 'vue';

import { api, pushToast, type SandboxExecResult, type SandboxFileEntry, type WorkspaceInfo } from '../api';

const loading = ref(true);
const error = ref('');
const workspaces = ref<WorkspaceInfo[]>([]);
const activeId = ref('');

const creating = ref(false);
const newId = ref('');

const cmdText = ref('echo hello sandbox');
const execing = ref(false);
const termLines = ref<{ kind: 'cmd' | 'out' | 'err' | 'meta'; text: string }[]>([]);
const termBox = ref<HTMLElement | null>(null);

const files = ref<SandboxFileEntry[]>([]);
const filesLoading = ref(false);

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    workspaces.value = await api.get<WorkspaceInfo[]>('/api/v1/sandbox/workspaces');
    if (activeId.value === '' && workspaces.value.length > 0) select(workspaces.value[0]?.id ?? '');
  } catch (e) {
    error.value = (e as { message?: string }).message ?? '加载失败';
  } finally {
    loading.value = false;
  }
}

function select(id: string): void {
  activeId.value = id;
  termLines.value = [];
  void loadFiles();
}

async function create(): Promise<void> {
  creating.value = true;
  try {
    const body = newId.value.trim() !== '' ? { id: newId.value.trim() } : {};
    const ws = await api.post<WorkspaceInfo>('/api/v1/sandbox/workspaces', body);
    newId.value = '';
    await load();
    select(ws.id);
  } finally {
    creating.value = false;
  }
}

async function removeWs(ws: WorkspaceInfo): Promise<void> {
  if (!window.confirm(`删除工作区 "${ws.id}"？（家目录保留，容器销毁）`)) return;
  await api.delete(`/api/v1/sandbox/workspaces/${encodeURIComponent(ws.id)}`);
  if (activeId.value === ws.id) activeId.value = '';
  await load();
}

async function exec(): Promise<void> {
  const cmd = cmdText.value.trim();
  if (cmd === '' || activeId.value === '') return;
  // 简单分词（空格分隔，支持双引号包裹）；内核侧不走 shell 拼接
  const parts = cmd.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((s) => s.replace(/"/g, '')) ?? [];
  if (parts.length === 0) return;
  termLines.value = [...termLines.value, { kind: 'cmd', text: `$ ${cmd}` }];
  execing.value = true;
  try {
    const res = await api.post<SandboxExecResult>(`/api/v1/sandbox/workspaces/${encodeURIComponent(activeId.value)}/exec`, { cmd: parts });
    if (res.stdout !== '') termLines.value = [...termLines.value, { kind: 'out', text: res.stdout.replace(/\n$/, '') }];
    if (res.stderr !== '') termLines.value = [...termLines.value, { kind: 'err', text: res.stderr.replace(/\n$/, '') }];
    termLines.value = [...termLines.value, { kind: 'meta', text: `exit ${res.exitCode}` }];
    termBox.value?.scrollTo({ top: termBox.value.scrollHeight });
  } finally {
    execing.value = false;
  }
}

async function loadFiles(): Promise<void> {
  if (activeId.value === '') {
    files.value = [];
    return;
  }
  filesLoading.value = true;
  try {
    files.value = await api.get<SandboxFileEntry[]>(`/api/v1/sandbox/workspaces/${encodeURIComponent(activeId.value)}/files?list=1&path=.`);
  } finally {
    filesLoading.value = false;
  }
}

function stateClass(s: string): string {
  if (s === 'running') return 'ok';
  if (s === 'error') return 'err';
  if (s === 'stopped') return 'warn';
  return 'accent';
}

onMounted(() => void load());
</script>

<template>
  <section>
    <header class="page-head">
      <h2>沙箱工作区</h2>
      <span class="spacer" />
      <input v-model="newId" type="text" placeholder="workspace id（可留空自动生成）" style="width:220px" />
      <button type="button" :disabled="creating" @click="create"><span v-if="creating" class="spin" /> 创建</button>
      <button class="ghost" type="button" @click="load">刷新</button>
    </header>

    <div v-if="loading" class="state"><span class="spin" /> 加载中…</div>
    <div v-else-if="error !== ''" class="state error">
      {{ error }}（Docker 未启用时沙箱整体降级为 SANDBOX_DISABLED）
      <button type="button" @click="load">重试</button>
    </div>
    <div v-else-if="workspaces.length === 0" class="state">暂无工作区</div>

    <template v-else>
      <div class="panel">
        <table>
          <thead><tr><th>id</th><th>状态</th><th>镜像</th><th>容器</th><th>操作</th></tr></thead>
          <tbody>
            <tr v-for="ws in workspaces" :key="ws.id" :class="{ picked: ws.id === activeId }">
              <td><strong>{{ ws.id }}</strong></td>
              <td><span class="badge" :class="stateClass(ws.state)">{{ ws.state }}</span></td>
              <td><code>{{ ws.image }}</code></td>
              <td class="dim">{{ ws.containerId?.slice(0, 12) ?? '—' }}</td>
              <td class="actions">
                <button type="button" @click="select(ws.id)">打开</button>
                <button type="button" class="danger" @click="removeWs(ws)">删除</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-if="activeId !== ''" class="cols">
        <div class="col">
          <h3>exec 终端 — {{ activeId }}</h3>
          <div class="panel term">
            <div ref="termBox" class="lines">
              <div v-if="termLines.length === 0" class="state">输入命令回车执行（空格分词；例：echo hello）</div>
              <pre v-for="(l, i) in termLines" :key="i" :class="l.kind" class="line">{{ l.text }}</pre>
            </div>
            <form class="entry" @submit.prevent="exec">
              <span class="prompt">$</span>
              <input v-model="cmdText" type="text" placeholder="echo hello sandbox" />
              <button class="primary" type="submit" :disabled="execing"><span v-if="execing" class="spin" /> 执行</button>
            </form>
          </div>
        </div>
        <div class="col">
          <h3>家目录文件（./）</h3>
          <div class="panel">
            <div v-if="filesLoading" class="state"><span class="spin" /> 加载中…</div>
            <div v-else-if="files.length === 0" class="state">目录为空</div>
            <table v-else>
              <thead><tr><th>名称</th><th>类型</th></tr></thead>
              <tbody>
                <tr v-for="f in files" :key="String(f.name)">
                  <td>{{ f.name }}</td>
                  <td class="dim">{{ f.type ?? 'file' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
      <p v-else class="note">从上方选择一个工作区以执行命令 / 查看文件。</p>
    </template>
  </section>
</template>

<style scoped>
.page-head { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; flex-wrap: wrap; }
.page-head h2 { margin: 0; font-size: 17px; }
.spacer { flex: 1; }
h3 { font-size: 14px; margin: 16px 0 8px; }
.panel { background: var(--bg-raised); border: 1px solid var(--border); border-radius: var(--radius); overflow: auto; }
.dim { color: var(--text-dim); font-size: 12px; }
tr.picked td { background: var(--accent-soft); }
.actions { display: flex; gap: 6px; }
.actions button { padding: 3px 10px; font-size: 12.5px; }
.cols { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.term { display: flex; flex-direction: column; height: 320px; }
.lines { flex: 1; overflow: auto; padding: 10px 12px; display: flex; flex-direction: column; gap: 2px; }
.line { margin: 0; white-space: pre-wrap; word-break: break-all; background: transparent; border: none; padding: 0; }
.line.cmd { color: var(--accent); }
.line.err { color: var(--err); }
.line.meta { color: var(--text-faint); }
.entry { display: flex; gap: 8px; align-items: center; padding: 8px 12px; border-top: 1px solid var(--border); }
.entry input { flex: 1; font-family: var(--mono); }
.prompt { color: var(--ok); font-family: var(--mono); }
.note { color: var(--text-faint); }
@media (max-width: 900px) { .cols { grid-template-columns: 1fr; } }
</style>
