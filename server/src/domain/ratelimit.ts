/**
 * 内存滑动窗口限流（与 cloud/security.py::rate_ok 一致）。
 *
 * 注意：这是进程内存态，重启清零——与 Python 版行为一致（Python 也是内存 RATE dict）。
 */
const buckets = new Map<string, number[]>();

export function rateOk(ip: string, bucket: string, limit: number, windowSec = 60): boolean {
  const key = `${ip}|${bucket}`;
  const now = Date.now() / 1000;
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
