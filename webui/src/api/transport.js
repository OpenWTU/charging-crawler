/**
 * 传输基座：WebView JS 桥 + HTTP fetch 的唯一出口。
 *
 * 不变量（改动前请先读）：
 *  1. 所有 HTTP 请求都必须带超时（默认 10s），不允许无限 pending；
 *  2. 错误统一分类为 timeout / network / http / bridge / other，
 *     调用方只展示 friendlyErrorText()，不再各自拼网络文案；
 *  3. 本模块不含任何业务接口，只提供 fetch / 桥 / 解析 / 重试原语；
 *  4. 默认不自动重试（保持既有行为），需要重试的调用方显式包 withRetry()。
 */

// App WebView 内走 JS 桥，浏览器内走 HTTP 接口
export const isApp = typeof window !== 'undefined' && typeof window.AndroidHost !== 'undefined';

// 网页端请求统一超时：10 秒无响应就 abort，避免弱网下页面永久停在加载态。
// 超时与网络错误都抛给调用方，由调用方进入错误态并允许重试。
export const FETCH_TIMEOUT_MS = 10000;

const NETWORK_ERROR_RE = /failed to fetch|networkerror|load failed|network request failed/i;

export function isObj(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

export function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  let timer = 0;
  const opts = { ...options };
  if (ctrl) {
    timer = setTimeout(() => { try { ctrl.abort(); } catch { /* ignore */ } }, timeoutMs);
    opts.signal = ctrl.signal;
  }
  try {
    return await fetch(url, opts);
  } catch (e) {
    if (ctrl && ctrl.signal.aborted) {
      const err = new Error('请求超时，请检查网络后重试');
      err.name = 'TimeoutError';
      err.kind = 'timeout';
      throw err;
    }
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// 非 2xx 统一抛 HTTP 错误（带 status，便于调用方区分 401/429）
export function httpError(status) {
  const err = new Error('HTTP ' + status);
  err.kind = 'http';
  err.status = status;
  return err;
}

// 错误分类：调用方按 kind 决定是否重试 / 跳登录 / 提示
export function classifyError(e) {
  if (e && e.kind) return e.kind;
  if (e && e.name === 'TimeoutError') return 'timeout';
  const msg = (e && (e.message || String(e))) || '';
  if (NETWORK_ERROR_RE.test(msg)) return 'network';
  if (/^HTTP \d+/.test(msg)) return 'http';
  if (/bridge/i.test(msg)) return 'bridge';
  return 'other';
}

// 给用户看的错误文案：网络层错误统一成一句可操作的话，其余保留原始信息
export function friendlyErrorText(e) {
  const msg = (e && (e.message || String(e))) || '';
  if (!msg || NETWORK_ERROR_RE.test(msg)) return '网络连接失败，请检查网络后重试';
  return msg;
}

// 网页端统一 GET：no-store 防缓存，非 2xx/超时统一抛给调用方
export async function getJSON(path, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const resp = await fetchWithTimeout(path, { cache: 'no-store', ...options }, timeoutMs);
  if (!resp.ok) throw httpError(resp.status);
  return resp.json();
}

// 需要自己看状态码/返回体的请求（刷新、导出等）：永远返回 {status, ok, data}
export async function requestJSON(path, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const resp = await fetchWithTimeout(path, { cache: 'no-store', ...options }, timeoutMs);
  let body;
  try { body = await resp.json(); } catch { body = {}; }
  return { status: resp.status, ok: resp.ok, data: isObj(body) ? body : {} };
}

// 可重试错误：只重试超时与网络抖动，HTTP 4xx/5xx 与解析错误原样抛出
function retryable(e) {
  const kind = classifyError(e);
  return kind === 'timeout' || kind === 'network';
}

/**
 * 显式重试包装（默认关闭，调用方按接口决定是否启用）。
 * attempts 是总尝试次数；退避为 delayMs * (i + 1)。
 */
export async function withRetry(fn, { attempts = 2, delayMs = 400, isRetryable = retryable } = {}) {
  const total = Math.max(1, Math.floor(Number(attempts) || 1));
  let last = null;
  for (let i = 0; i < total; i += 1) {
    try {
      return await fn(i);
    } catch (e) {
      last = e;
      if (i + 1 >= total || !isRetryable(e)) throw e;
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
    }
  }
  throw last;
}

// ---- JS 桥 ----

// 桥回调统一解析：对象直接返回，字符串尝试 JSON.parse，异常返回 null
export function parseBridgeJSON(raw) {
  if (isObj(raw) && typeof raw.then !== 'function') return raw;
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s) return null;
  try {
    const d = JSON.parse(s);
    return isObj(d) ? d : null;
  } catch {
    return null;
  }
}

// 通用 JS 桥调用：兼容同步返回 JSON 字符串与 window.__onXxx 回调两种写法。
// 回调名各自独立计数，避免并发请求互相丢弃；超时/解析失败/桥抛错都 reject，
// 由调用方决定是否回退 HTTP（App 侧桥未实现时按回退处理）。
const bridgeSeqs = Object.create(null);

export function callBridgeJSON(cbKey, invoke, timeoutMs) {
  return new Promise((resolve, reject) => {
    const seq = (bridgeSeqs[cbKey] || 0) + 1;
    bridgeSeqs[cbKey] = seq;
    let done = false;
    const timer = setTimeout(() => finish(false, new Error('bridge timeout')), timeoutMs);
    let handler = null;
    function finish(ok, value) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // 只清理自己装的那个 handler：并发调同一 cbKey 时别人可能已替换，删了会让对方收不到回调
      if (handler && window[cbKey] === handler) {
        try { delete window[cbKey]; } catch { /* ignore */ }
      }
      if (ok) resolve(value); else reject(value);
    }
    handler = (raw) => {
      if (bridgeSeqs[cbKey] !== seq) return;
      const d = parseBridgeJSON(raw);
      if (d) finish(true, d); else finish(false, new Error('bridge parse failed'));
    };
    window[cbKey] = handler;
    try {
      const ret = invoke();
      // 兼容 JS 桥返回 Promise 的实现（Android Java 桥是同步字符串，不会走到这里）
      if (ret && typeof ret.then === 'function') {
        ret.then((v) => {
          const d = parseBridgeJSON(v);
          if (d) finish(true, d); else finish(false, new Error('bridge parse failed'));
        }, (e) => finish(false, e));
        return;
      }
      const d = parseBridgeJSON(ret);
      if (d) finish(true, d);
    } catch (e) {
      finish(false, e);
    }
  });
}

