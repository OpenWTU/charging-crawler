/**
 * 端口状态的展示映射（UI 层唯一入口）。
 *
 * 与 api/ports.js 的分工：
 *  - api/ports.js 负责「数据」：给每个端口补齐 v2 的 group（缺失时按 status 原文回退），
 *    并把 summary.statuses（逐状态计数）归一好；
 *  - 本文件负责「展示」：状态原文 → 色板 tone、可读文案、图例条目与计数。
 *
 * 不变量：
 *  1. **端口方块按「状态原文」上色**，因此「充电中 / 已充满 / 浮充 / 未充占用」
 *     在端口详情里是四种颜色，不再并成一个"占用"；
 *  2. 状态无法识别时才回退到分组色（free 绿 / busy 琥珀 / unavailable 红 / unknown 灰）；
 *  3. status 原文永远通过 title / aria-label 与方块内文案完整暴露，不吞信息。
 */
import { portGroupOf, portStatusOf } from './api/ports.js';

// 分组 → 色板类名后缀（回退用；对应 styles/app.css 的 .port-*）
const GROUP_TONES = Object.freeze({
  free: 'idle',
  busy: 'charging',
  unavailable: 'unavailable',
  unknown: 'other',
});

export const GROUP_LABELS = Object.freeze({
  free: '空闲',
  busy: '充电中',
  unavailable: '不可用',
  unknown: '未知',
});

/**
 * 细分状态 → 色板 tone。
 * 顺序即优先级：先匹配到的生效（已充满要先于"充电"判断，避免「充满占用」被当成充电中）。
 */
const STATUS_TONE_RULES = Object.freeze([
  [/空闲|idle|free|available|empty/i, 'idle'],
  [/已充满|充满占用/i, 'full'],
  [/浮充|trickle|float/i, 'float'],
  [/未充占用|占用|occupied/i, 'occupied'],
  [/充电|charging|in.?use|busy/i, 'charging'],
  // 不可用类：既含"禁用/绑定/离线/维护"，也含平台侧各种硬件故障原文，
  // 否则 v1 降级（无 group）时这些状态会回退成灰色 unknown
  [/禁用|绑定|故障|离线|维护|损坏|卡住|烧断|粘连|短路|disabled|bound|fault|offline|maintain|damage|stuck|blown|short/i, 'unavailable'],
]);

// 图例排序（同一分组内的细分状态也分开列，顺序固定，避免每次渲染跳动）
const LEGEND_PRIORITY = Object.freeze([
  '空闲', '充电中', '已充满', '浮充', '未充占用', '占用',
  '故障', '端口故障', '禁用', '绑定', '离线', '维护', '未知',
]);

export function statusTone(status) {
  const s = String(status == null ? '' : status).trim();
  if (!s) return 'other';
  for (const [re, tone] of STATUS_TONE_RULES) {
    if (re.test(s)) return tone;
  }
  return 'other';
}

export function portGroup(port) {
  return portGroupOf(port);
}

export function portStatus(port) {
  return portStatusOf(port);
}

// 端口方块 tone：优先按状态原文（细分），识别不了才回退分组色
export function portTone(port) {
  const tone = statusTone(portStatusOf(port));
  if (tone !== 'other') return tone;
  return GROUP_TONES[portGroupOf(port)] || 'other';
}

export function groupTone(group) {
  return GROUP_TONES[group] || 'other';
}

// 端口状态的统一可读文案（方块内文案、chip aria-label、面板 title 共用）
export function portStatusText(status) {
  const s = String(status == null ? '' : status).trim();
  if (!s) return '未知';
  if (/空闲|idle|free|available|empty/i.test(s)) return '空闲';
  if (/已充满|充满占用/i.test(s)) return '已充满';
  if (/浮充|trickle|float/i.test(s)) return '浮充';
  if (/未充占用|占用|occupied/i.test(s)) return '未充占用';
  if (/充电|charging|in.?use|busy/i.test(s)) return '充电中';
  if (/禁用|disabled|forbid/i.test(s)) return '禁用';
  if (/绑定|bound/i.test(s)) return '绑定';
  if (/维护|maintain/i.test(s)) return '维护';
  if (/故障|fault|error/i.test(s)) return '故障';
  if (/离线|offline|断开|掉线/i.test(s)) return '离线';
  return s;
}

export function portNumber(p, i) {
  if (p && typeof p === 'object' && p.port !== null && p.port !== undefined && p.port !== '') {
    return p.port;
  }
  return String(i + 1).padStart(2, '0');
}

// 端口格子的完整提示：端口号 + 状态原文（保留原文，便于区分细分状态）
export function portTitle(p, i) {
  return '端口 ' + portNumber(p, i) + ' · ' + portStatusText(portStatus(p));
}

/**
 * 图例条目（带计数）。
 *
 * 数据来源优先级：`summary.statuses`（后端逐状态计数）> 按 group 的四档（v1 回退）。
 * 只输出**实际出现**的状态，因此「浮充 0 个」不会占位；每种状态独立一条，
 * 满足"把充电中/已充满/浮充分开显示"的诉求。
 */
export function buildLegend(summary) {
  const s = summary || {};
  const statuses = s.statuses && typeof s.statuses === 'object' ? s.statuses : null;

  if (statuses) {
    const rows = Object.keys(statuses)
      .map((raw) => ({
        key: raw,
        label: portStatusText(raw),
        tone: statusTone(raw),
        count: Number(statuses[raw]) || 0,
      }))
      .filter((r) => r.count > 0);
    rows.sort((a, b) => {
      const ia = LEGEND_PRIORITY.indexOf(a.label);
      const ib = LEGEND_PRIORITY.indexOf(b.label);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.label.localeCompare(b.label);
    });
    if (rows.length) return rows;
  }

  // 回退：只有分组计数（v1 后端 / 无端口数据）
  return [
    { key: 'free', label: GROUP_LABELS.free, tone: GROUP_TONES.free, count: numOrNull(s.free) },
    { key: 'busy', label: GROUP_LABELS.busy, tone: GROUP_TONES.busy, count: numOrNull(s.busy) },
    { key: 'unavailable', label: GROUP_LABELS.unavailable, tone: GROUP_TONES.unavailable, count: numOrNull(s.unavailable) },
    { key: 'unknown', label: GROUP_LABELS.unknown, tone: GROUP_TONES.unknown, count: numOrNull(s.unknown) },
  ].filter((r) => r.count === null || r.count > 0);
}

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}
