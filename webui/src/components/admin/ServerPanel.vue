<template>
  <section
id="admin-panel-server" class="panel"
           role="tabpanel" aria-labelledby="admin-tab-server" tabindex="0">
    <div class="panel-head">
      <div>
        <h2>服务器抓取</h2>
        <p>后台任务用有效令牌主动抓取的快照（来源 IP 为服务器）</p>
      </div>
      <span class="muted">{{ state.rows.length }} / {{ state.total }} 条</span>
    </div>
    <div v-if="!state.loaded && !state.error" class="empty">加载中…</div>
    <div v-else-if="state.error" class="fail">
      <span>服务器抓取记录加载失败：{{ state.error }}</span>
      <button class="btn ghost sm" :disabled="state.loading" @click="load()">
        {{ state.loading ? '重试中…' : '重试' }}
      </button>
    </div>
    <div v-else-if="!state.rows.length" class="empty">暂无服务器抓取记录</div>
    <ul v-else class="list">
      <li
v-for="s in state.rows" :key="s.id" class="item"
          :class="{ open: open['server-' + s.id] }">
        <div
class="item-head" role="button" tabindex="0"
             @click="toggle(s.id)"
             @keydown.enter.prevent="toggle(s.id)"
             @keydown.space.prevent="toggle(s.id)">
          <div class="item-main">
            <div class="item-title">
              <span class="chip chip-ok">{{ s.area_count }} 个区域</span>
              <span class="mono">{{ s.received_at }}</span>
            </div>
            <div class="item-sub">
              抓取于 {{ s.captured_at || '—' }}
              <template v-if="s.project"> · {{ s.project }}</template>
              · #{{ s.id }}
            </div>
          </div>
          <span class="chev">{{ open['server-' + s.id] ? '▾' : '▸' }}</span>
        </div>
        <div v-show="open['server-' + s.id]" class="detail">
          <div class="area-head">
            <span>区域</span><span>空闲 / 总数</span><span>充电</span><span>故障</span>
          </div>
          <div v-for="a in s.areas" :key="a.name" class="area-row">
            <span>{{ a.name }}</span>
            <span class="mono">{{ a.idle }} / {{ a.total }}</span>
            <span class="mono">{{ a.charging }}</span>
            <span class="mono" :class="{ bad: a.fault }">{{ a.fault }}</span>
          </div>
          <div v-if="!s.areas.length" class="muted">payload 中无区域明细</div>
          <dl class="meta">
            <div><dt>用户 ID</dt><dd class="mono">{{ s.token_user || '—' }}</dd></div>
            <div><dt>项目</dt><dd>{{ s.project || '—' }}</dd></div>
            <div><dt>抓取时间</dt><dd>{{ s.captured_at || '—' }}</dd></div>
            <div><dt>入库时间</dt><dd>{{ s.received_at || '—' }}</dd></div>
            <div><dt>payload 大小</dt><dd>{{ fmtBytes(s.size) }}</dd></div>
          </dl>
        </div>
      </li>
    </ul>
    <AdminPager :state="state" @page="page" />
  </section>
</template>

<script setup>
/**
 * ② 服务器抓取面板：后台任务抓取的快照列表（limit=10），展开看区域明细与元数据。
 */
import { reactive, watch } from 'vue';
import AdminPager from './AdminPager.vue';
import { makeListState, fetchPage } from './useAdminList.js';
import { fmtBytes } from './adminFormat.js';

const props = defineProps({
  active: { type: Boolean, default: false },
  refreshToken: { type: Number, default: 0 },
});

const state = makeListState(10);
const open = reactive({});

function toggle(id) {
  const key = `server-${id}`;
  open[key] = !open[key];
}

async function load(reset = false) {
  if (reset) state.offset = 0;
  return fetchPage(
    state,
    `/admin/api/server-snapshots?limit=${state.limit}&offset=${state.offset}`,
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

watch(() => props.active, (v) => {
  if (!v) return;
  if (state.loaded && !state.error) return;
  load();
}, { immediate: true });

watch(() => props.refreshToken, () => { if (props.active) load(true); });
</script>
