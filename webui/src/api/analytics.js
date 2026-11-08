/**
 * 分析页数据接口：/api/analytics（样本/趋势/热力/排行/预测）与
 * /api/free-rate（空闲时段柱状）。
 *
 * 两者互相独立：free-rate 失败只影响它自己的卡片，不拖累其它分析数据；
 * App 侧桥方法缺失或失败时回退 HTTP，保证新接口先能跑通。
 */
import {
  isApp, getJSON, awaitGlobalBridge, callBridgeJSON,
} from './transport.js';

// /api/analytics：App 走 __onAnalytics 回调（20s 超时给空兜底），网页走 HTTP
let analyticsSeq = 0;


export async function getAnalytics() {
  if (!isApp) {
    return getJSON('/api/analytics');
  }
  try {
    const host = window.AndroidHost;
    if (host && typeof host.getAnalytics === 'function') {
      const seq = ++analyticsSeq;
      const r = await awaitGlobalBridge('__onAnalytics', () => host.getAnalytics(), 26000);
      // 序号过期说明有更新的一次请求在飞，这里返回 null 让调用方忽略，
      // 不能用空数据覆盖已有结果（会让分析页闪成「暂无数据」）
      if (seq !== analyticsSeq) return null;
      if (!r.threw && typeof r.raw === 'string') {
        try { return JSON.parse(r.raw); } catch { return { samples: 0 }; }
      }
    }
  } catch { /* ignore */ }
    // M14：原来返回 EMPTY_ANALYTICS（成功形状）→ 分析页把超时渲染成「暂无分析数据」
    throw new Error('分析数据加载失败，请检查网络后重试');
}

// 空闲时段：/api/free-rate?days=14 → { ok, days, total_samples, points:[{hour,samples,free_rate}] }
// App 侧若桥 getFreeRate 未实现（或失败）就回退 fetch，保证新接口先能跑通。
export async function getFreeRate(days = 14) {
  // 与后端一致：days 允许 1..30，默认 14
  const n = Math.max(1, Math.min(30, Math.floor(Number(days)) || 14));
  const host = isApp ? window.AndroidHost : null;
  if (host && typeof host.getFreeRate === 'function') {
    try {
      const d = await callBridgeJSON('__onFreeRate', () => host.getFreeRate(n), 23000);
      if (d && d.ok !== false) return d;
    } catch { /* 桥未实现/失败：回退 HTTP */ }
  }
  return getJSON('/api/free-rate?days=' + n);
}
