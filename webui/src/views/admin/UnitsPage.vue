<template>
  <div class="units">
    <aside class="list a-panel">
      <div class="a-head">
        <h2>区域（{{ areas.length }}）</h2>
        <button class="a-btn sm" @click="loadAreas">刷新</button>
      </div>
      <input v-model.trim="q" class="a-input q" placeholder="搜索区域" @input="loadAreas" />
      <ul>
        <li
v-for="a in areas" :key="a.area_id" :class="{ active: currentId === a.area_id }"
            @click="openArea(a.area_id)">
          <span class="nm">{{ a.name }}</span>
          <span class="a-small a-muted">{{ a.controllers }} 桩</span>
        </li>
        <li v-if="!areas.length" class="a-empty">暂无区域</li>
      </ul>
      <div class="a-pad">
        <button class="a-btn sm" @click="checkDup">重复区域检测</button>
      </div>
    </aside>

    <main class="a-grid">
      <p v-if="error" class="a-err">{{ error }}</p>
      <section v-if="current" class="a-panel a-pad">
        <div class="a-toolbar">
          <h2>{{ current.name }}</h2>
          <span class="a-spacer" />
          <button v-if="canWrite" class="a-btn sm" @click="editCoords">改坐标</button>
          <button v-if="canWrite" class="a-btn sm danger" @click="deleteArea">删除区域</button>
        </div>
        <dl class="a-kv" style="margin-top:12px">
          <div><dt>坐标</dt><dd>{{ current.lat ?? '—' }}, {{ current.lng ?? '—' }}</dd></div>
          <div><dt>桩数</dt><dd>{{ devices.length }}</dd></div>
          <div><dt>端口数</dt><dd>{{ ports.length }}</dd></div>
          <div><dt>最近出现</dt><dd>{{ current.last_seen || '—' }}</dd></div>
        </dl>
        <div class="grid">
          <span
v-for="p in ports" :key="p.device_hex + ':' + p.port" class="port"
                :class="'g-' + (p.status_group || 'unknown')"
                :title="`${p.device_hex} · ${p.port} · ${p.status || '未知'}`" />
        </div>
        <p class="legend a-small a-muted">
          <span class="port g-free" /> 空闲
          <span class="port g-busy" /> 充电
          <span class="port g-unavailable" /> 故障
          <span class="port g-unknown" /> 未知
        </p>
        <table class="a-tbl" style="margin-top:12px">
          <thead><tr><th>桩号</th><th>码牌</th><th>更新</th><th>操作</th></tr></thead>
          <tbody>
            <tr v-for="d in devices" :key="d.device_hex">
              <td class="a-mono">{{ d.device_hex }}</td>
              <td class="a-mono">{{ d.qr_device_no || d.code || '—' }}</td>
              <td class="a-small">{{ d.updated_at || '—' }}</td>
              <td><button v-if="canWrite" class="a-btn sm" @click="syncDevice(d.device_hex)">同步端口</button></td>
            </tr>
            <tr v-if="!devices.length"><td colspan="4" class="a-empty">该区域暂无桩</td></tr>
          </tbody>
        </table>
      </section>
      <section v-else class="a-panel a-empty">从左侧选一个区域</section>

      <section v-if="dups.length" class="a-panel a-pad">
        <h2 class="a-small">疑似重复区域</h2>
        <table class="a-tbl">
          <thead><tr><th>区域 A</th><th>区域 B</th><th class="num">名称相似</th><th class="num">距离</th><th>操作</th></tr></thead>
          <tbody>
            <tr v-for="(p, i) in dups" :key="i">
              <td>{{ p.a.name }}</td>
              <td>{{ p.b.name }}</td>
              <td class="num">{{ Math.round(p.similarity * 100) }}%</td>
              <td class="num">{{ p.distance_m === null ? '—' : Math.round(p.distance_m) + ' m' }}</td>
              <td><button v-if="canWrite" class="a-btn sm" @click="merge(p.a, p.b)">合并（B 并入 A）</button></td>
            </tr>
          </tbody>
        </table>
      </section>
    </main>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue';
import { useRole } from './useRole.js';
import { apiDelete, apiGet, apiPost } from '../../api/adminApi.js';

const areas = ref([]);
const currentId = ref('');
const current = ref(null);
const devices = ref([]);
const ports = ref([]);
const dups = ref([]);
const q = ref('');
const error = ref('');
const { canWrite } = useRole();

