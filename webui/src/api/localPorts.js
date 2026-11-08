/**
 * App 抓取后的「本地端口优先」层。
 *
 * 背景：Android 抓完一次会把 ports 一并推给前端（`__onLocalState` 的载荷里带 ports），
 * 但以前 `applyLocalState` 只吃 `areas`，ports 被整个丢掉 —— 于是端口面板永远等服务器
 * 回写，上传被拒/上传慢的时候，用户看不到自己刚抓到的那份端口状态，像是抓取没生效。
 *
 * 语义（按这个顺序理解）：
 *  1. Android 推送 → `applyLocalPorts(list)`，按 device_hex 建索引；
 *  2. 端口面板 / 全量列表读取 → `devicesForArea(name)` / `allDevices()`，命中就用本地；
 *  3. **上传成功 → `clearLocalPorts()`**，立刻回到「服务器权威」；
 *  4. 上传失败 → 保留，下次刷新仍优先显示本地抓到的数据；
 *  5. TTL 兜底（10 分钟），避免长时间停在很久以前的一份本地快照上。
 *
 * 本模块不 import 任何其它 api 模块，避免 ports.js / areas.js 之间出现循环依赖。
 */

/** 本地快照的有效期：超过就认为过时，回到服务器数据。 */
const TTL_MS = 10 * 60 * 1000;

/** device_hex → { device_hex, area, code, ports } */
let byHex = new Map();
let snapshotAt = 0;

function normList(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const e of list) {
    if (!e || typeof e !== 'object') continue;
    const hex = typeof e.device_hex === 'string' ? e.device_hex.trim() : '';
    if (!hex) continue;
    if (!Array.isArray(e.ports)) continue;
    out.push({
      device_hex: hex,
      area: typeof e.area === 'string' ? e.area : '',
      code: typeof e.code === 'string' ? e.code : '',
      ports: e.ports,
    });
  }
  return out;
}

/**
 * 接收 Android 推来的端口快照（`state.ports`）。
 * @returns {number} 接收到的设备数（0 表示这份载荷没有可用端口）
 */
export function applyLocalPorts(list) {
  const rows = normList(list);
  if (!rows.length) return 0;
  byHex = new Map(rows.map((r) => [r.device_hex, r]));
  snapshotAt = Date.now();
  return rows.length;
}

/** 上传成功 / 退出登录 / 需要强制回服务器数据时调用。 */
export function clearLocalPorts() {
  byHex = new Map();
  snapshotAt = 0;
}

/** 本地快照是否仍然可用（有数据且未过期）。 */
export function localPortsActive() {
  return byHex.size > 0 && snapshotAt > 0 && Date.now() - snapshotAt < TTL_MS;
}

/** 某个区域下的本地设备端口；没有命中返回 null（调用方回退服务器）。 */
export function devicesForArea(areaName) {
  if (!localPortsActive()) return null;
  const want = String(areaName == null ? '' : areaName);
  const out = [];
  for (const r of byHex.values()) {
    if (r.area !== want) continue;
    out.push({ device_hex: r.device_hex, code: r.code, ports: r.ports });
  }
  return out.length ? out : null;
}

/** 全量：把本地设备按区域名归组，形状与 /api/areas-ports 的 `areas` 一致。 */
export function allLocalAreas() {
  if (!localPortsActive()) return null;
  const map = new Map();
  for (const r of byHex.values()) {
    const name = r.area || '';
    if (!name) continue;
    if (!map.has(name)) map.set(name, []);
    map.get(name).push({ device_hex: r.device_hex, code: r.code, ports: r.ports });
  }
  if (!map.size) return null;
  return [...map.entries()].map(([name, devices]) => ({ name, devices }));
}
