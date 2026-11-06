<template>
  <!-- 设置页容器：把 Settings.vue 的事件（主题/检查更新/上传开关）原样上报给 App.vue -->
  <section v-if="isApp">
    <Settings
      :active="active"
      :version="version"
      :checking="checking"
      :theme-pref="themePref"
      @theme-change="(v) => emit('theme-change', v)"
      @check-update="(v) => emit('check-update', v)"
      @upload-token-change="(v) => emit('upload-token-change', v)"
    />
  </section>
</template>

<script setup>
/**
 * 设置页容器（薄适配层）。
 *
 * 职责：把 Settings.vue 挂进 Tab 布局，并保持原有 props / 事件契约不变；
 * 版本号、检查更新状态、主题偏好都由 App.vue 传入（Settings.vue 只是展示与触发）。
 */
import Settings from '../Settings.vue';
import { isApp } from '../api/index.js';

defineProps({
  active: { type: Boolean, default: false },
  version: { type: String, default: '' },
  checking: { type: Boolean, default: false },
  themePref: { type: String, default: 'system' },
});

const emit = defineEmits(['theme-change', 'check-update', 'upload-token-change']);
</script>
