/**
 * 区域维度接口：概览、实时推荐、区域坐标、历史、定位、导航、刷新触发。
 *
 * 职责边界：只负责「一个充电区」级别的数据；端口级接口在 ports.js。
 * 所有函数在 App（WebView + JS 桥）与网页（HTTP）两端行为保持一致：
 *  - 桥方法缺失/抛错/超时 → 回退 HTTP 或返回空兜底，绝不抛给点击处理；
 *  - 失败语义与旧实现完全一致（哪个能忍、哪个必须抛错，见各函数注释）。
 */
import {
  isApp, getJSON, requestJSON, isObj, numOrNull, coordsQuery,
  awaitGlobalBridge, callBridgeJSON,
} from './transport.js';
import { normalizeDevices } from './ports.js';

// 概览：网页走 /api/overview；App 优先读 getState() 桥，
// 桥缺失/返回损坏时回退 HTTP。Android buildState 把令牌状态放在
// d.token{present,expires_at} 下，这里统一映射成健康条用的顶层字段；
// 顶层字段存在时优先用顶层（Web 与服务端返回同一形状），token.* 只做兼容补齐。
export async function getOverview() {
  if (isApp) {
    const host = window.AndroidHost;
    if (host && typeof host.getState === 'function') {
      try {
        const d = JSON.parse(host.getState());
        if (isObj(d)) {
          const tok = isObj(d.token) ? d.token : null;
          const topReady = typeof d.token_ready === 'boolean' ? d.token_ready : null;
          const tokPresent = tok && typeof tok.present === 'boolean' ? tok.present : null;
          const topEarliest = numOrNull(d.earliest_exp);
          const tokExp = tok ? numOrNull(tok.expires_at) : null;
          const topValid = numOrNull(d.token_valid);
          const tokValid = tokPresent === null ? null : (tokPresent ? 1 : 0);
          return {
            uploads: Number(d.uploads) || 0,
            received_at: d.received_at || d.data_updated_at || '',
            generated_at: numOrNull(d.generated_at),
            last_scan_at: d.last_scan_at || d.data_updated_at || '',
            token_ready: topReady !== null ? topReady : tokPresent,
            token_valid: topValid !== null ? topValid : tokValid,
            earliest_exp: topEarliest !== null ? topEarliest : tokExp,
            interval: numOrNull(d.interval),
            error_count: numOrNull(d.error_count),
            token_pool: isObj(d.token_pool) ? d.token_pool : null,
            snapshot: {
              captured_at: d.data_updated_at || '',
              areas: Array.isArray(d.areas) ? d.areas : [],
            },
          };
        }
      } catch { /* 桥不可用：回退 HTTP */ }
    }
  }
  return getJSON('/api/overview');
}

// 解析桥回调：正常是 JSON 字符串，异常时给空列表，绝不让调用方吃到异常
function parseNow(raw) {
  if (raw && typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return { areas: [] }; }
}

// 最新推荐：带坐标时服务端返回 distance_m / 距离加权 score。
// 网页 fetch 带 query；App 内优先调用新桥 getNowWithCoords(lat,lng)，
// 桥方法缺失或同步抛错时回退旧的 getNow()（保持 1.6.0 行为）。
export async function getNow(lat, lng) {
  const qs = coordsQuery(lat, lng);
  if (!isApp) {
    return getJSON('/api/now' + qs);
  }
  const host = window.AndroidHost;
  if (qs && host && typeof host.getNowWithCoords === 'function') {
    const r = await awaitGlobalBridge('__onNow', () => host.getNowWithCoords(Number(lat), Number(lng)), 8000);
    if (!r.threw) {
      const d = parseNow(r.raw);
      if (d) return d;
    }
  }
  if (host && typeof host.getNow === 'function') {
    const r = await awaitGlobalBridge('__onNow', () => host.getNow(), 8000);
    if (!r.threw) {
      const d = parseNow(r.raw);
      if (d) return d;
    }
  }
  return { areas: [] };
}

