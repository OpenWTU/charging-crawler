<template>
  <div class="overview">
    <!-- 指标卡 -->
    <section class="cards">
      <article class="card" @click="$emit('go', 'tokens')">
        <div class="label">今日快照</div>
        <div class="value">{{ fmt(data?.cards?.snapshots_today) }}</div>
        <div class="sub" :class="deltaTone">{{ deltaText }}</div>
      </article>
      <article class="card" @click="$emit('go', 'live')">
        <div class="label">在线设备</div>
        <div class="value">{{ fmt(data?.cards?.devices_online) }} <small>/ {{ fmt(data?.cards?.devices_total) }}</small></div>
        <div class="sub">24h 内有上传</div>
      </article>
      <article class="card" @click="$emit('go', 'tokens')">
        <div class="label">有效令牌</div>
        <div class="value" :class="tokenTone">
          {{ fmt(data?.cards?.tokens_valid) }} <small>/ {{ fmt(data?.cards?.tokens_total) }}</small>
        </div>
        <div class="sub">{{ tokenSub }}</div>
      </article>
      <article class="card">
        <div class="label">在线节点</div>
        <div class="value">{{ fmt(data?.cards?.nodes_online) }}</div>
        <div class="sub">白名单 {{ fmt(data?.cards?.nodes_whitelist) }}</div>
      </article>
      <article class="card">
        <div class="label">数据新鲜度</div>
        <div class="value small">{{ freshText }}</div>
        <div class="sub">{{ data?.data?.last_upload_at || '—' }}</div>
      </article>
    </section>

    <div class="row">
      <!-- 趋势 -->
      <section class="panel">
        <div class="panel-head">
          <h2>近 24 小时</h2>
          <small class="muted">快照量（柱）· 平均空闲率（线）</small>
        </div>
        <div v-if="points.length" class="chart">
          <svg :viewBox="`0 0 ${W} ${H}`" preserveAspectRatio="none">
            <!-- 柱：快照量 -->
            <rect
v-for="(p, i) in points" :key="'b' + i" :x="barX(i)" :y="barY(p.snapshots)"
                  :width="barW" :height="H - barY(p.snapshots)" class="bar" />
            <!-- 线：空闲率 -->
            <polyline :points="linePoints" class="line" />
          </svg>
          <div class="axis">
            <span>{{ points[0]?.t?.slice(11) || '' }}</span>
            <span>{{ points[points.length - 1]?.t?.slice(11) || '' }}</span>
          </div>
        </div>
        <p v-else class="muted empty">还没有足够的快照</p>
      </section>

      <!-- 告警 -->
      <section class="panel">
        <div class="panel-head">
          <h2>告警（{{ (data?.alerts || []).length }}）</h2>
        </div>
        <ul v-if="(data?.alerts || []).length" class="alerts">
          <li v-for="a in data.alerts" :key="a.code" :class="'lv-' + a.level" @click="a.jump && $emit('go', a.jump)">
            <span class="dot" />{{ a.text }}
          </li>
        </ul>
        <p v-else class="muted empty">系统正常</p>
      </section>
    </div>

    <div class="row">
      <!-- 排行 -->
      <section class="panel">
        <div class="panel-head"><h2>空位排行</h2></div>
        <div class="rank">
          <div>
            <h3 class="muted">最空</h3>
            <div v-for="r in ranking.emptiest" :key="'e' + r.area_name" class="rank-row">
              <span class="nm">{{ r.area_name }}</span>
              <span class="bar-wrap"><span class="bar-fill ok" :style="{ width: pct(r) }" /></span>
              <span class="num">{{ pctText(r) }}</span>
            </div>
            <p v-if="!ranking.emptiest.length" class="muted empty">暂无</p>
          </div>
          <div>
            <h3 class="muted">最满</h3>
            <div v-for="r in ranking.fullest" :key="'f' + r.area_name" class="rank-row">
              <span class="nm">{{ r.area_name }}</span>
              <span class="bar-wrap"><span class="bar-fill bad" :style="{ width: pct(r) }" /></span>
              <span class="num">{{ pctText(r) }}</span>
            </div>
            <p v-if="!ranking.fullest.length" class="muted empty">暂无</p>
          </div>
        </div>
      </section>

      <!-- 事件流 -->
      <section class="panel">
        <div class="panel-head"><h2>实时事件</h2></div>
        <ul v-if="events.length" class="events">
          <li v-for="e in events" :key="e.id">
            <span class="t">{{ e.ts?.slice(11, 19) }}</span>
            <span class="tag" :class="e.source === 'app' ? 'is-app' : 'is-worker'">
              {{ e.source === 'app' ? 'App' : 'Worker' }}
            </span>
            <span class="muted">{{ e.areas }} 区</span>
          </li>
        </ul>
        <p v-else class="muted empty">暂无</p>
      </section>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { apiGet } from '../../api/adminApi.js';

