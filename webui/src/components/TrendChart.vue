<template>
  <div ref="el" class="chart" role="img" :aria-label="ariaLabel"></div>
</template>

<script setup>
/**
 * 空闲率折线图（ECharts 按需加载）。
 *
 * 不变量：
 *  - echarts 只在真正要画图时动态 import，实时页首屏不下载图表库；
 *  - 配色全部从设计令牌取值（Canvas 不认 CSS 变量，必须拿具体色值），
 *    主题变化时整体重绘（notMerge），避免旧颜色残留；
 *  - 容器尺寸变化（切 tab / 转屏 / 分屏）自动 resize；
 *  - 卸载时 dispose，不留下残留实例与监听。
 */
import { onMounted, onUnmounted, ref, watch } from 'vue';

const props = defineProps({
  rows: { type: Array, default: () => [] },
  // 15 分钟粒度的 24 小时图：更小字号 + 只在 00/06/12/18 打标签
  compact: { type: Boolean, default: false },
  ariaLabel: { type: String, default: '' },
  // 主题（'light' | 'dark'）：变化时按新配色整体重绘（Canvas 需要具体色值）
  theme: { type: String, default: 'light' },
});

const el = ref(null);
let chart = null;
let chartSeq = 0;
let observer = null;
let raf = 0;

// 图表库按需加载：多个图表实例共享同一次动态 import
let echartsPromise = null;
function ensureEcharts() {
  if (!echartsPromise) {
    echartsPromise = import('../charts.js')
      .then((m) => m.echarts)
      .catch((e) => { echartsPromise = null; throw e; });
  }
  return echartsPromise;
}

function chartColors() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name, fallback) => cs.getPropertyValue(name).trim() || fallback;
  return {
    axis: v('--border', '#e2e8f0'),
    split: v('--line', '#eef2f7'),
    label: v('--muted', '#64748b'),
    text: v('--text', '#0f172a'),
    line: v('--primary', '#047857'),
    area: v('--chart-area', 'rgba(4, 120, 87, .14)'),
    tooltipBg: v('--chart-tooltip-bg', 'rgba(255, 255, 255, .97)'),
    tooltipBorder: v('--border', '#e2e8f0'),
  };
}

function option() {
  const c = chartColors();
  const data = Array.isArray(props.rows) ? props.rows : [];
  const compact = props.compact;
  const axisLabel = { fontSize: compact ? 9 : 10, color: c.label, hideOverlap: true };
  if (compact) {
    const labelTimes = new Set(['00:00', '06:00', '12:00', '18:00']);
    axisLabel.interval = (i, value) => labelTimes.has(String(value || ''));
  }
  return {
    backgroundColor: 'transparent',
    grid: { left: compact ? 34 : 32, right: 12, top: 12, bottom: 20 },
    tooltip: {
      trigger: 'axis',
      backgroundColor: c.tooltipBg,
      borderColor: c.tooltipBorder,
      textStyle: { color: c.text, fontSize: 11 },
      // tooltip 显示时间 + 空闲率（缺数据的点在 series 里已跳过，不会显示 0）
      formatter: (ps) => {
        const p = Array.isArray(ps) ? ps[0] : ps;
        if (!p) return '';
        const v = Number(p.value);
        return String(p.axisValue) + '<br/>空闲率 ' +
          (Number.isFinite(v) ? Math.round(v * 100) + '%' : '—');
      },
    },
    xAxis: {
      type: 'category',
      data: data.map((r) => r.t),
      axisLine: { lineStyle: { color: c.axis } },
      axisTick: { show: false },
      axisLabel,
    },
    yAxis: {
      type: 'value',
      min: 0,
      max: 1,
      axisLine: { show: false },
      axisTick: { show: false },
      splitLine: { lineStyle: { color: c.split } },
      axisLabel: { fontSize: 10, color: c.label, formatter: (v) => Math.round(v * 100) + '%' },
    },
    series: [{
      type: 'line',
      smooth: true,
      showSymbol: false,
      connectNulls: true,
      data: data.map((r) => r.ratio),
      lineStyle: { color: c.line, width: 2 },
      itemStyle: { color: c.line },
      areaStyle: { color: c.area },
    }],
  };
}

function resize() {
  try { if (chart) chart.resize(); } catch { /* ignore */ }
}

function observe() {
  if (typeof ResizeObserver === 'undefined') return;
  if (!observer) observer = new ResizeObserver(() => resize());
  observer.disconnect();
  if (el.value) observer.observe(el.value);
}

function onWindowResize() {
  if (raf) return;
  if (typeof requestAnimationFrame === 'function') {
    raf = requestAnimationFrame(() => { raf = 0; resize(); });
  } else {
    raf = setTimeout(() => { raf = 0; resize(); }, 16);
  }
}

function dispose() {
  if (observer) { observer.disconnect(); observer = null; }
  if (chart) { try { chart.dispose(); } catch { /* ignore */ } chart = null; }
}

async function render() {
  if (!el.value) { dispose(); return; }
  const seq = ++chartSeq;
  let ec;
  try {
    ec = await ensureEcharts();
  } catch (e) {
    console.warn('[charts] 图表库加载失败', e);
    return;
  }
  if (seq !== chartSeq) return; // 期间又触发了新的渲染，以最新一次为准
  if (!el.value) { dispose(); return; }
  try {
    if (chart && chart.getDom() !== el.value) { chart.dispose(); chart = null; }
    chart = chart || ec.init(el.value);
    // notMerge: true —— 主题切换时整体替换配色，避免旧颜色残留
    chart.setOption(option(), true);
    resize();
    observe();
  } catch (e) {
    console.warn('[charts] 渲染失败', e);
  }
}

onMounted(() => {
  render();
  window.addEventListener('resize', onWindowResize);
});

onUnmounted(() => {
  window.removeEventListener('resize', onWindowResize);
  if (raf) {
    try {
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
    } catch { /* ignore */ }
    try { clearTimeout(raf); } catch { /* ignore */ }
    raf = 0;
  }
  dispose();
});

watch(() => [props.rows, props.compact, props.theme], render);
</script>
