/**
 * 手动/自动刷新编排（网页端 + App 桥两条路径）。
 *
 * 不变量：
 *  1. 同一时刻只允许一次刷新（refreshing 是唯一事实）；
 *  2. App 侧桥方法缺失/同步抛错时立刻复位状态并提示，绝不把 UI 卡在「刷新中」；
 *  3. 真机刷新（采集+上传）可能远超 60s：只在 App 侧 arm 60s 兜底，
 *     收到任意 __onRefreshProgress 即续期、__onRefreshDone 即清除；
 *  4. 自动刷新（silent）失败不弹 Toast，避免后台噪声，并按指数退避重试。
 */
import { computed, ref } from 'vue';
import { showToast } from 'vant';
import { isApp, refreshData, refreshWeb } from '../api/index.js';
import { friendlyErrorText, parseEventPayload } from '../api/transport.js';

const REFRESH_GUARD_MS = 60000;

/**
 * @param {object} deps
 * @param {import('vue').ComputedRef<number>} deps.dataAt 当前数据采集时间
 * @param {() => Promise<void>} deps.reload 概览刷新
 * @param {() => void} deps.loadTokenState 重新读原生令牌状态
 * @param {import('vue').Ref<boolean>} deps.tokenUnset 从未设置令牌
 * @param {import('vue').Ref<boolean>} deps.tokenInvalid 令牌已失效
 * @param {() => void} deps.onNeedToken 需要先去「令牌」页时的跳转
 * @param {() => void} deps.onDataRefreshed 收到新数据后的追加动作（自动刷新退避复位）
 */
