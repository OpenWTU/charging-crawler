/**
 * 离线统计：热力图 / 24h-7d 趋势 / 区域排行 / 同时段预测，全部按端口数加权。
 *
 * ⚠️ 与 `cloud/analytics.py` 的 build_analytics() 逐行对应，输出必须一致（P2 对拍）。
 *
 * 关键不变量：
 *  - 15 分钟固定槽（24h = 96 槽）、天粒度 7 天
 *  - 没有样本的槽 ratio 为 **null** 而不是 0
 *  - 热力图下标：0=周一 … 6=周日（SQL 的 strftime('%w') 是 0=周日，要 (dow+6)%7）
 *  - ranking 按 avg_idle_ratio 降序；best_slots 要求 total_sum >= 20 取前 3
 *
 * 注意：Python 的 round() 是**银行家舍入**（round half to even），JS 的 Math.round 不是。
 * 这里实现 pyRound() 复刻 Python 语义，避免小数末位差异。
 */
import { ANALYTICS_SLOT_MINUTES, ANALYTICS_TREND_DAYS, ANALYTICS_TREND_SLOTS } from '../config.js';
import { getDb, sql } from '../db/index.js';

/**
 * 复刻 Python 的 round(x, n)。
 *
 * ⚠️ 关键：Python 的 round 跟随**二进制浮点的真实值**，而不是十进制字面值。
 *    例：0.1625 实际存为 0.16250000000000000555 → round(.,3) = 0.163（进位）
 *        0.0375 实际存为 0.03749999999999999861 → round(.,3) = 0.037（舍去）
 *    如果先把值"抹平"到 0.1625 / 0.0375 再做银行家舍入，这两例都会算错。
 *
 * 做法：用 toFixed(20) 展开真实十进制展开，按「第 n+1 位起 vs 一半」判断；
 * 正好等于一半（后面全 0）时才用银行家舍入（取偶）。
 */
export function pyRound(x: number, n = 0): number {
  if (!Number.isFinite(x)) return x;
  const neg = x < 0;
  const abs = Math.abs(x);
  const s = abs.toFixed(20);
  const [intPart = '0', fracRaw = ''] = s.split('.');
  if (fracRaw.length <= n) return x;

  const keep = fracRaw.slice(0, n);
  const rest = fracRaw.slice(n); // 第 n+1 位起
  const firstRest = Number(rest[0] ?? '0');
  const tail = rest.slice(1);
  const hasTail = /[1-9]/.test(tail);

  let bump = false;
  if (firstRest > 5) {
    bump = true;
  } else if (firstRest === 5) {
    if (hasTail) {
      bump = true; // 大于一半
    } else {
      // 正好一半：银行家舍入，末位取偶。
      // n=0 时"末位"是整数部分的最后一位（1.5 → 看 1 是奇数 → 进位到 2）
      const lastKept =
        n > 0 ? Number(keep.slice(-1) || '0') : Number(intPart.slice(-1) || '0');
      bump = lastKept % 2 === 1;
    }
  }

  const base = Number(intPart + (n > 0 ? `.${keep.padEnd(n, '0')}` : ''));
  const out = bump ? Number((base + 10 ** -n).toFixed(n)) : base;
  return neg ? -out : out;
}

type IdleTotal = [number, number];

export interface AnalyticsPayload {
  ok: true;
  area: string | null;
  samples: number;
  heatmap: Array<Array<number | null>>;
  trend_24h: Array<{ t: string; ratio: number | null }>;
  trend_7d: Array<{ t: string; ratio: number | null }>;
  weekday_weekend: { weekday: number | null; weekend: number | null };
  ranking: Array<{
    name: string;
    samples: number;
    avg_idle_ratio: number;
    avg_fault_ratio: number;
    idle: number;
    total: number;
  }>;
  forecast: Array<{
    name: string;
    predicted_idle: number;
    total: number;
    samples: number;
    basis: string;
  }>;
  best_slots: Array<{ dow: number; hour: number; ratio: number }>;
}

