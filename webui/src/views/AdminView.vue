<template>
  <div class="admin">
    <AdminTopBar
:summary="summary" :refreshing="refreshing" :exporting="exporting"
                 @refresh="refreshAll" @export="exportCsv" @logout="logout" />

    <AdminStats :cards="statCards" />

    <AdminTabs :tabs="tabs" :tab="tab" @switch="switchTab" />

    <AdminAlerts
:error-msg="errorMsg" :success-msg="successMsg" :anomalies="anomalies"
                 @clear="clearAlerts" />

    <!-- ① 上传审计 -->
    <AuditPanel v-show="tab === 'audit'" :active="tab === 'audit'" :refresh-token="refreshToken" />
    <!-- ② 服务器抓取 -->
    <ServerPanel v-show="tab === 'server'" :active="tab === 'server'" :refresh-token="refreshToken" />
    <!-- ③ 设备 -->
    <DevicesPanel v-show="tab === 'devices'" :active="tab === 'devices'" :refresh-token="refreshToken" />
    <!-- 控制器 -->
    <ControllersPanel
v-show="tab === 'controllers'" :active="tab === 'controllers'"
                      :refresh-token="refreshToken" />
    <!-- ④ 令牌 -->
    <TokensPanel v-show="tab === 'tokens'" :active="tab === 'tokens'" :refresh-token="refreshToken" />
    <!-- 账户 -->
    <AccountPanel v-show="tab === 'account'" :active="tab === 'account'" :refresh-token="refreshToken" />
    <!-- 区域 -->
    <AreasPanel v-show="tab === 'areas'" :active="tab === 'areas'" :refresh-token="refreshToken" />
    <!-- ⑤ 系统 -->
    <SystemPanel v-show="tab === 'system'" :active="tab === 'system'" :refresh-token="refreshToken" />

    <footer class="foot">
      充电桩数据后台 · Cookie 会话 12 小时 · 所有操作仅对本服务生效
    </footer>
  </div>
</template>

<script setup>
/**
 * 管理后台装配层：顶栏 / 统计卡 / 分区页签 / 全局提示 + 8 个面板。
 *
 * 数据边界：
 *  - 统计卡与异常清单属于「全局」，在这里加载（面板动作后可要求重拉 summary）；
 *  - 每个面板自己按 active 懒加载、按 refreshToken 刷新（与拆分前 switchTab/refreshAll 语义一致）；
 *  - 成功/失败提示通过 adminUi 的 provide/inject 下发给面板，避免 props 逐层传函数。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { adminRequest, exportCsv as adminExportCsv, logout as adminLogout } from '../api/index.js';
import { errorText } from '../components/admin/useAdminList.js';
import { provideAdminUi } from '../components/admin/adminUi.js';
import { fmtNum } from '../components/admin/adminFormat.js';
import AdminTopBar from '../components/admin/AdminTopBar.vue';
import AdminStats from '../components/admin/AdminStats.vue';
import AdminTabs from '../components/admin/AdminTabs.vue';
import AdminAlerts from '../components/admin/AdminAlerts.vue';
import AuditPanel from '../components/admin/AuditPanel.vue';
import ServerPanel from '../components/admin/ServerPanel.vue';
import DevicesPanel from '../components/admin/DevicesPanel.vue';
import ControllersPanel from '../components/admin/ControllersPanel.vue';
import TokensPanel from '../components/admin/TokensPanel.vue';
import AccountPanel from '../components/admin/AccountPanel.vue';
import AreasPanel from '../components/admin/AreasPanel.vue';
import SystemPanel from '../components/admin/SystemPanel.vue';

const tabs = [
  { key: 'audit', label: '上传审计' },
  { key: 'server', label: '服务器抓取' },
  { key: 'devices', label: '设备' },
  { key: 'controllers', label: '控制器' },
  { key: 'tokens', label: '令牌' },
  { key: 'account', label: '账户' },
  { key: 'areas', label: '区域' },
  { key: 'system', label: '系统' },
];

const tab = ref('audit');
const refreshing = ref(false);
const exporting = ref('');
const errorMsg = ref('');
const successMsg = ref('');
const anomalies = ref([]);
const summary = ref(null);
const summaryError = ref('');
// 递增即要求当前面板重拉（顶栏「刷新」）
const refreshToken = ref(0);

function clearAlerts() {
  errorMsg.value = '';
  successMsg.value = '';
}

function showOk(msg) {
  errorMsg.value = '';
  successMsg.value = msg;
}

function showError(err) {
  successMsg.value = '';
  errorMsg.value = errorText(err);
}

async function loadSummary() {
  try {
    const d = await adminRequest('/admin/api/summary');
    summary.value = d;
    summaryError.value = '';
  } catch (err) {
    summaryError.value = errorText(err);
    throw err;
  }
}

// 面板动作（撤销设备等）后同步统计卡：失败静默，不打断面板操作
async function refreshSummary() {
  try { await loadSummary(); } catch { /* ignore */ }
}