// 历史数据：网页走 HTTP /api/history；App 走 AndroidHost.getHistory 桥（回调 __onHistory）。
// 失败时抛错，调用方统一显示「加载失败」。
// 注意 limit：Android 侧与后端都夹到 1..1000，这里传原始值即可。
export async function getHistory(name, limit) {
  const raw = String(name == null ? '' : name);
  if (!raw) return [];
  const n = Math.min(1000, Math.max(1, Number(limit) || 30));

  if (isApp) {
    const host = window.AndroidHost;
    if (!host || typeof host.getHistory !== 'function') return []; // 老版本 APK 没有这个桥
    const d = await callBridgeJSON('__onHistory', () => host.getHistory(raw, n), 20000);
    return Array.isArray(d && d.rows) ? d.rows : [];
  }

  const area = encodeURIComponent(raw);
  const d = await getJSON('/api/history?limit=' + n + '&area=' + area);
  return Array.isArray(d && d.rows) ? d.rows : [];
}

// ---- 定位 ----
// App 内：AndroidHost.getLocation()，返回 JSON 字符串（{"lat":..,"lng":..} 或 {}），
// 无权限/失败/桥方法缺失时返回 null；也兼容 Android 侧异步回填 window.__onLocation 的写法。
// 网页：navigator.geolocation.getCurrentPosition，失败静默返回 null。
// 任何情况下都不抛错，调用方只需判断 null。
function parseLocation(raw) {
  if (!raw) return null;
  let d = raw;
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) return null;
    try { d = JSON.parse(s); } catch { return null; }
  }
  if (!d || typeof d !== 'object') return null;
  const la = Number(d.lat);
  const ln = Number(d.lng);
  if (!Number.isFinite(la) || !Number.isFinite(ln)) return null;
  if (Math.abs(la) > 90 || Math.abs(ln) > 180) return null;
  return { lat: la, lng: ln };
}

function browserLocation() {
  return new Promise((resolve) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      resolve(null);
      return;
    }
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const timer = setTimeout(() => finish(null), 10000);
    try {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          clearTimeout(timer);
          finish(parseLocation(pos && pos.coords
            ? { lat: pos.coords.latitude, lng: pos.coords.longitude }
            : null));
        },
        () => { clearTimeout(timer); finish(null); },
        { enableHighAccuracy: false, timeout: 9000, maximumAge: 300000 },
      );
    } catch {
      clearTimeout(timer);
      finish(null);
    }
  });
}

export async function getLocation() {
  if (!isApp) return browserLocation();
  const host = window.AndroidHost;
  if (!host || typeof host.getLocation !== 'function') return null;
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const timer = setTimeout(() => finish(null), 10000);
    window.__onLocation = (raw) => { clearTimeout(timer); finish(parseLocation(raw)); };
    let raw;
    try {
      raw = host.getLocation();
    } catch {
      clearTimeout(timer);
      finish(null);
      return;
    }
    const parsed = parseLocation(raw);
    if (parsed) { clearTimeout(timer); finish(parsed); return; }
    // "{}" 可能是权限弹窗期间：继续等 __onLocation（Java 授权后会补发），最多 10s
    // 返回空串/undefined：可能是 Android 正在申请权限，等 __onLocation，最多 10s
  });
}

export function openAmap(name, lat, lng, startLat, startLng) {
  const hasStart = startLat !== null && startLat !== undefined
    && startLng !== null && startLng !== undefined
    && Number.isFinite(Number(startLat)) && Number.isFinite(Number(startLng))
    && !(Number(startLat) === 0 && Number(startLng) === 0);
  if (isApp) {
    try {
      window.AndroidHost.openAmap(String(name || ''), Number(lat), Number(lng),
        hasStart ? Number(startLat) : 0, hasStart ? Number(startLng) : 0);
      return;
    } catch { /* 回退浏览器 */ }
  }
  const url = 'https://uri.amap.com/navigation?to=' + lng + ',' + lat + ','
    + encodeURIComponent(name || '') + '&callnative=1';
  window.open(url, '_blank');
}

