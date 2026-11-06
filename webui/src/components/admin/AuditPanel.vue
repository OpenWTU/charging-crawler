<template>
  <section
id="admin-panel-audit" class="panel"
           role="tabpanel" aria-labelledby="admin-tab-audit" tabindex="0">
    <div class="panel-head">
      <div>
        <h2>上传审计</h2>
        <p>上传请求与管理员操作审计（签名失败、重放、限速、区域/设置变更）</p>
      </div>
      <span class="muted">{{ state.rows.length }} / {{ state.total }} 条</span>
    </div>
    <div v-if="!state.loaded && !state.error" class="empty">加载中…</div>
    <div v-else-if="state.error" class="fail">
      <span>审计记录加载失败：{{ state.error }}</span>
      <button class="btn ghost sm" :disabled="state.loading" @click="load()">
        {{ state.loading ? '重试中…' : '重试' }}
      </button>
    </div>
    <div v-else-if="!state.rows.length" class="empty">暂无记录</div>
    <ul v-else class="list">
      <li
v-for="r in state.rows" :key="r.id" class="item"
          :class="{ open: open['audit-' + r.id] }">
        <div
class="item-head" role="button" tabindex="0"
             @click="toggle(r.id)"
             @keydown.enter.prevent="toggle(r.id)"
             @keydown.space.prevent="toggle(r.id)">
          <div class="item-main">
            <div class="item-title">
              <span class="chip" :class="'chip-' + tone(r.result)">{{ resultLabel(r.result) }}</span>
              <span class="src" :class="'src-' + (r.source || 'other')">{{ sourceLabel(r.source) }}</span>
              <span class="mono">{{ r.ts }}</span>
            </div>
            <div class="item-sub">
              {{ r.ip || '—' }} · {{ fmtBytes(r.size) }} · #{{ r.id }}
              <template v-if="r.device"> · 设备 {{ shortId(r.device) }}</template>
            </div>
          </div>
          <span class="chev">{{ open['audit-' + r.id] ? '▾' : '▸' }}</span>
        </div>
        <div v-show="open['audit-' + r.id]" class="detail">
          <dl>
            <div><dt>来源</dt><dd>{{ sourceLabel(r.source) }}</dd></div>
            <div><dt>设备 ID</dt><dd class="mono">{{ r.device || '—' }}</dd></div>
            <div><dt>IP</dt><dd class="mono">{{ r.ip || '—' }}</dd></div>
            <div><dt>大小</dt><dd>{{ r.size }} 字节（{{ fmtBytes(r.size) }}）</dd></div>
            <div><dt>结果</dt><dd>{{ resultLabel(r.result) }}</dd></div>
            <div><dt>说明</dt><dd>{{ r.detail || '—' }}</dd></div>
            <div><dt>User-Agent</dt><dd>{{ r.ua || '—' }}</dd></div>
          </dl>
        </div>
      </li>
    </ul>
    <AdminPager :state="state" @page="page" />
  </section>
</template>

<script setup>
/**
 * ① 上传审计面板：分页列表 + 单条展开明细。
 * 数据：/admin/api/audit（limit=15）。展开状态是本面板自己的 UI 状态。
 */
import { reactive, watch } from 'vue';
import AdminPager from './AdminPager.vue';
import { makeListState, fetchPage } from './useAdminList.js';
import {
  fmtBytes, shortId, tone, resultLabel, sourceLabel,
} from './adminFormat.js';

const props = defineProps({
  active: { type: Boolean, default: false },
  refreshToken: { type: Number, default: 0 },
});

const state = makeListState(15);
const open = reactive({});

function toggle(id) {
  const key = `audit-${id}`;
  open[key] = !open[key];
}

async function load(reset = false) {
  if (reset) state.offset = 0;
  return fetchPage(
    state,
    `/admin/api/audit?limit=${state.limit}&offset=${state.offset}`,
    (data) => {
      state.rows = Array.isArray(data.rows) ? data.rows : [];
      state.total = Number(data.total) || 0;
    },
  );
}

async function page(dir) {
  if (state.paging) return;
  const next = state.offset + dir * state.limit;
  if (next < 0 || next >= state.total) return;
  state.offset = next;
  state.paging = true;
  await load();
}

// 首次进入该页签才请求；loaded 且无错误时切回不重复拉（与拆分前一致）
watch(() => props.active, (v) => {
  if (!v) return;
  if (state.loaded && !state.error) return;
  load();
}, { immediate: true });

// 顶栏「刷新」：重置到第一页重新拉
watch(() => props.refreshToken, () => { if (props.active) load(true); });

defineExpose({ reload: () => load(true) });
</script>
