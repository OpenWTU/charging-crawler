/**
 * 管理后台的共享 UI 通道（provide / inject）。
 *
 * 为什么不用 props 逐层传：8 个面板都要能弹「成功/失败」提示条，逐层传函数会让
 * AdminView 的 props 表爆掉；用 provide 只传一套「提示入口」。
 * 没有 provider 时（例如单独渲染某个面板做调试）降级为静默，不抛错。
 */
import { inject, provide } from 'vue';

const ADMIN_UI = Symbol('charge-admin-ui');

export function provideAdminUi(ui) {
  provide(ADMIN_UI, ui);
}

export function useAdminUi() {
  const ui = inject(ADMIN_UI, null);
  if (ui) return ui;
  return {
    clearAlerts: () => {},
    showOk: () => {},
    showError: (err) => { console.warn('[admin-ui] 没有 provider，错误未展示', err); },
    // 面板改了数据后同步顶栏统计卡（无 provider 时静默）
    refreshSummary: async () => {},
  };
}
