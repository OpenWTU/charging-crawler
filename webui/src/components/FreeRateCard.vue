<template>
  <div class="card free-card">
    <div class="free-head">
      <div class="free-head-main">
        <div class="card-title">空闲时段</div>
        <div v-if="avg" class="free-sub muted">
          06:00–24:00 平均空闲率 {{ avg }} · 点柱子看样本数
        </div>
      </div>
      <span class="free-tag" :class="tagTone">{{ tag }}</span>
    </div>
    <div v-if="loading" class="free-skel" aria-busy="true"></div>
    <div v-else-if="error" class="free-fail" role="alert">
      <span>空闲时段加载失败</span>
      <button type="button" class="state-btn" @click="load">重试</button>
    </div>
    <div v-else-if="!total" class="muted free-empty">
      积累中：还没有样本，数据会随采集逐步积累
    </div>
    <template v-else>
      <div class="free-scroll">
        <div
class="free-bars" role="group"
             :style="{ '--free-cols': points.length }"
             aria-label="06:00–24:00 的平均空闲率，夜间 01:00–05:59 样本少，未展示">
          <button
v-for="p in points" :key="p.hour" type="button"
                  class="free-slot" :class="{ 'is-on': selectedHour === p.hour }"
                  :title="barTitle(p)" :aria-label="barTitle(p)"
                  @click="selectHour(p.hour)">
            <span class="free-track">
              <span
class="free-bar" :class="{ 'is-empty': p.rate === null }"
                    :style="{ height: barHeight(p) }"></span>
            </span>
            <span class="free-hour">{{ hourLabel(p.hour) }}</span>
          </button>
        </div>
      </div>
      <p class="scroll-hint muted" aria-hidden="true">左右滑动查看全部时段</p>
      <div class="free-detail">{{ detail }}</div>
      <div v-if="sparse" class="free-note muted">
        积累中：已采集 {{ total }} 条样本，满 30 条后曲线更稳定
      </div>
      <div v-else class="free-note muted">
        近 {{ days }} 天 · 共 {{ total }} 条样本 · 夜间 01:00–05:59 样本少，未展示
      </div>
    </template>
  </div>
</template>

<script setup>
/**
 * 「空闲时段」卡片：独立请求 /api/free-rate，失败只影响本卡片，不拖累其余分析数据。
 *
 * 口径（与后端一致）：
 *  - 只画 00:00 与 06:00–23:00；夜间 01:00–05:59 样本极少，不画也不计入平均；
 *  - free_rate 兼容 0~1 与 0~100；null/空串表示该小时无样本，不能当成 0%；
 *  - 平均空闲率按样本数加权，只统计展示出来的时段。
 */
import { computed, ref, watch } from 'vue';
import { getFreeRate } from '../api/index.js';
import { hourLabel as hourTick } from '../format.js';

const props = defineProps({
  // 页面是否处于前台（切到分析页时才加载，与旧行为一致）
  active: { type: Boolean, default: false },
});

const FREE_RATE_DAYS = 14;
const FREE_RATE_HIDDEN = Object.freeze([1, 2, 3, 4, 5]);
const FREE_RATE_HOURS = Object.freeze(
  Array.from({ length: 24 }, (_, h) => h).filter((h) => FREE_RATE_HIDDEN.indexOf(h) < 0),
);

const data = ref(null);
const loading = ref(false);
const error = ref(false);
const selectedHour = ref(null);
let seq = 0;

// free_rate 兼容 0~1 与 0~100；null/空串表示该小时无样本（不能当成 0%）
function rateRatio(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(1, n > 1 ? n / 100 : n));
}

