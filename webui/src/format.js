// 页面间共用的格式化与抓包结果信号。
// 只放「多个页面必须显示同一套结果」的逻辑，避免 Token.vue / Settings.vue 各写一份。

// 剩余有效期：天 / 小时 / 分钟三档，0 秒也至少显示 1 分钟
export function fmtRemain(sec) {
  const s = Math.max(0, Number(sec) || 0);
  const mins = Math.floor(s / 60);
  if (mins >= 1440) {
    const d = Math.floor(mins / 1440);
    const h = Math.floor((mins % 1440) / 60);
    return d + ' 天' + (h ? ' ' + h + ' 小时' : '');
  }
  if (mins >= 60) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return h + ' 小时' + (m ? ' ' + m + ' 分' : '');
  }
  return Math.max(1, mins) + ' 分钟';
}

// ---- 抓包结果信号 ----
// window.__onTokenCaptured / window.__onCaptureEnd 只能有一个持有者（Token.vue 负责挂载）。
// 设置页也发起了抓取，但不能再覆盖这两个 window 回调，否则 Token 页收不到结果；
// 所以统一由 Token.vue 转发到这里的订阅表，其它页面按需订阅。
const captureListeners = { captured: new Set(), end: new Set() };

export function onCapture(kind, fn) {
  const set = captureListeners[kind];
  if (!set || typeof fn !== 'function') return () => {};
  set.add(fn);
  return () => { set.delete(fn); };
}

export function emitCapture(kind) {
  const set = captureListeners[kind];
  if (!set) return;
  Array.from(set).forEach((fn) => {
    try {
      fn();
    } catch {
      // 单个订阅者异常不影响其它页面
    }
  });
}

// ---- 时间格式化（实时页健康条 / 端口面板 / 历史弹层共用） ----


// 兼容秒/毫秒时间戳与 "YYYY-MM-DD HH:MM:SS" 文本，非法值返回 0
export function toMs(v) {
  if (v === null || v === undefined || v === '') return 0;
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) return n > 1e12 ? n : n * 1000;
  const t = Date.parse(String(v).replace(' ', 'T'));
  return Number.isFinite(t) ? t : 0;
}

// 月-日 时:分（标题/提示里用，年份没意义）
export function fmtExp(ms) {
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, '0');
  return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' '
    + p(d.getHours()) + ':' + p(d.getMinutes());
}

export function tsText(v) {
  const ms = toMs(v);
  return ms ? fmtExp(ms) : '';
}

// 只取 "HH:MM"（更新时间文案）
export function hhmm(s) {
  const m = /(\d{2}):(\d{2})/.exec(String(s || ''));
  return m ? m[1] + ':' + m[2] : '';
}

// "YYYY-MM-DD HH:MM(:SS)" → 毫秒；未来时间夹到 now，非法返回 0
export function parseCaptured(s) {
  if (!s) return 0;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(s);
  if (!m) return 0;
  const ms = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)).getTime();
  return ms > Date.now() ? Date.now() : ms;
}

// 相对时间：刚刚 / x 分钟前 / x 小时前 / x 天前（now 由调用方传入，随节拍刷新）
export function agoText(at, now) {
  if (!at) return '';
  const sec = Math.max(0, Math.floor(((now || Date.now()) - at) / 1000));
  if (sec < 60) return '刚刚';
  if (sec < 3600) return Math.floor(sec / 60) + ' 分钟前';
  if (sec < 86400) return Math.floor(sec / 3600) + ' 小时前';
  return Math.floor(sec / 86400) + ' 天前';
}

// 24 小时横轴刻度：只在 00/06/12/18 点打标签，其余留空（热力图与柱状图共用）
export function hourLabel(h) {
  return h % 6 === 0 ? String(h).padStart(2, '0') : '';
}

