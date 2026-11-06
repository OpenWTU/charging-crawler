<template>
  <section
id="admin-panel-tokens" class="panel"
           role="tabpanel" aria-labelledby="admin-tab-tokens" tabindex="0">
    <div class="panel-head">
      <div>
        <h2>令牌</h2>
        <p>App 上传时保存的用户令牌元数据，不回传令牌本身</p>
      </div>
      <span class="muted">{{ health.valid }} 有效 / {{ health.count }} 个</span>
    </div>
    <!-- token 池健康：字段缺失（旧后端）统一显示「—」 -->
    <div class="token-health" aria-label="令牌池健康">
      <div class="tk">
        <div class="tk-label">有效 / 总数</div>
        <div class="tk-value">{{ health.valid }}<small> / {{ health.count }}</small></div>
        <div class="tk-sub">当前可用于刷新的令牌数</div>
      </div>
      <div class="tk">
        <div class="tk-label">最早过期</div>
        <div class="tk-value small mono">{{ health.earliest }}</div>
        <div class="tk-sub">最早到期的有效令牌</div>
      </div>
      <div class="tk">
        <div class="tk-label">覆盖到</div>
        <div class="tk-value small mono">{{ health.cover }}</div>
        <div class="tk-sub">token 池可支撑刷新到此时</div>
      </div>
      <div class="tk">
        <div class="tk-label">长期令牌</div>
        <div class="tk-value small">{{ health.longLived }}</div>
        <div class="tk-sub">long_lived（不会短期过期）</div>
      </div>
    </div>
    <div v-if="!state.loaded && !state.error" class="empty">加载中…</div>
    <div v-else-if="state.error" class="fail">
      <span>令牌列表加载失败：{{ state.error }}</span>
      <button class="btn ghost sm" :disabled="state.loading" @click="load()">
        {{ state.loading ? '重试中…' : '重试' }}
      </button>
    </div>
    <div v-else-if="!state.rows.length" class="empty">暂无令牌</div>
    <div v-else class="table-wrap">
      <div class="table" role="table" aria-label="令牌列表">
        <div class="tr th" role="row">
          <span role="columnheader">用户 ID</span><span role="columnheader">状态</span><span role="columnheader">过期时间</span><span role="columnheader">更新时间</span>
        </div>
        <div v-for="t in state.rows" :key="t.user_id" class="tr" role="row">
          <span role="cell" class="mono">{{ t.user_id }}</span>
          <span role="cell"><span class="chip" :class="t.valid ? 'chip-ok' : 'chip-bad'">
            {{ t.valid ? '有效' : '已过期' }}</span></span>
          <span role="cell" class="mono">{{ fmtTs(t.expires_at) }}</span>
          <span role="cell" class="mono">{{ t.updated_at || '—' }}</span>
        </div>
      </div>
      <p class="scroll-hint muted" aria-hidden="true">左右滑动查看完整表格</p>
    </div>
    <AdminPager :state="state" @page="page" />
  </section>
</template>

<script setup>
/**
 * 令牌面板：令牌池健康四宫格 + 令牌列表（分页）。
 * 健康字段兼容嵌套 pool / 顶层平铺两种返回，缺失一律显示「—」。
 */
import { computed, reactive, watch } from 'vue';
import AdminPager from './AdminPager.vue';
import { makeListState, fetchPage } from './useAdminList.js';
import { fmtTs, fmtEpochAny, fmtLongLived } from './adminFormat.js';

const props = defineProps({
  active: { type: Boolean, default: false },
  refreshToken: { type: Number, default: 0 },
});

const state = makeListState(10);

// /admin/api/tokens 的 token 池新字段：都没有时保持 null，页面显示「—」
const pool = reactive({
  count: null,
  valid: null,
  earliest_exp: null,
  cover_until: null,
  long_lived: null,
});

function firstDefined(...vals) {
  for (const v of vals) {
    if (v !== null && v !== undefined && v !== '') return v;
  }
  return null;
}

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function fillPool(data) {
  if (!data || typeof data !== 'object') return;
  // 后端实际返回 pool；同时兼容 token_pool 与顶层平铺，便于新旧版本共存
  const p = data.token_pool && typeof data.token_pool === 'object' ? data.token_pool
    : (data.pool && typeof data.pool === 'object' ? data.pool : {});
  pool.count = numOrNull(firstDefined(p.count, data.total));
  pool.valid = numOrNull(firstDefined(p.valid, data.valid));
  pool.earliest_exp = firstDefined(p.earliest_exp, data.earliest_exp);
  pool.cover_until = firstDefined(p.cover_until, data.cover_until);
  pool.long_lived = firstDefined(p.long_lived, data.long_lived);
}

const health = computed(() => ({
  valid: pool.valid === null ? '—' : String(pool.valid),
  count: pool.count === null
    ? (state.loaded ? String(state.total) : '—')
    : String(pool.count),
  earliest: fmtEpochAny(pool.earliest_exp),
  cover: fmtEpochAny(pool.cover_until),
  longLived: fmtLongLived(pool.long_lived),
}));

async function load(reset = false) {
  if (reset) state.offset = 0;
  return fetchPage(
    state,
    `/admin/api/tokens?limit=${state.limit}&offset=${state.offset}`,
    (data) => {
      state.rows = Array.isArray(data.rows) ? data.rows : [];
      state.total = Number(data.total) || 0;
      state.valid = Number(data.valid) || 0;
      fillPool(data);
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

watch(() => props.active, (v) => {
  if (!v) return;
  if (state.loaded && !state.error) return;
  load();
}, { immediate: true });

watch(() => props.refreshToken, () => { if (props.active) load(true); });
</script>
