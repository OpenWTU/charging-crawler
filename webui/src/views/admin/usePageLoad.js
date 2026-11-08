/**
 * L14：管理后台页面的「进页面就加载 + 切回来再加载」统一封装。
 *
 * 背景：AdminShell 用 `<KeepAlive>` 包页面，组件**不会重新挂载** ——
 * 只写 `onMounted` 的页面切回来永远是旧数据（令牌倒计时冻结、配置中心能覆盖别人刚改的值）；
 * 只写 `onActivated` 又隐式依赖 KeepAlive（一旦页面被移出/在单测里单独挂载就永远不取数）。
 *
 * 这里同时挂两个钩子并去重：
 *   - 首次：`onMounted` 触发一次，`onActivated` 跳过
 *   - 切回：`onActivated` 触发
 *   - 非 KeepAlive 场景：只有 `onMounted` 触发（`onActivated` 根本不会被调用）
 *
 * @param {() => unknown} fn 加载函数（可 async）
 * @param {{ activatedOnly?: boolean }} [opts]
 *   activatedOnly: 挂载时不跑、等到第一次 activated / 后续切回才跑（给「重操作」页面留的口子）
 */
import { onActivated, onMounted } from 'vue';

export function usePageLoad(fn, opts = {}) {
  const activatedOnly = opts.activatedOnly === true;
  // 非 activatedOnly 时，首次 activated 要跳过（onMounted 已经跑过一次）
  let skipFirstActivated = !activatedOnly;

  onMounted(() => {
    if (!activatedOnly) void fn();
  });

  onActivated(() => {
    if (skipFirstActivated) {
      skipFirstActivated = false;
      return;
    }
    void fn();
  });
}
