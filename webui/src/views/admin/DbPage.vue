<template>
  <div class="a-grid">
    <p v-if="error" class="a-err">{{ error }}</p>

    <section class="a-panel a-pad">
      <div class="a-toolbar">
        <h2 class="a-small">表</h2>
        <span class="a-spacer" />
        <button class="a-btn sm" @click="loadTables">刷新</button>
      </div>
      <div class="tables">
        <button
v-for="t in tables" :key="t.name" class="a-btn sm"
                :class="{ primary: table === t.name }" @click="openTable(t.name)">
          {{ t.name }} <span class="a-small a-muted">({{ t.rows < 0 ? '?' : t.rows }})</span>
        </button>
      </div>
    </section>

    <section v-if="table" class="a-panel">
      <div class="a-head"><h2>{{ table }}</h2><span class="a-small a-muted">{{ columns.length }} 列 · 显示 {{ rows.length }} 行</span></div>
      <div style="overflow:auto;max-height:60vh">
        <table class="a-tbl">
          <thead><tr><th v-for="c in columns" :key="c">{{ c }}</th></tr></thead>
          <tbody>
            <tr v-for="(r, i) in rows" :key="i">
              <td v-for="c in columns" :key="c" class="a-small wrap">{{ fmt(r[c]) }}</td>
            </tr>
            <tr v-if="!rows.length"><td :colspan="columns.length || 1" class="a-empty">空表</td></tr>
          </tbody>
        </table>
      </div>
      <div class="a-pad a-toolbar">
        <button class="a-btn sm" :disabled="offset === 0" @click="page(-1)">上一页</button>
        <button class="a-btn sm" @click="page(1)">下一页</button>
        <span class="a-small a-muted">offset {{ offset }}</span>
      </div>
    </section>

    <section class="a-panel a-pad">
      <h2 class="a-small">只读 SQL（仅超管）</h2>
      <p class="a-small a-muted">
        只允许单条 SELECT；自动补 LIMIT 5000；含 insert/update/delete/drop 等关键字会被拒；每次执行进审计。
      </p>
      <textarea v-model="sql" class="a-input sqlin" placeholder="SELECT * FROM snapshots ORDER BY id DESC LIMIT 20"></textarea>
      <div class="a-toolbar">
        <button class="a-btn sm primary" :disabled="busy" @click="runQuery">{{ busy ? '执行中…' : '执行' }}</button>
        <span v-if="ms !== null" class="a-small a-muted">耗时 {{ ms }} ms，{{ qRows.length }} 行</span>
      </div>
      <div v-if="qColumns.length" style="overflow:auto;max-height:40vh;margin-top:8px">
        <table class="a-tbl">
          <thead><tr><th v-for="c in qColumns" :key="c">{{ c }}</th></tr></thead>
          <tbody>
            <tr v-for="(r, i) in qRows" :key="i">
              <td v-for="c in qColumns" :key="c" class="a-small wrap">{{ fmt(r[c]) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue';
import { apiGet, apiPost } from '../../api/adminApi.js';

const tables = ref([]);
const table = ref('');
const columns = ref([]);
const rows = ref([]);
const offset = ref(0);
const sql = ref('SELECT * FROM snapshots ORDER BY id DESC LIMIT 20');
const qColumns = ref([]);
const qRows = ref([]);
const ms = ref(null);
const busy = ref(false);
const error = ref('');

function fmt(v) {
  if (v === null || v === undefined) return '—';
  const s = String(v);
  return s.length > 120 ? s.slice(0, 117) + '…' : s;
}

async function loadTables() {
  error.value = '';
  try {
    const d = await apiGet('/admin/api/db/tables');
    tables.value = d.tables || [];
  } catch (e) {
    error.value = e.message || '加载失败';
  }
}

async function openTable(name) {
  table.value = name;
  offset.value = 0;
  await fetchRows();
}

async function fetchRows() {
  try {
    const d = await apiGet(`/admin/api/db/rows?table=${encodeURIComponent(table.value)}&limit=100&offset=${offset.value}`);
    columns.value = d.columns || [];
    rows.value = d.rows || [];
  } catch (e) {
    error.value = e.message || '查询失败';
  }
}

function page(dir) {
  offset.value = Math.max(0, offset.value + dir * 100);
  fetchRows();
}

async function runQuery() {
  busy.value = true;
  error.value = '';
  try {
    const d = await apiPost('/admin/api/db/query', { sql: sql.value });
    qColumns.value = d.columns || [];
    qRows.value = d.rows || [];
    ms.value = d.ms ?? null;
  } catch (e) {
    error.value = e.message || '执行失败';
    qColumns.value = [];
    qRows.value = [];
  } finally {
    busy.value = false;
  }
}

onMounted(loadTables);
</script>

<style scoped>
.tables { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.sqlin {
  width: 100%; min-height: 90px; margin: 8px 0; padding: 8px 10px;
  font-family: var(--font-mono); font-size: 12px; line-height: 1.5;
  border: 1px solid var(--border, #d8dee9); border-radius: var(--r-sm);
  background: var(--card); color: var(--text); resize: vertical;
}
</style>
