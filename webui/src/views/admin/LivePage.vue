<template>
  <div class="live-page">
    <div class="toolbar">
      <input v-model.trim="q" class="search" placeholder="搜索区域" @input="load" />
      <label class="chk"><input v-model="onlyFree" type="checkbox" @change="load" /> 只看有空位</label>
      <select v-model="sort" class="sel" @change="load">
        <option value="idle">按空位数</option>
        <option value="rate">按空位率</option>
      </select>
      <span class="spacer" />
      <small class="muted">{{ snapText }}</small>
    </div>

    <section class="panel">
      <table class="tbl">
        <thead>
          <tr>
            <th>区域</th>
            <th class="num">总数</th>
            <th class="num">空</th>
            <th class="num">充</th>
            <th class="num">故障</th>
            <th>空位率</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="a in areas" :key="a.name" @click="openArea(a.name)">
            <td>{{ a.name }}</td>
            <td class="num">{{ a.total }}</td>
            <td class="num">{{ a.idle }}</td>
            <td class="num">{{ a.charging }}</td>
            <td class="num" :class="{ bad: a.fault > 0 }">{{ a.fault }}</td>
            <td class="rate">
              <span class="bar-wrap"><span class="bar-fill" :style="{ width: pct(a), background: tone(a) }" /></span>
              <span class="num">{{ pct(a) }}</span>
            </td>
          </tr>
          <tr v-if="!areas.length">
            <td colspan="6" class="muted empty">没有数据（可能今天还没有快照）</td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- 端口抽屉 -->
    <div v-if="drawer" class="drawer-mask" @click.self="drawer = ''">
      <aside class="drawer">
        <header>
          <h2>{{ drawer }}</h2>
          <button class="btn ghost sm" @click="drawer = ''">关闭</button>
        </header>
        <p class="muted small">{{ drawerPorts.length }} 个端口</p>
        <div class="grid">
          <span
v-for="p in drawerPorts" :key="p.device_hex + ':' + p.port" class="port"
                :class="'g-' + (p.status_group || 'unknown')"
                :title="`${p.device_hex} · ${p.port} · ${p.status || '未知'} · ${p.updated_at || ''}`" />
        </div>
        <p class="legend">
          <span class="port g-free" /> 空闲
          <span class="port g-busy" /> 充电
          <span class="port g-unavailable" /> 故障
          <span class="port g-unknown" /> 未知
        </p>
      </aside>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { apiGet } from '../../api/adminApi.js';

const q = ref('');
const onlyFree = ref(false);
const sort = ref('idle');
const areas = ref([]);
const snapshot = ref(null);
const drawer = ref('');
const drawerPorts = ref([]);

const snapText = computed(() => (snapshot.value
  ? `数据来自 ${snapshot.value.received_at}`
  : '暂无快照'));

function pct(a) {
  return a.total > 0 ? `${Math.round((a.idle / a.total) * 100)}%` : '0%';
}
function tone(a) {
  const r = a.total > 0 ? a.idle / a.total : 0;
  if (r >= 0.3) return 'var(--ok, #16a34a)';
  if (r > 0) return 'var(--warn-fg, #b26a00)';
  return 'var(--danger, #dc2626)';
}

async function load() {
  const params = new URLSearchParams();
  if (q.value) params.set('q', q.value);
  if (onlyFree.value) params.set('only_free', '1');
  params.set('sort', sort.value);
  try {
    const d = await apiGet(`/admin/api/live?${params.toString()}`);
    areas.value = d.areas || [];
    snapshot.value = d.snapshot || null;
  } catch {
    areas.value = [];
  }
}

async function openArea(name) {
  drawer.value = name;
  drawerPorts.value = [];
  try {
    const d = await apiGet(`/admin/api/live/area?name=${encodeURIComponent(name)}`);
    drawerPorts.value = d.ports || [];
  } catch {
    /* 抽屉里显示空 */
  }
}

onMounted(load);
</script>

<style scoped>
.live-page {
  display: grid;
  gap: var(--sp-3);
  /* S1：legacy admin.css 的 .live 会把 color 设成 #a7f3d0（白底对比度 1.1:1）；
     根类改名后这里再显式兜一次 color/字号 */
  color: var(--text);
  font-size: var(--fs-13, 13px);
}
.toolbar { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; }
.search, .sel {
  height: var(--ctl-36, 36px);
  padding: 0 10px;
  border: 1px solid var(--border, #d8dee9);
  border-radius: var(--r-sm);
  font-size: var(--fs-14);
  background: var(--card);
  color: var(--text);
}
.chk { font-size: var(--fs-12); color: var(--text-3); display: flex; align-items: center; gap: 4px; }
.spacer { flex: 1; }
.panel { background: var(--card); border-radius: var(--r-md); box-shadow: var(--shadow-card); overflow: auto; }
.tbl { width: 100%; border-collapse: collapse; font-size: var(--fs-13, 13px); }
.tbl th, .tbl td { padding: 8px 10px; text-align: left; border-bottom: 1px solid var(--border, #eef1f5); }
.tbl th { font-weight: var(--fw-medium); color: var(--muted); font-size: var(--fs-12); }
.tbl tbody tr { cursor: pointer; }
.tbl tbody tr:hover { background: var(--neutral-bg, #f8fafc); }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.num.bad { color: var(--danger, #dc2626); }
.rate { display: flex; align-items: center; gap: 6px; }
.bar-wrap { flex: 1; background: var(--neutral-bg, #f3f4f6); height: 6px; border-radius: 3px; overflow: hidden; min-width: 60px; }
.bar-fill { display: block; height: 6px; }
.empty { text-align: center; padding: 24px; }
.drawer-mask {
  position: fixed; inset: 0; background: rgba(0, 0, 0, 0.35);
  display: flex; justify-content: flex-end; z-index: 20;
}
.drawer {
  width: min(520px, 92vw); background: var(--card); padding: var(--sp-4);
  overflow: auto; display: grid; gap: var(--sp-3); align-content: start;
}
.drawer header { display: flex; align-items: center; justify-content: space-between; }
.drawer h2 { font-size: var(--fs-16); margin: 0; }
.small { font-size: var(--fs-12); }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(18px, 1fr)); gap: 3px; }
.port { width: 100%; aspect-ratio: 1; border-radius: 3px; display: inline-block; }
.g-free { background: #22c55e; }
.g-busy { background: #3b82f6; }
.g-unavailable { background: #9ca3af; }
.g-unknown { background: #4b5563; }
.legend { display: flex; align-items: center; gap: 6px; font-size: var(--fs-12); color: var(--muted); }
.legend .port { width: 12px; height: 12px; aspect-ratio: auto; }
.muted { color: var(--muted); }
</style>
