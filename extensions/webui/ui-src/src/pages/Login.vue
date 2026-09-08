<script setup lang="ts">
/**
 * Login — 用户名密码登录（auth 扩展 POST /api/v1/auth/login）。
 * 成功后存 token + user 缓存并进入仪表盘。bootstrap owner 账号由 auth 扩展
 * 以 root 令牌引导（owner / <rootToken>，见 extensions/auth/README.md）。
 */
import { ref } from 'vue';
import { useRouter } from 'vue-router';

import { api, setCachedUser, setToken, type LoginResult } from '../api';

const router = useRouter();
const username = ref('');
const password = ref('');
const busy = ref(false);
const error = ref('');

async function submit(): Promise<void> {
  if (username.value === '' || password.value === '') {
    error.value = '请输入用户名与密码';
    return;
  }
  busy.value = true;
  error.value = '';
  try {
    const res = await api.post<LoginResult>('/api/v1/auth/login', {
      username: username.value.trim(),
      password: password.value,
    }, { silent: true });
    setToken(res.token);
    setCachedUser(res.user);
    await router.push({ name: 'dashboard' });
  } catch (e) {
    const err = e as { code?: string; message?: string };
    error.value = `${err.code ?? ''} ${err.message ?? '登录失败'}`.trim();
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="wrap">
    <form class="card" @submit.prevent="submit">
      <h1>Opptrix Console</h1>
      <p class="hint">登录 Harness OS 管理台（auth 扩展会话，7 天有效）</p>
      <label>
        <span>用户名</span>
        <input v-model="username" type="text" autocomplete="username" placeholder="owner" />
      </label>
      <label>
        <span>密码</span>
        <input v-model="password" type="password" autocomplete="current-password" placeholder="••••••••" />
      </label>
      <p v-if="error !== ''" class="error">{{ error }}</p>
      <button class="primary" type="submit" :disabled="busy">
        <span v-if="busy" class="spin" /> 登录
      </button>
    </form>
  </div>
</template>

<style scoped>
.wrap { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 16px; }
.card {
  width: 100%; max-width: 360px;
  background: var(--bg-raised); border: 1px solid var(--border); border-radius: 12px;
  padding: 28px;
  display: flex; flex-direction: column; gap: 14px;
}
h1 { margin: 0; font-size: 20px; text-align: center; letter-spacing: 0.04em; }
.hint { margin: 0; color: var(--text-dim); font-size: 12.5px; text-align: center; }
label { display: flex; flex-direction: column; gap: 6px; }
label span { font-size: 12.5px; color: var(--text-dim); }
.error { margin: 0; color: var(--err); font-size: 13px; }
button { justify-content: center; }
</style>
