// 登录令牌状态的单一事实来源。
// Token.vue / Settings.vue 只消费这里返回的状态，不再各自 getSettings + setInterval + 推断状态。
// 两页同时挂载时共享同一条 2s 轮询（模块级单例定时器），至少一个页面可见时才轮询，
// 避免两页各开一条定时器、对原生桥重复发同一份读取请求。

import { computed, onUnmounted, ref, watch } from 'vue';
import { getSettings } from './api.js';
import { fmtRemain } from './format.js';
import { usePageVisible } from './pageVisible.js';

const POLL_MS = 2000;

// 抓取失败（本地超时 / 原生 __onCaptureEnd 未抓到）统一文案：两页共用同一句
export const CAPTURE_FAIL_TEXT = '未抓到登录令牌，请重试或手动粘贴';

// 清除令牌的确认与完成文案：两页共用同一套说法
export const CLEAR_CONFIRM_TITLE = '清除登录令牌？';
export const CLEAR_CONFIRM_MESSAGE = '清除后需重新抓取才能刷新充电数据。';
export const CLEAR_DONE_TEXT = '已清除令牌';

// ---- 模块级共享快照：所有使用方读同一份状态 ----
const tokenPresent = ref(false);
/** 有本地令牌但解析失败（SecureState 标 corrupt）：文案要与 App 顶部横幅一致 */
const corrupt = ref(false);
const expiresAt = ref(0);
const readError = ref('');
const loading = ref(true);
const nowMs = ref(Date.now());
// 最近一次成功读取的原始设置：upload_token / diagnose 等字段由设置页只读镜像
const lastSettings = ref(null);

const hasStored = computed(() => Number(expiresAt.value) > 0 || corrupt.value);
// 剩余有效期由 expires_at 本地推算，不依赖原生侧下发的 remaining_seconds
const remainSeconds = computed(() => {
  const exp = Number(expiresAt.value) || 0;
  if (!exp) return 0;
  return Math.max(0, Math.floor(exp - nowMs.value / 1000));
});
const remainText = computed(() => fmtRemain(remainSeconds.value));
// 读取失败时状态未知：保留上一次已知状态并标记 readError，绝不伪装成「未设置」
const valid = computed(() => !readError.value
  && tokenPresent.value
  && (!hasStored.value || remainSeconds.value > 0));
const statusText = computed(() => {
  if (readError.value) return '读取失败';
  if (corrupt.value) return '已损坏';
  if (valid.value) return '有效';
  return hasStored.value ? '已过期' : '未设置';
});
// 两页徽章共用同一套状态 class：is-valid / is-expired / is-empty / is-error
const statusClass = computed(() => {
  if (readError.value) return 'is-error';
  if (corrupt.value) return 'is-error';
  if (valid.value) return 'is-valid';
  return hasStored.value ? 'is-expired' : 'is-empty';
});

let timer = 0;
let firstPoll = true;
let readFailLogged = false;
// 当前使用方（页面实例）集合：visible + 可选的 became-valid 回调
const consumers = new Set();

function errText(e) {
  const m = (e && (e.message || String(e))) || '';
  return m || '本机设置不可读';
}

function notifyBecameValid() {
  consumers.forEach((c) => {
    // 只通知当前可见的页面，避免在别的 tab 上弹出无关提示
    if (!c.visible || !c.onBecameValid) return;
    try {
      c.onBecameValid();
    } catch {
      // 单个页面异常不影响轮询
    }
  });
}

// 读一次原生设置，返回本次是否成功；失败保留上次快照，只标 readError。
// 原生 getSettings 成功时 token_present 一定是布尔值；缺字段说明桥调用失败。
function poll() {
  const wasValid = valid.value;
  const hadReadError = !!readError.value;
  try {
    const s = getSettings();
    if (!s || typeof s !== 'object' || typeof s.token_present !== 'boolean') {
      throw new Error('原生未返回令牌状态');
    }
    tokenPresent.value = !!s.token_present;
    corrupt.value = s.corrupt === true;
    expiresAt.value = Number(s.expires_at) || 0;
    lastSettings.value = s;
    readError.value = '';
  // M4：清除令牌后 corrupt 也要复位，否则 hasStored 仍为真 → statusText 还显示「已损坏」
  corrupt.value = false;
    nowMs.value = Date.now();
    loading.value = false;
    readFailLogged = false;
    const first = firstPoll;
    firstPoll = false;
    // 首次读取只建立基线；读取失败恢复后也不补「令牌已更新」，避免把恢复误报成状态变化
    if (!first && !hadReadError && !wasValid && valid.value) notifyBecameValid();
    return true;
  } catch (e) {
    // 保留上一次已知状态，只标记读取失败；共享轮询每 2s 自动重试
    readError.value = errText(e);
    nowMs.value = Date.now();
    loading.value = false;
    if (!readFailLogged) {
      readFailLogged = true;
      console.warn('[token] 读取令牌状态失败', e);
    }
    return false;
  }
}

function startPolling() {
  if (timer) return;
  poll();
  timer = setInterval(poll, POLL_MS);
}

function stopPolling() {
  if (timer) {
    clearInterval(timer);
    timer = 0;
  }
}

function anyVisible() {
  let any = false;
  consumers.forEach((c) => { if (c.visible) any = true; });
  return any;
}

// 显式刷新（重试 / 保存后 / 写入回读）：同步读一次，
// 成功返回本次原始设置快照，失败返回 null（调用方据此区分「读不到」与「字段缺失」）。
function refresh() {
  const ok = poll();
  return ok ? lastSettings.value : null;
}

// 清除令牌后的本地收尾：共享状态归零。两页共用，避免各写一份。
function clearLocal() {
  tokenPresent.value = false;
  expiresAt.value = 0;
  readError.value = '';
  lastSettings.value = null;
  nowMs.value = Date.now();
}

function resolveActive(active) {
  if (typeof active === 'function') return !!active();
  if (active && typeof active === 'object' && 'value' in active) return !!active.value;
  return active === undefined || active === null ? true : !!active;
}

// active：布尔 / ref / getter，表示 App 侧当前 tab 是否命中该页。
// 只有「tab 命中 + 文档可见」才轮询；页面卸载即退出共享轮询。
export function useTokenStatus(options = {}) {
  const consumer = {
    visible: false,
    onBecameValid: typeof options.onBecameValid === 'function' ? options.onBecameValid : null,
  };
  consumers.add(consumer);

  const visible = usePageVisible(() => resolveActive(options.active));

  watch(visible, (v) => {
    consumer.visible = !!v;
    if (v) startPolling();
    else if (!anyVisible()) stopPolling();
  }, { immediate: true });

  // 卸载即停止轮询：最后一个可见使用方卸载时定时器彻底停掉，不会留下后台请求
  onUnmounted(() => {
    consumer.visible = false;
    consumers.delete(consumer);
    if (!anyVisible()) stopPolling();
  });

  return {
    tokenPresent,
    expiresAt,
    hasStored,
    valid,
    readError,
    loading,
    nowMs,
    remainSeconds,
    remainText,
    statusText,
    statusClass,
    lastSettings,
    refresh,
    clearLocal,
  };
}
