<template>
  <div class="settings-page">
    <h2 class="page-title">设置</h2>

    <div class="group">
      <div class="group-label">账户</div>
      <van-cell-group inset class="group-card">
        <van-cell title="登录令牌" :label="tokenDetail">
          <template #value>
            <span class="state-badge" :class="statusClass">
              <i v-if="valid"></i>{{ statusText }}
            </span>
          </template>
        </van-cell>
        <van-cell
          title="重新获取令牌"
          :label="reacquiring ? '抓取中：打开微信 → 快充公众号 → 单车充电' : '打开微信 → 快充公众号 → 单车充电'"
          is-link
          :class="{ 'is-busy': reacquiring }"
          @click="reacquire"
        >
          <template #right-icon>
            <van-loading v-if="reacquiring" size="14" color="currentColor" />
            <van-icon v-else name="arrow" />
          </template>
        </van-cell>
        <van-cell title="清除令牌" class="danger-cell" is-link @click="clear" />
      </van-cell-group>
    </div>

    <div class="group">
      <div class="group-label">上传</div>
      <van-cell-group inset class="group-card">
        <van-cell title="上传令牌" :label="uploadLabel" center>
          <template #right-icon>
            <van-switch
              :model-value="uploadToken"
              :disabled="uploadBusy"
              @update:model-value="onToggle"
            />
          </template>
        </van-cell>
      </van-cell-group>
    </div>

    <div class="group">
      <div class="group-label">外观</div>
      <van-cell-group inset class="group-card">
        <van-radio-group v-model="themeModel">
          <van-cell
            v-for="o in themeOptions"
            :key="o.value"
            :title="o.label"
            clickable
            @click="themeModel = o.value"
          >
            <template #right-icon>
              <van-radio :name="o.value" :icon-size="18" />
            </template>
          </van-cell>
        </van-radio-group>
      </van-cell-group>
    </div>

    <div class="group">
      <div class="group-label">诊断</div>
      <van-cell-group inset class="group-card">
        <van-cell title="诊断抓包" label="记录微信请求 URL，手动开启/关闭，不抓令牌" center>
          <template #right-icon>
            <van-switch :model-value="diagnose" @update:model-value="toggleDiagnose" />
          </template>
        </van-cell>
        <van-cell title="查看抓包日志" is-link @click="openLog" />
      </van-cell-group>
    </div>

    <div class="group">
      <div class="group-label">关于</div>
      <van-cell-group inset class="group-card">
        <van-cell
          title="当前版本"
          :value="version ? 'v' + version : '未知'"
          :label="version ? '来自安装包信息' : '暂未获取到版本信息'"
        />
        <van-cell
          v-if="!version"
          title="重试获取版本"
          :label="checking ? '正在获取…' : '点此重新读取安装包版本'"
          is-link
          @click="retryVersion"
        />
        <van-cell
          title="检查更新"
          :label="checking ? '正在检查…' : '从云端获取最新版本'"
          is-link
          @click="askCheck"
        />
      </van-cell-group>
    </div>

    <p class="footnote">设置仅保存在本机，不上传服务器</p>
  </div>
</template>

<script setup>
import { computed, onUnmounted, ref, watch } from 'vue';
import { showConfirmDialog, showToast } from 'vant';
import {
  captureToken, clearToken, isApp, setUploadToken,
  startDiagnose, stopDiagnose, showLog as showLogNative,
} from './api.js';
import { onCapture } from './format.js';
import {
  CAPTURE_FAIL_TEXT,
  CLEAR_CONFIRM_MESSAGE,
  CLEAR_CONFIRM_TITLE,
  CLEAR_DONE_TEXT,
  useTokenStatus,
} from './tokenStatus.js';

const props = defineProps({
  version: { type: String, default: '' },
  checking: { type: Boolean, default: false },
  themePref: { type: String, default: 'system' },
  active: { type: Boolean, default: true },
});

const emit = defineEmits(['check-update', 'theme-change', 'upload-token-change']);