// 先解析后端给的 24 个小时点（样本合计仍按全量算），再按展示时段切片
const allHours = computed(() => {
  const d = data.value;
  const rows = d && Array.isArray(d.points) ? d.points : [];
  const byHour = new Map();
  rows.forEach((p) => {
    const h = Math.floor(Number(p && p.hour));
    if (!Number.isFinite(h) || h < 0 || h > 23) return;
    const samples = Math.floor(Number(p.samples));
    byHour.set(h, {
      hour: h,
      samples: Number.isFinite(samples) && samples > 0 ? samples : 0,
      rate: rateRatio(p.free_rate),
    });
  });
  return Array.from({ length: 24 }, (_, h) => byHour.get(h) || { hour: h, samples: 0, rate: null });
});

const points = computed(() => FREE_RATE_HOURS.map((h) => allHours.value[h]));

const total = computed(() => {
  const n = Number(data.value && data.value.total_samples);
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  return allHours.value.reduce((s, p) => s + p.samples, 0);
});
// total_samples < 30 视为样本不足，显示「积累中」
const sparse = computed(() => total.value > 0 && total.value < 30);
const days = computed(() => {
  const n = Math.floor(Number(data.value && data.value.days));
  return Number.isFinite(n) && n > 0 ? n : FREE_RATE_DAYS;
});

// 按样本加权的小时平均空闲率：口径与柱状一致，只统计展示出来的时段
const avg = computed(() => {
  let samples = 0;
  let weighted = 0;
  points.value.forEach((p) => {
    if (p.rate === null || !p.samples) return;
    samples += p.samples;
    weighted += p.rate * p.samples;
  });
  if (!samples) return '';
  return Math.round((weighted / samples) * 100) + '%';
});

const tag = computed(() => {
  if (error.value) return '暂不可用';
  if (loading.value) return '加载中';
  if (!total.value || sparse.value) return '积累中';
  return '近 ' + days.value + ' 天';
});
const tagTone = computed(() => {
  if (error.value) return 'is-bad';
  if (!total.value || sparse.value) return 'is-warm';
  return '';
});

const selectedPoint = computed(() => {
  if (selectedHour.value === null) return null;
  return points.value.find((p) => p.hour === selectedHour.value) || null;
});

// 小时区间：23 点的下一格是 24:00，而不是回绕成 00:00
function hourRange(h) {
  const end = h >= 23 ? '24:00' : String(h + 1).padStart(2, '0') + ':00';
  return String(h).padStart(2, '0') + ':00–' + end;
}

const detail = computed(() => {
  const p = selectedPoint.value;
  if (!p) return '点柱状图查看该时段的空闲率与样本数';
  const range = hourRange(p.hour);
  if (p.rate === null) return range + ' · 无数据 · ' + p.samples + ' 个样本';
  return range + ' · 空闲率 ' + Math.round(p.rate * 100) + '% · ' + p.samples + ' 个样本';
});

function barHeight(p) {
  if (!p || p.rate === null) return '0%';
  return (Math.max(0, Math.min(1, p.rate)) * 100).toFixed(1) + '%';
}

function barTitle(p) {
  const range = hourRange(p.hour);
  if (p.rate === null) return range + ' · 无样本';
  return range + ' · 空闲率 ' + Math.round(p.rate * 100) + '% · ' + p.samples + ' 个样本';
}

function hourLabel(h) {
  return hourTick(h);
}

function selectHour(h) {
  selectedHour.value = selectedHour.value === h ? null : h;
}

async function load() {
  if (loading.value) return;
  const mine = ++seq;
  loading.value = true;
  error.value = false;
  try {
    const d = await getFreeRate(FREE_RATE_DAYS);
    if (mine !== seq) return;
    data.value = d && typeof d === 'object' ? d : null;
    selectedHour.value = null;
  } catch (e) {
    if (mine !== seq) return;
    data.value = null;
    selectedHour.value = null;
    error.value = true;
    console.warn('[free-rate] 加载失败', e);
  } finally {
    if (mine === seq) loading.value = false;
  }
}

watch(() => props.active, (v) => { if (v) load(); }, { immediate: true });
</script>
