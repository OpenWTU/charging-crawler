<template>
  <div class="a-grid">
    <div class="a-toolbar">
      <button class="a-btn sm primary" :disabled="busy" @click="scan">{{ busy ? '体检中…' : '重新体检' }}</button>
      <span class="a-small a-muted">{{ scannedAt ? `上次扫描：${scannedAt}` : '' }}</span>
    </div>

    <p v-if="error" class="a-err">{{ error }}</p>

    <section v-if="!checks.length" class="a-panel a-empty">
      未发现问题（或还没有数据）
    </section>

    <section v-for="c in checks" :key="c.code" class="a-panel">
      <div class="a-head">
        <h2>
          <span class="a-tag" :class="c.level === 'red' ? 'err' : c.level === 'yellow' ? 'warn' : 'info'">
            {{ c.level === 'red' ? '严重' : c.level === 'yellow' ? '警告' : '提示' }}
          </span>
          {{ c.title }}
        </h2>
        <span class="a-small a-muted">{{ c.count }} 项</span>
      </div>
      <table v-if="c.samples.length" class="a-tbl">
        <thead>
          <tr>
            <th v-for="k in sampleKeys(c)" :key="k">{{ k }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(s, i) in c.samples" :key="i">
            <td v-for="k in sampleKeys(c)" :key="k" class="a-small">{{ fmt(s[k]) }}</td>
          </tr>
        </tbody>
      </table>
      <div class="a-pad">
        <button
v-if="canWrite && c.code === 'ghost_ports'" class="a-btn sm danger"
                @click="fixGhost">
清理全部幽灵端口
</button>
        <span v-else class="a-small a-muted">该项需人工处理（在对应页面操作）</span>
      </div>
    </section>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue';
import { useRole } from './useRole.js';
import { apiGet, apiPost } from '../../api/adminApi.js';

const checks = ref([]);
const scannedAt = ref('');
const busy = ref(false);
const error = ref('');
const { canWrite } = useRole();

function sampleKeys(c) {
  const first = c.samples?.[0];
  return first ? Object.keys(first).slice(0, 6) : [];
}
function fmt(v) {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'number') return Number.isInteger(v) ? v : v.toFixed(2);
  return String(v);
}

async function scan() {
  busy.value = true;
  error.value = '';
  try {
    const d = await apiGet('/admin/api/quality/scan');
    checks.value = d.checks || [];
    scannedAt.value = d.scanned_at || '';
  } catch (e) {
    error.value = e.message || '体检失败';
  } finally {
    busy.value = false;
  }
}

async function fixGhost() {
  if (!window.confirm('删除所有 24h 未更新的端口记录？')) return;
  try {
    const d = await apiPost('/admin/api/quality/fix', { kind: 'ghost_ports' });
    window.alert(`已清理 ${d.deleted} 条`);
    await scan();
  } catch (e) {
    error.value = e.message || '清理失败';
  }
}

onMounted(scan);
</script>