async function loadAreas() {
  try {
    const d = await apiGet(`/admin/api/units/areas${q.value ? `?q=${encodeURIComponent(q.value)}` : ''}`);
    areas.value = d.areas || [];
  } catch (e) {
    error.value = e.message || '区域加载失败';
  }
}

async function openArea(id) {
  currentId.value = id;
  error.value = '';
  try {
    const d = await apiGet(`/admin/api/units/area/${encodeURIComponent(id)}`);
    current.value = d.area;
    devices.value = d.devices || [];
    ports.value = d.ports || [];
  } catch (e) {
    error.value = e.message || '区域详情加载失败';
  }
}

async function syncDevice(hex) {
  try {
    const d = await apiPost('/admin/api/units/device/sync', { device_hex: hex });
    window.alert(d.ok ? `同步成功：${d.result}` : `同步失败：${d.result || '未知'}`);
    if (currentId.value) await openArea(currentId.value);
  } catch (e) {
    error.value = e.message || '同步失败';
  }
}

async function editCoords() {
  const latRaw = window.prompt('纬度（-90 ~ 90）', String(current.value?.lat ?? ''));
  if (latRaw === null) return;
  const lngRaw = window.prompt('经度（-180 ~ 180）', String(current.value?.lng ?? ''));
  if (lngRaw === null) return;
  // M18：Number('')=0、Number('abc')=NaN —— 原来空输入会被静默写成 (0,0)
  const lat = Number(latRaw.trim());
  const lng = Number(lngRaw.trim());
  if (!latRaw.trim() || !lngRaw.trim() || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    error.value = '经纬度必须是数字';
    return;
  }
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    error.value = '纬度需在 ±90、经度需在 ±180 内';
    return;
  }
  try {
    await apiPost('/admin/api/units/area', {
      area_id: currentId.value,
      lat,
      lng,
    });
    await openArea(currentId.value);
  } catch (e) {
    error.value = e.message || '保存失败';
  }
}

async function deleteArea() {
  const name = current.value?.name || '';
  if (!window.confirm(`确定删除区域「${name}」？（软删除，历史采样保留）`)) return;
  try {
    await apiDelete(`/admin/api/units/area/${encodeURIComponent(currentId.value)}`);
    current.value = null;
    currentId.value = '';
    await loadAreas();
  } catch (e) {
    error.value = e.message || '删除失败';
  }
}

async function checkDup() {
  try {
    const d = await apiGet('/admin/api/units/duplicates');
    dups.value = d.pairs || [];
    if (!dups.value.length) window.alert('没发现疑似重复的区域');
  } catch (e) {
    error.value = e.message || '检测失败';
  }
}

async function merge(a, b) {
  if (!window.confirm(`把「${b.name}」并入「${a.name}」？`)) return;
  try {
    const d = await apiPost('/admin/api/units/area/merge', { from: b.area_id, to: a.area_id });
    window.alert(`已合并，迁移 ${d.moved_samples} 条采样`);
    dups.value = [];
    await loadAreas();
  } catch (e) {
    error.value = e.message || '合并失败';
  }
}

onMounted(loadAreas);
</script>

<style scoped>
.units { display: grid; grid-template-columns: 240px 1fr; gap: var(--sp-3); }
@media (max-width: 900px) { .units { grid-template-columns: 1fr; } }
.list { display: grid; align-content: start; gap: 0; }
.list .q { margin: 0 var(--sp-3) var(--sp-2); }
.list ul { list-style: none; margin: 0; padding: 0; max-height: 60vh; overflow: auto; }
.list li {
  display: flex; justify-content: space-between; gap: 8px;
  padding: 8px var(--sp-3); cursor: pointer; font-size: var(--fs-13, 13px);
  border-left: 2px solid transparent;
}
.list li:hover { background: var(--neutral-bg, #f8fafc); }
.list li.active { background: var(--brand-glass, #ecfdf5); border-left-color: var(--primary); color: var(--primary); }
.list .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(18px, 1fr)); gap: 3px; margin-top: 12px; }
.port { width: 100%; aspect-ratio: 1; border-radius: 3px; display: inline-block; }
.g-free { background: #22c55e; }
.g-busy { background: #3b82f6; }
.g-unavailable { background: #9ca3af; }
.g-unknown { background: #4b5563; }
.legend { display: flex; align-items: center; gap: 6px; margin: 8px 0 0; }
.legend .port { width: 12px; height: 12px; aspect-ratio: auto; }
</style>
