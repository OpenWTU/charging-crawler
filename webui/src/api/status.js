/**
 * 状态页接口：GET /status（公开只读）。
 *
 * App 内走 AndroidHost.getStatus 桥（回调 __onStatus），老版本 APK 没有该桥时
 * 回退 HTTP /status（WebView 可能因跨域失败，此时状态页显示桥不可用）。
 */
import { getJSON, isApp, callBridgeJSON } from './transport.js';

export async function getStatus() {
  if (isApp) {
    const host = window.AndroidHost;
    if (host && typeof host.getStatus === 'function') {
      const d = await callBridgeJSON('__onStatus', () => host.getStatus(), 15000);
      if (d && d.ok !== false) return d;
    }
    // 桥不存在或失败：回退 HTTP（老 APK 无桥时至少网页能看）
    return getJSON('/status');
  }
  return getJSON('/status');
}

/** 手动切换连接的服务器节点：App 走桥；网页端跳转到该节点地址 */
export function switchNode(url) {
  if (!url) return false;
  if (isApp) {
    const host = window.AndroidHost;
    if (host && typeof host.setNodeBase === 'function') {
      host.setNodeBase(url);
      return true;
    }
    return false;
  }
  try {
    window.location.href = url;
    return true;
  } catch {
    return false;
  }
}
