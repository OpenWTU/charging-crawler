/**
 * 版本检查与安装引导（仅 App 内生效）。
 *
 * 不变量：
 *  1. 桥方法缺失/同步抛错时返回「未发起」，由调用方复位 checking 并提示；
 *  2. 自动检查（silent）不弹 Toast；同一版本号只弹一次更新弹窗（localStorage 记录）；
 *  3. 检查更新失败不阻塞刷新链路（失败后仍会走 maybeAutoRefresh）。
 */
import { ref } from 'vue';
import { showToast } from 'vant';
import { checkUpdate, startUpdate } from '../api/index.js';
import { parseBridgeJSON } from '../api/transport.js';

/** 已提示过的版本记录，格式 "versionCode:timestamp"（兼容旧版纯数字） */
const SEEN_KEY = 'charge_update_seen';
const SEEN_TTL_MS = 12 * 60 * 60 * 1000; // 12 小时后允许再次自动提示

function readSeen() {
  try {
    const raw = String(localStorage.getItem(SEEN_KEY) || '');
    const [codeStr, tsStr] = raw.split(':');
    return { code: Number(codeStr) || 0, ts: Number(tsStr) || 0 };
  } catch {
    return { code: 0, ts: 0 };
  }
}

function writeSeen(code) {
  try {
    localStorage.setItem(SEEN_KEY, code + ':' + Date.now());
  } catch { /* 隐私模式等忽略 */ }
}

/**
 * @param {{ onAfterCheck?: () => void }} [deps] 检查完成后的追加动作（如自动刷新判定）
 */
export function useUpdate(deps = {}) {
  const onAfterCheck = typeof deps.onAfterCheck === 'function' ? deps.onAfterCheck : () => {};

  const appVersion = ref('');
  const upChecking = ref(false);
  const showUpdate = ref(false);
  const up = ref({});
  let silent = true;
  let lastAutoCheck = 0;

  function doUpdate() {
    showUpdate.value = false;
    let started;
    try {
      started = startUpdate(up.value.apkPath || '/download/app-release.apk',
        up.value.sha256 || '') !== false;
    } catch (e) {
      started = false;
      console.warn('[update] 启动安装失败', e);
    }
    if (!started) showToast('无法开始安装更新，请稍后重试');
  }

  function checkUpdateNow(silentArg) {
    silent = silentArg === true;
    upChecking.value = true;
    if (!silent) showToast('正在检查更新…');
    let started;
    try {
      started = checkUpdate() !== false;
    } catch (e) {
      started = false;
      console.warn('[update] 检查更新失败', e);
    }
    if (!started) {
      upChecking.value = false;
      if (!silent) showToast('无法检查更新，请稍后重试');
    }
  }

  function onUpdateChecking() {
    upChecking.value = true;
  }

  function onUpdateInfo(raw) {
    upChecking.value = false;
    const s = typeof raw === 'string' ? parseBridgeJSON(raw) : (raw || null);
    if (!s || !s.ok) {
      if (!silent) showToast('检查更新失败');
      // 不阻塞刷新链路（模块不变量 3）：失败也要走 maybeAutoRefresh
      onAfterCheck();
      return;
    }
    if (s.currentName) appVersion.value = String(s.currentName);
    const cur = Number(s.currentCode) || 0;
    const latest = Number(s.versionCode) || 0;
    if (latest <= cur) {
      if (!silent) showToast('已是最新版本');
      onAfterCheck();
      return;
    }
    // 自动检查：同一版本在 12 小时内只弹一次；手动检查（!silent）始终弹窗
    if (silent) {
      const seen = readSeen();
      const fresh = seen.code === latest && Date.now() - seen.ts < SEEN_TTL_MS;
      if (fresh) {
        onAfterCheck();
        return;
      }
    }
    writeSeen(latest);
    up.value = s;
    showUpdate.value = true;
    onAfterCheck();
  }

  function onUpdateError() {
    upChecking.value = false;
    if (!silent) showToast('检查更新失败');
    // 失败也继续刷新链路（模块不变量 3）
    onAfterCheck();
  }

  // 自动检查：20 秒内最多触发一次；正在检查时不打断（否则会把手动检查的 silent 改成 true）
  function autoCheck() {
    if (upChecking.value) return;
    const now = Date.now();
    if (now - lastAutoCheck < 20000) return;
    lastAutoCheck = now;
    checkUpdateNow(true);
  }

  return {
    appVersion, upChecking, showUpdate, up,
    doUpdate, checkUpdateNow, onUpdateChecking, onUpdateInfo, onUpdateError, autoCheck,
  };
}
