<template>
  <van-popup
:show="show" round position="bottom" class="sheet"
             role="dialog" aria-modal="true" aria-label="历史数据"
             @update:show="(v) => emit('update:show', v)">
    <div class="hist-head">
      <h3 class="sheet-title">{{ name }} · 历史</h3>
      <button
type="button" class="sheet-act" aria-label="关闭"
              @click="emit('update:show', false)">
        <van-icon name="cross" />
      </button>
    </div>
    <div v-if="loading" class="muted hist-empty">加载中…</div>
    <div v-else-if="error" class="muted hist-empty">加载失败</div>
    <div v-else-if="!rows.length" class="muted hist-empty">暂无历史</div>
    <template v-else>
      <div v-for="(r, i) in rows" :key="i" class="hist-row">
        <span class="hist-t">{{ r.t }}</span>
        <span class="hist-v">空闲 {{ r.idle }} / {{ r.total }}</span>
      </div>
    </template>
  </van-popup>
</template>

<script setup>
/**
 * 行内「历史」弹层（网页端）：拉取最近 60 条样本，失败/为空都只在本弹层提示，
 * 不影响列表与其它弹层。
 */
import { ref, watch } from 'vue';
import { getHistory, isApp } from '../api/index.js';

const props = defineProps({
  show: { type: Boolean, default: false },
  name: { type: String, default: '' },
});

const emit = defineEmits(['update:show']);

const rows = ref([]);
const loading = ref(false);
const error = ref(false);
let seq = 0;

async function load(name) {
  const mine = ++seq;
  rows.value = [];
  loading.value = true;
  error.value = false;
  try {
    const list = await getHistory(name, 60);
    if (mine !== seq) return;
    rows.value = list;
  } catch (e) {
    if (mine !== seq) return;
    error.value = true;
    console.warn('[history] 行内历史加载失败', e);
  } finally {
    if (mine === seq) loading.value = false;
  }
}

watch(() => [props.show, props.name], ([visible]) => {
  if (!visible) return;
  if (isApp) { loading.value = false; return; }
  if (props.name) load(props.name);
});
</script>
