<template>
  <div class="a-grid">
    <div class="a-toolbar">
      <button
v-for="t in tabs" :key="t.key" class="a-btn sm" :class="{ primary: tab === t.key }"
              @click="tab = t.key">
{{ t.label }}
</button>
      <span class="a-spacer" />
      <select v-model="exportTable" class="a-select">
        <option value="">导出 CSV…</option>
        <option v-for="t in exportables" :key="t" :value="t">{{ t }}</option>
      </select>
      <button class="a-btn sm" :disabled="!exportTable || exporting" @click="doExport">{{ exporting ? '导出中…' : '导出' }}</button>
    </div>

    <p v-if="error" class="a-err">{{ error }}</p>

    <!-- 快照流 -->
    <section v-if="tab === 'snapshots'" class="a-panel">
      <div class="a-toolbar a-pad">
        <select v-model="source" class="a-select" @change="loadSnaps">
          <option value="">全部来源</option>
          <option value="app">App 上传</option>
          <option value="worker">服务端抓取</option>
        </select>
        <input v-model="deviceFilter" class="a-input" placeholder="设备 ID" @keyup.enter="loadSnaps" />
        <button class="a-btn sm" @click="loadSnaps">刷新</button>
      </div>
      <table class="a-tbl">
        <thead>
          <tr><th>时间</th><th>来源</th><th>设备</th><th>版本</th><th class="num">区域</th><th>摘要</th><th>操作</th></tr>
        </thead>
        <tbody>
          <tr v-for="s in snaps" :key="s.id">
            <td class="a-small">{{ s.received_at }}</td>
            <td><span class="a-tag" :class="s.source === 'app' ? 'ok' : 'info'">{{ s.source === 'app' ? 'App' : 'Worker' }}</span></td>
            <td class="a-mono a-small">{{ s.device_id ? String(s.device_id).slice(0, 10) : '—' }}</td>
            <td class="a-mono a-small">{{ s.app_version || '—' }}</td>
            <td class="num">{{ s.areas }}</td>
            <td class="a-mono a-small">{{ s.sha8 }}</td>
            <td>
              <button class="a-btn sm" @click="viewSnap(s.id)">详情</button>
              <button v-if="canWrite" class="a-btn sm danger" @click="delSnap(s.id)">删除</button>
            </td>
          </tr>
          <tr v-if="!snaps.length"><td colspan="7" class="a-empty">暂无快照</td></tr>
        </tbody>
      </table>
      <div class="a-pad">
        <button v-if="!reachedEnd" class="a-btn sm" :disabled="!nextCursor || loadingMore" @click="loadMore">
          {{ loadingMore ? '加载中…' : '加载更多' }}
        </button>
        <span v-else class="a-small a-muted">已到底</span>
      </div>
    </section>

    <!-- 区域趋势 -->
    <section v-else-if="tab === 'area'" class="a-panel a-pad">
      <div class="a-toolbar">
        <input v-model.trim="areaInput" class="a-input" placeholder="区域名（逗号分隔）" style="min-width:260px" />
        <select v-model="range" class="a-select"><option value="6h">6 小时</option><option value="24h">24 小时</option><option value="7d">7 天</option></select>
        <select v-model="metric" class="a-select"><option value="rate">空闲率</option><option value="idle">空位数</option><option value="total">总端口</option></select>
        <button class="a-btn sm primary" @click="loadTrend">查询</button>
      </div>
      <div v-if="series.length" class="chart">
        <div v-for="(s, i) in series" :key="s.name" class="srow">
          <span class="nm">{{ s.name }}</span>
          <svg viewBox="0 0 300 40" preserveAspectRatio="none">
            <polyline :points="spark(s.points)" :style="{ stroke: colors[i % colors.length] }" />
          </svg>
          <span class="a-small a-muted">{{ s.points.length }} 点</span>
        </div>
      </div>
      <p v-else class="a-empty">选择区域后查询</p>
    </section>

    <!-- 单桩趋势 -->
    <section v-else class="a-panel a-pad">
      <div class="a-toolbar">
        <input v-model.trim="deviceHex" class="a-input" placeholder="桩号 device_hex" style="min-width:200px" />
        <select v-model="range" class="a-select"><option value="24h">24 小时</option><option value="7d">7 天</option></select>
        <button class="a-btn sm primary" @click="loadPile">查询</button>
      </div>
      <table v-if="pile.length" class="a-tbl" style="margin-top:10px">
        <thead><tr><th>时段</th><th class="num">空闲</th><th class="num">充电</th><th class="num">不可用</th><th class="num">总数</th></tr></thead>
        <tbody>
          <tr v-for="p in pile" :key="p.t">
            <td class="a-small">{{ p.t }}</td>
            <td class="num">{{ p.free.toFixed(1) }}</td>
            <td class="num">{{ p.busy.toFixed(1) }}</td>
            <td class="num">{{ p.unavailable.toFixed(1) }}</td>
            <td class="num">{{ p.total.toFixed(0) }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else class="a-empty">输入桩号后查询</p>
    </section>

    <div v-if="snapDetail" class="a-drawer-mask" role="dialog" aria-modal="true" @click.self="snapDetail = null">
      <aside class="a-drawer">
        <header><h2>快照 #{{ snapDetail.snapshot?.id }}</h2><button class="a-btn sm" @click="snapDetail = null">关闭</button></header>
        <dl class="a-kv">
          <div><dt>接收时间</dt><dd>{{ snapDetail.snapshot?.received_at }}</dd></div>
          <div><dt>采集时间</dt><dd>{{ snapDetail.snapshot?.captured_at || '—' }}</dd></div>
          <div><dt>设备</dt><dd class="a-mono a-small">{{ snapDetail.snapshot?.device_id || '—' }}</dd></div>
          <div><dt>摘要</dt><dd class="a-mono a-small">{{ snapDetail.snapshot?.body_sha256?.slice(0, 16) }}</dd></div>
        </dl>
        <table class="a-tbl">
          <thead><tr><th>区域</th><th class="num">空</th><th class="num">充</th><th class="num">故障</th><th class="num">总</th></tr></thead>
          <tbody>
            <tr v-for="a in snapDetail.areas" :key="a.area_name">
              <td>{{ a.area_name }}</td>
              <td class="num">{{ a.idle }}</td><td class="num">{{ a.charging }}</td>
              <td class="num">{{ a.fault }}</td><td class="num">{{ a.total }}</td>
            </tr>
          </tbody>
        </table>
      </aside>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import { usePageLoad } from './usePageLoad.js';
import { useRole } from './useRole.js';
import { apiDelete, apiGet } from '../../api/adminApi.js';

const tabs = [
  { key: 'snapshots', label: '快照流' },
  { key: 'area', label: '区域趋势' },
  { key: 'pile', label: '单桩趋势' },
];
const tab = ref('snapshots');
const error = ref('');
const snaps = ref([]);
const nextCursor = ref(null);
const source = ref('');
const deviceFilter = ref('');
const areaInput = ref('');
const range = ref('24h');
const metric = ref('rate');
const series = ref([]);
const deviceHex = ref('');
const pile = ref([]);
const snapDetail = ref(null);
const exportTable = ref('');
const exportables = ['snapshots', 'area_samples', 'pile_samples', 'devices', 'tokens', 'audit'];
const colors = ['#047857', '#2563eb', '#b26a00', '#dc2626', '#7c3aed', '#0891b2'];

async function loadSnaps() {
  // M3（复审）：重置到底标记 —— 否则翻到末页后换筛选/刷新，按钮永远停在「已到底」
  reachedEnd.value = false;
  error.value = '';
  try {
    const p = new URLSearchParams();
    if (source.value) p.set('source', source.value);
    if (deviceFilter.value) p.set('device_id', deviceFilter.value);
    p.set('size', '50');
    const d = await apiGet(`/admin/api/history/snapshots?${p.toString()}`);
    snaps.value = d.items || [];
    nextCursor.value = d.next_cursor;
  } catch (e) {
    error.value = e.message || '加载失败';
  }
}

const loadingMore = ref(false);
const { canWrite } = useRole();
const reachedEnd = ref(false);

async function loadMore() {
  if (!nextCursor.value || loadingMore.value) return; // M6：忙锁，连点不再发重复请求
  loadingMore.value = true;
  try {
    // M5：必须带上筛选条件，否则「按 App 筛选」后翻页会混进 worker 数据
    const p = new URLSearchParams();
    p.set('cursor', String(nextCursor.value));
    p.set('size', '50');
    if (source.value) p.set('source', source.value);
    if (deviceFilter.value) p.set('device_id', deviceFilter.value);
    const d = await apiGet(`/admin/api/history/snapshots?${p.toString()}`);
    const seen = new Set(snaps.value.map((s) => s.id));
    const fresh = (d.items || []).filter((s) => !seen.has(s.id)); // M6：按 id 去重
    snaps.value = [...snaps.value, ...fresh];
    nextCursor.value = d.next_cursor;
    if (!d.next_cursor || !fresh.length) reachedEnd.value = true; // M7：到底了
  } catch (e) {
    error.value = e.message || '加载失败';
  } finally {
    loadingMore.value = false;
  }
}

async function viewSnap(id) {
  try {
    snapDetail.value = await apiGet(`/admin/api/history/snapshot/${id}`);
  } catch (e) {
    error.value = e.message || '详情加载失败';
  }
}

async function delSnap(id) {
  if (!window.confirm(`删除快照 #${id} 及其区域采样？（硬删除，数据可重抓）`)) return;
  try {
    await apiDelete(`/admin/api/snapshot/${id}`);
    await loadSnaps();
  } catch (e) {
    error.value = e.message || '删除失败';
  }
}

async function loadTrend() {
  const areas = areaInput.value.split(',').map((s) => s.trim()).filter(Boolean);
  if (!areas.length) { error.value = '请输入至少一个区域名'; return; }
  try {
    const d = await apiGet(`/admin/api/history/area-trend?areas=${encodeURIComponent(areas.join(','))}&range=${range.value}&metric=${metric.value}`);
    series.value = d.series || [];
    error.value = '';
  } catch (e) {
    error.value = e.message || '查询失败';
  }
}

function spark(points) {
  const vals = points.map((p) => (p.value === null ? 0 : Number(p.value)));
  if (vals.length < 2) return '';
  const max = Math.max(...vals, 0.0001);
  const min = Math.min(...vals, 0);
  const span = max - min || 1;
  return vals.map((v, i) => {
    const x = (i / (vals.length - 1)) * 300;
    const y = 38 - ((v - min) / span) * 34;
    return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
}

async function loadPile() {
  if (!deviceHex.value) { error.value = '请输入桩号'; return; }
  try {
    const d = await apiGet(`/admin/api/history/pile-trend?device_hex=${encodeURIComponent(deviceHex.value)}&range=${range.value}`);
    pile.value = d.points || [];
    error.value = '';
  } catch (e) {
    error.value = e.message || '查询失败';
  }
}

const exporting = ref(false);

async function doExport() {
  if (!exportTable.value) return;
  // L13：加 loading 与失败提示（原来直接跳转，参数错时浏览器会显示 JSON）
  exporting.value = true;
  try {
    const resp = await fetch(`/admin/api/export.csv?table=${encodeURIComponent(exportTable.value)}`, {
      credentials: 'same-origin',
    });
    if (!resp.ok) {
      let msg = `导出失败 HTTP ${resp.status}`;
      try { const d = await resp.json(); if (d && d.error) msg = d.error; } catch { /* 非 JSON */ }
      throw new Error(msg);
    }
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${exportTable.value}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000); // L6：立即 revoke 会让部分浏览器截断下载
    exportTable.value = '';
  } catch (e) {
    error.value = e.message || '导出失败';
  } finally {
    exporting.value = false;
  }
}

// L13（复审）：轻查询，切回也刷新（否则长会话里快照流停在进入时刻）
usePageLoad(loadSnaps);
</script>

<style scoped>
.chart { display: grid; gap: 6px; margin-top: 10px; }
.srow { display: grid; grid-template-columns: 140px 1fr 60px; gap: 8px; align-items: center; font-size: var(--fs-12); }
.srow .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.srow svg { width: 100%; height: 40px; }
.srow polyline { fill: none; stroke-width: 1.6; }
</style>