// 上传开关只有一组事实描述：开关说明 label 与成功 Toast 都由它拼出来，
// 避免「开关说明 / 副标题 / Toast」对同一状态给出不同说法。
const UPLOAD_ON_DESC = '上传登录令牌，分析页显示';
const UPLOAD_OFF_DESC = '不上传登录令牌，分析页隐藏';
const UPLOAD_ON_LABEL = '开启后' + UPLOAD_ON_DESC;
const UPLOAD_OFF_LABEL = '关闭后' + UPLOAD_OFF_DESC;
const UPLOAD_ON_TOAST = '已开启：' + UPLOAD_ON_DESC;
const UPLOAD_OFF_TOAST = '已关闭：' + UPLOAD_OFF_DESC;

// 原生 token 抓包上限 60s，本地兜底多留 5s，避免两边同时失败文案打架
const CAPTURE_TIMEOUT_MS = 65000;

// 原生诊断抓包 debug 模式 5 分钟后自动关闭且不回调 __onCaptureEnd，
// 所以把「是否开启 + 开启时间」落到 localStorage，读取时按 5 分钟上限判过期。
const DIAGNOSE_KEY = 'charge_diagnose';
const DIAGNOSE_TTL_MS = 5 * 60 * 1000;

const themeOptions = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '明亮' },
  { value: 'dark', label: '深色' },
];

const uploadToken = ref(true);
const uploadBusy = ref(false);
const diagnose = ref(readDiagnoseStored());
const reacquiring = ref(false);
let loadErrorNotified = false;
let captureGuard = 0;

// 令牌镜像只读地来自同一个 composable：设置页不再自己 getSettings 轮询、也不再推断状态。
const {
  hasStored, valid, readError, remainText, statusText, statusClass,
  lastSettings, refresh, clearLocal,
} = useTokenStatus({ active: () => props.active });

// 上传开关只以原生设置为来源：共享轮询到的快照仅做镜像对齐，写入后另有回读校验
watch(lastSettings, (s) => {
  if (!s) return;
  if (typeof s.upload_token === 'boolean' && !uploadBusy.value) {
    uploadToken.value = s.upload_token;
  }
  syncDiagnoseState(s);
}, { immediate: true });

// 读取失败只提示一次，共享轮询会继续自动重试；恢复成功后重置
watch(readError, (msg) => {
  if (!msg) {
    loadErrorNotified = false;
    return;
  }
  if (loadErrorNotified) return;
  loadErrorNotified = true;
  showToast('读取本机设置失败，正在自动重试');
  console.warn('[settings] 读取设置失败', msg);
}, { immediate: true });

// ---- 抓包结果 ----
// window.__onTokenCaptured / window.__onCaptureEnd 只能有一个持有者（Token.vue 负责挂载），
// 设置页不能覆盖这两个回调，只能订阅它转发到 format.js 的同一份信号；
// 这样设置页自己发起的抓取也能收到成功 / 失败结果。
const offCaptured = onCapture('captured', () => {
  refresh();
  if (!reacquiring.value) return;
  reacquiring.value = false;
  clearCaptureGuard();
  showToast('令牌已获取');
});
const offEnd = onCapture('end', () => {
  // 任何抓包结束都复位诊断开关，避免开关停在「开」但 VPN 已关
  resetDiagnose();
  if (!reacquiring.value) return;
  reacquiring.value = false;
  clearCaptureGuard();
  showToast(CAPTURE_FAIL_TEXT);
});

