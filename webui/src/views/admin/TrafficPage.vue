<template>
  <div class="a-grid">
    <p v-if="error" class="a-err">{{ error }}</p>

    <section class="a-cards">
      <div class="a-card"><div class="lbl">近 24h 请求</div><div class="val">{{ summary.total.toLocaleString('zh-CN') }}</div></div>
      <div class="a-card"><div class="lbl">独立 IP</div><div class="val">{{ summary.uniqIps }}</div></div>
      <div class="a-card"><div class="lbl">当前封禁</div><div class="val">{{ banlist.devices + banlist.ips }}</div><div class="sub">设备 {{ banlist.devices }} / IP {{ banlist.ips }}</div></div>
    </section>

    <!-- 状态码分布 -->
    <section class="a-panel a-pad">
      <div class="a-toolbar"><h2 class="a-small">状态码分布（近 24h）</h2><span class="a-spacer" /><button class="a-btn sm" @click="load">刷新</button></div>
      <div v-if="statusBars.length" class="bars">
        <div v-for="b in statusBars" :key="b.status" class="barrow">
          <span class="lb">{{ b.status }}</span>
          <span class="a-bar"><i :style="{ width: b.pct + '%', background: b.color }" /></span>
          <span class="a-small num">{{ b.hits }}</span>
        </div>
      </div>
      <p v-else class="a-empty">还没有流量数据（重启后重新累计）</p>
    </section>

    <!-- 端点排行 -->
    <section class="a-panel">
      <div class="a-head"><h2>端点排行</h2></div>
      <table class="a-tbl">
        <thead><tr><th>路径</th><th class="num">请求</th><th>状态分布</th></tr></thead>
        <tbody>
          <tr v-for="e in endpoints" :key="e.path">
            <td class="a-mono a-small">{{ e.path }}</td>
            <td class="num">{{ e.hits }}</td>
            <td class="a-small">
              <span v-for="(n, s) in e.status" :key="s" class="a-tag" :class="s === '2xx' ? 'ok' : s === '429' ? 'warn' : 'err'">{{ s }}:{{ n }}</span>
            </td>
          </tr>
          <tr v-if="!endpoints.length"><td colspan="3" class="a-empty">暂无</td></tr>
        </tbody>
      </table>
    </section>

    <!-- 封禁列表 -->
    <section class="a-panel">
      <div class="a-head"><h2>当前封禁</h2></div>
      <table class="a-tbl">
        <thead><tr><th>类型</th><th>目标</th><th class="num">剩余</th><th>计数</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="b in bans" :key="b.kind + b.target">
            <td><span class="a-tag" :class="b.kind === 'device' ? 'warn' : 'err'">{{ b.kind === 'device' ? '设备' : 'IP' }}</span></td>
            <td class="a-mono a-small">{{ b.target }}</td>
            <td class="num">{{ Math.ceil(b.remaining_sec / 60) }} 分</td>
            <td class="a-small a-muted">{{ Object.entries(b.kinds || {}).map(([k, v]) => k + ':' + v).join(' ') }}</td>
            <td><button v-if="canWrite" class="a-btn sm" @click="unban(b.target)">解封</button></td>
          </tr>
          <tr v-if="!bans.length"><td colspan="5" class="a-empty">当前没有封禁</td></tr>
        </tbody>
      </table>
    </section>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { useRole } from './useRole.js';
import { apiGet, apiPost } from '../../api/adminApi.js';

const summary = ref({ total: 0, uniqIps: 0, points: [] });
const endpoints = ref([]);
const banlist = ref({ devices: 0, ips: 0 });
const bans = ref([]);
const error = ref('');
const { canWrite } = useRole();

const statusBars = computed(() => {
  const agg = {};
  for (const p of summary.value.points || []) {
    agg[p.status] = (agg[p.status] || 0) + p.hits;
  }
  const total = Object.values(agg).reduce((a, b) => a + b, 0) || 1;
  const colors = { '2xx': '#16a34a', '3xx': '#2563eb', '4xx': '#b26a00', '429': '#ea580c', '5xx': '#dc2626' };
  return Object.entries(agg)
    .sort((a, b) => b[1] - a[1])
    .map(([status, hits]) => ({
      status, hits, pct: Math.round((hits / total) * 100), color: colors[status] || '#9ca3af',
    }));
});

async function load() {
  error.value = '';
  try {
    const [s, e, b] = await Promise.all([
      apiGet('/admin/api/traffic/summary?range=24'),
      apiGet('/admin/api/traffic/endpoints?range=24'),
      apiGet('/admin/api/traffic/banlist'),
    ]);
    summary.value = s;
    endpoints.value = e.endpoints || [];
    banlist.value = b;
    bans.value = b.items || [];
  } catch (err) {
    error.value = err.message || '加载失败';
  }
}

async function unban(target) {
  if (!window.confirm(`解封 ${target}？`)) return;
  try {
    const d = await apiPost('/admin/api/traffic/unban', { target });
    window.alert(d.note || (d.ok ? '已解封' : '未找到'));
    await load();
  } catch (e) {
    error.value = e.message || '解封失败';
  }
}

onMounted(load);
</script>

<style scoped>
.bars { display: grid; gap: 6px; margin-top: 8px; }
.barrow { display: grid; grid-template-columns: 50px 1fr 60px; gap: 8px; align-items: center; font-size: var(--fs-12); }
.barrow .lb { color: var(--muted); }
.barrow .num { text-align: right; font-variant-numeric: tabular-nums; }
</style>
