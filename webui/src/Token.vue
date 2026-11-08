<template>
  <div class="token-page">
    <h2 class="page-title">令牌</h2>

    <!-- 状态卡：是否有效 + 剩余时间 -->
    <section class="card">
      <div class="status-top">
        <span class="status-name">登录令牌</span>
        <span class="state-badge" :class="statusClass"><i v-if="valid"></i>{{ statusText }}</span>
      </div>
      <div class="status-num" :class="numClass">
        {{ readError ? '—' : (valid ? remainText : statusText) }}
      </div>
      <p class="status-foot">{{ statusFoot }}</p>
      <div class="status-actions">
        <button v-if="readError" class="status-link" type="button" @click="retryRead">
          <van-icon name="replay" />重试读取
        </button>
        <button class="status-link" type="button" :disabled="capturing" @click="start">
          <van-icon name="replay" />重新获取
        </button>
        <button v-if="canClear" class="status-link is-danger" type="button" @click="clear">
          <van-icon name="delete-o" />清除令牌
        </button>
        <button v-if="valid" class="status-link" type="button" @click="$emit('done')">
          返回实时页<van-icon name="arrow" />
        </button>
      </div>
    </section>

    <!-- 主操作：自动抓取 + 手动粘贴入口 -->
    <section class="card">
      <div class="action-row">
        <van-button
          class="main-btn"
          type="primary"
          :loading="capturing"
          loading-text="抓取中"
          @click="start"
        >
自动抓取
</van-button>
        <button class="manual-toggle" type="button" @click="manualOpen = !manualOpen">
          手动粘贴<van-icon :name="manualOpen ? 'arrow-up' : 'arrow-down'" />
        </button>
      </div>

      <div class="steps">
        <span class="step"><i>1</i>打开微信</span>
        <van-icon name="arrow" class="step-arrow" />
        <span class="step"><i>2</i>微信公众号"蛮来电"</span>
        <van-icon name="arrow" class="step-arrow" />
        <span class="step"><i>3</i>单车充电</span>
      </div>

      <div v-if="capturing" class="capture-tip">
        <van-loading size="14" color="currentColor" />
        <span>抓包已开启，成功后自动返回实时页</span>
      </div>
      <!-- 抓取失败只有这一种展示：超时与原生 __onCaptureEnd 走同一段文案 -->
      <div v-else-if="captureError" class="capture-tip is-error" role="alert">
        <van-icon name="warning-o" />
        <span class="capture-error-text">{{ captureError }}</span>
        <button class="tip-btn" type="button" @click="start">重试</button>
        <button class="tip-btn is-ghost" type="button" @click="manualOpen = true">手动粘贴</button>
      </div>
    </section>

    <!-- 次要折叠项：手动粘贴，默认收起 -->
    <section v-show="manualOpen" class="card">
      <div class="manual-label">粘贴令牌</div>
      <textarea
        v-model="text"
        class="token-input"
        rows="3"
        spellcheck="false"
        placeholder="粘贴 eyJ 开头的令牌"
      ></textarea>
      <div class="manual-foot">
        <span class="manual-tip">保存前会校验有效期</span>
        <van-button plain type="primary" class="save-btn" :disabled="!text.trim()" @click="save">
          保存
        </van-button>
      </div>
    </section>
  </div>
</template>

<script setup>
let doneTimer = null;
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { showConfirmDialog, showToast } from 'vant';
import { captureToken, clearToken, saveToken } from './api.js';
import { emitCapture } from './format.js';
import {
  CAPTURE_FAIL_TEXT,
  CLEAR_CONFIRM_MESSAGE,
  CLEAR_CONFIRM_TITLE,
  CLEAR_DONE_TEXT,
  useTokenStatus,
} from './tokenStatus.js';

const props = defineProps({
  active: { type: Boolean, default: true },
});
const emit = defineEmits(['done']);

const CAPTURE_GUARD_MS = 65000;

const capturing = ref(false);
const manualOpen = ref(false);
const text = ref('');
const captureError = ref('');

let captureFlow = false;
let captureSucceeded = false;
let lastManualSave = 0;
let returnTimer = 0;
let captureGuard = 0;

// 令牌状态统一由 tokenStatus 维护：轮询、状态推断、读取失败处理都不在本页重复实现。
const {
  tokenPresent, expiresAt, hasStored, valid, readError,
  remainText, statusText, statusClass, refresh, clearLocal,
} = useTokenStatus({
  active: () => props.active,
  onBecameValid: () => {
    if (Date.now() - lastManualSave < 3000) return;
    if (captureFlow) { finishCapture('令牌已保存'); return; }
    showToast('令牌已更新');
  },
});

