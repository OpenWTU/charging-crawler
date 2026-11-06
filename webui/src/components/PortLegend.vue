<template>
  <div class="ports-legend" role="group" aria-label="端口状态图例">
    <span
v-for="item in items" :key="item.key"
          :title="item.label + (item.count === null ? '' : '：' + item.count + ' 个')">
      <i class="legend-dot" :class="'is-' + item.tone"></i>{{ item.label }}<b v-if="item.count !== null" class="legend-count">{{ item.count }}</b>
    </span>
  </div>
</template>

<script setup>
/**
 * 端口状态图例（按**细分状态**逐条列出，不再是四分组）。
 *
 * 计数来自后端 v2 的 `summary.statuses`（逐状态计数），因此
 * 「空闲 3 / 充电中 4 / 已充满 2 / 浮充 1 / 禁用 1」会分别显示；
 * 后端未提供 statuses 时回退到四分组计数，保持与旧版一致。
 */
import { computed } from 'vue';
import { buildLegend } from '../portStatus.js';

const props = defineProps({
  summary: { type: Object, default: null },
});

const items = computed(() => buildLegend(props.summary));
</script>
