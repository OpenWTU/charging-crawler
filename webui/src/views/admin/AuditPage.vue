<template>
  <div class="a-grid">
    <div class="a-toolbar">
      <button
v-for="t in tabs" :key="t.key" class="a-btn sm" :class="{ primary: tab === t.key }"
              @click="tab = t.key">
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
      <div class="a-pad a-small a-muted">
        上传审计表（upload_audit）目前还没有埋点写入，所以这里是空的。
        需要在 /api/snapshot 里补记录（P2 待办），补完即可看到每条上传的 IP/UA/大小/结果。
      </div>
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