// 全区端口：网页走 HTTP；App 走桥。失败/超时抛错，调用方保留上一份数据；
// 只有「桥方法不存在（旧 APK 无此能力）」才返回空，让上层按空闲回退。
// 返回的每台设备 ports[] 已补齐 v2 的 group（见 ports.js）。
let areasPortsSeq = 0;

export async function getAreasPorts() {
  if (!isApp) {
    const d = await getJSON('/api/areas-ports');
    return withAreaDeviceGroups(d);
  }
  const host = window.AndroidHost;
  if (!host || typeof host.getAreasPorts !== 'function') return { areas: [] };
  const seq = ++areasPortsSeq;
  const r = await awaitGlobalBridge('__onAreasPorts', () => host.getAreasPorts(), 15000);
  if (seq !== areasPortsSeq) throw new Error('端口数据请求已失效');
  let d = null;
  if (!r.threw && typeof r.raw === 'string') {
    try { d = JSON.parse(r.raw); } catch { d = null; }
  }
  if (!d || d.ok === false || !Array.isArray(d.areas)) {
    throw new Error((d && d.error) || '端口数据暂不可用');
  }
  return withAreaDeviceGroups(d);
}

// /api/areas-ports 里每台设备的端口也补 group，列表行内 chip 才能按分组上色
function withAreaDeviceGroups(d) {
  if (!isObj(d) || !Array.isArray(d.areas)) return d;
  return {
    ...d,
    areas: d.areas.map((a) => (isObj(a) && Array.isArray(a.devices)
      ? { ...a, devices: normalizeDevices(a.devices) }
      : a)),
  };
}

function parseAreas(raw) {
  if (isObj(raw)) return raw;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const d = JSON.parse(raw);
    return isObj(d) ? d : null;
  } catch { return null; }
}

export async function getAreaCoords() {
  if (isApp) {
    const host = window.AndroidHost;
    if (!host || typeof host.getAreaCoords !== 'function') return { areas: [] };
    // 同步返回值里已有坐标就不再等异步回调（旧实现同语义）
    const r = await awaitGlobalBridge('__onAreaCoords', () => host.getAreaCoords(), 12000, {
      isSyncHit: (raw) => {
        const d = parseAreas(raw);
        return !!d && Array.isArray(d.areas) && d.areas.length > 0;
      },
    });
    const sync = parseAreas(r.sync);
    if (sync && Array.isArray(sync.areas) && sync.areas.length) return sync;
    const d = parseAreas(r.raw);
    return d && Array.isArray(d.areas) ? d : { areas: [] };
  }
  return getJSON('/api/area-coords');
}

// 触发一次刷新（网页端 fire-and-forget）。App 侧桥方法可能缺失或同步抛错：
// 统一返回 boolean，由调用方据此复位「刷新中」并提示，绝不让异常穿透到点击处理里卡死 UI。
export function refreshData() {
  if (isApp) {
    const host = window.AndroidHost;
    if (!host || typeof host.refresh !== 'function') return false;
    try {
      host.refresh();
      return true;
    } catch (e) {
      console.warn('[refresh] 原生刷新调用失败', e);
      return false;
    }
  }
  requestJSON('/api/refresh', { method: 'POST' }).catch(() => {});
  return true;
}

// 网页端手动刷新：POST /api/refresh 并解析返回体（需要 result/ok/error 文案）。
// 服务端要先跑一轮采集，超时给到 90s；超时/网络错误照常抛给调用方。
export async function refreshWeb() {
  const r = await requestJSON('/api/refresh', { method: 'POST' }, 90000);
  return { status: r.status, data: r.data };
}
