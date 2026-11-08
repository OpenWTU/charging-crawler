<template>
  <div class="sys">
    <p v-if="error" class="a-err">{{ error }}</p>
    <section class="panel">
      <div class="panel-head"><h2>运行信息</h2><button class="a-btn sm" @click="load">刷新</button></div>
      <dl class="kv">
        <div><dt>服务版本</dt><dd class="mono">{{ rt.version || '—' }}</dd></div>
        <div><dt>运行时长</dt><dd>{{ uptime }}</dd></div>
        <div><dt>内存</dt><dd>{{ memText }}</dd></div>
        <div><dt>数据库</dt><dd>{{ dbSize }}（含 wal/shm）</dd></div>
        <div><dt>P2P</dt><dd>{{ rt.p2p_enabled ? (rt.p2p_self ? '已启动 · ' + (rt.p2p_self_name || rt.p2p_self.slice(0, 8)) : '已启用但未启动') : '未启用' }}</dd></div>
        <div><dt>NODE_ENV</dt><dd class="mono">{{ rt.node_env || '—' }}</dd></div>
      </dl>
    </section>

    <section class="panel">
      <div class="panel-head"><h2>环境变量（脱敏）</h2></div>
      <table class="tbl">
        <thead><tr><th>键</th><th>状态</th></tr></thead>
        <tbody>
          <tr v-for="e in env" :key="e.key">
            <td class="mono">{{ e.key }}</td>
            <td>
              <span v-if="e.configured" class="tag ok">已配置</span>
              <span v-else class="tag off">未配置</span>
              <span v-if="e.value !== undefined && e.value !== null" class="muted"> · {{ e.value }}</span>
            </td>
          </tr>
        </tbody>
      </table>
      <p class="muted small">密钥类变量只显示是否配置，不显示值。</p>
    </section>

    <section class="panel">
      <div class="panel-head"><h2>数据库表</h2></div>
      <table class="tbl">
        <thead><tr><th>表</th><th class="num">行数</th></tr></thead>
        <tbody>
          <tr v-for="t in tables" :key="t.name">
            <td class="mono">{{ t.name }}</td>
            <td class="num">{{ t.rows.toLocaleString('zh-CN') }}</td>
          </tr>
        </tbody>
      </table>
    </section>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { apiGet } from '../../api/adminApi.js';

const rt = ref({});
const env = ref([]);
const tables = ref([]);
const error = ref('');

const uptime = computed(() => {
  const s = Number(rt.value.uptime_sec) || 0;
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d} 天 ${h} 小时`;
  if (h) return `${h} 小时 ${m} 分`;
  return `${m} 分`;
});
const memText = computed(() => {
  const b = Number(rt.value.mem_rss) || 0;
  return b ? `${(b / 1024 / 1024).toFixed(1)} MB` : '—';
});
const dbSize = computed(() => {
  const b = Number(rt.value.db_size) || 0;
  if (!b) return '—';
  return b > 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${(b / 1024).toFixed(0)} KB`;
});

async function load() {
  try {
    const d = await apiGet('/admin/api/system');
    rt.value = d.runtime || {};
    env.value = d.env || [];
    tables.value = d.tables || [];
  } catch (e) {
    error.value = e.message || '加载失败';
  }
}

onMounted(load);
</script>

<style scoped>
.sys { display: grid; gap: var(--sp-3); }
.panel { background: var(--card); border-radius: var(--r-md); padding: var(--sp-3); box-shadow: var(--shadow-card); overflow: auto; }
.panel-head { margin-bottom: var(--sp-2); }
.panel-head h2 { font-size: var(--fs-14); margin: 0; }
.kv { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: var(--sp-3); margin: 0; }
.kv > div { display: grid; gap: 2px; }
.kv dt { font-size: var(--fs-12); color: var(--muted); }
.kv dd { margin: 0; font-size: var(--fs-14); }
.tbl { width: 100%; border-collapse: collapse; font-size: var(--fs-13, 13px); }
.tbl th, .tbl td { padding: 6px 8px; text-align: left; border-bottom: 1px solid var(--border, #eef1f5); }
.tbl th { font-size: var(--fs-12); color: var(--muted); font-weight: var(--fw-medium); }
.mono { font-family: var(--font-mono); }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.tag { font-size: 11px; padding: 1px 8px; border-radius: 999px; }
.tag.ok { background: #ecfdf5; color: #047857; }
.tag.off { background: var(--neutral-bg, #f3f4f6); color: var(--muted); }
.small { font-size: var(--fs-12); }
.muted { color: var(--muted); }
</style>
