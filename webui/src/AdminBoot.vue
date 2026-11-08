/**
 * 管理后台入口：判断登录态后渲染登录页 / 主界面 / 强制改密页。
 *
 * 不使用 hash 路由库：状态只有「未登录 / 需改密 / 已登录」，主界面内部再按 tab 切换。
 */
<template>
  <AdminLogin v-if="state === 'login'" :notice="notice" @done="onLoggedIn" />
  <AdminForcePassword v-else-if="state === 'must-change'" :me="me" @done="onPasswordChanged" />
  <AdminShell v-else-if="state === 'ready'" :me="me" @logout="onLogout" />
  <div v-else class="boot">加载中…</div>
</template>

<script setup>
import { onMounted, ref } from 'vue';
import { probeSession } from './api/adminApi.js';
import AdminLogin from './views/admin/AdminLogin.vue';
import AdminForcePassword from './views/admin/AdminForcePassword.vue';
import AdminShell from './views/admin/AdminShell.vue';

const state = ref('boot'); // boot | login | must-change | ready
const me = ref(null);
const notice = ref('');

function apply(session) {
  if (!session) {
    me.value = null;
    state.value = 'login';
    return;
  }
  me.value = session;
  state.value = session.must_change ? 'must-change' : 'ready';
}

function onLoggedIn(session) {
  notice.value = '';
  apply(session);
}

function onPasswordChanged(session) {
  apply(session);
}

async function onLogout() {
  try {
    await fetch('/admin/logout', { method: 'POST', credentials: 'same-origin' });
  } catch {
    /* 忽略网络错误 */
  }
  me.value = null;
  state.value = 'login';
  notice.value = '已退出登录';
}

onMounted(async () => {
  try {
    apply(await probeSession());
  } catch (e) {
    notice.value = e && e.message ? e.message : '';
    state.value = 'login';
  }
});
</script>

<style scoped>
.boot {
  display: grid;
  place-items: center;
  min-height: 60vh;
  color: var(--muted);
  font-size: var(--fs-14);
}
</style>
