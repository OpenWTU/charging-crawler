/**
 * 端口维度接口 + 数据契约 v2 兼容层。
 *
 * 职责：
 *  1. 拉取单个区域 / 单台桩的端口数据（App 走 JS 桥，网页走 HTTP）；
 *  2. 把 v2 的 `ports[].group` 与 `summary{free,busy,unavailable,unknown,total}`
 *     统一补齐（后端尚未部署 v2 时用 status 原文 / 数字码回退推导），
 *     这样所有页面拿到的形状一致，UI 只认 group。
 *
 * 不变量：
 *  - 端口 `status` 原文永远保留，不改写成「其他」；
 *  - group 只取 'free' | 'busy' | 'unavailable' | 'unknown'；
 *  - `summary` 一定存在：后端给了就原样用（fromBackend=true），没给就按端口现算。
 */
import {
  isApp, getJSON, isObj, awaitGlobalBridge, callBridgeJSON,
} from './transport.js';

// ---- 状态 → 分组（契约 3.1，与后端 PORT_STATUS_GROUPS / PORT_CODE_GROUPS 对齐）----
export const PORT_GROUPS = Object.freeze(['free', 'busy', 'unavailable', 'unknown']);

const STATUS_GROUPS = Object.freeze({
  空闲: 'free',
  充电中: 'busy',
  未充占用: 'busy',
  已充满: 'busy',
  充满占用: 'busy',
  浮充: 'busy',
  占用: 'busy',
  端口故障: 'unavailable',
  故障: 'unavailable',
  离线: 'unavailable',
  维护: 'unavailable',
  禁用: 'unavailable',
  绑定: 'unavailable',
  绑定端口: 'unavailable',
  禁用端口: 'unavailable',
  存储器损坏: 'unavailable',
  安全门卡住: 'unavailable',
  保险丝烧断: 'unavailable',
  继电器粘连: 'unavailable',
  门磁芯片损坏: 'unavailable',
  '预检-负载短路': 'unavailable',
  刷卡芯片损坏故障: 'unavailable',
});

const CODE_GROUPS = Object.freeze({
  0: 'free',
  1: 'busy', 2: 'busy', 3: 'busy', 5: 'busy',
  4: 'unavailable', 6: 'unavailable', 7: 'unavailable', 8: 'unavailable',
  9: 'unavailable', 10: 'unavailable', 13: 'unavailable', 15: 'unavailable',
  88: 'unavailable', 99: 'unavailable',
});

// 未在表里的中英文写法做兜底识别（旧后端/脏数据）：只保证 group 不失真，
// 不改变 status 原文。
const FREE_RE = /空闲|idle|free|available|empty/;
const BUSY_RE = /充电|充满|浮充|占用|charging|in.?use|busy|occupied/;
const UNAVAILABLE_RE = /故障|离线|维护|禁用|绑定|损坏|短路|卡住|烧断|粘连|fault|error|offline|disabled|bound|maintain/;

export function isPortGroup(v) {
  return typeof v === 'string' && PORT_GROUPS.indexOf(v) >= 0;
}

// 分组推导：后端 group 优先 → 状态原文（中文表 / 数字码 / 中英关键字）→ unknown
export function portGroupOf(port) {
  const p = isObj(port) ? port : { status: port };
  if (isPortGroup(p.group)) return p.group;
  const raw = p.status === null || p.status === undefined ? '' : p.status;
  const text = String(raw).trim();
  if (!text) return 'unknown';
  if (Object.prototype.hasOwnProperty.call(STATUS_GROUPS, text)) {
    return STATUS_GROUPS[text];
  }
  // 平台有的接口直接给数字状态码（0=空闲，1/2/3/5=占用，4/6/7/8/9/10/13/15/88/99=故障类）
  if (/^-?\d+$/.test(text)) {
    const code = Number(text);
    if (Object.prototype.hasOwnProperty.call(CODE_GROUPS, code)) return CODE_GROUPS[code];
  }
  if (FREE_RE.test(text)) return 'free';
  if (BUSY_RE.test(text)) return 'busy';
  if (UNAVAILABLE_RE.test(text)) return 'unavailable';
  return 'unknown';
}

// 端口状态原文（兼容 ports 项是字符串的旧形状）
export function portStatusOf(port) {
  if (isObj(port)) return port.status === null || port.status === undefined ? '' : port.status;
  return port === null || port === undefined ? '' : port;
}

function normalizePort(port) {
  if (!isObj(port)) return { port: null, status: portStatusOf(port), group: portGroupOf(port) };
  const group = portGroupOf(port);
  return port.group === group ? port : { ...port, group };
}

