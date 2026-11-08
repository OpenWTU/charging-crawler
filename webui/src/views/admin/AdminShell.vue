<template>
  <div class="shell">
    <aside class="side">
      <div class="brand">充电桩后台</div>
      <nav>
        <template v-for="group in groups" :key="group.title">
          <div class="grp">{{ group.title }}</div>
          <button
v-for="m in group.items" :key="m.key" class="nav-item"
                  :class="{ active: tab === m.key }" :aria-current="tab === m.key ? 'page' : undefined"
                @click="tab = m.key">
            <span>{{ m.label }}</span>
            <span v-if="m.badge" class="badge">{{ m.badge }}</span>
          </button>
        </template>
      </nav>
      <div class="side-foot muted">v{{ version }}</div>
    </aside>

    <div class="main">
      <header class="topbar">
        <span class="fresh" :class="freshTone" :title="freshTitle">● {{ freshText }}</span>
        <span v-if="alertCount" class="alerts" @click="tab = 'overview'">⚠ {{ alertCount }} 条告警</span>
        <span class="spacer" />
        <span class="who">{{ me?.username }} · {{ roleText }}</span>
        <button class="btn ghost sm" @click="$emit('logout')">退出</button>
      </header>

      <main class="content">
        <p v-if="error && tab === 'overview'" class="err">
          {{ error }} <button class="btn ghost sm" @click="load">重试</button>
        </p>
        <!-- M29：原来是一长串 v-if —— 每次切 tab 都销毁重建，查询条件/滚动位置/筛选全丢。
             改成动态组件 + KeepAlive：切回来状态还在。 -->
        <KeepAlive :max="18">
          <component :is="currentPage" v-bind="currentProps" @changed="load" @go="tab = $event" @refresh="load" />
        </KeepAlive>
      </main>
    </div>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, provide, ref } from 'vue';
import { apiGet } from '../../api/adminApi.js';
import OverviewPage from './OverviewPage.vue';
import LivePage from './LivePage.vue';
import HistoryPage from './HistoryPage.vue';
import QualityPage from './QualityPage.vue';
import DbPage from './DbPage.vue';
import TokensPage from './TokensPage.vue';
import DevicesPage from './DevicesPage.vue';
import UnitsPage from './UnitsPage.vue';
import NodesPage from './NodesPage.vue';
import JobsPage from './JobsPage.vue';
import LogsPage from './LogsPage.vue';
import TrafficPage from './TrafficPage.vue';
import ConfigPage from './ConfigPage.vue';
import ReleasePage from './ReleasePage.vue';
import BackupPage from './BackupPage.vue';
import AccountsPage from './AccountsPage.vue';
import AuditPage from './AuditPage.vue';
import SystemPage from './SystemPage.vue';

const props = defineProps({ me: { type: Object, default: null } });
defineEmits(['logout']);

const PAGES = {
  overview: OverviewPage, live: LivePage, history: HistoryPage, quality: QualityPage,
  db: DbPage, tokens: TokensPage, devices: DevicesPage, units: UnitsPage,
  nodes: NodesPage, jobs: JobsPage, logs: LogsPage, traffic: TrafficPage,
  config: ConfigPage, release: ReleasePage, backup: BackupPage,
  accounts: AccountsPage, audit: AuditPage, system: SystemPage,
};

const tab = ref('overview');
const currentPage = computed(() => PAGES[tab.value] ?? OverviewPage);
// 只有概览需要 Shell 下发的数据，其余页面自己拉
const currentProps = computed(() => (tab.value === 'overview'
  ? { data: overview.value, loading: loading.value }
  : {}));
const overview = ref(null);
const loading = ref(false);
const error = ref('');
const version = ref('—');
let timer = null;

const ROLE_TEXT = { super: '超级管理员', ops: '运维', viewer: '只读' };
const roleText = computed(() => ROLE_TEXT[props.me?.role] || props.me?.role || '');
const isSuper = computed(() => props.me?.role === 'super');
const canWrite = computed(() => ['super', 'ops'].includes(props.me?.role));

provide('adminRole', computed(() => props.me?.role ?? 'viewer'));
provide('canWrite', canWrite);
provide('isSuper', isSuper);

const alertCount = computed(() => (overview.value?.alerts || []).length);
const tokenBadge = computed(() => {
  const c = overview.value?.cards;
  return c && c.tokens_total > 0 && c.tokens_valid === 0 ? '!' : null;
});

