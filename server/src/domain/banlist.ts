/**
 * 脏数据自动拉黑（新功能，Python 版没有，替代人工审批的自动化手段）。
 *
 * 规则（内存态，重启清零；P7 公开状态页可查看）：
 *  - bad_sig 验签失败：5 次 / 10 分钟 → 拉黑 1 小时
 *  - replay   nonce 重放：3 次 / 10 分钟 → 拉黑 1 小时（阈值不能是 1：
 *             nonce 是全局主键，两台设备随机撞车或客户端重发都会命中，会误伤合法设备）
 *  - bad_ts   时间戳过期：10 次 / 10 分钟 → 拉黑 1 小时
 *
 * 计数按 kind 分开统计（共用一个计数器会让 bad_sig 与 replay 互相累加，提前误拉黑）。
 *
 * 拉黑维度：优先按 device_id（若有），否则按 IP。
 */
interface BanState {
  /** 按事件类型分开计数（窗口内） */
  kinds: Partial<Record<BanKind, number>>;
  windowStart: number;
  bannedUntil: number;
}

const FAIL_WINDOW = 10 * 60; // 10 分钟
const BAN_SECONDS = 3600; // 1 小时

const byDevice = new Map<string, BanState>();
const byIp = new Map<string, BanState>();

/**
 * 惰性清扫：只有条目超过阈值才扫一遍（正常规模下几乎零成本），
 * 避免伪造 IP/device 把内存撑爆（配合 XFF 伪造的风险面）。
 */
function sweep(m: Map<string, BanState>, now: number): void {
  if (m.size < 5000) return;
  for (const [k, s] of m) {
    if (s.bannedUntil <= now && now - s.windowStart > FAIL_WINDOW) m.delete(k);
  }
}

export type BanKind = 'bad_sig' | 'replay' | 'bad_ts';

const THRESHOLD: Record<BanKind, number> = {
  bad_sig: 5,
  // nonce 是全局主键（未按 device 分区），两台设备随机撞车或客户端重发都会命中，
  // 阈值 1 会误伤合法设备（拉黑 1 小时），放宽到 3 次
  replay: 3,
  bad_ts: 10,
};

function stateOf(m: Map<string, BanState>, key: string, now: number): BanState {
  let s = m.get(key);
  if (!s) {
    s = { kinds: {}, windowStart: now, bannedUntil: 0 };
    m.set(key, s);
  }
  return s;
}

export function isBanned(deviceId: string | null, ip: string): boolean {
  const now = Date.now() / 1000;
  if (deviceId) {
    const s = byDevice.get(deviceId);
    if (s && s.bannedUntil > now) return true;
  }
  const s = byIp.get(ip);
  return !!s && s.bannedUntil > now;
}

/** 记录一次脏数据事件；返回是否触发拉黑 */
export function recordBan(deviceId: string | null, ip: string, kind: BanKind): boolean {
  const now = Date.now() / 1000;
  const map = deviceId ? byDevice : byIp;
  sweep(map, now);
  const key = deviceId ?? ip;
  const s = stateOf(map, key, now);
  if (s.bannedUntil > now) return false; // 已拉黑，不再计数
  if (now - s.windowStart > FAIL_WINDOW) {
    s.kinds = {};
    s.windowStart = now;
  }
  const n = (s.kinds[kind] ?? 0) + 1;
  s.kinds[kind] = n;
  if (n >= THRESHOLD[kind]) {
    s.bannedUntil = now + BAN_SECONDS;
    return true;
  }
  return false;
}

/** 剩余拉黑秒数（状态页展示用）；未拉黑返回 0 */
export function bannedSeconds(deviceId: string | null, ip: string): number {
  const now = Date.now() / 1000;
  const candidates: Array<BanState | undefined> = [
    deviceId ? byDevice.get(deviceId) : undefined,
    byIp.get(ip),
  ];
  for (const s of candidates) {
    if (s && s.bannedUntil > now) return Math.ceil(s.bannedUntil - now);
  }
  return 0;
}

/** 拉黑统计（公开状态页展示） */
export function banlistStats(): { devices: number; ips: number } {
  const now = Date.now() / 1000;
  const dev = [...byDevice.values()].filter((s) => s.bannedUntil > now).length;
  const ips = [...byIp.values()].filter((s) => s.bannedUntil > now).length;
  return { devices: dev, ips };
}

export interface BanEntry {
  kind: 'device' | 'ip';
  target: string;
  /** 窗口内各类失败计数 */
  kinds: Partial<Record<BanKind, number>>;
  remaining_sec: number;
}

/** 列出当前生效的封禁（管理后台「流量与限流」页） */
export function listBans(limit = 100): BanEntry[] {
  const now = Date.now() / 1000;
  const out: BanEntry[] = [];
  for (const [target, s] of byDevice) {
    if (s.bannedUntil > now) {
      out.push({ kind: 'device', target, kinds: s.kinds, remaining_sec: Math.ceil(s.bannedUntil - now) });
    }
  }
  for (const [target, s] of byIp) {
    if (s.bannedUntil > now) {
      out.push({ kind: 'ip', target, kinds: s.kinds, remaining_sec: Math.ceil(s.bannedUntil - now) });
    }
  }
  return out.sort((a, b) => b.remaining_sec - a.remaining_sec).slice(0, limit);
}

/** 按设备/ IP 主动解封；返回是否找到并解除了封禁 */
export function unbanById(target: string): boolean {
  let hit = false;
  const dev = byDevice.get(target);
  if (dev) {
    byDevice.delete(target);
    hit = true;
  }
  const ip = byIp.get(target);
  if (ip) {
    byIp.delete(target);
    hit = true;
  }
  return hit;
}

/** 测试用：清空 */
export function resetBanlist(): void {
  byDevice.clear();
  byIp.clear();
}
