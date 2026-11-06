<template>
  <nav class="tabs" role="tablist" aria-label="管理后台分区">
    <button
v-for="(t, ti) in tabs" :id="'admin-tab-' + t.key" :key="t.key" class="tab"
            role="tab" :class="{ active: tab === t.key }"
            :aria-selected="tab === t.key ? 'true' : 'false'"
            :aria-controls="'admin-panel-' + t.key"
            :tabindex="tab === t.key ? 0 : -1"
            @click="emit('switch', t.key)"
            @keydown="moveTab($event, ti)">
      {{ t.label }}
    </button>
  </nav>
</template>

<script setup>
/**
 * 分区页签：左右箭头循环、Home/End 跳首尾，切换后把焦点交给新 tab（与拆分前一致）。
 */
import { nextTick } from 'vue';

const props = defineProps({
  tabs: { type: Array, required: true },
  tab: { type: String, required: true },
});

const emit = defineEmits(['switch']);

function moveTab(e, idx) {
  const key = e && e.key;
  let next;
  if (key === 'ArrowRight') next = (idx + 1) % props.tabs.length;
  else if (key === 'ArrowLeft') next = (idx - 1 + props.tabs.length) % props.tabs.length;
  else if (key === 'Home') next = 0;
  else if (key === 'End') next = props.tabs.length - 1;
  else return;
  e.preventDefault();
  const target = props.tabs[next];
  emit('switch', target.key);
  nextTick(() => {
    const el = document.getElementById('admin-tab-' + target.key);
    if (el) el.focus();
  });
}
</script>
