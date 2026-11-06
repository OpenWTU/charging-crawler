/**
 * App 全局 JS 桥事件注册 / 注销（window.__onXxx 一族）。
 *
 * 不变量：
 *  1. 同一个 window 上只允许一套回调：以 window.__chargeAppMounted 做防重复注册，
 *     重复挂载时先幂等 teardown，绝不叠加定时器与监听；
 *  2. 卸载时把所有 __onXxx 与自己的定时器全部摘掉，不给下一次挂载留残渣；
 *  3. 只做「事件登记」，具体处理逻辑由调用方注入（本模块不认识业务状态）。
 */

const GLOBAL_HOOKS = [
  '__onCheckUpdate',
  '__onNativeLocation',
  '__onAppResume',
  '__onBackPressed',
  '__onRefreshProgress',
  '__onRefreshDone',
  '__onUploadDone',
  '__onOverview',
  '__onUpdateChecking',
  '__onUpdateInfo',
  '__onUpdateError',
  '__chargeAppMounted',
];

/**
 * @param {object} handlers 与 __onXxx 一一对应的处理函数
 *   { autoCheck, nativeLocation, appResume, backPressed, refreshProgress,
 *     refreshDone, uploadDone, updateChecking, updateInfo, updateError }
 */
export function useAppBridge(handlers = {}) {
  let autoCheckTimer = 0;

  function teardown() {
    if (autoCheckTimer) { clearTimeout(autoCheckTimer); autoCheckTimer = 0; }
    GLOBAL_HOOKS.forEach((key) => {
      try { delete window[key]; } catch {
        try { window[key] = undefined; } catch { /* ignore */ }
      }
    });
  }

  /** 注册全部桥回调；已挂载过则直接返回 false（不重复注册） */
  function mount() {
    if (window.__chargeAppMounted) return false;
    teardown(); // 幂等清理（同实例重复挂载时不会叠加）
    window.__chargeAppMounted = true;
    window.__onCheckUpdate = handlers.autoCheck;
    window.__onNativeLocation = handlers.nativeLocation;
    window.__onAppResume = handlers.appResume;
    window.__onBackPressed = handlers.backPressed;
    window.__onRefreshProgress = handlers.refreshProgress;
    window.__onRefreshDone = handlers.refreshDone;
    window.__onUploadDone = handlers.uploadDone;
    window.__onOverview = handlers.overview;
    window.__onUpdateChecking = handlers.updateChecking;
    window.__onUpdateInfo = handlers.updateInfo;
    window.__onUpdateError = handlers.updateError;
    return true;
  }

  /** 延迟触发一次自动检查（原生侧可能在首帧后才可用） */
  function scheduleAutoCheck(ms, fn) {
    if (autoCheckTimer) clearTimeout(autoCheckTimer);
    autoCheckTimer = setTimeout(() => {
      autoCheckTimer = 0;
      if (typeof fn === 'function') fn();
    }, ms);
  }

  return { mount, teardown, scheduleAutoCheck };
}
