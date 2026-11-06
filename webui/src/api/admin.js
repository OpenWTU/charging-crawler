/**
 * 管理后台（/admin/api/*）请求封装。
 *
 * 与前台 api/areas.js 的区别：
 *  - 走 Cookie 会话（credentials: same-origin），401 直接跳登录页；
 *  - 429 单独给「请求过于频繁」文案；
 *  - 其它非 2xx 优先采用服务端返回体里的 error 文案。
 * 行为与拆分前 Admin.vue 内联的 request() 完全一致。
 */
import { fetchWithTimeout, isObj, FETCH_TIMEOUT_MS } from './transport.js';

const LOGIN_PATH = '/admin/login';

async function readResponseError(resp, fallback) {
  try {
    const data = await resp.json();
    if (isObj(data) && typeof data.error === 'string' && data.error.trim()) return data.error;
  } catch {
    /* 非 JSON 响应体，退回 fallback */
  }
  return fallback;
}

/**
 * 管理接口统一入口：返回解析后的 JSON（非对象时给 {}）。
 * 401 → 跳登录页并抛错；429 → 限流文案；其它非 2xx → 服务端 error 文案。
 */
export async function request(path, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const resp = await fetchWithTimeout(path, {
    cache: 'no-store',
    credentials: 'same-origin',
    ...options,
  }, timeoutMs);
  if (resp.status === 401) {
    if (typeof window !== 'undefined') window.location.href = LOGIN_PATH;
    throw new Error('未登录或会话已过期');
  }
  if (resp.status === 429) {
    throw new Error('请求过于频繁，请稍后再试');
  }
  if (!resp.ok) {
    throw new Error(await readResponseError(resp, `接口异常 HTTP ${resp.status}`));
  }
  const data = await resp.json();
  return isObj(data) ? data : {};
}

/** POST JSON 便捷封装（管理端写操作用得最多） */
export function postJSON(path, payload) {
  return request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  });
}

/**
 * CSV 导出：返回 Blob，401 跳登录、其它错误抛服务端文案。
 * 与旧实现一致地不做自动下载，下载动作留给调用方（便于提示成败）。
 */
export async function exportCsv(table) {
  const path = `/admin/api/export.csv?table=${encodeURIComponent(table)}`;
  const resp = await fetchWithTimeout(path, {
    credentials: 'same-origin',
    cache: 'no-store',
  }, 60000);
  if (resp.status === 401) {
    if (typeof window !== 'undefined') window.location.href = LOGIN_PATH;
    const err = new Error('未登录或会话已过期');
    err.code = 401;
    throw err;
  }
  if (!resp.ok) throw new Error(await readResponseError(resp, `导出失败 HTTP ${resp.status}`));
  return resp.blob();
}

/** 退出登录：忽略网络错误，之后统一回登录页 */
export async function logout() {
  try {
    await fetchWithTimeout('/admin/logout', { method: 'POST', credentials: 'same-origin' }, 8000);
  } catch {
    /* 忽略网络错误，直接回登录页 */
  }
  if (typeof window !== 'undefined') window.location.href = LOGIN_PATH;
}
