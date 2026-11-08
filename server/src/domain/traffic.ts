/**
 * 流量统计（内存聚合）。
 *
 * 只统计业务接口（`/api/*`、`/admin/api/*`），跳过静态资源与健康检查，
 * 避免资产请求把噪声淹没真实流量。进程重启清零（历史归档在 traffic_minute，后续接）。
 */
const MAX_BUCKETS = 5000;
/** 只保留最近 N 分钟的桶（原实现无时间淘汰，靠削到 5000 条硬顶，会把当前分钟的真实数据删掉） */
const KEEP_MINUTES = 180;

interface Bucket {
  hits: number;
  ips: Set<string>;
}

/** key = `${minute}|${path}|${statusGroup}` */
const buckets = new Map<string, Bucket>();

function minuteOf(d: Date): string {
  const p = (x: number): string => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
    + `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 路径归一化：把数字段替换成 :id，避免 /api/pile/001 /002 各占一行 */
export function normalizePath(raw: string): string {
  const path = (raw.split('?')[0] ?? '').slice(0, 120);
  return path
    .replace(/\/\d{2,}(?=\/|$)/g, '/:id')
    .replace(/\/[0-9a-fA-F]{16,}(?=\/|$)/g, '/:id');
}

function statusGroup(code: number): string {
  if (code >= 500) return '5xx';
  if (code === 429) return '429';
  if (code >= 400) return '4xx';
  if (code >= 300) return '3xx';
  return '2xx';
}

/** 是否值得统计 */
export function shouldTrack(path: string): boolean {
  if (!path.startsWith('/api/') && !path.startsWith('/admin/api/')) return false;
  if (path === '/api/version' || path === '/api/latest') return false;
  return true;
}

/** 淘汰超过 KEEP_MINUTES 的桶 */
function sweepOldMinutes(): void {
  const cutoff = minuteOf(new Date(Date.now() - KEEP_MINUTES * 60_000));
  for (const key of buckets.keys()) {
    const minute = key.split('|')[0] ?? '';
    if (minute < cutoff) buckets.delete(key);
  }
}

export function noteRequest(rawPath: string, statusCode: number, ip: string | undefined): void {
  if (!shouldTrack(rawPath)) return;
  // L14：404 归到一个桶里，否则随机路径能凭空制造无限 key
  if (statusCode === 404) {
    const minute = minuteOf(new Date());
    const key = `${minute}|/_notfound|4xx`;
    let b = buckets.get(key);
    if (!b) {
      b = { hits: 0, ips: new Set() };
      buckets.set(key, b);
    }
    b.hits += 1;
    if (ip && b.ips.size < 5000) b.ips.add(ip);
    return;
  }
  const minute = minuteOf(new Date());
  const key = `${minute}|${normalizePath(rawPath)}|${statusGroup(statusCode)}`;
  let b = buckets.get(key);
  if (!b) {
    if (buckets.size >= MAX_BUCKETS) {
      // 先按时间淘汰旧分钟；仍然超限就整体清空（比逐条排序删更省 CPU）
      sweepOldMinutes();
      if (buckets.size >= MAX_BUCKETS) buckets.clear();
    }
    b = { hits: 0, ips: new Set() };
    buckets.set(key, b);
  }
  b.hits += 1;
  if (ip && b.ips.size < 5000) b.ips.add(ip);
}

export interface TrafficPoint {
  minute: string;
  status: string;
  hits: number;
  uniq_ip: number;
}

export interface PathStat {
  path: string;
  hits: number;
  status: Record<string, number>;
}

/** 近 N 小时按分钟汇总（供图表） */
export function trafficSummary(hours = 24): { points: TrafficPoint[]; total: number; uniqIps: number } {
  const since = minuteOf(new Date(Date.now() - hours * 3600_000));
  const byMinute = new Map<string, { hits: number; ips: Set<string>; status: Record<string, number> }>();
  const allIps = new Set<string>();
  let total = 0;
  for (const [key, b] of buckets) {
    const [minute, , status] = key.split('|');
    if (!minute || minute < since) continue;
    let m = byMinute.get(minute);
    if (!m) {
      m = { hits: 0, ips: new Set(), status: {} };
      byMinute.set(minute, m);
    }
    m.hits += b.hits;
    m.status[status ?? '2xx'] = (m.status[status ?? '2xx'] ?? 0) + b.hits;
    for (const ip of b.ips) {
      m.ips.add(ip);
      allIps.add(ip);
    }
    total += b.hits;
  }
  const points: TrafficPoint[] = [];
  for (const [minute, m] of [...byMinute].sort()) {
    for (const [status, hits] of Object.entries(m.status)) {
      points.push({ minute, status, hits, uniq_ip: m.ips.size });
    }
  }
  return { points, total, uniqIps: allIps.size };
}

/** 端点排行（近 N 小时） */
export function topEndpoints(hours = 24, limit = 15): PathStat[] {
  const since = minuteOf(new Date(Date.now() - hours * 3600_000));
  const byPath = new Map<string, PathStat>();
  for (const [key, b] of buckets) {
    const [minute, path, status] = key.split('|');
    if (!minute || !path || minute < since) continue;
    let p = byPath.get(path);
    if (!p) {
      p = { path, hits: 0, status: {} };
      byPath.set(path, p);
    }
    p.hits += b.hits;
    p.status[status ?? '2xx'] = (p.status[status ?? '2xx'] ?? 0) + b.hits;
  }
  return [...byPath.values()].sort((a, b) => b.hits - a.hits).slice(0, limit);
}

/** 全部路径（供前端筛选） */
export function allPaths(): string[] {
  const set = new Set<string>();
  for (const key of buckets.keys()) {
    const path = key.split('|')[1];
    if (path) set.add(path);
  }
  return [...set].sort();
}

/** 测试/重置用 */
export function resetTraffic(): void {
  buckets.clear();
}
