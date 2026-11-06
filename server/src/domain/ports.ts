/**
 * 端口领域逻辑。
 *
 * ⚠️ 与 `cloud/ports.py` 逐函数对应，算法必须完全一致（P2 要对拍）：
 *   status_group()      → statusGroup()
 *   status_counts()     → statusCounts()
 *   _ports_health()     → portsHealth()
 *   _summarize_devices()→ summarizeDevices()
 *
 * 关键不变量（v2 数据契约）：
 *  - 无法识别的状态 **保留原文**，分组记 unknown（不改写成"其他"）
 *  - busy = total - free - unavailable（unknown 计入 busy，保持 v1 语义）
 *  - state：无端口→unknown；free>0→free；busy>0→full；否则→unavailable
 */
import { PORT_STALE_SECONDS } from '../config.js';
import { getDb, sql } from '../db/index.js';
import { statusGroup as mapStatusGroup, type PortGroup } from './port-status.js';

/** 端口行：[port, status, updated_at] */
export type PortRow = readonly [string | null, string | null, string | null];

export interface PortsHealth {
  total: number;
  free: number;
  busy: number;
  unavailable: number;
  unknown: number;
  statuses: Record<string, number>;
  state: 'free' | 'full' | 'unavailable' | 'unknown';
  stale: boolean;
  online: boolean;
  error: string | null;
}

/** 状态原文 → 分组（与 Python 的 status_group 一致） */
export function statusGroup(status: unknown): PortGroup {
  return mapStatusGroup(typeof status === 'string' ? status : String(status ?? ''));
}

/**
 * 逐状态计数：`{状态原文: 数量}`。
 * 空/缺失状态统一记为 "未知"（与 Python 的 status_counts 一致）。
 */
export function statusCounts(ports: readonly PortRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of ports) {
    const raw = String(row[1] ?? '').trim();
    const key = raw || '未知';
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

/**
 * 端口健康判定。
 *
 * 注意 `stale` 的计算方式必须与 Python 一致：把 "YYYY-MM-DD HH:MM:SS" 当作
 * **本地时间**解析（Python 的 time.mktime + strptime 就是这个语义），
 * 不能用 Date.parse 的 UTC 语义，否则时区偏移会让 stale 判定错 8 小时。
 */
export function portsHealth(ports: readonly PortRow[], updatedAt: string | null): PortsHealth {
  const groups = ports.map((r) => statusGroup(r[1]));
  const total = ports.length;
  const free = groups.filter((g) => g === 'free').length;
  const unavailable = groups.filter((g) => g === 'unavailable').length;
  const unknown = groups.filter((g) => g === 'unknown').length;
  const busy = total - free - unavailable;

  const latest = ports.reduce(
    (acc: string, r) => {
      const v = r[2] ?? '';
      return v > acc ? v : acc;
    },
    updatedAt ?? '',
  );

  let stale = true;
  if (latest) {
    const ts = parseLocalTimestamp(latest);
    stale = ts === null ? true : Date.now() / 1000 - ts > PORT_STALE_SECONDS;
  }

  let state: PortsHealth['state'];
  let error: string | null;
  if (ports.length === 0) {
    state = 'unknown';
    error = '无端口数据';
  } else if (free > 0) {
    state = 'free';
    error = null;
  } else if (busy > 0) {
    state = 'full';
    error = null;
  } else {
    state = 'unavailable';
    error = null;
  }

  return {
    total,
    free,
    busy,
    unavailable,
    unknown,
    statuses: statusCounts(ports),
    state,
    stale,
    online: ports.length > 0 && !stale,
    error,
  };
}

/**
 * 解析 "YYYY-MM-DD HH:MM:SS" 为**本地时间**的 Unix 秒。
 * 与 Python 的 `time.mktime(time.strptime(s, "%Y-%m-%d %H:%M:%S"))` 等价。
 * 解析失败返回 null（Python 侧 except 分支也是按 stale=True 处理）。
 */
export function parseLocalTimestamp(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, sec] = m;
  const dt = new Date(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(sec),
  );
  const t = dt.getTime();
  return Number.isNaN(t) ? null : t / 1000;
}

export interface AreaSummary {
  free: number;
  busy: number;
  unavailable: number;
  unknown: number;
  total: number;
  statuses: Record<string, number>;
}

/** summarizeDevices 只关心这 6 个计数字段，故意不要求完整 PortsHealth */
export interface DeviceCounts {
  free?: number;
  busy?: number;
  unavailable?: number;
  unknown?: number;
  total?: number;
  statuses?: Record<string, number>;
}

/**
 * 把多台设备的健康计数汇总成区域级 summary。
 * 与 Python 的 `_summarize_devices` 逐字段一致。
 */
export function summarizeDevices(devices: ReadonlyArray<DeviceCounts>): AreaSummary {
  const summary: AreaSummary = {
    free: 0,
    busy: 0,
    unavailable: 0,
    unknown: 0,
    total: 0,
    statuses: {},
  };
  for (const dev of devices) {
    for (const key of ['free', 'busy', 'unavailable', 'unknown', 'total'] as const) {
      summary[key] += Number(dev[key] ?? 0);
    }
    const st = dev.statuses ?? {};
    for (const [status, count] of Object.entries(st)) {
      summary.statuses[status] = (summary.statuses[status] ?? 0) + Number(count ?? 0);
    }
  }
  return summary;
}

/**
 * 区域级端口状态（/api/now 的 port_state），口径与 portsHealth 对齐。
 *  - total <= 0 → unknown
 *  - idle == 0 且 busy == 0 → unavailable
 *  - idle == 0 且 busy > 0 → full
 *  - 0 < idle < total → busy
 *  - idle >= total → free
 */
export function areaPortState(idle: number, total: number, unavailable = 0): string {
  const totalI = Math.max(Math.trunc(total || 0), 0);
  const idleI = Math.max(Math.trunc(idle || 0), 0);
  const unavailI = Math.max(Math.trunc(unavailable || 0), 0);
  if (totalI <= 0) return 'unknown';
  const busyI = totalI - idleI - unavailI;
  if (idleI <= 0) return busyI > 0 ? 'full' : 'unavailable';
  if (idleI >= totalI) return 'free';
  return 'busy';
}

/**
 * 按区域统计 (端口总数, 不可用数)，供 /api/now 的 unavailable_ports。
 * 口径：unavailable 来自端口级明细（含禁用/绑定/维护/硬件故障），
 * 比平台的 faultPort 更全；没有明细的区域不出现在返回值里，调用方回退 faultPort。
 */
export async function areaPortGroupCounts(): Promise<Map<string, [number, number]>> {
  const db = getDb();
  const res = await sql<{ area_name: string; total: number; bad: number | null }>`
    SELECT c.area_name, COUNT(*) AS total,
           SUM(CASE WHEN p.status_group = 'unavailable' THEN 1 ELSE 0 END) AS bad
      FROM port_states p
      JOIN controllers c ON c.device_hex = p.device_hex
     WHERE c.area_name IS NOT NULL AND c.area_name <> ''
     GROUP BY c.area_name
  `.execute(db);
  const out = new Map<string, [number, number]>();
  for (const r of res.rows) {
    out.set(String(r.area_name), [Number(r.total), Number(r.bad ?? 0)]);
  }
  return out;
}
