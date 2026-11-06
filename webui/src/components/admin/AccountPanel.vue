<template>
  <section
id="admin-panel-account" class="panel"
           role="tabpanel" aria-labelledby="admin-tab-account" tabindex="0">
    <div class="panel-head">
      <div>
        <h2>账户</h2>
        <p>修改当前账号密码；可新增管理员账号（弱密码会被拒绝）</p>
      </div>
      <span class="muted">{{ users.length }} 个账号</span>
    </div>
    <div class="account">
      <div class="form">
        <h3>修改密码</h3>
        <input v-model="pwOld" type="password" placeholder="原密码" />
        <input v-model="pwNew" type="password" placeholder="新密码（≥8 位，字母+数字）" />
        <button class="btn" @click="changePassword">保存</button>
      </div>
      <div class="form">
        <h3>新增管理员</h3>
        <input v-model="newUser" placeholder="用户名（3-32 位）" />
        <input v-model="newPass" type="password" placeholder="初始密码（≥8 位，字母+数字）" />
        <button class="btn" @click="createUser">创建</button>
      </div>
    </div>
    <ul class="list">
      <li v-for="u in users" :key="u.username" class="item">
        <div class="item-head">
          <b>{{ u.username }}</b>
          <span class="muted">创建 {{ u.created_at }}</span>
        </div>
      </li>
    </ul>
  </section>
</template>

<script setup>
/**
 * 账户面板：改密码 / 新增管理员 / 账号列表。
 * 失败提示统一走 adminUi（顶栏下方那条可关闭的红条）。
 */
import { ref, watch } from 'vue';
import { adminRequest, adminPost } from '../../api/index.js';
import { useAdminUi } from './adminUi.js';

const props = defineProps({
  active: { type: Boolean, default: false },
  refreshToken: { type: Number, default: 0 },
});

const ui = useAdminUi();

const users = ref([]);
const pwOld = ref('');
const pwNew = ref('');
const newUser = ref('');
const newPass = ref('');
let usersSeq = 0;

async function loadUsers() {
  usersSeq += 1;
  const seq = usersSeq;
  try {
    const d = await adminRequest('/admin/api/users');
    if (seq !== usersSeq) return false;
    users.value = Array.isArray(d.rows) ? d.rows : [];
    return true;
  } catch (e) {
    if (seq !== usersSeq) return false;
    users.value = [];
    ui.showError(e);
    return false;
  }
}

async function changePassword() {
  ui.clearAlerts();
  try {
    await adminPost('/admin/api/password', { old: pwOld.value, new: pwNew.value });
    pwOld.value = ''; pwNew.value = '';
    ui.showOk('密码已更新');
  } catch (err) {
    ui.showError(err);
  }
}

async function createUser() {
  ui.clearAlerts();
  try {
    await adminPost('/admin/api/users', { username: newUser.value, password: newPass.value });
    newUser.value = ''; newPass.value = '';
    await loadUsers();
    ui.showOk('账号已创建');
  } catch (err) {
    ui.showError(err);
  }
}

watch(() => props.active, (v) => { if (v) loadUsers(); }, { immediate: true });
watch(() => props.refreshToken, () => { if (props.active) loadUsers(); });
</script>
