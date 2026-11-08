<template>
  <div class="shell">
    <aside class="side">
      <div class="brand">充电桩后台</div>
      <nav>
        <button
v-for="m in menus" :key="m.key" class="nav-item"
                :class="{ active: tab === m.key }" @click="tab = m.key">
          <span>{{ m.label }}</span>
          <span v-if="m.badge" class="badge">{{ m.badge }}</span>
        </button>
      </nav>
      <div class="side-foot muted">v{{ version }}</div>
    </aside>

    <div class="main">
      <header class="topbar">
        <span class="fresh" :class="freshTone" :title="freshTitle">● {{ freshText }}</span>
        <span v-if="alertCount" class="alerts" @click="tab = 'overview'">
          ⚠ {{ alertCount }} 条告警
        </span>
        <span class="spacer" />
        <span class="who">{{ me?.username }} · {{ roleText }}</span>
        <button class="btn ghost sm" @click="$emit('logout')">退出</button>
      </header>

      <main class="content">
        <p v-if="error" class="err">
          {{ error }}
          <button class="btn ghost sm" @click="load">重试</button>
        </p>
        <OverviewPage
v-if="tab === 'overview'" :data="overview" :loading="loading"
                      @go="tab = $event" @refresh="load" />
        <LivePage v-else-if="tab === 'live'" />
        <TokensPage v-else-if="tab === 'tokens'" @changed="load" />
        <SystemPage v-else-if="tab === 'system'" />
        <section v-else class="todo panel">
          <h2>该页面尚未实现</h2>
          <p class="muted">设备 / 桩与区域 / 节点网络 / 历史分析等排在 P2、P3。</p>
        </section>
      </main>
    </div>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { apiGet } from '../../api/adminApi.js';
import OverviewPage from './OverviewPage.vue';
import LivePage from './LivePage.vue';
import TokensPage from './TokensPage.vue';
import SystemPage from './SystemPage.vue';

const props = defineProps({ me: { type: Object, default: null } });
defineEmits(['logout']);

const tab = ref('overview');
const overview = ref(null);
const loading = ref(false);
const error = ref('');
const version = ref('—');
let timer = null;

const ROLE_TEXT = { super: '超级管理员', ops: '运维', viewer: '只读' };
const roleText = computed(() => ROLE_TEXT[props.me?.role] || props.me?.role || '');

const alertCount = computed(() => (overview.value?.alerts || []).length);
const menus = computed(() => [
  { key: 'overview', label: '概览', badge: alertCount.value || null },
  { key: 'live', label: '实时数据' },
  { key: 'tokens', label: '令牌池', badge: overview.value && overview.value.cards.tokens_valid === 0
    && overview.value.cards.tokens_total > 0 ? '!' : null },
  { key: 'system', label: '系统' },
]);

const freshText = computed(() => {
  const sec = overview.value?.cards?.freshness_sec;
  if (sec === null || sec === undefined) return '暂无数据';
  if (sec < 120) return `数据 ${Math.floor(sec / 60) || 0} 分钟前`;
  if (sec < 3600) return `数据 ${Math.floor(sec / 60)} 分钟前`;
  return `数据 ${Math.floor(sec / 3600)} 小时前`;
});
const freshTone = computed(() => {
  const sec = overview.value?.cards?.freshness_sec;
  if (sec === null || sec === undefined) return 'is-red';
  if (sec < 900) return 'is-ok';
  if (sec < 3600) return 'is-warn';
  return 'is-red';
});
const freshTitle = computed(() => overview.value?.data?.last_upload_at
  ? `最近上传：${overview.value.data.last_upload_at}` : '');

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const d = await apiGet('/admin/api/overview');
    overview.value = d;
    version.value = d?.server_version || version.value;
  } catch (e) {
    error.value = e && e.message ? e.message : '加载失败';
  } finally {
    loading.value = false;
  }
}

onMounted(async () => {
  await load();
  timer = setInterval(() => { void load(); }, 30000);
});
onBeforeUnmount(() => { if (timer) clearInterval(timer); });
</script>

<style scoped>
.shell {
  display: grid;
  grid-template-columns: 200px 1fr;
  min-height: 100vh;
  background: var(--page-bg);
}
.side {
  background: var(--card);
  border-right: 1px solid var(--border, #e5e7eb);
  display: flex;
  flex-direction: column;
  padding: var(--sp-3) 0;
}
.brand {
  font-weight: var(--fw-semibold);
  font-size: var(--fs-16);
  padding: 0 var(--sp-4) var(--sp-3);
}
nav { display: grid; gap: 2px; }
.nav-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px var(--sp-4);
  border: 0;
  background: none;
  text-align: left;
  font-size: var(--fs-14);
  color: var(--text-2, #374151);
  cursor: pointer;
}
.nav-item:hover { background: var(--neutral-bg, #f3f4f6); }
.nav-item.active {
  background: var(--brand-glass, #ecfdf5);
  color: var(--primary);
  font-weight: var(--fw-semibold);
}
.badge {
  background: var(--danger, #dc2626);
  color: #fff;
  font-size: 11px;
  padding: 0 6px;
  border-radius: 999px;
  min-width: 18px;
  text-align: center;
}
.side-foot { margin-top: auto; padding: var(--sp-3) var(--sp-4); font-size: var(--fs-12); }
.main { display: flex; flex-direction: column; min-width: 0; }
.topbar {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-3) var(--sp-4);
  background: var(--card);
  border-bottom: 1px solid var(--border, #e5e7eb);
  font-size: var(--fs-12);
}
.fresh.is-ok { color: var(--ok, #16a34a); }
.fresh.is-warn { color: var(--warn-fg, #b26a00); }
.fresh.is-red { color: var(--danger, #dc2626); }
.alerts { color: var(--warn-fg, #b26a00); cursor: pointer; }
.spacer { flex: 1; }
.who { color: var(--muted); }
.content { padding: var(--sp-4); max-width: 1100px; width: 100%; }
.err { color: var(--danger, #dc2626); font-size: var(--fs-12); }
.todo { padding: var(--sp-4); }
@media (max-width: 768px) {
  .shell { grid-template-columns: 1fr; }
  .side { flex-direction: row; overflow-x: auto; padding: 0; }
  .brand, .side-foot { display: none; }
  nav { display: flex; }
  .nav-item { white-space: nowrap; }
}
</style>
