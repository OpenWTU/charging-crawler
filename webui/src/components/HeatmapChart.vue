<template>
  <div class="card">
    <div class="card-title">时段热力图</div>
    <div class="heat-scroll">
      <div
class="heat-grid" role="group"
           aria-label="时段热力图，行为周一至周日，列为 0 到 23 点，颜色越深空闲率越高">
        <span class="heat-corner" aria-hidden="true"></span>
        <div class="heat-cols" aria-hidden="true">
          <span v-for="h in 24" :key="'hc' + h" class="heat-col">{{ hourLabel(h - 1) }}</span>
        </div>
        <template v-for="(row, d) in rows" :key="'hr' + d">
          <span class="heat-dow">{{ DOW_LABELS[d] }}</span>
          <div class="heat-cells">
            <button
v-for="(v, h) in row" :key="'hx' + d + '-' + h" type="button"
                    class="heat-cell" :class="{ 'is-on': isSelected(d, h) }"
                    :style="{ background: color(v) }"
                    :aria-label="cellTitle(d, h, v)"
                    :aria-pressed="isSelected(d, h) ? 'true' : 'false'"
                    @click="select(d, h)"
                    @contextmenu.prevent="select(d, h)"></button>
          </div>
        </template>
      </div>
    </div>
    <div class="heat-legend">
      <span class="muted">低</span>
      <i
v-for="(p, i) in HEAT_LEGEND" :key="'lg' + i" class="heat-swatch"
         :style="{ background: color(p) }"></i>
      <span class="muted">高</span>
      <span class="heat-swatch is-empty" :style="{ background: color(null) }"></span>
      <span class="muted">无数据</span>
    </div>
    <div class="heat-detail" aria-live="polite">{{ detail }}</div>
  </div>
</template>

<script setup>
/**
 * 时段热力图：7 行（周一→周日）× 24 列，null = 无数据，0~1 = 空闲率。
 *
 * 色阶全部走设计令牌（--heat-rgb / --heat-empty），主题切换时重算缓存，
 * 不逐格调用 getComputedStyle。点格子展示该时段详情（读屏用 aria-live 播报）。
 */
import { computed, ref } from 'vue';

const props = defineProps({
  // 后端 heatmap 固定 7×24（周一在前），缺行/缺列补 null
  heatmap: { type: Array, default: () => [] },
  theme: { type: String, default: 'light' },
});

const DOW_LABELS = Object.freeze(['周一', '周二', '周三', '周四', '周五', '周六', '周日']);
// 图例色阶：低 → 高是同一绿色系（透明度递增），无数据单独用灰
const HEAT_LEGEND = Object.freeze([0.05, 0.25, 0.45, 0.65, 0.85, 1]);

// 只缓存当前主题的令牌值，避免每个格子重复 getComputedStyle
const cache = { theme: '', empty: '', rgb: '' };

function style() {
  const key = props.theme === 'dark' ? 'dark' : 'light';
  if (cache.theme !== key) {
    let cs = null;
    try { cs = getComputedStyle(document.documentElement); } catch { cs = null; }
    cache.theme = key;
    cache.empty = (cs && cs.getPropertyValue('--heat-empty').trim()) || (key === 'dark' ? '#334155' : '#e2e8f0');
    cache.rgb = (cs && cs.getPropertyValue('--heat-rgb').trim()) || (key === 'dark' ? '52, 211, 153' : '4, 120, 87');
  }
  return cache;
}

// 依赖 props.theme，保证主题切换时色阶重算并重渲染（不能靠 `:style` 里的函数式非响应值）
const palette = computed(() => style());

function color(v) {
  const p = palette.value;
  if (v === null || v === undefined) return p.empty;
  const a = 0.15 + 0.75 * Math.min(1, Math.max(0, v));
  return 'rgba(' + p.rgb + ',' + a.toFixed(2) + ')';
}

const rows = computed(() => {
  const src = Array.isArray(props.heatmap) ? props.heatmap : [];
  return Array.from({ length: 7 }, (_, d) => {
    const row = Array.isArray(src[d]) ? src[d] : [];
    return Array.from({ length: 24 }, (_, h) => {
      const raw = row[h];
      if (raw === null || raw === undefined || raw === '') return null;
      const v = Number(raw);
      return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : null;
    });
  });
});

const selected = ref(null);

function isSelected(d, h) {
  const s = selected.value;
  return !!s && s.d === d && s.h === h;
}

function select(d, h) {
  const s = selected.value;
  selected.value = s && s.d === d && s.h === h ? null : { d, h };
}

// 「周几 HH:00 · 空闲率/无数据」：aria-label 与下方详情共用同一文案
function cellLabel(d, h) {
  return DOW_LABELS[d] + ' ' + String(h).padStart(2, '0') + ':00';
}

function cellTitle(d, h, v) {
  return cellLabel(d, h) + ' · ' +
    (v == null ? '无数据' : '空闲率 ' + Math.round(v * 100) + '%');
}

const detail = computed(() => {
  const s = selected.value;
  if (!s) return '点格子看该时段的空闲率，灰色表示无数据';
  const v = rows.value[s.d][s.h];
  return cellLabel(s.d, s.h) + ' · ' +
    (v == null ? '无数据' : '空闲率 ' + Math.round(v * 100) + '%');
});

function hourLabel(h) {
  return h % 6 === 0 ? String(h).padStart(2, '0') : '';
}
</script>
