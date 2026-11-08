<template>
  <div class="a-grid">
    <p v-if="error" class="a-err">{{ error }}</p>

    <section class="a-panel a-pad">
      <div class="a-toolbar">
        <h2 class="a-small">备份（{{ items.length }}）</h2>
        <span class="a-spacer" />
        <button class="a-btn sm primary" :disabled="busy" @click="create">{{ busy ? '备份中…' : '立即备份' }}</button>
        <button class="a-btn sm" @click="load">刷新</button>
      </div>
      <p class="a-small a-muted">用 VACUUM INTO 在线生成一致性快照，不影响服务；保留最近 10 份。</p>
      <table class="a-tbl" style="margin-top:10px">
        <thead><tr><th>文件</th><th class="num">大小</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="b in items" :key="b.name">
            <td class="a-mono a-small">{{ b.name }}</td>
            <td class="num">{{ (Number(b.size) || 0) > 0 ? ((b.size / 1024 / 1024).toFixed(2) + ' MB') : '—' }}</td>
            <td>
              <button class="a-btn sm" @click="download(b.name)">下载</button>
              <button class="a-btn sm danger" @click="restore(b.name)">恢复</button>
            </td>
          </tr>
          <tr v-if="!items.length"><td colspan="3" class="a-empty">还没有备份</td></tr>
        </tbody>
      </table>
    </section>

    <section class="a-panel a-pad">
      <h2 class="a-small">⚠ 恢复说明</h2>
      <p class="a-small a-muted">
        恢复会覆盖当前数据库。本页会先生成一份「恢复前」安全副本，并给出宿主机上的替换步骤
        （SQLite 文件不能在运行中热替换，需要重启服务）。
      </p>
      <p v-if="lastRestore" class="a-small">
        已登记恢复：{{ lastRestore.name }}（安全副本 {{ lastRestore.safety_copy }}）<br />
        <span class="a-mono a-small">{{ (lastRestore.manual_steps || []).join(' · ') }}</span>
      </p>
    </section>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue';
import { apiGet, apiPost } from '../../api/adminApi.js';

const items = ref([]);
const error = ref('');
const busy = ref(false);
const lastRestore = ref(null);

async function load() {
  error.value = '';
  try {
    const d = await apiGet('/admin/api/backup');
    items.value = d.items || [];
  } catch (e) {
    error.value = e.message || '加载失败';
  }
}

async function download(name) {
  // L21：原来用 <a> 伪装按钮，失败时会离开 SPA
  try {
    const resp = await fetch(`/admin/api/backup/download?name=${encodeURIComponent(name)}`, {
      credentials: 'same-origin',
    });
    if (!resp.ok) {
      let msg = `下载失败 HTTP ${resp.status}`;
      try { const d = await resp.json(); if (d && d.error) msg = d.error; } catch { /* 非 JSON */ }
      throw new Error(msg);
    }
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000); // L6：立即 revoke 会让部分浏览器截断下载
  } catch (e) {
    error.value = e.message || '下载失败';
  }
}

async function create() {
  busy.value = true;
  try {
    const d = await apiPost('/admin/api/backup/create', {});
    window.alert(`已生成 ${d.name}（${(d.size / 1024 / 1024).toFixed(2)} MB）`);
    await load();
  } catch (e) {
    error.value = e.message || '备份失败';
  } finally {
    busy.value = false;
  }
}

async function restore(name) {
  if (!window.confirm(`用 ${name} 覆盖当前数据库？`)) return;
  const confirm = window.prompt('输入 RESTORE 确认：');
  if (confirm !== 'RESTORE') { error.value = '未确认，已取消'; return; }
  try {
    const d = await apiPost('/admin/api/backup/restore', { name, confirm });
    lastRestore.value = { name, ...d };
    window.alert(d.note || '已登记恢复');
  } catch (e) {
    error.value = e.message || '恢复失败';
  }
}

onMounted(load);
</script>
