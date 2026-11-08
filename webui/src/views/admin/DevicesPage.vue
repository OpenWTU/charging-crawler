<template>
  <div class="a-grid">
    <div class="a-toolbar">
      <button
v-for="f in filters" :key="f.key" class="a-btn sm"
              :class="{ primary: status === f.key }" @click="setStatus(f.key)">
        {{ f.label }}
        <span v-if="counts[f.key] !== undefined" class="a-small">({{ counts[f.key] }})</span>
      </button>
      <input v-model.trim="q" class="a-input" placeholder="搜索设备/型号" @keyup.enter="load" />
      <button class="a-btn sm" @click="load">刷新</button>
      <span class="a-spacer" />
      <span class="a-small a-muted">自动审批 {{ autoApprove ? '开' : '关' }}</span>
    </div>

    <p v-if="error" class="a-err">{{ error }}</p>

    <section class="a-panel">
      <table class="a-tbl">
        <thead>
          <tr>
            <th><input type="checkbox" :checked="allChecked" @change="toggleAll($event)" /></th>
            <th>设备 ID</th><th>型号</th><th>版本</th><th>状态</th>
            <th class="num">上传</th><th>最后活跃</th><th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="d in items" :key="d.device_id">
            <td><input v-model="checked" type="checkbox" :value="d.device_id" /></td>
            <td class="a-mono">{{ d.device_id.slice(0, 16) }}</td>
            <td>{{ d.model || '—' }}</td>
            <td class="a-mono a-small">{{ d.app_version || '—' }}</td>
            <td>
              <span class="a-tag" :class="d.status === 'approved' ? 'ok' : d.status === 'pending' ? 'warn' : 'err'">
                {{ statusText(d.status) }}
              </span>
            </td>
            <td class="num">{{ d.uploads }}</td>
            <td class="a-small">{{ d.last_seen || '—' }}</td>
            <td>
              <button class="a-btn sm" @click="detail(d.device_id)">详情</button>
              <button v-if="d.status === 'pending'" class="a-btn sm primary" @click="approve([d.device_id])">审批</button>
              <button
v-if="d.status !== 'revoked'" class="a-btn sm danger"
                      @click="revoke([d.device_id], true)">
拉黑
</button>
              <button v-else class="a-btn sm" @click="revoke([d.device_id], false)">恢复</button>
            </td>
          </tr>
          <tr v-if="!items.length"><td colspan="8" class="a-empty">没有设备</td></tr>
        </tbody>
      </table>
      <div v-if="checked.length" class="a-toolbar a-pad">
        <span class="a-small">已选 {{ checked.length }} 台</span>
        <button class="a-btn sm primary" @click="approve(checked)">批量审批</button>
        <button class="a-btn sm danger" @click="revoke(checked, true)">批量拉黑</button>
        <button class="a-btn sm" @click="del(checked)">批量删除</button>
      </div>
    </section>

    <div v-if="drawer" class="a-drawer-mask" @click.self="drawer = null">
      <aside class="a-drawer">
        <header>
          <h2>设备详情</h2>
          <button class="a-btn sm" @click="drawer = null">关闭</button>
        </header>
        <dl v-if="drawer.device" class="a-kv">
          <div><dt>设备 ID</dt><dd class="a-mono a-small">{{ drawer.device.device_id }}</dd></div>
          <div><dt>型号 / 版本</dt><dd>{{ drawer.device.model || '—' }} / {{ drawer.device.app_version || '—' }}</dd></div>
          <div><dt>状态</dt><dd>{{ statusText(drawer.device.status) }}</dd></div>
          <div><dt>上传次数</dt><dd>{{ drawer.device.uploads }}</dd></div>
          <div><dt>首次注册</dt><dd>{{ drawer.device.created_at }}</dd></div>
          <div><dt>最后活跃</dt><dd>{{ drawer.device.last_seen || '—' }}</dd></div>
        </dl>
        <h3 class="a-small a-muted">最近上传（{{ (drawer.snapshots || []).length }}）</h3>
        <table class="a-tbl">
          <thead><tr><th>时间</th><th>版本</th></tr></thead>
          <tbody>
            <tr v-for="s in drawer.snapshots" :key="s.id">
              <td>{{ s.received_at }}</td><td class="a-mono a-small">{{ s.app_version || '—' }}</td>
            </tr>
            <tr v-if="!(drawer.snapshots || []).length"><td colspan="2" class="a-empty">暂无</td></tr>
          </tbody>
        </table>
      </aside>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { apiGet, apiPost } from '../../api/adminApi.js';

const filters = [
  { key: '', label: '全部' },
  { key: 'approved', label: '正常' },
  { key: 'pending', label: '待审批' },
  { key: 'revoked', label: '已拉黑' },
];
const status = ref('');
const q = ref('');
const items = ref([]);
const counts = ref({});
const checked = ref([]);
const error = ref('');
const drawer = ref(null);

const allChecked = computed(() => items.value.length > 0 && checked.value.length === items.value.length);
const autoApprove = ref(true);

function statusText(s) {
  return s === 'approved' ? '正常' : s === 'pending' ? '待审批' : '已拉黑';
}

function setStatus(k) {
  status.value = k;
  load();
}

function toggleAll(e) {
  checked.value = e.target.checked ? items.value.map((d) => d.device_id) : [];
}

async function load() {
  error.value = '';
  try {
    const params = new URLSearchParams();
    if (status.value) params.set('status', status.value);
    if (q.value) params.set('q', q.value);
    params.set('limit', '100');
    const d = await apiGet(`/admin/api/devices?${params.toString()}`);
    items.value = d.items || [];
    counts.value = d.counts || {};
    checked.value = [];
  } catch (e) {
    error.value = e.message || '加载失败';
  }
}

async function detail(id) {
  drawer.value = { device: null, snapshots: [] };
  try {
    drawer.value = await apiGet(`/admin/api/devices/${encodeURIComponent(id)}`);
  } catch (e) {
    error.value = e.message || '详情加载失败';
  }
}

async function approve(ids) {
  try {
    await apiPost('/admin/api/devices/approve', { ids });
    await load();
  } catch (e) {
    error.value = e.message || '操作失败';
  }
}

async function revoke(ids, flag) {
  try {
    await apiPost('/admin/api/devices/revoke', { ids, revoked: flag });
    await load();
  } catch (e) {
    error.value = e.message || '操作失败';
  }
}

async function del(ids) {
  if (!window.confirm(`确定删除 ${ids.length} 台设备？（软删除，数据可追溯）`)) return;
  try {
    await apiPost('/admin/api/devices/delete', { ids });
    await load();
  } catch (e) {
    error.value = e.message || '删除失败';
  }
}

onMounted(async () => {
  await load();
  try {
    const s = await apiGet('/admin/api/settings');
    autoApprove.value = s.settings?.device_auto_approve !== false;
  } catch { /* 忽略 */ }
});
</script>
