<template>
  <div class="history-wrap">
    <!-- 选择区 + 范围 -->
    <div class="card">
      <div class="hist-head">
        <select v-model="areaName" class="hist-select" :disabled="loading" @change="load">
          <option v-if="!areaOptions.length" value="">（暂无区域数据）</option>
          <option v-for="a in areaOptions" :key="a" :value="a">{{ a }}</option>
        </select>
        <div class="hist-range">
          <button
            v-for="r in RANGES" :key="r" type="button"
            class="hist-range-btn" :class="{ on: range === r }"
            @click="pickRange(r)"
          >
            {{ r }} 次
          </button>
        </div>
      </div>
      <div v-if="rows.length" class="hist-sub muted">
        共 {{ rows.length }} 条采样 · {{ rows[0].t }} → {{ rows[rows.length - 1].t }}
      </div>
    </div>

    <!-- 加载 / 错误 / 空态 -->
    <div v-if="loading" class="card hist-state" aria-busy="true">
      <div class="hist-skel" />
      <div class="muted">正在读取历史数据…</div>
    </div>
    <div v-else-if="err" class="card hist-state" role="alert">
      <div class="muted">历史数据加载失败</div>
      <button type="button" class="state-btn" @click="load">重试</button>
    </div>
    <div v-else-if="!rows.length" class="card hist-state">
      <div class="muted">这个区域还没有历史采样</div>
      <div class="muted hist-hint">数据靠每次抓取上传积累，抓几次就会有了</div>
    </div>

    <template v-else>
      <!-- 空闲率曲线 -->
      <div class="card">
        <div class="card-title">空闲率变化</div>
        <TrendChart :rows="trendRows" :theme="theme" aria-label="该区域空闲率随时间变化" />
      </div>

      <!-- 作息规律：按小时聚合 -->
      <div class="card">
        <div class="card-title">作息规律</div>
        <div class="hist-sub muted">按小时平均空闲数——看出这个区什么时候最容易有空位</div>
        <div class="hour-bars" role="img" :aria-label="hourAria">
          <div v-for="h in byHour" :key="h.hour" class="hour-col">
            <div class="hour-bar-wrap">
              <div
                class="hour-bar"
                :class="barTone(h)"
                :style="{ height: barPct(h) + '%' }"
                :title="hourLabel(h)"
              />
            </div>
            <div class="hour-tick" :class="{ major: h.hour % 6 === 0 }">
              {{ h.hour % 6 === 0 ? h.hour : '' }}
            </div>
          </div>
        </div>
      </div>

      <!-- 采样明细 -->
      <div class="card">
        <div class="card-title">采样明细</div>
        <div class="hist-table-wrap">
          <table class="hist-table">
            <thead>
              <tr>
                <th>时间</th><th>空闲</th><th>充电中</th><th>故障</th><th>总数</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(r, i) in recentRows" :key="i">
                <td class="mono">{{ (r.t || '').slice(5) }}</td>
                <td class="mono hist-idle">{{ r.idle }}</td>
                <td class="mono">{{ r.charging }}</td>
                <td class="mono">{{ r.fault }}</td>
                <td class="mono">{{ r.total }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-if="rows.length > RECENT_LIMIT" class="hist-sub muted">
          只显示最近 {{ RECENT_LIMIT }} 条，曲线用的是全部 {{ rows.length }} 条
        </div>
      </div>
    </template>
  </div>
</template>

<script setup>
/**
 * 历史数据页：单区历史曲线 + 作息规律（按小时聚合）+ 采样明细。
 *
 * 数据来源：/api/history?area=&limit=（App 走 AndroidHost.getHistory 桥）。
 * 该接口只往回传原始采样 [{idle,total,charging,fault,t}]，「作息规律」和曲线
 * 都在前端算，服务端不做二次聚合。
 *
 * 不变量：
 *  1. 只有 active 时才首次加载，切走不重复请求；
 *  2. 区域列表变化（例如刚抓完新数据）不自动重载，避免打断正在看的内容；
 *  3. 空态给出「抓几次就会有」的引导，而不是空白。
 */
import { computed, ref, watch } from 'vue';
import TrendChart from '../components/TrendChart.vue';
import { getHistory } from '../api/index.js';

const props = defineProps({
  active: { type: Boolean, default: false },
  theme: { type: String, default: 'light' },
  // 区域名数组（来自 live.areas 的 name）
  areas: { type: Array, default: () => [] },
});

const RANGES = [30, 100, 300];
const RECENT_LIMIT = 40;

const areaName = ref('');
const range = ref(100);
const loading = ref(false);
const err = ref(false);
const rows = ref([]);
let loadedOnce = false;
let seq = 0;

const areaOptions = computed(() => {
  const out = [];
  for (const a of props.areas) {
    const n = a && a.name ? String(a.name) : '';
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
});

// 优先切到「当前空闲最多」的区域，用户最可能想看这个
function preferredArea() {
  const opts = areaOptions.value;
  if (!opts.length) return '';
  let best = opts[0];
  let bestIdle = -1;
  for (const a of props.areas) {
    const n = a && a.name ? String(a.name) : '';
    if (!n) continue;
    const idle = Number(a.idle_port) || 0;
    if (idle > bestIdle) { bestIdle = idle; best = n; }
  }
  return best;
}

async function load() {
  if (!areaName.value) return;
  const my = ++seq;
  loading.value = true;
  err.value = false;
  try {
    const r = await getHistory(areaName.value, range.value);
    if (my !== seq) return; // 期间又切了区域
    rows.value = Array.isArray(r) ? r : [];
    loadedOnce = true;
  } catch {
    if (my !== seq) return;
    err.value = true;
    rows.value = [];
  } finally {
    if (my === seq) loading.value = false;
  }
}

function pickRange(r) {
  if (range.value === r) return;
  range.value = r;
  load();
}

// 首次进入页签：自动挑一个区域并加载
watch(() => props.active, (on) => {
  if (!on) return;
  if (!areaName.value) areaName.value = preferredArea();
  if (areaName.value && !loadedOnce) load();
}, { immediate: true });

// 区域从无到有（首次数据到达）时补一次
watch(areaOptions, (opts) => {
  if (!areaName.value && opts.length) {
    areaName.value = preferredArea();
    if (props.active && !loadedOnce) load();
  }
});

/* ---- 曲线 ---- */
const trendRows = computed(() => rows.value.map((r) => {
  const t = String(r.t || '');
  const total = Number(r.total) || 0;
  const idle = Number(r.idle) || 0;
  return {
    t: t.length >= 16 ? t.slice(11, 16) : t,
    ratio: total > 0 ? idle / total : null,
  };
}));

/* ---- 按小时聚合 ---- */
const byHour = computed(() => {
  const acc = Array.from({ length: 24 }, () => ({ idle: 0, total: 0, n: 0 }));
  for (const r of rows.value) {
    const t = String(r.t || '');
    const h = Number(t.slice(11, 13));
    if (!Number.isInteger(h) || h < 0 || h > 23) continue;
    acc[h].idle += Number(r.idle) || 0;
    acc[h].total += Number(r.total) || 0;
    acc[h].n += 1;
  }
  return acc.map((a, hour) => ({
    hour,
    n: a.n,
    avgIdle: a.n ? a.idle / a.n : 0,
    avgTotal: a.n ? a.total / a.n : 0,
  }));
});

const maxAvgIdle = computed(() => {
  let m = 0;
  for (const h of byHour.value) if (h.avgIdle > m) m = h.avgIdle;
  return m;
});

function barPct(h) {
  if (!h.n || maxAvgIdle.value <= 0) return 0;
  return Math.max(3, Math.round((h.avgIdle / maxAvgIdle.value) * 100));
}

function barTone(h) {
  if (!h.n) return 'empty';
  const ratio = h.avgTotal > 0 ? h.avgIdle / h.avgTotal : 0;
  if (ratio >= 0.5) return 'good';
  if (ratio >= 0.2) return 'mid';
  return 'low';
}

function hourLabel(h) {
  if (!h.n) return `${String(h.hour).padStart(2, '0')}:00 无采样`;
  return `${String(h.hour).padStart(2, '0')}:00 平均 ${h.avgIdle.toFixed(1)} 空闲 / ${h.avgTotal.toFixed(0)} 总（${h.n} 次采样）`;
}

const hourAria = computed(() => {
  const peak = byHour.value.reduce((a, b) => (b.avgIdle > a.avgIdle ? b : a), byHour.value[0]);
  return peak && peak.n
    ? `按小时平均空闲数，最高在 ${peak.hour} 点，平均 ${peak.avgIdle.toFixed(1)} 个`
    : '按小时平均空闲数';
});

const recentRows = computed(() => rows.value.slice(-RECENT_LIMIT).reverse());
</script>

<style scoped>
.history-wrap { display: flex; flex-direction: column; gap: 12px; padding: 12px; }

.hist-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.hist-select {
  flex: 1 1 160px; min-width: 0;
  padding: 8px 10px; border-radius: 10px;
  border: 1px solid var(--border, #e2e8f0);
  background: var(--surface, #fff); color: var(--text, #0f172a);
  font-size: 14px;
}
.hist-range { display: flex; gap: 6px; }
.hist-range-btn {
  padding: 6px 10px; border-radius: 8px; font-size: 12px;
  border: 1px solid var(--border, #e2e8f0);
  background: transparent; color: var(--muted, #64748b); cursor: pointer;
}
.hist-range-btn.on {
  background: var(--primary, #2563eb); border-color: var(--primary, #2563eb); color: #fff;
}
.hist-sub { font-size: 12px; margin-top: 6px; }
.hist-hint { margin-top: 4px; font-size: 12px; opacity: .8; }

.hist-state { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 28px 16px; }
.hist-skel {
  width: 28px; height: 28px; border-radius: 50%;
  border: 2px solid var(--border, #e2e8f0); border-top-color: var(--primary, #2563eb);
  animation: hist-spin .8s linear infinite;
}
@keyframes hist-spin { to { transform: rotate(360deg); } }

.hour-bars { display: flex; gap: 2px; align-items: flex-end; height: 96px; margin-top: 10px; }
.hour-col { flex: 1; display: flex; flex-direction: column; align-items: center; min-width: 0; }
.hour-bar-wrap { flex: 1; width: 100%; display: flex; align-items: flex-end; }
.hour-bar {
  width: 100%; border-radius: 3px 3px 0 0; min-height: 2px;
  transition: height .25s ease;
}
.hour-bar.good { background: var(--success, #16a34a); }
.hour-bar.mid { background: var(--warning, #f59e0b); }
.hour-bar.low { background: var(--danger, #dc2626); opacity: .65; }
.hour-bar.empty { background: var(--border, #e2e8f0); }
.hour-tick { font-size: 9px; height: 14px; color: var(--muted, #64748b); }
.hour-tick.major { font-weight: 600; }

.hist-table-wrap { overflow-x: auto; margin-top: 8px; }
.hist-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.hist-table th, .hist-table td {
  padding: 6px 8px; text-align: right; white-space: nowrap;
  border-bottom: 1px solid var(--line, #eef2f7);
}
.hist-table th:first-child, .hist-table td:first-child { text-align: left; }
.hist-table th { color: var(--muted, #64748b); font-weight: 500; }
.hist-idle { color: var(--success, #16a34a); font-weight: 600; }
.mono { font-variant-numeric: tabular-nums; }
</style>
