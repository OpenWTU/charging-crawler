<template>
  <div class="a-grid">
    <div class="a-toolbar">
      <select v-model="level" class="a-select" @change="load">
        <option value="">全部级别</option>
        <option value="debug">debug+</option>
        <option value="info">info+</option>
        <option value="warn">warn+</option>
        <option value="error">error+</option>
      </select>
      <input v-model.trim="q" class="a-input" placeholder="关键字" @keyup.enter="load" />
      <button class="a-btn sm" @click="load">刷新</button>
      <label class="a-small a-muted">
        <input v-model="auto" type="checkbox" /> 自动刷新 5s
      </label>
      <span class="a-spacer" />
      <span class="a-small a-muted">缓冲 {{ stats.size }}/{{ stats.max }} 条</span>
    </div>

    <p v-if="error" class="a-err">{{ error }}</p>

    <section class="a-panel logbox">
      <div v-for="l in items" :key="l.seq" class="line" :class="lvClass(l.level)">
        <span class="t">{{ fmtTime(l.ts) }}</span>
        <span class="lv">{{ lvText(l.level) }}</span>
        <span class="msg">{{ l.msg || (l.extra ? JSON.stringify(l.extra) : '') }}</span>
      </div>
      <div v-if="!items.length" class="a-empty">暂无日志（重启后缓冲会清空）</div>
    </section>
  </div>
</template>

<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { apiGet } from '../../api/adminApi.js';

const level = ref('');
const q = ref('');
const items = ref([]);
const stats = ref({ size: 0, max: 2000 });
const error = ref('');
const auto = ref(true);
let timer = null;

const LV = { 10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal' };
const lvText = (n) => LV[n] || String(n);
const lvClass = (n) => (n >= 50 ? 'is-err' : n >= 40 ? 'is-warn' : n <= 20 ? 'is-dim' : '');

function fmtTime(ms) {
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

async function load() {
  error.value = '';
  try {
    const p = new URLSearchParams();
    if (level.value) p.set('level', level.value);
    if (q.value) p.set('q', q.value);
    p.set('limit', '300');
    const d = await apiGet(`/admin/api/logs?${p.toString()}`);
    items.value = d.items || [];
    stats.value = d.stats || stats.value;
  } catch (e) {
    error.value = e.message || '加载失败';
  }
}

function reschedule() {
  if (timer) clearInterval(timer);
  if (auto.value) timer = setInterval(load, 5000);
}

watch(auto, reschedule);
onMounted(() => { load(); reschedule(); });
onBeforeUnmount(() => { if (timer) clearInterval(timer); });
</script>

<style scoped>
.logbox { max-height: 70vh; overflow: auto; font-family: var(--font-mono); font-size: 12px; padding: 8px; }
.line { display: grid; grid-template-columns: 120px 50px 1fr; gap: 8px; padding: 2px 0; }
.line .t { color: var(--muted); }
.line .lv { color: var(--muted); text-transform: uppercase; }
.line .msg { white-space: pre-wrap; word-break: break-word; }
.line.is-err .msg { color: var(--danger, #dc2626); }
.line.is-warn .msg { color: var(--warn-fg, #b26a00); }
.line.is-dim { opacity: 0.65; }
</style>
