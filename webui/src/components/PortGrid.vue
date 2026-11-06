<template>
  <div v-if="ports.length" class="port-grid">
    <div
v-for="(p, pi) in ports" :key="pi" class="port"
         role="img"
         :class="'port-' + toneOf(p)"
         :aria-label="'端口 ' + portNumber(p, pi) + '，' + portStatusText(statusOf(p))"
         :title="portTitle(p, pi)">
      <span class="port-no">{{ portNumber(p, pi) }}</span>
      <span class="port-status">{{ portStatusText(statusOf(p)) }}</span>
    </div>
  </div>
  <div v-else class="muted dev-empty">该设备暂无端口数据</div>
</template>

<script setup>
/**
 * 单台设备的端口网格。
 *
 * **按状态原文上色**（不是只按 group）：空闲=绿 / 充电中=琥珀 / 已充满=蓝 /
 * 浮充=青 / 未充占用=紫 / 禁用·绑定·故障=红 / 未知=灰。
 * 方块内同时显示端口号与状态文案，因此「充电中 / 已充满 / 浮充」一眼可分，
 * 不再聚合成一个"占用"。识别不了的状态才回退到分组色。
 */
import { portNumber, portStatus, portStatusText, portTitle, portTone as toneOfPort } from '../portStatus.js';

defineProps({
  ports: { type: Array, default: () => [] },
});

function toneOf(p) { return toneOfPort(p); }
function statusOf(p) { return portStatus(p); }
</script>
