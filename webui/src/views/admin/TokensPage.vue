<template>
  <div class="tokens">
    <!-- 健康卡 -->
    <section class="panel health" :class="{ bad: stats.valid === 0 && stats.count > 0 }">
      <div class="big">
        <span class="num">{{ stats.valid }} / {{ stats.count }}</span>
        <span class="lbl">有效 / 总数</span>
      </div>
      <div class="meta">
        <div>
          <span class="lbl">覆盖到</span>
          <b>{{ coverText }}</b>
        </div>
        <div>
          <span class="lbl">最快到期</span>
          <b>{{ expText }}</b>
        </div>
        <button v-if="canWrite" class="btn ghost sm" :disabled="busy" @click="purge">
          {{ busy ? '处理中…' : '清空已过期' }}
        </button>
      </div>
    </section>

    <p v-if="error" class="a-err">{{ error }}</p>
    <p v-if="stats.valid === 0 && stats.count > 0" class="hint">
      ⚠ 令牌池已全部过期，服务器无法抓取。请打开手机 App →「令牌」页 → 重新获取，抓完会自动上传，这里 30 秒内刷新。
    </p>

    <!-- 表格 -->
    <section class="panel">
      <table class="tbl">
        <thead>
          <tr>
            <th>用户 ID</th>
            <th>来源</th>
            <th>过期时间</th>
            <th class="num">剩余</th>
            <th>状态</th>
            <th>最后错误</th>
            <th class="num">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="t in list" :key="t.id">
            <td class="mono">{{ t.user_id || '—' }}</td>
            <td>{{ t.source || '—' }}</td>
            <td class="mono">{{ fmtTs(t.expires_at) }}</td>
            <td class="num">{{ remainText(t) }}</td>
            <td>
              <span class="tag" :class="t.status === 'valid' ? 'ok' : 'off'">
                {{ t.status === 'valid' ? '有效' : '已过期' }}
              </span>
            </td>
            <td class="err-cell" :title="t.last_error || ''">{{ t.last_error || '—' }}</td>
            <td class="num">
              <button v-if="canWrite" class="btn ghost sm" :disabled="busy" @click="del(t.id)">删除</button>
            </td>
          </tr>
          <tr v-if="!list.length">
            <td colspan="7" class="muted empty">令牌池为空</td>
          </tr>
        </tbody>
      </table>
    </section>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { useRole } from './useRole.js';
import { apiGet, apiPost } from '../../api/adminApi.js';

const emit = defineEmits(['changed']);

const stats = ref({ count: 0, valid: 0, earliest_exp: null, cover_until: null, long_lived: 0 });
const list = ref([]);
const busy = ref(false);
const error = ref('');
const { canWrite } = useRole();

const coverText = computed(() => fmtTs(stats.value.cover_until));
const expText = computed(() => {
  const e = stats.value.earliest_exp;
  if (!e) return '—';
  const left = Number(e) - Math.floor(Date.now() / 1000);
  if (left <= 0) return '已全部过期';
  const m = Math.floor(left / 60);
  return m < 60 ? `${m} 分钟后` : `${Math.floor(m / 60)} 小时 ${m % 60} 分后`;
});

function fmtTs(sec) {
  const n = Number(sec);
  if (!n) return '—';
  const d = new Date(n * 1000);
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function remainText(t) {
  if (!t.remain_sec) return '—';
  if (t.remain_sec <= 0) return '已过期';
  const m = Math.floor(t.remain_sec / 60);
  return m < 60 ? `${m} 分` : `${Math.floor(m / 60)} 时 ${m % 60} 分`;
}

async function load() {
  try {
    const d = await apiGet('/admin/api/tokens');
    stats.value = d.stats || stats.value;
    list.value = d.list || [];
  } catch {
    /* 保留旧数据 */
  }
}

async function purge() {
  if (busy.value) return;
  if (!window.confirm('清空所有已过期令牌？此操作不可撤销。')) return;
  busy.value = true;
  error.value = '';
  try {
    const d = await apiPost('/admin/api/tokens/purge', {});
    await load();
    emit('changed');
    if (!d.deleted) error.value = '没有需要清理的过期令牌';
  } catch (e) {
    // S5：原来没有 catch，403 时页面上什么都没发生
    error.value = e.message || '清理失败';
  } finally {
    busy.value = false;
  }
}

async function del(id) {
  if (busy.value) return;
  if (!window.confirm('删除该令牌？')) return;
  busy.value = true;
  error.value = '';
  try {
    await apiPost('/admin/api/tokens/delete', { ids: [id] });
    await load();
    emit('changed');
  } catch (e) {
    error.value = e.message || '删除失败';
  } finally {
    busy.value = false;
  }
}

onMounted(load);
</script>

<style scoped>
.tokens { display: grid; gap: var(--sp-3); }
.panel { background: var(--card); border-radius: var(--r-md); box-shadow: var(--shadow-card); overflow: auto; }
.health { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-4); padding: var(--sp-4); flex-wrap: wrap; }
.health.bad { border: 1px solid var(--danger, #dc2626); }
.big { display: flex; flex-direction: column; }
.big .num { font-size: 42px; font-weight: var(--fw-semibold); line-height: 1; }
.health.bad .big .num { color: var(--danger, #dc2626); }
.lbl { font-size: var(--fs-12); color: var(--muted); }
.meta { display: flex; align-items: center; gap: var(--sp-4); font-size: var(--fs-13, 13px); flex-wrap: wrap; }
.meta > div { display: flex; flex-direction: column; gap: 2px; }
.hint {
  background: #fff4e5; color: #b26a00; border-radius: var(--r-sm);
  padding: var(--sp-3); font-size: var(--fs-13, 13px); margin: 0;
}
.tbl { width: 100%; border-collapse: collapse; font-size: var(--fs-13, 13px); }
.tbl th, .tbl td { padding: 8px 10px; text-align: left; border-bottom: 1px solid var(--border, #eef1f5); }
.tbl th { font-size: var(--fs-12); color: var(--muted); font-weight: var(--fw-medium); }
.mono { font-family: var(--font-mono); }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.tag { font-size: 11px; padding: 1px 8px; border-radius: 999px; }
.tag.ok { background: #ecfdf5; color: #047857; }
.tag.off { background: var(--neutral-bg, #f3f4f6); color: var(--muted); }
.err-cell { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--danger, #dc2626); }
.empty { text-align: center; padding: 24px; }
.muted { color: var(--muted); }
</style>