export function useRefresh(deps) {
  const {
    dataAt, reload, loadTokenState, tokenUnset, tokenInvalid, onNeedToken, onDataRefreshed,
  } = deps;

  const refreshing = ref(false);
  const progress = ref('');
  // 进度百分比：把「抓取充电区」「补全端口」两个串行阶段合并成一条连续进度线，
  // 不再各自从 0 涨到 100。权重按阶段占比估算：
  //   抓取充电区 0% ～ 45%；补全端口 45% ～ 95%；上传/补传 95%。
  // 「上传数据中」「补传中」等无 x/y 计数的阶段保留上一进度，进度线不闪没。
  let lastPct = 0;
  const progressPct = computed(() => {
    const p = progress.value;
    // 刷新刚开始的占位文案（'…' 或空）：进度线归零且不显示，
    // 避免上一次刷新残留的满线在下一轮开始时闪没
    if (!p || p === '…') {
      lastPct = 0;
      return 0;
    }
    let m = /抓取充电区\s*(\d+)\s*\/\s*(\d+)/.exec(p);
    if (m) {
      lastPct = Math.round((+m[1] / Math.max(1, +m[2])) * 45);
      return lastPct;
    }
    m = /补全端口\s*(\d+)\s*\/\s*(\d+)/.exec(p);
    if (m) {
      lastPct = 45 + Math.round((+m[1] / Math.max(1, +m[2])) * 50);
      return lastPct;
    }
    if (/上传|补传/.test(p)) {
      lastPct = 95;
      return lastPct;
    }
    // 旧版文案（无阶段前缀）或未知：尽量解析纯 x/y，无法解析就保留上一进度
    m = /(\d+)\/(\d+)/.exec(p);
    if (m) {
      lastPct = Math.round((+m[1] / Math.max(1, +m[2])) * 100);
      return lastPct;
    }
    return lastPct;
  });
  // 网页刷新没有进度回调：此时不显示 0% 空进度条
  const showProgress = computed(() => refreshing.value && progressPct.value > 0);

  let guardTimer = 0;
  let doneTimer = 0;
  let guardSilent = false;
  let autoFails = 0;
  let autoLast = 0;
  let autoRetryAt = 0;

  function clearRefreshGuard() {
    if (guardTimer) { clearTimeout(guardTimer); guardTimer = 0; }
    if (doneTimer) { clearTimeout(doneTimer); doneTimer = 0; }
  }

  function armRefreshGuard() {
    clearRefreshGuard();
    guardTimer = setTimeout(() => {
      guardTimer = 0;
      if (!refreshing.value) return;
      refreshing.value = false;
      progress.value = '';
      if (!guardSilent) showToast('刷新超时，未收到完成回调');
    }, REFRESH_GUARD_MS);
  }

  function refreshNow(silent = false) {
    if (refreshing.value) return;
    guardSilent = silent === true;
    if (!isApp) {
      // 网页端：refreshWeb 自带 90s 超时，失败/超时都会抛进 catch
      refreshing.value = true;
      progress.value = '';
      (async () => {
        try {
          const r = await refreshWeb();
          const body = (r && r.data) || {};
          const result = String(body.result || '');
          if (r && (r.status === 401 || r.status === 403)) {
            showToast('需要管理员登录后才能刷新');
          } else if (result === 'no-token') {
            showToast('服务端没有可用令牌，请先在 App 里抓取');
          } else if (result === 'auth-expired') {
            showToast('令牌已过期，请在 App 里重新抓取');
          } else if (result.startsWith('error') || body.ok === false) {
            showToast('刷新失败：' + (body.error || result || '未知错误'));
          } else {
            showToast('刷新完成');
          }
        } catch (e) {
          showToast('刷新失败：' + friendlyErrorText(e));
        } finally {
          refreshing.value = false;
          reload();
        }
      })();
      return;
    }
    loadTokenState(); // 统一以原生 token_present/expires_at 判断「未设置」还是「已失效」
    if (tokenUnset.value || tokenInvalid.value) {
      if (!silent) {
        showToast(tokenUnset.value
          ? '尚未设置令牌，请先到「令牌」页获取'
          : '登录令牌已失效，请先到「令牌」页重新获取');
        if (typeof onNeedToken === 'function') onNeedToken();
      }
      return;
    }
    refreshing.value = true;
    progress.value = '…';
    // 桥方法缺失/同步抛错：复位状态并明确提示，不要停在「刷新中」
    let started;
    try {
      started = refreshData() !== false;
    } catch (e) {
      started = false;
      console.warn('[refresh] 发起刷新失败', e);
    }
    if (!started) {
      refreshing.value = false;
      progress.value = '';
      if (!silent) showToast('无法发起刷新，请稍后重试');
      return;
    }
    armRefreshGuard();
    if (!silent) showToast('正在刷新…');
  }

  // 数据超过 3 分钟未更新则自动刷新一次（仅 App），失败按指数退避，最多 5 分钟间隔
  function maybeAutoRefresh() {
    if (!isApp || refreshing.value) return;
    const at = dataAt.value;
    if (!at) return;
    if (Date.now() - at < 180000) return;
    const now = Date.now();
    if (now < autoRetryAt || now - autoLast < 30000) return;
    autoLast = now;
    autoFails += 1;
    autoRetryAt = now + Math.min(300000, 30000 * Math.pow(2, Math.min(autoFails, 4)));
    refreshNow(true);
  }

  // 有进度就续期：长采集/上传不会被 60 秒兜底误判超时。
  // 若刚收到过 done（收尾延迟中），取消延迟——说明还有后续阶段在跑。
  function onRefreshProgress(p) {
    if (doneTimer) { clearTimeout(doneTimer); doneTimer = 0; }
    refreshing.value = true;
    progress.value = p;
    armRefreshGuard();
  }

  // Android 新事件：__onRefreshDone(JSON字符串 {ok, msg})。
  // 旧版 APK 在「区域抓取完成」时就发 done，紧接着端口补全阶段又发进度，
  // 会让「刷新中」状态与进度线一消失一重现（闪没）。这里延迟 500ms 收尾，
  // 期间若收到新的 progress 就取消收尾，保持进度线连续。
  function onRefreshDone(raw) {
    clearRefreshGuard();
    if (doneTimer) clearTimeout(doneTimer);
    doneTimer = setTimeout(() => {
      doneTimer = 0;
      refreshing.value = false;
      progress.value = '';
    }, 500);
    const s = parseEventPayload(raw);
    const failed = !!(s && s.ok === false);
    if (failed) showToast('刷新失败：' + (s.msg || '请稍后重试'));
    const before = dataAt.value;
    reload().then(() => {
      if (failed) return;
      if (dataAt.value > before) {
        autoFails = 0;
        autoRetryAt = 0;
      }
      if (typeof onDataRefreshed === 'function') onDataRefreshed();
    });
  }

  return {
    refreshing, progress, progressPct, showProgress,
    refreshNow, maybeAutoRefresh, onRefreshProgress, onRefreshDone,
    clearRefreshGuard,
  };
}