// 有原生记录（token_present 或历史 expires_at）才能清除，与两页共用同一判断
const canClear = computed(() => tokenPresent.value || hasStored.value);
const numClass = computed(() => {
  if (readError.value) return 'is-off';
  if (valid.value) return 'is-valid';
  return hasStored.value ? 'is-expired' : 'is-off';
});
const statusFoot = computed(() => {
  if (readError.value) return '无法读取本机令牌状态：' + readError.value;
  if (valid.value) {
    const exp = fmtExpire(expiresAt.value);
    return exp ? '剩余有效期 · 到期 ' + exp : '有效期内';
  }
  if (hasStored.value) return '令牌已过期，请重新抓取或手动粘贴';
  return '还没有登录令牌，点「自动抓取」获取';
});

function fmtExpire(ts) {
  const n = Number(ts);
  if (!n) return '';
  const d = new Date(n * 1000);
  if (Number.isNaN(d.getTime())) return '';
  const p = (v) => String(v).padStart(2, '0');
  return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

function finishCapture(msg) {
  if (captureSucceeded) return;
  captureSucceeded = true;
  captureFlow = false;
  capturing.value = false;
  captureError.value = '';
  clearGuard();
  showToast(msg);
  if (!returnTimer) {
    returnTimer = setTimeout(() => { returnTimer = 0; emit('done'); }, 1200);
  }
}

// 抓取失败：超时与 __onCaptureEnd 统一走这里，页面显示同一句失败文案。
// nativeNotified=true 表示原生已弹过「抓包结束：未抓到 token」，这里不再重复弹，
// 只把页面切到同一失败态。
function failCapture(nativeNotified) {
  if (captureSucceeded) return;
  captureFlow = false;
  capturing.value = false;
  clearGuard();
  captureError.value = CAPTURE_FAIL_TEXT;
  if (!nativeNotified) showToast(CAPTURE_FAIL_TEXT);
}

function clearGuard() {
  if (captureGuard) { clearTimeout(captureGuard); captureGuard = 0; }
}

function start() {
  if (capturing.value) return;
  capturing.value = true;
  captureFlow = true;
  captureSucceeded = false;
  captureError.value = '';
  manualOpen.value = false;
  try {
    captureToken();
  } catch (e) {
    capturing.value = false;
    captureFlow = false;
    captureError.value = '无法启动抓取，请检查 VPN 权限后重试';
    showToast('无法启动抓取，请重试');
    console.warn('[token] captureToken 启动失败', e);
    return;
  }
  clearGuard();
  captureGuard = setTimeout(() => {
    captureGuard = 0;
    if (!capturing.value) return;
    failCapture(false);
  }, CAPTURE_GUARD_MS);
}

function save() {
  const t = text.value.trim();
  if (!t) return;
  let r;
  try { r = saveToken(t); } catch (e) { r = 'error:' + errText(e); }
  if (r === 'ok') {
    text.value = '';
    manualOpen.value = false;
    lastManualSave = Date.now();
    captureError.value = '';
    refresh();
    // 原生已弹「Token 已保存」，这里不再二次 Toast
    doneTimer = setTimeout(() => emit('done'), 900);
  } else if (r === 'invalid') {
    showToast('令牌无效或已过期');
  } else {
    // 桥返回 "error:具体原因"，把原因如实展示；空原因回退到通用文案
    const msg = String(r || '').replace(/^error:\s*/, '').trim();
    const detail = (msg && msg !== 'null' && msg !== 'undefined') ? msg : '';
    showToast(detail ? '保存失败：' + detail : '保存失败，请重试');
  }
}

function errText(e) {
  const m = (e && (e.message || String(e))) || '';
  return m || '本机设置不可读';
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
  try {
    clearToken();
  } catch (e) {
    showToast('清除失败，请重试');
    console.warn('[token] clearToken 失败', e);
    return;
  }
  // 原生实现会顺手 reload 页面；这里先把共享状态归零，界面立即一致
  clearLocal();
  captureError.value = '';
  showToast(CLEAR_DONE_TEXT);
}

function retryRead() {
  refresh();
}

function handleCaptured() {
  if (captureFlow) {
    refresh();
    finishCapture('令牌已保存');
  }
  // 设置页发起的抓取也要收到结果
  emitCapture('captured');
}

function handleCaptureEnd() {
  if (captureFlow && !captureSucceeded) failCapture(true);
  emitCapture('end');
}

onMounted(() => {
  window.__onTokenCaptured = handleCaptured;
  window.__onCaptureEnd = handleCaptureEnd;
});

onUnmounted(() => {
  // 轻微6：保存成功的 900ms 定时器也要清（否则卸载后仍会 emit）
  if (doneTimer) { clearTimeout(doneTimer); doneTimer = null; }
  if (returnTimer) { clearTimeout(returnTimer); returnTimer = 0; }
  clearGuard();
  if (window.__onTokenCaptured === handleCaptured) window.__onTokenCaptured = null;
  if (window.__onCaptureEnd === handleCaptureEnd) window.__onCaptureEnd = null;
});
</script>

<style scoped>
.token-page { padding-bottom: var(--sp-1); }
.status-top { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2); }
.status-name { font-size: var(--fs-13); font-weight: var(--fw-medium); color: var(--muted); }
.state-badge {
  display: inline-flex; align-items: center; gap: var(--sp-1);
  padding: 3px 9px; border-radius: var(--r-pill);
  font-size: var(--fs-12); font-weight: var(--fw-semibold); white-space: nowrap;
}
.state-badge i { display: block; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
/* 与 Settings.vue 共用同一套状态 class 与配色 */
.state-badge.is-valid { background: var(--ok-bg); color: var(--ok-fg); }
.state-badge.is-expired { background: var(--warn-bg); color: var(--warn-fg); }
.state-badge.is-empty { background: var(--neutral-bg); color: var(--neutral-fg); }
.state-badge.is-error { background: var(--neutral-bg); color: var(--num-fault); }

.status-num {
  margin-top: 10px; font-size: var(--fs-24); font-weight: var(--fw-bold);
  line-height: var(--lh-tight); font-variant-numeric: tabular-nums;
}
.status-num.is-valid { color: var(--num-idle); }
.status-num.is-expired { color: var(--num-fault); font-size: var(--fs-20); }
.status-num.is-off { color: var(--muted); font-size: var(--fs-20); }
.status-foot { margin: 6px 0 0; font-size: var(--fs-12); line-height: var(--lh-normal); color: var(--muted); }

.status-actions { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-4); margin-top: var(--sp-3); }
.status-link {
  padding: 0; border: 0; background: none;
  color: var(--chip-text); font-size: var(--fs-13); font-weight: var(--fw-medium);
  display: inline-flex; align-items: center; gap: 3px; min-height: var(--ctl-40);
}
.status-link .van-icon { font-size: var(--fs-13); }
.status-link:disabled { opacity: .5; }
.status-link.is-danger { color: var(--num-fault); }