/** 与 Python 的 strftime('%Y-%m-%d %H:%M:%S') 同格式 */
function fmtDateTime(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

function fmtDate(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export async function buildAnalytics(area: string | null = null, weeks = 8): Promise<AnalyticsPayload> {
  const db = getDb();
  const nowDt = new Date();

  const cutoff = fmtDateTime(new Date(nowDt.getTime() - weeks * 7 * 24 * 3600 * 1000));
  const whereArea = area ? sql` AND area_name = ${area}` : sql``;

  // 1) 样本总数
  const samplesRes = await sql<{ n: number }>`
    SELECT COUNT(*) AS n FROM area_samples WHERE received_at >= ${cutoff}${whereArea}
  `.execute(db);
  const samples = Number(samplesRes.rows[0]?.n ?? 0);

  // 2) 热力图：[7 天][24 小时][idleSum, totalSum]
  const heat: IdleTotal[][] = Array.from({ length: 7 }, () =>
    Array.from({ length: 24 }, () => [0, 0] as IdleTotal),
  );
  const heatRes = await sql<{ dow: number; hour: number; idle: number | null; total: number | null }>`
    SELECT CAST(strftime('%w', received_at) AS INTEGER) AS dow,
           CAST(strftime('%H', received_at) AS INTEGER) AS hour,
           SUM(idle) AS idle, SUM(total) AS total
      FROM area_samples WHERE received_at >= ${cutoff}${whereArea}
     GROUP BY 1, 2
  `.execute(db);
  for (const r of heatRes.rows) {
    const d = (Number(r.dow) + 6) % 7; // SQL: 0=周日 → 本实现 0=周一
    const h = Number(r.hour);
    heat[d]![h]![0] += Number(r.idle ?? 0);
    heat[d]![h]![1] += Number(r.total ?? 0);
  }

  // 3) 24h 趋势：96 个 15 分钟槽（末槽对齐当前 15 分钟）
  const endSlot = new Date(nowDt);
  endSlot.setMinutes(Math.floor(nowDt.getMinutes() / ANALYTICS_SLOT_MINUTES) * ANALYTICS_SLOT_MINUTES, 0, 0);
  const startSlot = new Date(endSlot.getTime() - ANALYTICS_SLOT_MINUTES * (ANALYTICS_TREND_SLOTS - 1) * 60000);
  const startSlotStamp = fmtDateTime(startSlot);

  const hourlyRes = await sql<{ k: string; idle: number | null; total: number | null }>`
    SELECT substr(received_at, 1, 14) || printf('%02d',
             (CAST(substr(received_at, 15, 2) AS INTEGER) / 15) * 15) AS k,
           SUM(idle) AS idle, SUM(total) AS total
      FROM area_samples
     WHERE received_at >= ${cutoff}${whereArea}
       AND received_at >= ${startSlotStamp}
     GROUP BY 1 ORDER BY 1
  `.execute(db);
  const hourlyMap = new Map<string, IdleTotal>();
  for (const r of hourlyRes.rows) {
    hourlyMap.set(String(r.k), [Number(r.idle ?? 0), Number(r.total ?? 0)]);
  }
  const hourly: Array<{ key: string; idle: number; total: number }> = [];
  for (let i = 0; i < ANALYTICS_TREND_SLOTS; i += 1) {
    const t = new Date(startSlot.getTime() + ANALYTICS_SLOT_MINUTES * i * 60000);
    const key = `${fmtDate(t)} ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
    const [idle, total] = hourlyMap.get(key) ?? [0, 0];
    hourly.push({ key, idle, total });
  }

  // 4) 7 天趋势
  const today = new Date(nowDt);
  today.setHours(0, 0, 0, 0);
  const startDay = new Date(today.getTime() - (ANALYTICS_TREND_DAYS - 1) * 86400000);
  const dailyRes = await sql<{ k: string; idle: number | null; total: number | null }>`
    SELECT strftime('%Y-%m-%d', received_at) AS k, SUM(idle) AS idle, SUM(total) AS total
      FROM area_samples
     WHERE received_at >= ${cutoff}${whereArea}
       AND received_at >= ${fmtDateTime(startDay)}
     GROUP BY 1 ORDER BY 1
  `.execute(db);
  const dailyMap = new Map<string, IdleTotal>();
  for (const r of dailyRes.rows) {
    dailyMap.set(String(r.k), [Number(r.idle ?? 0), Number(r.total ?? 0)]);
  }
  const daily: Array<{ key: string; idle: number; total: number }> = [];
  for (let i = 0; i < ANALYTICS_TREND_DAYS; i += 1) {
    const d = new Date(startDay.getTime() + i * 86400000);
    const key = fmtDate(d);
    const [idle, total] = dailyMap.get(key) ?? [0, 0];
    daily.push({ key, idle, total });
  }

  const ratio = (pair: IdleTotal): number | null =>
    pair[1] ? pyRound(pair[0] / pair[1], 4) : null;

  // 5) 工作日 / 周末
  let wdIdle = 0;
  let wdTotal = 0;
  let weIdle = 0;
  let weTotal = 0;
  for (let d = 0; d < 7; d += 1) {
    for (let h = 0; h < 24; h += 1) {
      const cell = heat[d]![h]!;
      if (d < 5) {
        wdIdle += cell[0];
        wdTotal += cell[1];
      } else {
        weIdle += cell[0];
        weTotal += cell[1];
      }
    }
  }

  // 6) 每个区域的最新一次采样
  const lastRes = await sql<{ area_name: string; idle: number | null; total: number | null }>`
    SELECT a.area_name, a.idle, a.total
      FROM area_samples a
      JOIN (SELECT area_name, MAX(snapshot_id) AS mid FROM area_samples
             WHERE received_at >= ${cutoff}${whereArea}
             GROUP BY area_name) m
        ON a.area_name = m.area_name AND a.snapshot_id = m.mid
  `.execute(db);
  const last = new Map<string, IdleTotal>();
  for (const r of lastRes.rows) {
    last.set(String(r.area_name), [Number(r.idle ?? 0), Number(r.total ?? 0)]);
  }

  // 7) 排行
  const rankRes = await sql<{
    area_name: string;
    n: number;
    idle_sum: number | null;
    total_sum: number | null;
    fault_sum: number | null;
  }>`
    SELECT area_name, COUNT(*) AS n, SUM(idle) AS idle_sum,
           SUM(total) AS total_sum, SUM(fault) AS fault_sum
      FROM area_samples WHERE received_at >= ${cutoff}${whereArea}
     GROUP BY area_name
  `.execute(db);
  const ranking = rankRes.rows.map((r) => {
    const cur = last.get(String(r.area_name)) ?? [0, 0];
    return {
      name: String(r.area_name),
      samples: Number(r.n),
      avg_idle_ratio: ratio([Number(r.idle_sum ?? 0), Number(r.total_sum ?? 0)]) ?? 0,
      avg_fault_ratio: ratio([Number(r.fault_sum ?? 0), Number(r.total_sum ?? 0)]) ?? 0,
      idle: cur[0],
      total: cur[1],
    };
  });
  ranking.sort((a, b) => b.avg_idle_ratio - a.avg_idle_ratio);

  // 8) 最佳时段（样本量 >= 20 才计入）
  const best: Array<{ dow: number; hour: number; ratio: number }> = [];
  for (let d = 0; d < 7; d += 1) {
    for (let h = 0; h < 24; h += 1) {
      const [idleSum, totalSum] = heat[d]![h]!;
      if (totalSum >= 20) {
        best.push({ dow: d, hour: h, ratio: pyRound(idleSum / totalSum, 3) });
      }
    }
  }
  best.sort((a, b) => b.ratio - a.ratio);

  // 9) 同星期同时段预测（当前小时 + 下一小时）
  const slotsRes = await sql<{
    area_name: string;
    dow: number;
    hour: number;
    idle: number | null;
    total: number | null;
  }>`
    SELECT area_name, CAST(strftime('%w', received_at) AS INTEGER) AS dow,
           CAST(strftime('%H', received_at) AS INTEGER) AS hour,
           SUM(idle) AS idle, SUM(total) AS total
      FROM area_samples WHERE received_at >= ${cutoff}${whereArea}
     GROUP BY 1, 2, 3
  `.execute(db);
  const slots = new Map<string, IdleTotal>();
  for (const r of slotsRes.rows) {
    const key = `${r.area_name}|${(Number(r.dow) + 6) % 7}|${Number(r.hour)}`;
    slots.set(key, [Number(r.idle ?? 0), Number(r.total ?? 0)]);
  }
  // Python 的 datetime.weekday(): 0=周一 … 6=周日；JS getDay(): 0=周日 → (d+6)%7
  const todayDow = (nowDt.getDay() + 6) % 7;
  const forecast = [...last.entries()].map(([name, cur]) => {
    let idleSum = 0;
    let totalSum = 0;
    for (const h of [nowDt.getHours(), (nowDt.getHours() + 1) % 24]) {
      const slot = slots.get(`${name}|${todayDow}|${h}`);
      if (slot) {
        idleSum += slot[0];
        totalSum += slot[1];
      }
    }
    const r = totalSum ? idleSum / totalSum : 0;
    return {
      name,
      predicted_idle: pyRound(r * cur[1]),
      total: cur[1],
      samples: cur[1],
      basis: '同星期同时段均值（按端口加权）',
    };
  });
  forecast.sort((a, b) => b.predicted_idle - a.predicted_idle);

  return {
    ok: true,
    area,
    samples,
    heatmap: heat.map((day) =>
      day.map((cell) => (cell[1] ? pyRound(cell[0] / cell[1], 3) : null)),
    ),
    trend_24h: hourly.map(({ key, idle, total }) => ({
      t: key.slice(-5),
      ratio: total ? pyRound(idle / total, 3) : null,
    })),
    trend_7d: daily.map(({ key, idle, total }) => ({
      t: key.slice(5),
      ratio: total ? pyRound(idle / total, 3) : null,
    })),
    weekday_weekend: { weekday: ratio([wdIdle, wdTotal]), weekend: ratio([weIdle, weTotal]) },
    ranking,
    forecast,
    best_slots: best.slice(0, 3),
  };
}
