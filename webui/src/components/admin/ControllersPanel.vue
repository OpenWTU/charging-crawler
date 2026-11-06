<template>
  <section
id="admin-panel-controllers" class="panel"
           role="tabpanel" aria-labelledby="admin-tab-controllers" tabindex="0">
    <div class="panel-head">
      <div>
        <h2>控制器</h2>
        <p>充电桩控制器与区域的对应关系、端口占用与最近同步时间</p>
      </div>
      <div class="ctrl-actions">
        <span v-if="state.loading" class="muted">加载中…</span>
        <span v-else class="muted">{{ state.rows.length }} 台</span>
        <button
class="btn success sm" :disabled="syncing || state.loading"
                @click="sync">
          {{ syncing ? '同步中…' : '立即同步' }}
        </button>
      </div>
    </div>

    <div v-if="!state.loaded && !state.error" class="empty">加载中…</div>
    <div v-else-if="state.error" class="fail">
      <span>控制器数据加载失败：{{ state.error }}</span>
      <button class="btn ghost sm" :disabled="state.loading" @click="load()">
        {{ state.loading ? '重试中…' : '重试' }}
      </button>
    </div>
    <template v-else>
      <div v-if="!state.rows.length" class="empty">
        暂无控制器数据，可点击「立即同步」拉取
      </div>
      <div v-else class="table-wrap">
        <div class="table ctrl-table" role="table" aria-label="控制器列表">
          <div class="tr th" role="row">
            <span role="columnheader">设备</span><span role="columnheader">区域</span><span role="columnheader">code</span><span role="columnheader">端口数</span>
            <span role="columnheader">空闲 / 充电</span><span role="columnheader">更新时间</span>
          </div>
          <div v-for="c in state.rows" :key="c.device_hex" class="tr" role="row">
            <span role="cell" class="mono">{{ c.device_hex || '—' }}</span>
            <span role="cell">{{ c.area_name || '—' }}</span>
            <span role="cell" class="mono">{{ decCode(c.code) }}</span>
            <span role="cell" class="mono">{{ numOrDash(c.port_count) }}</span>
            <span role="cell" class="mono">
              <b class="ctrl-idle">{{ numOrDash(c.idle) }}</b> /
              <b class="ctrl-charging">{{ numOrDash(c.charging) }}</b>
            </span>
            <span role="cell" class="mono">{{ c.updated_at || '—' }}</span>
          </div>
        </div>
        <p class="scroll-hint muted" aria-hidden="true">左右滑动查看完整表格</p>
      </div>

      <div class="missing-box">
        <div class="missing-head">
          <b>缺失区域</b>
          <span class="muted">{{ state.missing.length }} 个</span>
        </div>
        <div v-if="!state.missing.length" class="muted">所有区域都已有控制器记录</div>
        <div v-else class="missing-list">
          <span v-for="m in state.missing" :key="m" class="missing-chip">{{ m }}</span>
        </div>
      </div>
    </template>
  </section>
</template>

<script setup>
/**
 * 控制器面板：控制器 ↔ 区域对应表 + 缺失区域清单 + 「立即同步」。
 * 同步结果既提示文案也决定是否重载列表（同步成功但列表刷新失败要单独告知）。
 */
import { ref, watch } from 'vue';
import { adminPost } from '../../api/index.js';
import { makeListState, fetchPage, errorText } from './useAdminList.js';
import { decCode, numOrDash } from './adminFormat.js';
import { useAdminUi } from './adminUi.js';

const props = defineProps({
  active: { type: Boolean, default: false },
  refreshToken: { type: Number, default: 0 },
});

const ui = useAdminUi();
const state = makeListState(0);
const syncing = ref(false);

async function load() {
  return fetchPage(state, '/admin/api/controllers', (data) => {
    state.rows = Array.isArray(data.rows) ? data.rows : [];
    state.missing = Array.isArray(data.missing_areas) ? data.missing_areas : [];
  });
}

function syncResultText(result) {
  if (result === null || result === undefined || result === '') return '完成';
  if (typeof result === 'string') return result;
  try { return JSON.stringify(result); } catch { return String(result); }
}

async function sync() {
  if (syncing.value) return;
  syncing.value = true;
  ui.clearAlerts();
  try {
    const d = await adminPost('/admin/api/controllers/sync', {});
    const okFlag = !(d && d.ok === false);
    const text = syncResultText(d && d.result);
    const refreshed = await load();
    if (okFlag && refreshed) {
      ui.showOk('同步完成：' + text);
    } else if (okFlag) {
      ui.showError(new Error('同步完成：' + text + '（列表刷新失败，请重试）'));
    } else {
      ui.showError(new Error('同步失败：' + text));
    }
  } catch (err) {
    ui.showError(new Error('同步失败：' + errorText(err)));
  } finally {
    syncing.value = false;
  }
}

watch(() => props.active, (v) => {
  if (!v) return;
  if (state.loaded && !state.error) return;
  load();
}, { immediate: true });

watch(() => props.refreshToken, () => { if (props.active) load(); });
</script>