.action-row { display: flex; align-items: center; gap: 10px; }
.action-row .main-btn {
  height: var(--ctl-44); min-width: 132px; border-radius: var(--r-sm);
  font-size: var(--fs-16); font-weight: var(--fw-semibold); padding: 0 20px;
}
.manual-toggle {
  flex: none; height: var(--ctl-40); padding: 0 var(--sp-3); border-radius: var(--r-sm);
  border: 1px solid var(--line); background: transparent; color: var(--text-2);
  font-size: var(--fs-13); display: inline-flex; align-items: center; gap: var(--sp-1);
}
.manual-toggle .van-icon { font-size: var(--fs-11); }

.steps {
  display: flex; align-items: center; flex-wrap: wrap; gap: 6px;
  margin-top: var(--sp-3); font-size: var(--fs-12); color: var(--muted);
}
.step { display: inline-flex; align-items: center; gap: var(--sp-1); }
.step i {
  font-style: normal; width: 16px; height: 16px; border-radius: 50%;
  background: var(--chip); color: var(--chip-text);
  font-size: var(--fs-11); font-weight: var(--fw-semibold);
  display: inline-flex; align-items: center; justify-content: center;
}
.step-arrow { font-size: var(--fs-10); color: var(--muted); }

.capture-tip {
  display: flex; align-items: center; gap: 6px;
  margin-top: var(--sp-3); padding: var(--sp-2) 10px; border-radius: var(--r-sm);
  background: var(--chip); color: var(--chip-text); font-size: var(--fs-12);
}
.capture-tip.is-error { background: var(--warn-bg); color: var(--warn-fg); }
.capture-tip .van-icon { font-size: var(--fs-14); flex: none; }
.capture-error-text { flex: 1; min-width: 0; }
.tip-btn {
  flex: none; border: 0; border-radius: var(--r-sm); min-height: var(--ctl-40);
  padding: 4px 10px; background: var(--warn-fg); color: var(--on-primary);
  font-size: var(--fs-12); font-family: inherit;
}
.tip-btn.is-ghost { background: transparent; color: var(--warn-fg); border: 1px solid currentColor; }

.manual-label { font-size: var(--fs-13); font-weight: var(--fw-medium); color: var(--muted); margin-bottom: var(--sp-2); }
.token-input {
  display: block; width: 100%; box-sizing: border-box; min-height: 84px;
  padding: 10px var(--sp-3); border: 1px solid var(--line); border-radius: var(--r-sm);
  background: var(--page-bg); color: var(--text);
  font-family: var(--font-mono); font-size: var(--fs-12); line-height: var(--lh-normal);
  resize: none; outline: none;
}
.token-input::placeholder { color: var(--muted); font-family: inherit; }
.manual-foot { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 10px; }
.manual-tip { font-size: var(--fs-12); color: var(--muted); }
.manual-foot .save-btn {
  height: var(--ctl-40); min-width: 84px; border-radius: var(--r-sm);
  font-size: var(--fs-14); padding: 0 18px;
}
</style>
