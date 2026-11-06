/**
 * 管理后台的展示格式化（纯函数，无状态）。
 *
 * 集中在这里而不是各面板里各写一份：审计/设备/令牌/控制器四个面板对
 * 字节数、时间戳、结果码的展示口径必须一致。
 */

export function shortId(id) {
  const s = id === null || id === undefined ? '' : String(id).trim();
  if (!s) return '—';
  return s.length > 12 ? `${s.slice(0, 12)}…` : s;
}

export function fmtNum(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v.toLocaleString('zh-CN') : '—';
}

export function numOrDash(n) {
  return n === null || n === undefined || n === '' ? '—' : n;
}

export function decCode(code) {
  if (code === null || code === undefined || code === '') return '—';
  const n = Number(code);
  return Number.isFinite(n) ? String(n) : String(code);
}

export function fmtBytes(n) {
  if (n === null || n === undefined) return '—';
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / 1024 / 1024).toFixed(1)} MB`;
}

export function fmtTs(sec) {
  const v = Number(sec);
  if (!Number.isFinite(v) || v <= 0) return '—';
  const d = new Date(v * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
         `${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 秒/毫秒时间戳或时间文本 → 本地时间；非法值原样返回
export function fmtEpochAny(v) {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  if (Number.isFinite(n)) {
    if (n <= 0) return '—';
    return fmtTs(n > 1e12 ? Math.floor(n / 1000) : n);
  }
  const t = Date.parse(String(v).replace(' ', 'T'));
  return Number.isFinite(t) ? fmtTs(Math.floor(t / 1000)) : String(v);
}

export function fmtLongLived(v) {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'boolean') return v ? '是' : '否';
  const n = Number(v);
  return Number.isFinite(n) ? `${n} 个` : String(v);
}

// ---- 审计结果码 → 文案/色调 ----
export function tone(result) {
  if (result === 'ok' || result === 'register') return 'ok';
  if (['bad_sig', 'replay', 'bad_ts', 'rate_limited', 'register_rate'].includes(result)) {
    return 'bad';
  }
  return 'warn';
}

export const sourceLabel = (s) => ({
  device: '设备', user: '用户', register: '注册', other: '其他', admin: '管理',
}[s] || '其他');

const RESULT_LABELS = {
  ok: '成功', bad_sig: '签名失败', bad_body: '数据非法', invalid: '数据非法',
  replay: '重放', bad_ts: '时间戳过期', rate_limited: '限流', pending: '待审批',
  register: '设备注册', register_rate: '注册限流', auth_expired: '令牌过期',
  area_add: '新增区域', area_delete: '删除区域', admin_settings: '修改设置',
  admin_create: '新增管理员', admin_password: '修改密码',
  device_revoke: '撤销设备', device_revoke_undo: '恢复设备',
  area_coords: '设置坐标', controllers_sync: '控制器同步',
  device_approve: '设备通过', device_pending: '设备待审批',
  controller_qr: '更新二维码', token_update: '令牌写入', invalid_ports: '端口非法',
  store_error: '入库失败', too_large: '请求体过大',
};
export const resultLabel = (r) => RESULT_LABELS[r] || r || '—';

// 后台任务结果码 → 可读文案
export function resultText(r) {
  const v = String(r || '');
  if (v.startsWith('ok:')) return '成功 · ' + v.slice(3) + '（设备/端口）';
  if (v === 'no-token') return '无可用令牌';
  if (v === 'no-project') return '账号未绑定小区';
  if (v === 'empty') return '未抓到任何区域';
  if (v === 'skip:busy') return '跳过（正在刷新）';
  if (v === 'auth-expired' || v === 'decrypt-fail') return '令牌已过期';
  if (v.startsWith('error')) return '失败';
  return v || '—';
}

const LEVEL_CLASSES = { error: 'error', warn: 'warn', info: 'info' };
const LEVEL_LABELS = { error: '错误', warn: '警告', info: '提示' };
export const levelClass = (l) => LEVEL_CLASSES[l] || 'info';
export const levelLabel = (l) => LEVEL_LABELS[l] || '提示';

// 设备吊销/审批状态（revoked 与 status 两种表示并存，统一判定）
export const isRevoked = (d) => Boolean(d && d.revoked) || Boolean(d && d.status === 'revoked');
export const isPending = (d) => Boolean(d) && !isRevoked(d) && d.status === 'pending';

export function deviceStatusText(d) {
  if (isRevoked(d)) return '已撤销';
  if (isPending(d)) return '待审批';
  return '已通过';
}

export function deviceStatusClass(d) {
  if (isRevoked(d)) return 'chip-bad';
  if (isPending(d)) return 'chip-warn';
  return 'chip-ok';
}

// 让 revoked 与 status 两种表示保持一致
export function applyDevice(row, patch) {
  if (!row) return;
  if (patch && typeof patch.revoked === 'boolean') row.revoked = patch.revoked;
  if (patch && typeof patch.status === 'string' && patch.status) row.status = patch.status;
  if (row.revoked === true) row.status = 'revoked';
  else if (row.status === 'revoked') row.status = 'approved';
}

// 区域坐标：后端行里可能为空（旧区域），空值统一返回 null
export function areaCoord(a) {
  if (!a) return null;
  const lat = a.lat === null || a.lat === undefined || a.lat === '' ? NaN : Number(a.lat);
  const lng = a.lng === null || a.lng === undefined || a.lng === '' ? NaN : Number(a.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

export function coordLabel(a) {
  const c = areaCoord(a);
  return c ? `${c.lat.toFixed(6)}, ${c.lng.toFixed(6)}` : '未设置坐标';
}
