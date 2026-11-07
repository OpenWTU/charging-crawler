<template>
  <section>
    <h2 class="page-title">分析</h2>
    <!-- 空闲时段：独立请求 /api/free-rate，失败只影响本卡片，不拖累其余分析数据 -->
    <FreeRateCard :active="active" />

    <div v-if="loading" class="state-card" aria-busy="true">
      <van-icon name="underway-o" class="state-icon is-info" />
      <b>分析数据加载中…</b>
    </div>
    <div v-else-if="error" class="state-card is-error" role="alert">
      <van-icon name="warning-o" class="state-icon" />
      <b>分析数据加载失败</b>
      <span class="state-sub">可能是网络或服务暂不可用</span>
      <button type="button" class="state-btn" @click="load">重试</button>
    </div>
    <div v-else-if="!samples" class="state-card is-empty">
      <van-icon name="info-o" class="state-icon is-info" />
      <b>暂无分析数据</b>
      <span class="state-sub">数据会随采集逐步积累</span>
    </div>
    <template v-else>
      <div v-if="sparse" class="card muted">
        数据不足：已采集 {{ samples }} 条样本，热力图与趋势会随数据积累逐步完善
      </div>
      <div class="card">
        <div class="card-title">工作日 vs 周末</div>
        <div class="muted">工作日 {{ pct(ww.weekday) }} · 周末 {{ pct(ww.weekend) }}</div>
      </div>
      <div class="card">
        <div class="card-title">24 小时趋势</div>
        <div class="muted chart-sub">15 分钟粒度 · 最近 24 小时（空档平滑连接）</div>
        <TrendChart :rows="rows24" compact :theme="theme" :aria-label="chart24Aria" />
      </div>
      <div class="card">
        <div class="card-title">7 天趋势</div>
        <TrendChart :rows="rows7" :theme="theme" :aria-label="chart7Aria" />
      </div>
      <HeatmapChart :heatmap="heatmap" :theme="theme" />
      <div class="card">
        <div class="card-title">区域排行</div>
        <div v-for="r in ranking.slice(0, 10)" :key="r.name" class="rank">
          <span>{{ r.name }}</span><b>空闲 {{ Math.round(r.avg_idle_ratio * 100) }}%</b>
        </div>
      </div>
      <div class="card">
        <div class="card-title">未来 1 小时预测</div>
        <div v-for="f in forecast.slice(0, 10)" :key="f.name" class="rank">
          <span>{{ f.name }}</span><b>预计 {{ f.predicted_idle }} / {{ f.total }}</b>
        </div>
      </div>
    </template>
  </section>
</template>

<script setup>
/**
 * 分析页：空闲时段、工作日/周末、24h 与 7 天趋势、时段热力图、区域排行、未来预测。
 *
 * 不变量：
 *  - 只有切到分析页才请求 /api/analytics 与 /api/free-rate（首屏不拉图表库）；
 *  - 两张趋势图共用同一份清洗规则：t 非空、ratio 是有效数字（null/缺失丢弃，不补 0）并夹紧 0~1；
 *  - 24h 固定 96 个 15 分钟槽位（夜间置 null 形成断点），x 轴不随缺数据收缩。
 */
import { computed, ref, watch } from 'vue';
import FreeRateCard from '../components/FreeRateCard.vue';
import TrendChart from '../components/TrendChart.vue';
import HeatmapChart from '../components/HeatmapChart.vue';
import { getAnalytics } from '../api/index.js';

const props = defineProps({
  active: { type: Boolean, default: false },
  theme: { type: String, default: 'light' },
});

const analytics = ref({});
const loading = ref(false);
const error = ref(false);

const samples = computed(() => analytics.value.samples || 0);
const sparse = computed(() => samples.value < 200
  || ((analytics.value.trend_7d || []).length < 2));
const ww = computed(() => analytics.value.weekday_weekend || {});
const ranking = computed(() => analytics.value.ranking || []);
const forecast = computed(() => analytics.value.forecast || []);
const heatmap = computed(() => (Array.isArray(analytics.value.heatmap) ? analytics.value.heatmap : []));
const pct = (v) => (v == null ? '—' : Math.round(v * 100) + '%');

// 夜间时段判定：趋势图的 15 分钟点同样跳过这些小时（样本极少）
function isNightHour(h) {
  const n = Number(h);
  return Number.isFinite(n) && n >= 1 && n <= 5;
}

// 统一清洗趋势点：t 非空、ratio 是有效数字（null/缺失直接丢弃，不补 0），并夹紧到 0~1
const rows7 = computed(() => (Array.isArray(analytics.value.trend_7d) ? analytics.value.trend_7d : [])
  .map((r) => ({ t: String((r && r.t) || ''), raw: r ? r.ratio : null }))
  .filter((r) => r.t && r.raw !== null && r.raw !== undefined && r.raw !== ''
    && Number.isFinite(Number(r.raw)))
  .map((r) => ({ t: r.t, ratio: Math.max(0, Math.min(1, Number(r.raw))) })));

// 24h：严格按后端 24 小时前→现在的 96 个 15 分钟槽位顺序渲染；
// 不再用 00:00–23:45 重建（跨天会重复/错位），null 空桶与夜间保留为断点，
// 但折线用 connectNulls 平滑连接，视觉上不出现断线。
const rows24 = computed(() => {
  const src = Array.isArray(analytics.value.trend_24h) ? analytics.value.trend_24h : [];
  return src.slice(-96).map((r) => {
    const t = String((r && r.t) || '');
    const h = Number(t.slice(0, 2));
    const num = Number(r ? r.ratio : null);
    const ok = /^\d{2}:\d{2}$/.test(t) && !isNightHour(h) &&
      r && r.ratio !== null && r.ratio !== undefined && r.ratio !== '' &&
      Number.isFinite(num);
    return { t, ratio: ok ? Math.max(0, Math.min(1, num)) : null };
  });
});

// 图表对读屏的等价文本（Canvas 内容不可读，用 role=img + aria-label 提供摘要）
function chartAvgText(rows, label) {
  const vals = (Array.isArray(rows) ? rows : [])
    .map((r) => (r && r.ratio !== null && r.ratio !== undefined ? Number(r.ratio) : NaN))
    .filter((v) => Number.isFinite(v));
  if (!vals.length) return label + '折线图，暂无有效数据';
  const avg = Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100);
  return label + '折线图，平均空闲率 ' + avg + '%';
}
const chart24Aria = computed(() => chartAvgText(analytics.value.trend_24h,
  '24 小时空闲率趋势，15 分钟一个点，横轴标注 00、06、12、18 点，'));
const chart7Aria = computed(() => chartAvgText(analytics.value.trend_7d, '7 天空闲率趋势，'));

async function load() {
  if (loading.value) return;
  loading.value = true;
  error.value = false;
  try {
    const r = await getAnalytics();
    // null = 本次结果已被更新的请求取代，保留现有数据不要覆盖
    if (r) analytics.value = r;
  } catch (e) {
    error.value = true;
    console.warn('[analytics] load failed', e);
  } finally {
    loading.value = false;
  }
}

// 切到分析页才加载（每次进入都重新取，与旧行为一致）
watch(() => props.active, (v) => { if (v) load(); }, { immediate: true });
</script>
