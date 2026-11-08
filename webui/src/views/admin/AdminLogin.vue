<template>
  <div class="login-wrap">
    <form class="login-card" @submit.prevent="submit">
      <h1>充电桩后台</h1>
      <p class="muted">请使用管理员账号登录</p>
      <label>
        <span>用户名</span>
        <input v-model.trim="username" autocomplete="username" :disabled="busy" />
      </label>
      <label>
        <span>口令</span>
        <input v-model="password" type="password" autocomplete="current-password" :disabled="busy" />
      </label>
      <p v-if="error" class="err">{{ error }}</p>
      <p v-else-if="notice" class="muted">{{ notice }}</p>
      <button class="btn success" type="submit" :disabled="busy || !username || !password">
        {{ busy ? '登录中…' : '登录' }}
      </button>
    </form>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import { apiPost, AuthError } from '../../api/adminApi.js';

defineProps({ notice: { type: String, default: '' } });
const emit = defineEmits(['done']);

const username = ref('');
const password = ref('');
const busy = ref(false);
const error = ref('');

async function submit() {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    const r = await apiPost('/admin/login', { username: username.value, password: password.value });
    if (!r.ok) throw new Error(r.error || '登录失败');
    emit('done', r);
  } catch (e) {
    if (e instanceof AuthError) error.value = '用户名或口令错误';
    else error.value = e && e.message ? e.message : '登录失败';
  } finally {
    busy.value = false;
  }
}
</script>

<style scoped>
.login-wrap {
  display: grid;
  place-items: center;
  min-height: 100vh;
  padding: var(--sp-4);
  background: var(--page-bg);
}
.login-card {
  width: min(360px, 100%);
  background: var(--card);
  border-radius: var(--r-lg);
  padding: var(--sp-5, 24px);
  box-shadow: var(--shadow-card);
  display: grid;
  gap: var(--sp-3);
}
.login-card h1 {
  font-size: var(--fs-20);
  margin: 0;
}
.login-card label {
  display: grid;
  gap: 6px;
  font-size: var(--fs-12);
  color: var(--text-3);
}
.login-card input {
  height: var(--ctl-40, 40px);
  padding: 0 12px;
  border: 1px solid var(--border, #d8dee9);
  border-radius: var(--r-sm);
  font-size: var(--fs-14);
  background: var(--input-bg, #fff);
  color: var(--text);
}
.login-card .btn {
  min-height: var(--ctl-40, 40px);
  border: 0;
  border-radius: var(--r-sm);
  font-size: var(--fs-14);
  cursor: pointer;
}
.login-card .btn.success {
  background: var(--primary);
  color: var(--on-primary);
}
.login-card .btn:disabled {
  opacity: 0.6;
  cursor: default;
}
.err {
  color: var(--danger, #dc2626);
  font-size: var(--fs-12);
  margin: 0;
}
</style>
