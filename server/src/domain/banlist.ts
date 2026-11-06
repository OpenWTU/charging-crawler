/**
 * 脏数据自动拉黑（新功能，Python 版没有，替代人工审批的自动化手段）。
 *
 * 规则（内存态，重启清零；P7 公开状态页可查看）：
 *  - bad_sig 验签失败：5 次 / 10 分钟 → 拉黑 1 小时
 *  - replay   nonce 重放：1 次即拉黑 1 小时（重放是明确攻击）
 *  - bad_ts   时间戳过期：10 次 / 10 分钟 → 拉黑 1 小时
 *
 * 拉黑维度：优先按 device_id（若有），否则按 IP。
 */
interface BanState {
  fails: number;
  windowStart: number;
  bannedUntil: number;
}

const FAIL_WINDOW = 10 * 60; // 10 分钟
const BAN_SECONDS = 3600; // 1 小时

const byDevice = new Map<string, BanState>();
const byIp = new Map<string, BanState>();

export type BanKind = 'bad_sig' | 'replay' | 'bad_ts';

const THRESHOLD: Record<BanKind, number> = {
  bad_sig: 5,
  replay: 1,
  bad_ts: 10,
};

function stateOf(m: Map<string, BanState>, key: string, now: number): BanState {
  let s = m.get(key);
  if (!s) {
    s = { fails: 0, windowStart: now, bannedUntil: 0 };
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
  const key = deviceId ?? ip;
  const s = stateOf(map, key, now);
  if (s.bannedUntil > now) return false; // 已拉黑，不再计数
  if (now - s.windowStart > FAIL_WINDOW) {
    s.fails = 0;
    s.windowStart = now;
  }
  s.fails += 1;
  if (s.fails >= THRESHOLD[kind]) {
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

/** 测试用：清空 */
export function resetBanlist(): void {
  byDevice.clear();
  byIp.clear();
}