// 端口数量汇总：只要有一个端口能定组就统计；无端口数据时 total=0
// statuses 是**逐状态计数**（原文 → 数量），供端口详情按「充电中/已充满/浮充」分开显示。
export function summarizePorts(devices) {
  const out = { free: 0, busy: 0, unavailable: 0, unknown: 0, total: 0, statuses: {} };
  (Array.isArray(devices) ? devices : []).forEach((d) => {
    const ports = d && Array.isArray(d.ports) ? d.ports : [];
    ports.forEach((p) => {
      const g = portGroupOf(p);
      out[isPortGroup(g) ? g : 'unknown'] += 1;
      out.total += 1;
      const raw = String(portStatusOf(p) == null ? '' : portStatusOf(p)).trim();
      const key = raw || '未知';
      out.statuses[key] = (out.statuses[key] || 0) + 1;
    });
  });
  return out;
}

// summary 归一：后端 v2 给了就以它为准，缺字段/缺整体时用端口现算补齐
function normalizeSummary(raw, devices) {
  const computed = summarizePorts(devices);
  if (!isObj(raw)) return { ...computed, fromBackend: false };
  const pick = (k) => {
    const n = Number(raw[k]);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
  };
  const out = { ...computed, fromBackend: true };
  let known = 0;
  ['free', 'busy', 'unavailable', 'unknown'].forEach((k) => {
    const v = pick(k);
    if (v !== null) { out[k] = v; known += 1; }
  });
  const total = pick('total');
  out.total = total !== null ? total : out.free + out.busy + out.unavailable + out.unknown;
  // 后端若已给逐状态计数（v2 新增），直接用；否则保留上面按端口现算的结果
  if (isObj(raw.statuses)) {
    const statuses = {};
    Object.keys(raw.statuses).forEach((k) => {
      const n = Number(raw.statuses[k]);
      if (Number.isFinite(n) && n >= 0) statuses[String(k)] = Math.floor(n);
    });
    if (Object.keys(statuses).length) out.statuses = statuses;
  }
  return known ? out : { ...computed, fromBackend: false };
}

// 设备数组归一：每个端口的 group 一定存在
export function normalizeDevices(devices) {
  return (Array.isArray(devices) ? devices : []).map((d) => {
    if (!isObj(d)) return d;
    if (!Array.isArray(d.ports)) return d;
    return { ...d, ports: d.ports.map(normalizePort) };
  });
}

// 区域端口响应归一：{ area, devices, summary, ...原字段 }
export function normalizePortsPayload(raw, areaName) {
  const src = isObj(raw) ? raw : {};
  const devices = normalizeDevices(src.devices);
  return {
    ...src,
    area: src.area || areaName || '',
    devices,
    summary: normalizeSummary(src.summary, devices),
  };
}

// 区域端口详情：App 走 JS 桥（Android 侧返回 JSON 字符串），网页走 HTTP 接口。
// 桥方法不存在或调用/解析失败时回退为空列表，页面据此显示「暂无端口数据」。
let portsSeq = 0;

export async function getAreaPorts(name) {
  if (isApp) {
    const host = window.AndroidHost;
    if (host && typeof host.getAreaPorts === 'function') {
      const seq = ++portsSeq;
      const r = await awaitGlobalBridge('__onAreaPorts', () => host.getAreaPorts(name), 26000);
      if (seq !== portsSeq) throw new Error('端口数据请求已失效');
      let d = null;
      if (!r.threw && typeof r.raw === 'string') {
        try { d = JSON.parse(r.raw); } catch { d = null; }
      }
      if (!d || d.ok === false) throw new Error((d && d.error) || '端口数据不可用');
      return normalizePortsPayload(d, name);
    }
    return normalizePortsPayload({ devices: [], area: name }, name);
  }
  const d = await getJSON('/api/area-ports?area=' + encodeURIComponent(name));
  return normalizePortsPayload(d, name);
}

// 单台桩详情：/api/pile/<device_hex> → { ok, pile:{...,ports,history} }
// App 桥优先、失败回退 fetch；桩详情里的 ports 同样补 group。
export async function getPile(device) {
  const hex = String(device == null ? '' : device).trim();
  if (!hex) throw new Error('缺少设备号');
  const host = isApp ? window.AndroidHost : null;
  if (host && typeof host.getPile === 'function') {
    try {
      const d = await callBridgeJSON('__onPile', () => host.getPile(hex), 23000);
      if (d && d.ok !== false) return withPileGroups(d);
    } catch { /* 桥未实现/失败：回退 HTTP */ }
  }
  return withPileGroups(await getJSON('/api/pile/' + encodeURIComponent(hex)));
}

function withPileGroups(d) {
  if (!isObj(d) || !isObj(d.pile)) return d;
  const ports = normalizeDevices([{ ports: d.pile.ports }])[0];
  return { ...d, pile: { ...d.pile, ports: ports.ports } };
}
