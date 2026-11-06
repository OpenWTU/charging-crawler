<template>
  <van-popup
:show="show" round class="dialog"
             role="dialog" aria-modal="true" aria-label="发现新版本"
             @update:show="(v) => emit('update:show', v)">
    <h3 class="dialog-title">发现新版本 {{ up.versionName }}</h3>
    <p class="dialog-sub">{{ up.currentName || appVersion || '当前版本' }} → {{ up.versionName }}</p>
    <ul v-if="(up.changelog || []).length" class="changelog">
      <li v-for="(c, i) in up.changelog" :key="i">{{ c }}</li>
    </ul>
    <div class="dialog-actions">
      <van-button plain type="primary" class="btn-ghost" @click="emit('update:show', false)">以后再说</van-button>
      <van-button type="primary" class="btn-primary" @click="emit('install')">下载并安装</van-button>
    </div>
  </van-popup>
</template>

<script setup>
/**
 * 「发现新版本」弹窗（仅 App）。
 *
 * 纯展示：版本信息由 useUpdate 提供，「下载并安装」交给原生桥（startUpdate），
 * 失败提示也在装配层统一给出。
 */
defineProps({
  show: { type: Boolean, default: false },
  up: { type: Object, default: () => ({}) },
  appVersion: { type: String, default: '' },
});

const emit = defineEmits(['update:show', 'install']);
</script>
