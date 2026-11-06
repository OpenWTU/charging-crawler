<template>
  <section class="stats">
    <article v-for="card in cards" :key="card.label" class="stat">
      <div class="stat-label">{{ card.label }}</div>
      <div class="stat-value" :class="{ small: card.small }">{{ card.value }}</div>
      <div class="stat-sub">{{ card.sub }}</div>
    </article>
  </section>
</template>

<script setup>
/**
 * 顶部统计卡（6 项）。数值与副标题由 AdminView 计算好传入，
 * 加载中/失败一律显示「—」，不显示误导性的 0。
 */
defineProps({
  cards: { type: Array, default: () => [] },
});
</script>
