<template>
  <div class="a-grid">
    <div class="a-toolbar">
      <button
v-for="t in tabs" :key="t.key" class="a-btn sm" :class="{ primary: tab === t.key }"
              @click="switchTab(t.key)">
{{ t.label }}
</button>
      <span class="a-spacer" />
      <button class="a-btn sm" @click="load">刷新</button>
    </div>

    <p v-if="error" class="a-err">{{ error }}</p>

    <section v-if="tab === 'admin'" class="a-panel">
      <div class="a-toolbar a-pad">
        <input v-model.trim="fUsername" class="a-input" placeholder="账号" @keyup.enter="load" />
        <input v-model.trim="fAction" class="a-input" placeholder="动作（login/purge/…）" @keyup.enter="load" />
      </div>
      <table class="a-tbl">
        <thead><tr><th>时间</th><th>账号</th><th>动作</th><th>对象</th><th>IP</th><th>结果</th></tr></thead>
        <tbody>
          <tr v-for="r in adminRows" :key="r.id">
            <td class="a-small">{{ r.ts }}</td>
            <td>{{ r.username || '—' }}</td>
            <td><span class="a-tag info">{{ r.action }}</span></td>
            <td class="a-mono a-small wrap">{{ r.target || '—' }}</td>
            <td class="a-mono a-small">{{ r.ip || '—' }}</td>
            <td><span class="a-tag" :class="r.ok ? 'ok' : 'err'">{{ r.ok ? '成功' : '失败' }}</span></td>
          </tr>
          <tr v-if="!adminRows.length"><td colspan="6" class="a-empty">暂无记录</td></tr>
        </tbody>
      </table>
    </section>

    <section v-else class="a-panel">
      <div class="a-toolbar a-pad">
        <select v-model="upResult" class="a-select" @change="loadUpload">
          <option value="">全部结果</option>
          <option value="ok">成功</option>
          <option value="fail">失败</option>
        </select>
        <button class="a-btn sm" @click="loadUpload">刷新</button>
        <span class="a-spacer" />
        <span class="a-small a-muted">共 {{ upRows.length }} 条</span>
      </div>
      <table class="a-tbl">
        <thead><tr><th>时间</th><th>IP</th><th class="num">大小</th><th>结果</th><th>原因</th><th>设备</th></tr></thead>
        <tbody>
          <tr v-for="r in upRows" :key="r.id">
            <td class="a-small">{{ r.ts }}</td>
            <td class="a-mono a-small">{{ r.ip || '—' }}</td>
            <td class="num">{{ r.size ? (r.size / 1024).toFixed(1) + ' KB' : '—' }}</td>
            <td><span class="a-tag" :class="r.result === 'ok' ? 'ok' : 'err'">{{ r.result || '—' }}</span></td>
            <td class="a-small a-muted">{{ r.detail?.reason || '—' }}</td>
            <td class="a-mono a-small">{{ r.detail?.device_id ? r.detail.device_id.slice(0, 10) : '—' }}</td>
          </tr>
          <tr v-if="!upRows.length"><td colspan="6" class="a-empty">还没有上传记录</td></tr>
        </tbody>
      </table>
    </section>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue';
import { apiGet } from '../../api/adminApi.js';

const tabs = [
  { key: 'admin', label: '管理操作' },
  { key: 'upload', label: '上传记录' },
];
const tab = ref('admin');
const adminRows = ref([]);
const upRows = ref([]);
const upResult = ref('');
const fUsername = ref('');
const fAction = ref('');
const error = ref('');

function switchTab(k) {
  tab.value = k;
  if (k === 'upload') void loadUpload();
  else void load();
}

async function load() {
  error.value = '';
  try {
    const p = new URLSearchParams();
    if (fUsername.value) p.set('username', fUsername.value);
    if (fAction.value) p.set('action', fAction.value);
    p.set('limit', '100');
    const d = await apiGet(`/admin/api/audit?${p.toString()}`);
    adminRows.value = d.items || [];
  } catch (e) {
    error.value = e.message || '加载失败';
  }
}

async function loadUpload() {
  error.value = '';
  try {
    const p = new URLSearchParams();
    if (upResult.value) p.set('result', upResult.value);
    p.set('limit', '100');
    const d = await apiGet(`/admin/api/audit/upload?${p.toString()}`);
    upRows.value = d.items || [];
  } catch (e) {
    error.value = e.message || '加载失败';
  }
}

onMounted(() => {
  load();
  loadUpload();
});
</script>