/**
 * 等待一次 window[cbKey] 全局回调，返回 { threw, raw, sync }：
 *  - threw=true 表示桥方法同步抛错或超时（调用方回退 HTTP / 返回空兜底）；
 *  - raw 是桥回填的原始值（字符串或对象），由调用方自己决定怎么解析；
 *  - sync 是桥方法本身的同步返回值（Java 桥常用同步字符串，部分方法两路都给）。
 * 只允许一个持有者：后一次调用会覆盖同一个 window 回调（旧调用等超时），
 * 与旧实现一致；需要并发隔离的调用方请自行加请求序号。
 * opts.isSyncHit(ret)：同步返回值已够用时就提前结束等待（不再等回调）。
 */
export function awaitGlobalBridge(cbKey, invoke, timeoutMs, opts = {}) {
  const isSyncHit = typeof opts.isSyncHit === 'function' ? opts.isSyncHit : null;
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
    const timer = setTimeout(() => finish({ threw: true, raw: null, sync: null }), timeoutMs);
    window[cbKey] = (raw) => finish({ threw: false, raw, sync: null });
    try {
      const sync = invoke();
      if (isSyncHit && isSyncHit(sync)) finish({ threw: false, raw: null, sync });
    } catch {
      finish({ threw: true, raw: null, sync: null });
    }
  });
}

// 统一解析桥事件载荷：兼容对象与 JSON 字符串（无参旧版返回 null）
export function parseEventPayload(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const d = JSON.parse(raw);
      return d && typeof d === 'object' && !Array.isArray(d) ? d : null;
    } catch { return null; }
  }
  return null;
}

// 经纬度 → query string；缺失/非法时返回空串，保证「无参调用」与旧行为一致
export function coordsQuery(lat, lng) {
  if (lat === null || lat === undefined || lat === '' ||
      lng === null || lng === undefined || lng === '') return '';
  const la = Number(lat);
  const ln = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(ln)) return '';
  if (Math.abs(la) > 90 || Math.abs(ln) > 180) return '';
  return '?lat=' + la + '&lng=' + ln;
}
