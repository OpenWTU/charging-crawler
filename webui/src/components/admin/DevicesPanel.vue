<template>
  <section
id="admin-panel-devices" class="panel"
           role="tabpanel" aria-labelledby="admin-tab-devices" tabindex="0">
    <div class="panel-head">
      <div>
        <h2>设备</h2>
        <p>HMAC 签名上传的 App 设备，可撤销或恢复授权</p>
      </div>
      <span class="muted">{{ state.rows.length }} / {{ state.total }} 台</span>
    </div>
    <div class="toolbar">
      <label class="switch">
        <input
type="checkbox" :checked="approval === true"
               :disabled="saving || approval === null"
               @change="toggleApproval($event)" />
        <span class="switch-track"><span class="switch-dot"></span></span>
        <span class="switch-text">新设备需审批</span>
      </label>
      <span v-if="approval === null" class="muted">审批设置未知（读取失败）</span>
      <span v-else class="muted">开启后新设备注册为「待审批」，管理员通过后才能上传数据</span>
      <span v-if="saving" class="muted">保存中…</span>
    </div>
    <div v-if="!state.loaded && !state.error" class="empty">加载中…</div>
    <div v-else-if="state.error" class="fail">
      <span>设备列表加载失败：{{ state.error }}</span>
      <button class="btn ghost sm" :disabled="state.loading" @click="load()">
        {{ state.loading ? '重试中…' : '重试' }}
      </button>
    </div>
    <div v-else-if="!state.rows.length" class="empty">暂无设备</div>
    <ul v-else class="list">
      <li v-for="d in state.rows" :key="d.device_id" class="item static">
        <div class="item-head">
          <div class="item-main">
            <div class="item-title">
              <span class="mono">{{ d.device_id }}</span>
              <span class="chip" :class="deviceStatusClass(d)">{{ deviceStatusText(d) }}</span>
            </div>
            <div class="item-sub">
              {{ d.model || '未知机型' }} · App v{{ d.app_version || '—' }} ·
              上传 {{ d.uploads }} 次
            </div>
            <div class="item-sub">
              注册 {{ d.created_at || '—' }} · 最近 {{ d.last_seen || '—' }}
            </div>
          </div>
          <div class="row-actions">
            <template v-if="isPending(d)">
              <button class="btn sm success" :disabled="locking" @click="approve(d, true)">通过</button>
              <button class="btn sm danger" :disabled="locking" @click="approve(d, false)">拒绝</button>
            </template>
            <button
v-else class="btn sm" :disabled="locking"
                    :class="isRevoked(d) ? 'success' : 'danger'"
                    @click="revoke(d)">
{{ isRevoked(d) ? '恢复' : '撤销' }}
</button>
          </div>
        </div>
      </li>
    </ul>
    <AdminPager :state="state" @page="page" />
  </section>
</template>

<script setup>
/**
 * ③ 设备面板：设备列表 + 审批开关（null=未知，绝不默认关闭）+ 撤销/恢复/审批动作。
 * 审批设置与列表并行加载：设置读不到时开关禁用并提示「审批设置未知」。
 */
import { ref, watch } from 'vue';
import AdminPager from './AdminPager.vue';
import { adminRequest, adminPost } from '../../api/index.js';
import { makeListState, fetchPage } from './useAdminList.js';
import {
  shortId, isRevoked, isPending, deviceStatusText, deviceStatusClass, applyDevice,
} from './adminFormat.js';
import { useAdminUi } from './adminUi.js';

const props = defineProps({
  active: { type: Boolean, default: false },
  refreshToken: { type: Number, default: 0 },
});

const ui = useAdminUi();
const state = makeListState(10);

// null = 未知（尚未读到/读取失败），不可当成 false
const approval = ref(null);
const saving = ref(false);
const locking = ref(false);
let settingsSeq = 0;

async function loadSettings() {
  settingsSeq += 1;
  const seq = settingsSeq;
  try {
    const d = await adminRequest('/admin/api/settings');
    if (seq !== settingsSeq) return false;
    approval.value = typeof d.device_approval === 'boolean' ? d.device_approval : null;
    return true;
  } catch {
    // 读取失败保持未知（或上一次的已知值），不默认 false
    return false;
  }
}

async function load(reset = false) {
  if (reset) state.offset = 0;
  return fetchPage(
    state,
    `/admin/api/devices?limit=${state.limit}&offset=${state.offset}`,
    (data) => {
      state.rows = Array.isArray(data.rows) ? data.rows : [];
      state.total = Number(data.total) || 0;
    },
  );
}

async function loadWithSettings(reset = false) {
  const [ok] = await Promise.all([load(reset), loadSettings()]);
  return ok;
}

async function page(dir) {
  if (state.paging) return;
  const next = state.offset + dir * state.limit;
  if (next < 0 || next >= state.total) return;
  state.offset = next;
  state.paging = true;
  await load();
}

async function toggleApproval(ev) {
  if (saving.value || approval.value === null) return;
  const next = Boolean(ev.target.checked);
  const prev = approval.value;
  saving.value = true;
  ui.clearAlerts();
  try {
    const d = await adminPost('/admin/api/settings', { device_approval: next });
    approval.value = typeof d.device_approval === 'boolean' ? d.device_approval : next;
    ui.showOk(approval.value ? '已开启新设备审批' : '已关闭新设备审批');
  } catch (err) {
    approval.value = prev;
    ev.target.checked = prev === true;
    ui.showError(err);
  } finally {
    saving.value = false;
  }
}

async function approve(device, ok) {
  if (locking.value) return;
  locking.value = true;
  ui.clearAlerts();
  try {
    const d = await adminPost('/admin/api/device/approve', { device_id: device.device_id, approved: ok });
    applyDevice(device, { status: d && d.status });
    await Promise.all([load(), ui.refreshSummary()]);
    ui.showOk(ok
      ? `设备 ${shortId(device.device_id)} 已通过审批`
      : `设备 ${shortId(device.device_id)} 已拒绝`);
  } catch (err) {
    ui.showError(err);
  } finally {
    locking.value = false;
  }
}

async function revoke(device) {
  const wasRevoked = isRevoked(device);
  if (!confirm(`确认${wasRevoked ? '恢复' : '撤销'}设备 ${shortId(device.device_id)}？`)) return;
  if (locking.value) return;
  locking.value = true;
  ui.clearAlerts();
  try {
    const d = await adminPost('/admin/api/device/revoke', {
      device_id: device.device_id, revoked: !wasRevoked,
    });
    const nowRevoked = typeof d.revoked === 'boolean' ? d.revoked : !wasRevoked;
    applyDevice(device, { revoked: nowRevoked });
    await Promise.all([load(), ui.refreshSummary()]);
    ui.showOk(nowRevoked ? '设备已撤销' : '设备已恢复');
  } catch (err) {
    ui.showError(err);
  } finally {
    locking.value = false;
  }
}

watch(() => props.active, (v) => {
  if (!v) return;
  if (state.loaded && !state.error) return;
  loadWithSettings();
}, { immediate: true });

watch(() => props.refreshToken, () => { if (props.active) loadWithSettings(true); });


</script>
