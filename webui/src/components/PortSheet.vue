<template>
  <van-popup
:show="show" round position="bottom" class="sheet ports-sheet"
             role="dialog" aria-modal="true" aria-label="端口详情"
             @update:show="(v) => emit('update:show', v)">
    <div class="ports-head">
      <div class="ports-head-main">
        <h3 class="sheet-title">{{ area }}</h3>
        <div class="muted">最后更新：{{ updatedText }}</div>
      </div>
      <div class="ports-head-acts">
        <span v-if="!loading && !error" class="ports-count muted">
          {{ devices.length }} 台设备
        </span>
        <button
type="button" class="sheet-act" :disabled="loading"
                aria-label="刷新端口数据" @click="emit('retry')">
          <van-icon name="replay" />
        </button>
        <button
type="button" class="sheet-act" aria-label="关闭"
                @click="emit('update:show', false)">
          <van-icon name="cross" />
        </button>
      </div>
    </div>

    <div v-if="loading" class="ports-skel" aria-busy="true">
      <div v-for="i in 2" :key="i" class="ports-skel-card">
        <span class="skel-line w40"></span>
        <div class="ports-skel-grid"><i v-for="j in 10" :key="j"></i></div>
      </div>
    </div>

    <div v-else-if="error" class="state-card is-error ports-state" role="alert">
      <van-icon name="warning-o" class="state-icon" />
      <b>{{ error }}</b>
      <button type="button" class="state-btn" @click="emit('retry')">重试</button>
    </div>

    <div v-else-if="!devices.length" class="state-card is-empty ports-state">
      <van-icon name="info-o" class="state-icon is-info" />
      <span class="state-sub">该区域暂无端口数据（可能尚未同步）</span>
    </div>

    <template v-else>
      <PortLegend :summary="summary" />
      <div
v-for="(d, di) in devices" :id="'dev-card-' + di" :key="d.device_hex || ('dev-' + di)"
           class="dev-card" :class="{ 'is-hit': isHitDevice(d) }">
        <div class="dev-head">
          <span class="dev-id mono">{{ d.device_hex || '未知设备' }}</span>
          <span v-if="isHitDevice(d)" class="dev-hit-tag">搜索命中</span>
          <span class="dev-state" :class="'is-' + (d.state || 'unknown')">
            {{ d.state === 'free' ? '有空位' : d.state === 'full' ? '已满' : (d.state === 'unknown' ? '无数据' : '探不到') }}<template v-if="d.stale"> · 已过期</template>
          </span>
          <span class="dev-code">编号 <b class="mono">{{ decCode(d.code) }}</b></span>
        </div>
        <div v-if="d.qr_device_no" class="dev-qr mono">QR {{ d.qr_device_no }}</div>
        <PortGrid :ports="portsOf(d)" />
      </div>
    </template>
  </van-popup>
</template>

<script setup>
/**
 * 端口详情弹层：区域下每台设备的端口方块 + 状态图例。
 *
 * 纯展示组件（数据由 HomeView 负责拉取与重试），只有一件事自己做：
 * 搜索命中单台设备时把它滚进视野。
 */
import { nextTick, watch } from 'vue';
import PortGrid from './PortGrid.vue';
import PortLegend from './PortLegend.vue';
import { decCode, deviceKey } from '../composables/useAreaSelection.js';

const props = defineProps({
  show: { type: Boolean, default: false },
  area: { type: String, default: '' },
  devices: { type: Array, default: () => [] },
  summary: { type: Object, default: null },
  loading: { type: Boolean, default: false },
  error: { type: String, default: '' },
  updatedText: { type: String, default: '—' },
  hitKey: { type: String, default: '' },
});

const emit = defineEmits(['update:show', 'retry']);

function portsOf(d) {
  return d && Array.isArray(d.ports) ? d.ports : [];
}

function isHitDevice(d) {
  const k = props.hitKey;
  return !!k && k !== '—' && deviceKey(d) === k;
}

function scrollToHitDevice() {
  nextTick(() => {
    const idx = props.devices.findIndex((d) => isHitDevice(d));
    if (idx < 0) return;
    const el = document.getElementById('dev-card-' + idx);
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  });
}

watch(() => [props.show, props.hitKey, props.devices], () => {
  if (props.show && props.hitKey) scrollToHitDevice();
});
</script>