const props = defineProps({ data: { type: Object, default: null }, loading: Boolean });
defineEmits(['go', 'refresh']);

const trend = ref({ points: [] });
const ranking = ref({ emptiest: [], fullest: [] });
const events = ref([]);

const W = 300;
const H = 80;

const points = computed(() => trend.value.points || []);
const maxSnap = computed(() => Math.max(1, ...points.value.map((p) => p.snapshots || 0)));
const barW = computed(() => (points.value.length ? Math.max(1, (W / points.value.length) * 0.6) : 0));
function barX(i) {
  const step = points.value.length ? W / points.value.length : W;
  return i * step + (step - barW.value) / 2;
}
function barY(v) {
  return H - (Number(v) / maxSnap.value) * H * 0.9;
}
const linePoints = computed(() => {
  const pts = points.value.filter((p) => p.idle_rate !== null && p.idle_rate !== undefined);
  if (pts.length < 2) return '';
  return pts
    .map((p, i) => {
      const idx = points.value.indexOf(p);
      const step = W / points.value.length;
      const x = idx * step + step / 2;
      const y = H - Number(p.idle_rate) * H * 0.9 - 2;
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
});

function fmt(v) {
  if (v === null || v === undefined) return '—';
  return Number(v).toLocaleString('zh-CN');
}
const deltaText = computed(() => {
  const d = props.data?.cards?.snapshots_delta_pct;
  if (d === null || d === undefined) return '昨日无对比数据';
  return d >= 0 ? `↑ ${d}% 较昨日` : `↓ ${Math.abs(d)}% 较昨日`;
});
const deltaTone = computed(() => {
  const d = props.data?.cards?.snapshots_delta_pct;
  if (d === null || d === undefined) return 'muted';
  return d >= 0 ? 'up' : 'down';
});
const tokenTone = computed(() => {
  const valid = props.data?.cards?.tokens_valid;
  const total = props.data?.cards?.tokens_total;
  if (!total) return '';
  return valid === 0 ? 'bad' : '';
});
const tokenSub = computed(() => {
  const sec = props.data?.cards?.tokens_next_exp_sec;
  if (sec === null || sec === undefined) return '无有效期数据';
  const m = Math.floor(sec / 60);
  if (m < 60) return `最快 ${m} 分钟后过期`;
  return `最快 ${Math.floor(m / 60)} 小时后过期`;
});
const freshText = computed(() => {
  const sec = props.data?.cards?.freshness_sec;
  if (sec === null || sec === undefined) return '暂无数据';
  if (sec < 3600) return `${Math.floor(sec / 60) || 0} 分钟前`;
  return `${Math.floor(sec / 3600)} 小时前`;
});

function pct(r) {
  const total = Number(r.total) || 0;
  const idle = Number(r.idle) || 0;
  return total > 0 ? `${Math.round((idle / total) * 100)}%` : '0%';
}
function pctText(r) {
  const total = Number(r.total) || 0;
  const idle = Number(r.idle) || 0;
  return total > 0 ? `${Math.round((idle / total) * 100)}% (${idle}/${total})` : '—';
}

async function loadExtras() {
  const [t, r, e] = await Promise.allSettled([
    apiGet('/admin/api/overview/trend?range=24h'),
    apiGet('/admin/api/overview/ranking?limit=5'),
    apiGet('/admin/api/overview/events?limit=8'),
  ]);
  if (t.status === 'fulfilled') trend.value = t.value;
  if (r.status === 'fulfilled') ranking.value = r.value;
  if (e.status === 'fulfilled') events.value = e.value.items || [];
}

onMounted(loadExtras);
// 概览数据刷新时不重复拉图表（30s 一次足够）
watch(() => props.data, (v, old) => { if (v && !old) void loadExtras(); });
</script>

<style scoped>
.overview { display: grid; gap: var(--sp-3); }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: var(--sp-3); }
.card {
  background: var(--card);
  border-radius: var(--r-md);
  padding: var(--sp-3);
  box-shadow: var(--shadow-card);
  cursor: pointer;
}
.card:hover { filter: brightness(0.99); }
.label { font-size: var(--fs-12); color: var(--muted); }
.value { font-size: 24px; font-weight: var(--fw-semibold); margin-top: 4px; }
.value.small { font-size: var(--fs-16); }
.value small { font-size: var(--fs-12); color: var(--muted); font-weight: 400; }
.value.bad { color: var(--danger, #dc2626); }
.sub { font-size: var(--fs-12); color: var(--text-3); margin-top: 4px; }
.sub.up { color: var(--ok, #16a34a); }
.sub.down { color: var(--danger, #dc2626); }
.row { display: grid; grid-template-columns: 1.4fr 1fr; gap: var(--sp-3); }
@media (max-width: 900px) { .row { grid-template-columns: 1fr; } }
.panel { background: var(--card); border-radius: var(--r-md); padding: var(--sp-3); box-shadow: var(--shadow-card); }
.panel-head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: var(--sp-2); }
.panel-head h2 { font-size: var(--fs-14); margin: 0; }
.chart svg { width: 100%; height: 90px; display: block; }
.bar { fill: var(--brand-glass, #d1fae5); }
.line { fill: none; stroke: var(--primary); stroke-width: 1.6; }
.axis { display: flex; justify-content: space-between; font-size: 11px; color: var(--muted); }
.alerts { list-style: none; padding: 0; margin: 0; display: grid; gap: 6px; }
.alerts li { display: flex; align-items: center; gap: 6px; font-size: var(--fs-12); cursor: pointer; }
.dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.alerts .lv-red .dot { background: var(--danger, #dc2626); }
.alerts .lv-yellow .dot { background: var(--warn-fg, #b26a00); }
.alerts .lv-blue .dot { background: #2563eb; }
.alerts li.lv-red { color: var(--danger, #dc2626); }
.alerts li.lv-yellow { color: var(--warn-fg, #b26a00); }
.rank { display: grid; grid-template-columns: 1fr 1fr; gap: var(--sp-3); }
.rank h3 { font-size: var(--fs-12); margin: 0 0 6px; }
.rank-row { display: grid; grid-template-columns: 1fr 60px auto; gap: 6px; align-items: center; font-size: var(--fs-12); }
.nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bar-wrap { background: var(--neutral-bg, #f3f4f6); height: 6px; border-radius: 3px; overflow: hidden; }
.bar-fill { display: block; height: 6px; }
.bar-fill.ok { background: var(--ok, #16a34a); }
.bar-fill.bad { background: var(--danger, #dc2626); }
.num { color: var(--muted); font-variant-numeric: tabular-nums; }
.events { list-style: none; padding: 0; margin: 0; display: grid; gap: 6px; font-size: var(--fs-12); }
.events li { display: flex; align-items: center; gap: 6px; }
.events .t { font-variant-numeric: tabular-nums; color: var(--muted); }
.tag { font-size: 10px; padding: 1px 6px; border-radius: 999px; }
.tag.is-app { background: #ecfdf5; color: #047857; }
.tag.is-worker { background: #eff6ff; color: #2563eb; }
.empty { font-size: var(--fs-12); margin: 6px 0; }
.muted { color: var(--muted); }
</style>
