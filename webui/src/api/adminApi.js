/**
 * 管理后台请求封装（新版）。
 *
 * 与旧的 `api/admin.js` 区别：
 *  - 不自动跳转 `/admin/login`（那是 SPA 内的一屏，跳转会打断 Vue 状态）
 *  - 自动带 `X-Admin-CSRF`（从 cookie 读）
 *  - 401 抛 `AuthError`，由 AdminBoot 决定显示登录页
 */
const CSRF_COOKIE = 'admin_csrf';

export class AuthError extends Error {
  constructor(message = '未登录或会话已过期') {
    super(message);
    this.name = 'AuthError';
  }
}

function readCookie(name) {
  try {
    const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : '';
  } catch {
    return '';
  }
}

/**
 * @param {string} path
 * @param {{ method?: string, body?: unknown, timeoutMs?: number, silent?: boolean }} [opts]
 */
export async function apiFetch(path, opts = {}) {
  const method = (opts.method || 'GET').toUpperCase();
  const headers = {};
  const init = { method, credentials: 'same-origin', cache: 'no-store' };
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  if (method !== 'GET' && method !== 'HEAD') {
    const csrf = readCookie(CSRF_COOKIE);
    if (csrf) headers['X-Admin-CSRF'] = csrf;
  }
  init.headers = headers;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs || 20000);
  init.signal = ctrl.signal;
  let resp;
  try {
    resp = await fetch(path, init);
  } finally {
    clearTimeout(timer);
  }

  if (resp.status === 401) throw new AuthError();
  if (resp.status === 429) {
    const e = new Error('请求过于频繁，请稍后再试');
    e.status = 429;
    throw e;
  }
  let data = null;
  try {
    data = await resp.json();
  } catch {
    /* 非 JSON */
  }
  if (!resp.ok) {
    const msg = (data && typeof data.error === 'string' && data.error) || `接口异常 HTTP ${resp.status}`;
    const e = new Error(msg);
    e.status = resp.status;
    throw e;
  }
  return data && typeof data === 'object' ? data : {};
}

export const apiGet = (p, o) => apiFetch(p, { ...o, method: 'GET' });
export const apiPost = (p, body, o) => apiFetch(p, { ...o, method: 'POST', body });
export const apiDelete = (p, o) => apiFetch(p, { ...o, method: 'DELETE' });

/** 探测当前会话（不抛 401，返回 null） */
export async function probeSession() {
  try {
    return await apiGet('/admin/api/me');
  } catch (e) {
    if (e instanceof AuthError) return null;
    throw e;
  }
}
