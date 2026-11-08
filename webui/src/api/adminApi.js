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
  } catch (e) {
    // M24：把英文的 AbortError / Failed to fetch 换成中文
    if (e && e.name === 'AbortError') {
      throw new Error('请求超时（20 秒），请稍后重试', { cause: e });
    }
    throw new Error('网络不可达，请检查连接', { cause: e });
  } finally {
    clearTimeout(timer);
  }

  if (resp.status === 401) {
    // S2：任何页面拿到 401 都广播一次，由 AdminBoot 统一切回登录页
    // （原来只有 AdminLogin 处理，会话过期后外壳卡死、各页面静默失败）
    try {
      // M1（复审实测）：silent 之前只写在 JSDoc 里、代码从没读过 ——
      // probeSession 自己那次 401 也会广播，冷启动时登录页同时冒出
      // "请使用管理员账号登录" 和 "会话已过期，请重新登录"。
      if (!opts.silent) {
        window.dispatchEvent(new CustomEvent('admin-auth-expired'));
      }
    } catch {
      /* 非浏览器环境 */
    }
    throw new AuthError();
  }
  if (resp.status === 429) {
    // M24：后端的 429 文案通常更具体（如"请 N 分钟后再试"）
    let msg = '请求过于频繁，请稍后再试';
    try {
      const d = await resp.json();
      if (d && typeof d.error === 'string' && d.error) msg = d.error;
    } catch {
      /* 用默认文案 */
    }
    const e = new Error(msg);
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
    let msg = (data && typeof data.error === 'string' && data.error) || `接口异常 HTTP ${resp.status}`;
    // M25：403 补一句可操作提示（后端文案是"需要运维及以上权限"这类）
    if (resp.status === 403 && !/权限/.test(msg)) msg = `${msg}（权限不足）`;
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
    // M1（复审实测）：探测本身必然有一次 401，不能让它广播 admin-auth-expired ——
    // 否则冷启动时登录页会同时显示"请使用管理员账号登录"和"会话已过期，请重新登录"。
    return await apiGet('/admin/api/me', { silent: true });
  } catch (e) {
    if (e instanceof AuthError) return null;
    throw e;
  }
}