async function loadAnomalies() {
  try {
    const d = await adminRequest('/admin/api/anomalies');
    anomalies.value = Array.isArray(d.items) ? d.items : [];
  } catch {
    anomalies.value = [];
  }
}

async function switchTab(name) {
  tab.value = name;
  clearAlerts();
}

async function refreshAll() {
  if (refreshing.value) return;
  refreshing.value = true;
  clearAlerts();
  try {
    await Promise.all([loadSummary(), loadAnomalies()]);
  } catch (err) {
    showError(err);
  } finally {
    refreshToken.value += 1;
    refreshing.value = false;
  }
}

async function exportCsv(table) {
  if (exporting.value) return;
  exporting.value = table;
  clearAlerts();
  try {
    const blob = await adminExportCsv(table);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `charge-${table}.csv`;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showOk(`已导出 charge-${table}.csv`);
  } catch (err) {
    if (err && err.code === 401) return; // 已跳登录页
    showError(err);
  } finally {
    exporting.value = '';
  }
}

async function logout() {
  await adminLogout();
}

const statCards = computed(() => {
  const s = summary.value;
  if (!s) {
    const sub = summaryError.value ? '加载失败' : '加载中…';
    return [
      { label: '总上传次数', value: '—', sub },
      { label: '用户上传数', value: '—', sub },
      { label: '服务器抓取数', value: '—', sub },
      { label: '设备数', value: '—', sub },
      { label: '有效令牌', value: '—', sub },
      { label: '最近抓取', value: '—', sub, small: true },
    ];
  }
  return [
    { label: '总上传次数', value: fmtNum(s.uploads_total), sub: `成功 ${fmtNum(s.uploads_ok)} 次` },
    { label: '用户上传数', value: fmtNum(s.user_uploads), sub: 'App 设备签名上传' },
    { label: '服务器抓取数', value: fmtNum(s.server_snapshots), sub: '后台任务自动抓取' },
    { label: '设备数', value: fmtNum(s.devices), sub: `已撤销 ${fmtNum(s.devices_revoked)} 台` },
    { label: '有效令牌', value: fmtNum(s.tokens_valid), sub: `共 ${fmtNum(s.tokens)} 个` },
    { label: '最近抓取', value: s.last_capture_at || '—', sub: `服务器抓取 ${s.last_server_capture_at || '—'}`, small: true },
  ];
});

provideAdminUi({ clearAlerts, showOk, showError, refreshSummary });

// 管理后台跟随系统深浅色：在 <html> 上切换 .theme-dark，令牌一并生效
let darkQuery = null;
function applyColorScheme(dark) {
  if (typeof document === 'undefined' || !document.documentElement) return;
  document.documentElement.classList.toggle('theme-dark', !!dark);
}
function onSchemeChange(e) {
  applyColorScheme(e.matches);
}

onMounted(async () => {
  try {
    darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
    applyColorScheme(darkQuery.matches);
    if (typeof darkQuery.addEventListener === 'function') {
      darkQuery.addEventListener('change', onSchemeChange);
    } else if (typeof darkQuery.addListener === 'function') {
      darkQuery.addListener(onSchemeChange);
    }
  } catch { /* 无 matchMedia 时保持浅色 */ }
  clearAlerts();
  try {
    await Promise.all([loadSummary(), loadAnomalies()]);
  } catch (err) {
    showError(err);
  }
});

onUnmounted(() => {
  try {
    if (!darkQuery) return;
    if (typeof darkQuery.removeEventListener === 'function') {
      darkQuery.removeEventListener('change', onSchemeChange);
    } else if (typeof darkQuery.removeListener === 'function') {
      darkQuery.removeListener(onSchemeChange);
    }
  } catch { /* ignore */ }
});
</script>
