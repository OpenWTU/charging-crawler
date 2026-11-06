<template>
  <header class="topbar">
    <div class="brand">
      <span class="logo">⚡</span>
      <div class="brand-text">
        <h1>充电桩数据后台</h1>
        <p>Cloud Console · 管理控制台</p>
      </div>
    </div>
    <div class="actions">
      <span v-if="summary" class="live">{{ summary.server_time || '' }}</span>
      <button class="btn ghost" :disabled="refreshing" @click="emit('refresh')">
        {{ refreshing ? '刷新中…' : '刷新' }}
      </button>
      <button class="btn ghost" :disabled="!!exporting" @click="emit('export', 'audit')">
        {{ exporting === 'audit' ? '导出中…' : '导出审计' }}
      </button>
      <button class="btn ghost" :disabled="!!exporting" @click="emit('export', 'snapshots')">
        {{ exporting === 'snapshots' ? '导出中…' : '导出快照' }}
      </button>
      <button class="btn danger" @click="emit('logout')">退出登录</button>
    </div>
  </header>
</template>

<script setup>
/**
 * 管理后台顶栏：品牌、服务器时间、刷新/导出/退出。
 * 纯展示组件，动作全部上抛（导出目标也由父组件决定）。
 */
defineProps({
  summary: { type: Object, default: null },
  refreshing: { type: Boolean, default: false },
  exporting: { type: String, default: '' },
});

const emit = defineEmits(['refresh', 'export', 'logout']);
</script>
