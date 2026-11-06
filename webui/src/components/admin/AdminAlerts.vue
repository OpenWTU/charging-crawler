<template>
  <div>
    <div v-if="errorMsg" class="alert alert-error" @click="emit('clear')">
      {{ errorMsg }}（点击关闭）
    </div>
    <div v-if="successMsg" class="alert ok" @click="emit('clear')">
      {{ successMsg }}（点击关闭）
    </div>

    <div v-if="anomalies.length" class="alerts">
      <div
v-for="(a, i) in anomalies" :key="i"
           :class="['alert', 'alert-static', 'alert-' + levelClass(a.level)]">
        <b>{{ levelLabel(a.level) }}：</b>{{ a.title }}
        <div v-if="a.detail" class="alert-detail">{{ a.detail }}</div>
      </div>
    </div>
  </div>
</template>

<script setup>
/**
 * 全局提示条：操作成功/失败（可点击关闭）+ 后端异常清单（只读）。
 * 点击关闭只清理成功/失败两条，异常清单由后端数据决定。
 */
import { levelClass, levelLabel } from './adminFormat.js';

defineProps({
  errorMsg: { type: String, default: '' },
  successMsg: { type: String, default: '' },
  anomalies: { type: Array, default: () => [] },
});

const emit = defineEmits(['clear']);
</script>