const groups = computed(() => {
  const g = [
    {
      title: '监控',
      items: [
        { key: 'overview', label: '概览', badge: alertCount.value || null },
        { key: 'traffic', label: '流量与限流' },
        { key: 'audit', label: '审计' },
      ],
    },
    {
      title: '数据',
      items: [
        { key: 'live', label: '实时数据' },
        { key: 'history', label: '历史分析' },
        { key: 'quality', label: '数据质量' },
        ...(isSuper.value ? [{ key: 'db', label: '数据浏览器' }] : []),
      ],
    },
    {
      title: '运维',
      items: [
        { key: 'tokens', label: '令牌池', badge: tokenBadge.value },
        { key: 'devices', label: '上传设备' },
        { key: 'units', label: '桩与区域' },
        { key: 'nodes', label: '节点网络' },
        { key: 'jobs', label: '任务调度' },
        { key: 'logs', label: '运行日志' },
      ],
    },
    {
      title: '系统',
      items: [
        { key: 'system', label: '系统信息' },
        { key: 'config', label: '配置中心' },
        ...(isSuper.value ? [{ key: 'release', label: '版本发布' }] : []),
        ...(isSuper.value ? [{ key: 'backup', label: '备份恢复' }] : []),
        ...(isSuper.value ? [{ key: 'accounts', label: '账号权限' }] : []),
      ],
    },
  ];
  return g;
});

const freshText = computed(() => {
  const sec = overview.value?.cards?.freshness_sec;
  if (sec === null || sec === undefined) return '暂无数据';
  if (sec < 3600) return `数据 ${Math.floor(sec / 60) || 0} 分钟前`;
  return `数据 ${Math.floor(sec / 3600)} 小时前`;
});
const freshTone = computed(() => {
  const sec = overview.value?.cards?.freshness_sec;
  if (sec === null || sec === undefined) return 'is-red';
  if (sec < 900) return 'is-ok';
  if (sec < 3600) return 'is-warn';
  return 'is-red';
});
const freshTitle = computed(() => (overview.value?.data?.last_upload_at
  ? `最近上传：${overview.value.data.last_upload_at}` : ''));

async function load() {
  loading.value = true;
  error.value = '';
  try {
    overview.value = await apiGet('/admin/api/overview');
  } catch (e) {
    error.value = e.message || '加载失败';
  } finally {
    loading.value = false;
  }
}

onMounted(async () => {
  await load();
  // 版本号单独取（overview 不含版本字段）
  try {
    const sys = await apiGet('/admin/api/system');
    version.value = sys?.runtime?.version || '—';
  } catch {
    version.value = '—';
  }
  timer = setInterval(() => { void load(); }, 60000);
});
onBeforeUnmount(() => { if (timer) clearInterval(timer); });
</script>

<style scoped>
.shell { display: grid; grid-template-columns: 190px 1fr; min-height: 100vh; background: var(--page-bg); }
.side {
  background: var(--card); border-right: 1px solid var(--border, #e5e7eb);
  display: flex; flex-direction: column; padding: var(--sp-2) 0; overflow-y: auto;
}
.brand { font-weight: var(--fw-semibold); font-size: var(--fs-14); padding: 4px var(--sp-3) var(--sp-2); }
nav { display: grid; gap: 1px; }
.grp { font-size: 11px; color: var(--muted); padding: 8px var(--sp-3) 2px; letter-spacing: .5px; }
.nav-item {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 7px var(--sp-3); border: 0; background: none; text-align: left;
  font-size: var(--fs-13, 13px); color: var(--text-2, #374151); cursor: pointer;
}
.nav-item:hover { background: var(--neutral-bg, #f3f4f6); }
.nav-item.active { background: var(--brand-glass, #ecfdf5); color: var(--primary); font-weight: var(--fw-semibold); }
.badge {
  background: var(--danger, #dc2626); color: #fff; font-size: 11px;
  padding: 0 6px; border-radius: 999px; min-width: 18px; text-align: center;
}
.side-foot { margin-top: auto; padding: var(--sp-2) var(--sp-3); font-size: 11px; color: var(--muted); }
.main { display: flex; flex-direction: column; min-width: 0; }
.topbar {
  display: flex; align-items: center; gap: var(--sp-3); padding: var(--sp-2) var(--sp-4);
  background: var(--card); border-bottom: 1px solid var(--border, #e5e7eb); font-size: var(--fs-12);
}
.fresh.is-ok { color: var(--ok, #16a34a); }
.fresh.is-warn { color: var(--warn-fg, #b26a00); }
.fresh.is-red { color: var(--danger, #dc2626); }
.alerts { color: var(--warn-fg, #b26a00); cursor: pointer; }
.spacer { flex: 1; }
.who { color: var(--muted); }
.content { padding: var(--sp-4); max-width: 1200px; width: 100%; }
.err { color: var(--danger, #dc2626); font-size: var(--fs-12); }
@media (max-width: 768px) {
  .shell { grid-template-columns: 1fr; }
  .side { flex-direction: row; overflow-x: auto; padding: 0; }
  .brand, .side-foot, .grp { display: none; }
  nav { display: flex; }
  .nav-item { white-space: nowrap; }
}
</style>
