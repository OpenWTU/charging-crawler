/**
 * 内存滑动窗口限流（与 cloud/security.py::rate_ok 一致）。
 *
 * 注意：这是进程内存态，重启清零——与 Python 版行为一致（Python 也是内存 RATE dict）。
 */
const buckets = new Map<string, number[]>();

/** M11：桶永不清理 —— 每个 (ip,bucket) 永久留一个数组，真实 IP 分散时可长到几十 MB */
const SWEEP_EVERY = 1000; // 每 1000 次调用扫一次
let callsSinceSweep = 0;

function sweep(now: number): void {
  // 最大窗口 1 天；超过这个时间还没新记录的直接删
  const cutoff = now - 86400;
  for (const [key, q] of buckets) {
    const last = q[q.length - 1] ?? 0;
    if (last < cutoff) buckets.delete(key);
  }
}

export function rateOk(ip: string, bucket: string, limit: number, windowSec = 60): boolean {
  const key = `${ip}|${bucket}`;
  const now = Date.now() / 1000;
  callsSinceSweep += 1;
  if (callsSinceSweep >= SWEEP_EVERY) {
    callsSinceSweep = 0;
    sweep(now);
  }
  let q = buckets.get(key) ?? [];
  q = q.filter((t) => now - t <= windowSec);
  if (q.length >= limit) {
    buckets.set(key, q);
    return false;
  }
  q.push(now);
  buckets.set(key, q);
  return true;
}

/** 测试用：清空所有桶 */
export function resetRateBuckets(): void {
  buckets.clear();
}
