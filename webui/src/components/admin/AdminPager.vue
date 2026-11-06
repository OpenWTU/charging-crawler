<template>
  <div v-if="!state.error && state.total > state.limit" class="pager">
    <button
class="btn ghost sm" :disabled="state.paging || state.offset <= 0"
            @click="emit('page', -1)">
上一页
</button>
    <span class="muted">{{ state.paging ? '加载中…' : label }}</span>
    <button
class="btn ghost sm"
            :disabled="state.paging || state.offset + state.limit >= state.total"
            @click="emit('page', 1)">
下一页
</button>
  </div>
</template>

<script setup>
/**
 * 列表分页条：只在「有错误之外且总数超过一页」时出现，翻页触发 page(±1)。
 */
import { computed } from 'vue';
import { pageLabel } from './useAdminList.js';

const props = defineProps({
  state: { type: Object, required: true },
});

const emit = defineEmits(['page']);

const label = computed(() => pageLabel(props.state));
</script>
