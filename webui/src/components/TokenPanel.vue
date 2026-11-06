<template>
  <!-- 令牌页容器：Vant 页签里只占一个 section，把 Token.vue 的完成事件转给 App 装配层 -->
  <section v-if="isApp">
    <Token :active="active" @done="emit('done')" />
  </section>
</template>

<script setup>
/**
 * 令牌页容器（薄适配层）。
 *
 * 职责：把 Token.vue（抓包/校验/保存）挂进 Tab 布局，并把「令牌已就绪」事件
 * 原样上报给 App.vue（由 App 决定回实时页并刷新）。自身不持有任何业务状态。
 */
import Token from '../Token.vue';
import { isApp } from '../api/index.js';

defineProps({
  active: { type: Boolean, default: false },
});

const emit = defineEmits(['done']);
</script>
