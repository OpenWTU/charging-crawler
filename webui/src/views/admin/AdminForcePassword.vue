<template>
  <div class="pw-wrap">
    <form class="pw-card" @submit.prevent="submit">
      <h1>首次登录需修改口令</h1>
      <p class="muted">当前用的是系统初始口令，请设置你自己的口令（≥10 位，含字母与数字）。</p>
      <label>
        <span>原口令</span>
        <input v-model="oldPw" type="password" autocomplete="current-password" :disabled="busy" />
      </label>
      <label>
        <span>新口令</span>
        <input v-model="newPw" type="password" autocomplete="new-password" :disabled="busy" />
      </label>
      <label>
        <span>再输一次</span>
        <input v-model="newPw2" type="password" autocomplete="new-password" :disabled="busy" />
      </label>
      <p v-if="error" class="err">{{ error }}</p>
      <button class="btn success" type="submit" :disabled="busy || !oldPw || !newPw">
        {{ busy ? '提交中…' : '修改并进入后台' }}
      </button>
    </form>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import { apiPost } from '../../api/adminApi.js';

const props = defineProps({ me: { type: Object, default: null } });
const emit = defineEmits(['done']);

const oldPw = ref('');
const newPw = ref('');
const newPw2 = ref('');
const busy = ref(false);
const error = ref('');

async function submit() {
  if (busy.value) return;
  error.value = '';
  if (newPw.value !== newPw2.value) {
    error.value = '两次输入的新口令不一致';
    return;
  }
  busy.value = true;
  try {
    const r = await apiPost('/admin/api/password', { old: oldPw.value, new: newPw.value });
    if (!r.ok) throw new Error(r.error || '修改失败');
    emit('done', { ...(props.me || {}), must_change: false });
  } catch (e) {
    error.value = e && e.message ? e.message : '修改失败';
  } finally {
    busy.value = false;
  }
}
</script>

<style scoped>
.pw-wrap {
  display: grid;
  place-items: center;
  min-height: 100vh;
  padding: var(--sp-4);
  background: var(--page-bg);
}
.pw-card {
  width: min(420px, 100%);
  background: var(--card);
  border-radius: var(--r-lg);
  padding: var(--sp-5, 24px);
  box-shadow: var(--shadow-card);
  display: grid;
  gap: var(--sp-3);
}
.pw-card h1 {
  font-size: var(--fs-18, 18px);
  margin: 0;
}
.pw-card label {
  display: grid;
  gap: 6px;
  font-size: var(--fs-12);
  color: var(--text-3);
}
.pw-card input {
  height: var(--ctl-40, 40px);
  padding: 0 12px;
  border: 1px solid var(--border, #d8dee9);
  border-radius: var(--r-sm);
  font-size: var(--fs-14);
  background: var(--input-bg, #fff);
  color: var(--text);
}
.pw-card .btn {
  min-height: var(--ctl-40, 40px);
  border: 0;
  border-radius: var(--r-sm);
  font-size: var(--fs-14);
  cursor: pointer;
  background: var(--primary);
  color: var(--on-primary);
}
.pw-card .btn:disabled {
  opacity: 0.6;
  cursor: default;
}
.err {
  color: var(--danger, #dc2626);
  font-size: var(--fs-12);
  margin: 0;
}
</style>
