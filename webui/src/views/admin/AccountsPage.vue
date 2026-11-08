<template>
  <div class="a-grid">
    <p v-if="error" class="a-err">{{ error }}</p>

    <section class="a-panel">
      <div class="a-head"><h2>管理员账号（{{ accounts.length }}）</h2></div>
      <table class="a-tbl">
        <thead>
          <tr><th>用户名</th><th>角色</th><th>状态</th><th>最后登录</th><th>IP</th><th>操作</th></tr>
        </thead>
        <tbody>
          <tr v-for="a in accounts" :key="a.username">
            <td>{{ a.username }}<span v-if="a.must_change" class="a-tag warn" style="margin-left:6px">待改密</span></td>
            <td><span class="a-tag" :class="a.role === 'super' ? 'err' : a.role === 'ops' ? 'warn' : 'info'">{{ roleText(a.role) }}</span></td>
            <td><span class="a-tag" :class="a.disabled ? 'off' : 'ok'">{{ a.disabled ? '已禁用' : '启用' }}</span></td>
            <td class="a-small">{{ a.last_login_at || '—' }}</td>
            <td class="a-mono a-small">{{ a.last_login_ip || '—' }}</td>
            <td>
              <button class="a-btn sm" @click="resetPw(a.username)">重置口令</button>
              <button class="a-btn sm" :disabled="a.username === me?.username" @click="toggle(a)">
                {{ a.disabled ? '启用' : '禁用' }}
              </button>
              <button class="a-btn sm danger" :disabled="a.username === me?.username" @click="del(a.username)">删除</button>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <section class="a-panel a-pad">
      <h2 class="a-small">新增账号</h2>
      <div class="a-toolbar" style="margin-top:10px">
        <input v-model.trim="form.username" class="a-input" placeholder="用户名（3-32 位）" />
        <input v-model="form.password" class="a-input" placeholder="口令（≥10 位，含字母数字）" type="password" />
        <select v-model="form.role" class="a-select">
          <option value="viewer">只读</option>
          <option value="ops">运维</option>
          <option value="super">超级管理员</option>
        </select>
        <button class="a-btn sm primary" @click="add">创建</button>
      </div>
      <p class="a-small a-muted" style="margin-top:8px">
        角色能力：只读=只能看；运维=数据处理（清令牌/封设备/同步桩/跑任务），不能改配置；超管=全部。
      </p>
    </section>

    <section class="a-panel a-pad">
      <h2 class="a-small">改自己的口令</h2>
      <div class="a-toolbar" style="margin-top:10px">
        <input v-model="pw.old" class="a-input" type="password" placeholder="当前口令" />
        <input v-model="pw.next" class="a-input" type="password" placeholder="新口令" />
        <button class="a-btn sm primary" @click="changeOwn">修改</button>
      </div>
    </section>
  </div>
</template>

<script setup>
import { onActivated, reactive, ref } from 'vue';
import { apiDelete, apiGet, apiPost } from '../../api/adminApi.js';

const accounts = ref([]);
const me = ref(null);
const error = ref('');
const form = reactive({ username: '', password: '', role: 'viewer' });
const pw = reactive({ old: '', next: '' });

const roleText = (r) => (r === 'super' ? '超管' : r === 'ops' ? '运维' : '只读');

async function load() {
  error.value = '';
  try {
    me.value = await apiGet('/admin/api/me');
    const d = await apiGet('/admin/api/accounts');
    accounts.value = d.accounts || [];
  } catch (e) {
    error.value = e.message || '加载失败';
  }
}

async function add() {
  try {
    await apiPost('/admin/api/accounts', { ...form });
    form.username = ''; form.password = ''; form.role = 'viewer';
    await load();
  } catch (e) {
    error.value = e.message || '创建失败';
  }
}

async function toggle(a) {
  try {
    await apiPost('/admin/api/accounts/disable', { username: a.username, disabled: !a.disabled });
    await load();
  } catch (e) {
    error.value = e.message || '操作失败';
  }
}

async function resetPw(username) {
  const p = window.prompt(`给 ${username} 设置新口令（≥10 位，含字母数字）：`);
  if (!p) return;
  try {
    await apiPost('/admin/api/accounts/password', { username, password: p });
    window.alert('已重置，该账号下次登录需改密');
    await load();
  } catch (e) {
    error.value = e.message || '重置失败';
  }
}

async function del(username) {
  if (!window.confirm(`删除账号 ${username}？`)) return;
  try {
    await apiDelete(`/admin/api/accounts/${encodeURIComponent(username)}`);
    await load();
  } catch (e) {
    error.value = e.message || '删除失败';
  }
}

async function changeOwn() {
  try {
    await apiPost('/admin/api/password', { old: pw.old, new: pw.next });
    pw.old = ''; pw.next = '';
    window.alert('已修改');
  } catch (e) {
    error.value = e.message || '修改失败';
  }
}

// S1（复审实测）：KeepAlive 让页面只加载一次 —— 切回来是旧数据。
// 用 onActivated 替代 onMounted（首次挂载也会触发，不会双跑）。
onActivated(load);
</script>
