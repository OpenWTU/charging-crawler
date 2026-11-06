// 地理工具：BD09 / GCJ02 / WGS84 互转、球面距离、定位缓存。
// 纯函数，不依赖 Vue；App.vue 只负责状态与 UI。

export const GEO_KEY = 'charge_geo_v4';
export const GEO_TTL = 5 * 60 * 1000;

export function coordNum(v) {
  if (v === null || v === undefined || v === '') return NaN;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

// 合法坐标返回 {lat,lng}，否则 null；调用方据此决定是否显示距离
export function validGeo(lat, lng) {
  const la = coordNum(lat);
  const ln = coordNum(lng);
  if (!Number.isFinite(la) || !Number.isFinite(ln)) return null;
  if (Math.abs(la) > 90 || Math.abs(ln) > 180) return null;
  return { lat: la, lng: ln };
}

// 坐标缓存 5 分钟：刷新页面/重新打开都在有效期内复用，不重复请求定位
export function readGeoCache() {
  try {
    const raw = localStorage.getItem(GEO_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw);
    const c = validGeo(d && d.lat, d && d.lng);
    const ts = coordNum(d && d.ts);
    if (!c || !Number.isFinite(ts)) return null;
    const age = Date.now() - ts;
    if (age < 0 || age > GEO_TTL) return null;
    return c;
  } catch { return null; }
}

export function writeGeoCache(c) {
  try {
    localStorage.setItem(GEO_KEY, JSON.stringify({ lat: c.lat, lng: c.lng, ts: Date.now() }));
  } catch { /* 无 localStorage 时仅本次会话生效 */ }
}

export function clearGeoCache() {
  try { localStorage.removeItem(GEO_KEY); } catch { /* ignore */ }
}

// BD09 → GCJ02：平台区域坐标来自百度系地图，高德/距离计算需要 GCJ02
export function bdToGcj(g) {
  if (!g) return g;
  const x = Number(g.lng) - 0.0065, y = Number(g.lat) - 0.006;
  const z = Math.sqrt(x * x + y * y) - 0.00002 * Math.sin(y * Math.PI * 3000 / 180);
  const t = Math.atan2(y, x) - 0.000003 * Math.cos(x * Math.PI * 3000 / 180);
  return { lat: z * Math.sin(t), lng: z * Math.cos(t) };
}

// GCJ02 → BD09：平台 /api/now 按 BD09 计算距离
export function gcjToBd(g) {
  if (!g) return g;
  const x = Number(g.lng), y = Number(g.lat);
  const z = Math.sqrt(x * x + y * y) + 0.00002 * Math.sin(y * Math.PI * 3000 / 180);
  const t = Math.atan2(y, x) + 0.000003 * Math.cos(x * Math.PI * 3000 / 180);
  return { lat: z * Math.sin(t) + 0.006, lng: z * Math.cos(t) + 0.0065 };
}

// WGS84 → GCJ02：手机/GPS 返回 WGS84，平台区域坐标是 BD09
// 不转换会稳定偏几百米，地形复杂处可到 1km+。
export function toGcj(g) {
  if (!g) return g;
  const a = 6378245.0, ee = 0.00669342162296594;
  const x = Number(g.lng), y = Number(g.lat);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return g;
  let dLat = -100 + 2 * (x - 105) + 3 * (y - 35) + 0.2 * (y - 35) * (y - 35)
    + 0.1 * (x - 105) * (y - 35) + 0.2 * Math.sqrt(Math.abs(x - 105));
  dLat += (20 * Math.sin(6 * (x - 105) * Math.PI) + 20 * Math.sin(2 * (x - 105) * Math.PI)) * 2 / 3;
  dLat += (20 * Math.sin((y - 35) * Math.PI) + 40 * Math.sin((y - 35) / 3 * Math.PI)) * 2 / 3;
  dLat += (160 * Math.sin((y - 35) / 12 * Math.PI) + 320 * Math.sin((y - 35) * Math.PI / 30)) * 2 / 3;
  let dLng = 300 + (x - 105) + 2 * (y - 35) + 0.1 * (x - 105) * (x - 105)
    + 0.1 * (x - 105) * (y - 35) + 0.1 * Math.sqrt(Math.abs(x - 105));
  dLng += (20 * Math.sin(6 * (x - 105) * Math.PI) + 20 * Math.sin(2 * (x - 105) * Math.PI)) * 2 / 3;
  dLng += (20 * Math.sin((x - 105) * Math.PI) + 40 * Math.sin((x - 105) / 3 * Math.PI)) * 2 / 3;
  dLng += (150 * Math.sin((x - 105) / 12 * Math.PI) + 300 * Math.sin((x - 105) / 30 * Math.PI)) * 2 / 3;
  const radLat = y / 180 * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - ee * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180) / ((a * (1 - ee)) / (magic * sqrtMagic) * Math.PI);
  dLng = (dLng * 180) / (a / sqrtMagic * Math.cos(radLat) * Math.PI);
  return { lat: y + dLat, lng: x + dLng };
}

const R_EARTH = 6371000;

// 两点球面距离（米）
export function distanceM(lat1, lng1, lat2, lng2) {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLng = (lng2 - lng1) * rad;
  const a = Math.pow(Math.sin(dLat / 2), 2) +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.pow(Math.sin(dLng / 2), 2);
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(a)));
}

// 距离文案：<1000m 显示「120m」，否则「1.2km」；未知返回空串（调用方据此隐藏）
export function fmtDist(m) {
  const v = coordNum(m);
  if (!Number.isFinite(v) || v < 0) return '';
  if (v < 1000) return Math.round(v) + 'm';
  return (v / 1000).toFixed(1) + 'km';
}
