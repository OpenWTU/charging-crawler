/**
 * App 原生桥命令（设置 / 令牌 / 更新 / 诊断 / 日志）。
 *
 * 这些方法只在 App（window.AndroidHost 存在）里真正生效，网页端返回安全默认值；
 * 桥方法缺失或同步抛错一律返回 false/默认值，绝不让异常穿透到点击处理器里
 * 把 UI 卡在「刷新中 / 检查中」。
 */
import { isApp } from './transport.js';

export function getSettings() {
  if (!isApp) return { upload_token: true, token_present: false };
  try { return JSON.parse(window.AndroidHost.getSettings()); } catch { return {}; }
}

export function setUploadToken(on) {
  if (isApp) window.AndroidHost.setUploadToken(!!on);
}

export function clearToken() {
  if (isApp) window.AndroidHost.clearToken();
}

export function saveToken(token) {
  if (isApp) return window.AndroidHost.saveToken(token);
  return 'invalid';
}

export function captureToken() {
  if (isApp) window.AndroidHost.captureToken();
}

export function startDiagnose() {
  if (isApp) window.AndroidHost.startDiagnose();
}

export function stopDiagnose() {
  if (isApp) window.AndroidHost.stopDiagnose();
}

export function showLog() {
  if (isApp) window.AndroidHost.showLog();
}

/**
 * 把当前深浅色同步给原生状态栏（WebView 不识别 theme-color）。
 * 旧版 APK 没有该桥方法，静默跳过，不影响主题本身。
 */
export function setDarkMode(dark) {
  if (!isApp) return;
  const host = window.AndroidHost;
  if (!host || typeof host.setDarkMode !== 'function') return;
  try {
    host.setDarkMode(!!dark);
  } catch { /* 桥调用失败时保持原生现状 */ }
}

// 检查更新 / 开始安装：桥缺失或同步抛错时返回 false，由调用方复位 checking 并提示。
export function checkUpdate() {
  if (!isApp) return false;
  const host = window.AndroidHost;
  if (!host || typeof host.checkUpdate !== 'function') return false;
  try {
    host.checkUpdate();
    return true;
  } catch (e) {
    console.warn('[update] 检查更新调用失败', e);
    return false;
  }
}

export function startUpdate(apkPath, sha256) {
  if (!isApp) return false;
  const host = window.AndroidHost;
  if (!host || typeof host.startUpdate !== 'function') return false;
  try {
    host.startUpdate(apkPath, sha256 || '');
    return true;
  } catch (e) {
    console.warn('[update] 启动安装失败', e);
    return false;
  }
}
