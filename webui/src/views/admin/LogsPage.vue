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
      <label class="a-small a-muted" title="跟随最新：自动滚到底部">
        <input v-model="follow" type="checkbox" @change="onFollow" /> 跟随最新
      </label>
      <span class="a-spacer" />
      <span class="a-small a-muted">缓冲 {{ stats.size }}/{{ stats.max }} 条</span>
    </div>

    <p v-if="error" class="a-err">{{ error }}</p>

    <section ref="boxRef" class="a-panel logbox">
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
import { onActivated, onBeforeUnmount, onDeactivated, ref, watch } from 'vue';
import { apiGet } from '../../api/adminApi.js';

const level = ref('');
const q = ref('');
const items = ref([]);
const stats = ref({ size: 0, max: 2000 });
const error = ref('');
const auto = ref(true);
// L23：日志是旧→新，最新在底部；加「跟随最新」避免每次手动滚
const follow = ref(true);
const boxRef = ref(null);

function onFollow() {
  if (follow.value) scrollBottom();
}

function scrollBottom() {
  const el = boxRef.value;
  if (el) el.scrollTop = el.scrollHeight;
}
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
    if (follow.value) scrollBottom();
  } catch (e) {
    error.value = e.message || '加载失败';
  }
}

function reschedule() {
  if (timer) clearInterval(timer);
  if (auto.value) timer = setInterval(load, 5000);
}

watch(auto, reschedule);
// S2（复审实测）：KeepAlive 不会 unmount，原来只在 onBeforeUnmount 清定时器 →
// 切走后仍每 5 秒打一次 /admin/api/logs（实测停 11.5s 发了 2 次），一直刷到退出登录。
onActivated(() => { load(); reschedule(); });
onDeactivated(() => { if (timer) { clearInterval(timer); timer = 0; } });
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