// ---- 诊断抓包状态 ----
function readDiagnoseStored() {
  try {
    const raw = localStorage.getItem(DIAGNOSE_KEY);
    if (!raw) return false;
    const d = JSON.parse(raw);
    const ts = Number(d && d.ts) || 0;
    if (!d || d.on !== true || !ts || Date.now() - ts > DIAGNOSE_TTL_MS) {
      localStorage.removeItem(DIAGNOSE_KEY);
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function persistDiagnose(on) {
  try {
    if (on) localStorage.setItem(DIAGNOSE_KEY, JSON.stringify({ on: true, ts: Date.now() }));
    else localStorage.removeItem(DIAGNOSE_KEY);
  } catch { /* 无 localStorage 时仅本次会话生效 */ }
}

// 原生桥目前没有查询诊断开关的方法；若后续 getSettings 暴露 diagnose 字段，
// 就以原生值为准，否则回退到本地持久化的时间戳记录。
function syncDiagnoseState(s) {
  if (s && typeof s.diagnose === 'boolean') {
    diagnose.value = s.diagnose;
    persistDiagnose(s.diagnose);
    return;
  }
  const stored = readDiagnoseStored();
  if (diagnose.value !== stored) diagnose.value = stored;
}

function resetDiagnose() {
  diagnose.value = false;
  persistDiagnose(false);
}

function toggleDiagnose(v) {
  const prev = diagnose.value;
  const next = !!v;
  try {
    if (next) startDiagnose();
    else stopDiagnose();
  } catch (e) {
    diagnose.value = prev;
    showToast('诊断抓包开关失败，请重试');
    console.warn('[settings] 诊断抓包开关失败', e);
    return;
  }
  diagnose.value = next;
  persistDiagnose(next);
  showToast(next ? '诊断抓包已开启：去微信进入充电区详情' : '诊断抓包已关闭');
}

// 令牌文案来自同一份派生状态：读取失败 / 有效剩余 / 已过期 / 未设置
const tokenDetail = computed(() => {
  if (readError.value) return '读取设置失败，稍后自动重试';
  if (valid.value) return '剩余 ' + remainText.value;
  if (hasStored.value) return '请重新获取';
  return '请先获取令牌';
});

const themeModel = computed({
  get: () => props.themePref,
  set: (v) => emit('theme-change', v),
});

// 上传开关的说明与 Toast 共用同一组文案；保存中先显示「保存中…」
const uploadLabel = computed(() => {
  if (uploadBusy.value) return '保存中…';
  return uploadToken.value ? UPLOAD_ON_LABEL : UPLOAD_OFF_LABEL;
});

function onToggle(v) {
  if (uploadBusy.value) return;
  const want = !!v;
  const prev = uploadToken.value;
  if (want === prev) return;
  uploadBusy.value = true;

  // 先写原生：写入本身失败才回退（这是「保存失败」）
  try {
    setUploadToken(want);
  } catch (e) {
    uploadBusy.value = false;
    uploadToken.value = prev;
    showToast('设置失败，已保持原状态');
    console.warn('[settings] 上传令牌写入失败', e);
    return;
  }

  // 再回读原生校准：refresh() 复用同一条读取路径，不再单独 getSettings。
  // 回读失败不等于写入失败：以刚写入的值为准，共享轮询会继续对齐。
  let applied = want;
  const s = refresh();
  if (s && typeof s.upload_token === 'boolean') applied = s.upload_token;
  else if (s) console.warn('[settings] 上传令牌回读缺字段，等待轮询同步');
  else console.warn('[settings] 上传令牌回读失败，等待轮询同步');

  uploadBusy.value = false;
  uploadToken.value = applied;
  emit('upload-token-change', applied);
  showToast(applied !== want
    ? '设置未生效，已同步本机状态'
    : (applied ? UPLOAD_ON_TOAST : UPLOAD_OFF_TOAST));
}

function clearCaptureGuard() {
  if (captureGuard) { clearTimeout(captureGuard); captureGuard = 0; }
}

function reacquire() {
  if (reacquiring.value) return;
  reacquiring.value = true;
  try {
    captureToken();
  } catch (e) {
    reacquiring.value = false;
    showToast('无法启动抓取，请重试');
    console.warn('[settings] captureToken 启动失败', e);
    return;
  }
  clearCaptureGuard();
  captureGuard = setTimeout(() => {
    captureGuard = 0;
    if (!reacquiring.value) return;
    reacquiring.value = false;
    showToast(CAPTURE_FAIL_TEXT);
  }, CAPTURE_TIMEOUT_MS);
}

async function clear() {
  try {
    await showConfirmDialog({
      title: CLEAR_CONFIRM_TITLE,
      message: CLEAR_CONFIRM_MESSAGE,
      confirmButtonText: '清除',
      cancelButtonText: '取消',
    });
  } catch {
    return;
  }

  // 原生 Android 的 clearToken() 清完 token 会主动 web.reload()，
  // 网页版 clearToken() 是空实现。这里先原地把共享状态归零，
  // 不把「整页刷新」当成成功的唯一前提。
  try {
    clearToken();
  } catch (e) {
    showToast('清除失败，请重试');
    console.warn('[settings] clearToken 失败', e);
    return;
  }
  clearLocal();
  // Toast 文案与 Token 页共用同一句；App 内原生随后会自行刷新页面
  showToast(CLEAR_DONE_TEXT);
  if (!isApp) refresh();
}

function openLog() {
  try {
    showLogNative();
  } catch (e) {
    showToast('无法打开抓包日志，请稍后重试');
    console.warn('[settings] 打开抓包日志失败', e);
  }
}

function retryVersion() {
  if (props.checking) return;
  emit('check-update');
}

function askCheck() {
  if (props.checking) return;
  emit('check-update');
}

onUnmounted(() => {
  clearCaptureGuard();
  offCaptured();
  offEnd();
});
</script>

<style scoped>
/* 与 App.vue .card / Token.vue 卡片统一：r-md 圆角、16 内边距、同一阴影 */
.settings-page { padding-bottom: var(--sp-1); }
.group { margin-bottom: var(--sp-3); }
.group-card {
  margin: 0; border-radius: var(--r-md); overflow: hidden;
  background: var(--card); box-shadow: var(--shadow-card);
}
.group-card :deep(.van-cell) {
  padding: var(--sp-3) var(--sp-4); min-height: var(--ctl-44);
  background: var(--card); color: var(--text);
}
.group-card :deep(.van-cell__title) { font-size: var(--fs-14); color: var(--text); }
.group-card :deep(.van-cell__label) {
  margin-top: 2px; font-size: var(--fs-12); line-height: var(--lh-normal); color: var(--muted);
}
.group-card :deep(.van-cell__value) { font-size: var(--fs-12); color: var(--text-2); }
.group-card :deep(.van-cell__right-icon) { display: flex; align-items: center; color: var(--muted); }
.group-card :deep(.van-cell.is-busy) { opacity: .6; }
.group-card :deep(.van-cell:not(:last-child)::after) { border-color: var(--line); }
.danger-cell :deep(.van-cell__title) { color: var(--num-fault); }
.danger-cell :deep(.van-cell__right-icon) { color: var(--num-fault); }

/* 状态徽章与 Token.vue 共用同一套 class 名、尺寸与配色 */
.state-badge {
  display: inline-flex; align-items: center; gap: var(--sp-1);
  padding: 3px 9px; border-radius: var(--r-pill);
  font-size: var(--fs-12); font-weight: var(--fw-semibold); white-space: nowrap;
}
.state-badge i { display: block; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.state-badge.is-valid { background: var(--ok-bg); color: var(--ok-fg); }
.state-badge.is-expired { background: var(--warn-bg); color: var(--warn-fg); }
.state-badge.is-empty { background: var(--neutral-bg); color: var(--neutral-fg); }
.state-badge.is-error { background: var(--neutral-bg); color: var(--num-fault); }

.group-label { margin: 0 var(--sp-1) var(--sp-2); font-size: var(--fs-13);
  font-weight: var(--fw-medium); color: var(--muted); }
.footnote { margin: var(--sp-1) 0 var(--sp-2); text-align: center;
  font-size: var(--fs-12); color: var(--muted); }
</style>
