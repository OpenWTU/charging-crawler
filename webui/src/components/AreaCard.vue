<template>
  <van-popup
:show="show" round position="bottom" class="sheet card-sheet"
             role="dialog" aria-modal="true" aria-label="充电区详情"
             @update:show="(v) => emit('update:show', v)">
    <div class="card-head">
      <button
type="button" class="sheet-act card-close" aria-label="关闭"
              @click="emit('update:show', false)">
        <van-icon name="cross" />
      </button>
      <div class="card-head-title">
        {{ name }}
        <span v-if="area && area.state === 'full'" class="row-full-tag">已满</span>
        <button
type="button" class="fav-btn card-fav" :class="{ 'is-on': fav }"
                :aria-pressed="fav ? 'true' : 'false'"
                :aria-label="(fav ? '取消收藏 ' : '收藏置顶 ') + name"
                @click.stop="emit('toggle-fav', name)">
          <van-icon :name="fav ? 'star' : 'star-o'" />
        </button>
      </div>
      <div class="card-head-sub">
        <span v-if="area">空闲 {{ area.free_port }} / {{ area.ports_total }}</span>
        <span v-if="distText" class="row-dist">{{ distText }}</span>
      </div>
      <div v-if="predText" class="row-pred">{{ predText }}</div>
    </div>
    <div class="card-actions">
      <button v-if="amapUrl" type="button" class="action-row" @click="emit('go-amap')">
        <span class="action-ico ico-nav"><van-icon name="guide-o" /></span>
        <span class="action-text">
          <b>高德导航</b>
          <small>打开地图，自选步行 / 骑行</small>
        </span>
        <van-icon name="arrow" class="action-arrow" />
      </button>
      <button type="button" class="action-row" @click="openPorts">
        <span class="action-ico ico-ports"><van-icon name="apps-o" /></span>
        <span class="action-text">
          <b>端口详情</b>
          <small>查看每个端口的实时状态</small>
        </span>
        <van-icon name="arrow" class="action-arrow" />
      </button>
      <details v-if="!isApp" class="hist-fold">
        <summary><van-icon name="bar-chart-o" /> 历史数据</summary>
        <div v-if="histLoading" class="muted hist-empty">加载中…</div>
        <div v-else-if="histError" class="muted hist-empty">加载失败</div>
        <div v-else-if="!histRows.length" class="muted hist-empty">暂无历史</div>
        <template v-else>
          <div v-for="(r, i) in histRows" :key="i" class="hist-row">
            <span class="hist-t">{{ r.t }}</span>
            <span class="hist-v">空闲 {{ r.idle }} / {{ r.total }}</span>
          </div>
        </template>
      </details>
    </div>
  </van-popup>
</template>

<script setup>
/**
 * 充电区详情弹层（底部卡片）：空闲数、距离、到达预测、高德导航、端口详情、历史数据。
 *
 * 历史数据只在这里拉取（网页端才有），收藏状态由父组件持有（localStorage 持久化）。
 */
import { ref, watch } from 'vue';
import { getHistory, isApp } from '../api/index.js';

const props = defineProps({
  show: { type: Boolean, default: false },
  name: { type: String, default: '' },
  area: { type: Object, default: null },
  distText: { type: String, default: '' },
  predText: { type: String, default: '' },
  amapUrl: { type: String, default: '' },
  fav: { type: Boolean, default: false },
});

const emit = defineEmits(['update:show', 'toggle-fav', 'open-ports', 'go-amap']);

const histRows = ref([]);
const histLoading = ref(false);
const histError = ref(false);
let histSeq = 0;

async function loadHist(name) {
  const seq = ++histSeq;
  histRows.value = [];
  histLoading.value = true;
  histError.value = false;
  try {
    const rows = await getHistory(name, 30);
    if (seq !== histSeq) return;
    histRows.value = rows;
  } catch (e) {
    if (seq !== histSeq) return;
    histError.value = true;
    console.warn('[history] 卡片历史加载失败', e);
  } finally {
    if (seq === histSeq) histLoading.value = false;
  }
}

watch(() => [props.show, props.name], ([visible]) => {
  if (!visible) return;
  if (isApp) {
    histSeq += 1;
    histRows.value = [];
    histLoading.value = false;
    histError.value = false;
    return;
  }
  if (props.name) loadHist(props.name);
});

function openPorts() {
  emit('update:show', false);
  emit('open-ports', props.name);
}
</script>
