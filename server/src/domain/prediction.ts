/**
 * 到达预测：历史空闲率 / 30 分钟趋势斜率 / 满区释放风险率 / 到达概率与 ETA。
 *
 * ⚠️ 与 `cloud/prediction.py` 逐函数对应，输出必须完全一致（P2 对拍）。
 *   prediction_stats()      → predictionStats()
 *   _trend_10m()            → trend10m()
 *   _prediction_confidence()→ predictionConfidence()
 *   prediction_fields()     → predictionFields()
 *
 * 注意 julianday() / strftime() / LAG() OVER 是 SQLite 方言；迁 PostgreSQL 时这层要重写
 * （用 to_char / extract(epoch...) / 同样的 window function），业务逻辑不变。
 */
import { sql } from 'kysely';
import {
  NOW_ETA_MAX_MINUTES,
  NOW_ETA_MEDIAN_SCALE,
  NOW_FREE_KEEP_10M,
  NOW_HIST_DAYS,
  NOW_TREND_MINUTES,
  NOW_TREND_MIN_SPAN_MIN,
  NOW_TREND_SHRINK_K,
  NOW_ZERO_AREA_PRIOR_MIN,
  NOW_ZERO_GLOBAL_PRIOR_EVENTS,
  NOW_ZERO_GLOBAL_PRIOR_MIN,
  NOW_ZERO_HOUR_PRIOR_MIN,
} from '../config.js';
import { getDb } from '../db/index.js';
import { pyRound } from './analytics.js';

export interface AreaStat {
  hist_samples: number;
  hist_free: number;
  trend_n: number;
  sx: number;
  sy: number;
  sxy: number;
  sxx: number;
  syy: number;
  tmin: number | null;
  tmax: number | null;
  haz_exp?: number;
  haz_known?: boolean;
  p_zero?: number;
  eta_zero_min?: number;
}

function newStat(): AreaStat {
  return {
    hist_samples: 0,
    hist_free: 0,
    trend_n: 0,
    sx: 0,
    sy: 0,
    sxy: 0,
    sxx: 0,
    syy: 0,
    tmin: null,
    tmax: null,
  };
}

/** 与 Python 的 strftime('%Y-%m-%d %H:%M:%S') 同格式（本地时间） */
export function fmtDateTime(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

/**
 * 单次请求内聚合 area_samples，返回 {area_name: 统计}（只含有样本的区）。
 *
 * 两条 SQL（不随区数增加查询次数）：
 * 1) hist/trend：近 14 天「同星期几 + 同小时」样本数/空闲数；近 30 分钟样本的
 *    x=相对分钟、y=idle 的回归和（n/sx/sy/sxy/sxx/syy/tmin/tmax）；
 * 2) hazard：近 14 天相邻快照中「上一时刻满区」的暴露分钟数与释放次数。
 *
 * 所有窗口都带 `received_at <= now` 上界，防止未来数据泄漏（离线回测用）。
 */
export async function predictionStats(nowDt: Date = new Date()): Promise<Record<string, AreaStat>> {
  const db = getDb();
  const nowStamp = fmtDateTime(nowDt);
  const histCut = fmtDateTime(new Date(nowDt.getTime() - NOW_HIST_DAYS * 86400000));
  const trendCut = fmtDateTime(new Date(nowDt.getTime() - NOW_TREND_MINUTES * 60000));
  // Python 的 strftime('%w') 与 '%H'：注意 %w 是 0=周日，且是两位补零的字符串
  const dowStr = String(nowDt.getDay()); // Python %w: 0=Sunday..6=Saturday，与 JS getDay 一致
  const hourStr = String(nowDt.getHours()).padStart(2, '0');

  // ⚠️ 这里 **不用 UNION ALL**：SQL 的列名只取第一个 SELECT 的别名，
  // 若第一条里用无别名的 NULL 占位，第二条的 sx/sy/trend_n 会全部变成 "NULL" 键，
  // Kysely 按列名取字段就拿不到值（Python 用位置解包所以不受影响）。
  // 拆成两条查询，列名清晰且行为等价。
  const histRes = await sql<{ area_name: string; hist_samples: number; hist_free: number | null }>`
    SELECT area_name,
           COUNT(*) AS hist_samples,
           SUM(CASE WHEN idle > 0 THEN 1 ELSE 0 END) AS hist_free
      FROM area_samples
     WHERE received_at >= ${histCut} AND received_at <= ${nowStamp}
       AND strftime('%w', received_at) = ${dowStr}
       AND strftime('%H', received_at) = ${hourStr}
     GROUP BY area_name
  `.execute(db);

  const stats: Record<string, AreaStat> = {};
  for (const r of histRes.rows) {
    const item = (stats[String(r.area_name)] ??= newStat());
    item.hist_samples = Number(r.hist_samples ?? 0);
    item.hist_free = Number(r.hist_free ?? 0);
  }

  const trendRes = await sql<{
    area_name: string;
    trend_n: number;
    sx: number | null;
    sy: number | null;
    sxy: number | null;
    sxx: number | null;
    syy: number | null;
    tmin: number | null;
    tmax: number | null;
  }>`
    SELECT area_name,
           COUNT(*) AS trend_n,
           SUM((julianday(received_at) - julianday(${nowStamp})) * 1440.0) AS sx,
           SUM(idle) AS sy,
           SUM((julianday(received_at) - julianday(${nowStamp})) * 1440.0 * idle) AS sxy,
           SUM(((julianday(received_at) - julianday(${nowStamp})) * 1440.0)
               * ((julianday(received_at) - julianday(${nowStamp})) * 1440.0)) AS sxx,
           SUM(idle * idle) AS syy,
           MIN(julianday(received_at)) AS tmin,
           MAX(julianday(received_at)) AS tmax
      FROM area_samples
     WHERE received_at >= ${trendCut} AND received_at <= ${nowStamp}
     GROUP BY area_name
  `.execute(db);

  for (const r of trendRes.rows) {
    const item = (stats[String(r.area_name)] ??= newStat());
    item.trend_n = Number(r.trend_n ?? 0);
    item.sx = Number(r.sx ?? 0);
    item.sy = Number(r.sy ?? 0);
    item.sxy = Number(r.sxy ?? 0);
    item.sxx = Number(r.sxx ?? 0);
    item.syy = Number(r.syy ?? 0);
    item.tmin = r.tmin === null ? null : Number(r.tmin);
    item.tmax = r.tmax === null ? null : Number(r.tmax);
  }

  // 满区释放风险率：相邻快照 prev_idle=0、间隔 1~30 分钟
  const hazRes = await sql<{
    area_name: string;
    hour: number;
    exp_min: number | null;
    free_events: number | null;
  }>`
    WITH seq AS (
      SELECT area_name,
             CAST(strftime('%H', received_at) AS INTEGER) AS hour,
             received_at, idle,
             LAG(idle) OVER (PARTITION BY area_name ORDER BY received_at) AS prev_idle,
             LAG(received_at) OVER (PARTITION BY area_name ORDER BY received_at) AS prev_ts
        FROM area_samples
       WHERE received_at >= ${histCut} AND received_at <= ${nowStamp}
    )
    SELECT area_name, hour,
           SUM((julianday(received_at) - julianday(prev_ts)) * 1440.0) AS exp_min,
           SUM(CASE WHEN idle > 0 THEN 1.0 ELSE 0 END) AS free_events
      FROM seq
     WHERE prev_idle = 0
       AND (julianday(received_at) - julianday(prev_ts)) * 1440.0 BETWEEN 1.0 AND 30.0
     GROUP BY area_name, hour
  `.execute(db);

  const hour = nowDt.getHours();
  const areaExp = new Map<string, [number, number]>();
  let hourExp = 0;
  let hourFree = 0;
  let totalExp = 0;
  let totalFree = 0;
  for (const r of hazRes.rows) {
    const expMin = Number(r.exp_min ?? 0);
    const freeEvents = Number(r.free_events ?? 0);
    const a = areaExp.get(String(r.area_name)) ?? [0, 0];
    a[0] += expMin;
    a[1] += freeEvents;
    areaExp.set(String(r.area_name), a);
    totalExp += expMin;
    totalFree += freeEvents;
    if (Number(r.hour ?? 0) === hour) {
      hourExp += expMin;
      hourFree += freeEvents;
    }
  }

  // 三层收缩：全局 → 当前小时 → 区域；单位都是「空闲事件/分钟」
  const hGlobal = (totalFree + NOW_ZERO_GLOBAL_PRIOR_EVENTS) / (totalExp + NOW_ZERO_GLOBAL_PRIOR_MIN);
  const hHour =
    (hourFree + NOW_ZERO_HOUR_PRIOR_MIN * hGlobal) / (hourExp + NOW_ZERO_HOUR_PRIOR_MIN);

  const names = new Set([...Object.keys(stats), ...areaExp.keys()]);
  for (const name of names) {
    const [expMin, freeEvents] = areaExp.get(name) ?? [0, 0];
    const hArea =
      (freeEvents + NOW_ZERO_AREA_PRIOR_MIN * hHour) / (expMin + NOW_ZERO_AREA_PRIOR_MIN);
    const item = (stats[name] ??= newStat());
    item.haz_exp = expMin;
    item.haz_known = totalExp > 0;
    item.p_zero = pyRound(1.0 - Math.exp(-10.0 * hArea), 4);
    item.eta_zero_min = Math.min(
      NOW_ETA_MAX_MINUTES,
      Math.max(1, Math.ceil((NOW_ETA_MEDIAN_SCALE * Math.log(2.0)) / hArea)),
    );
  }
  return stats;
}

/**
 * 最近 30 分钟 idle 的稳健斜率 ×10（每 10 分钟变化量）；样本不足返回 [null, n]。
 * 斜率先最小二乘估计，再乘 t²/(t²+K) 收缩：趋势越不显著收缩越强。
 */
export function trend10m(item: AreaStat): [number | null, number] {
  const n = Number(item.trend_n ?? 0);
  if (n < 3) return [null, n];
  const { tmin, tmax } = item;
  if (tmin === null || tmax === null) return [null, n];
  const spanMin = (tmax - tmin) * 1440.0;
  if (spanMin < NOW_TREND_MIN_SPAN_MIN) return [null, n];

  const sx = Number(item.sx ?? 0);
  const sy = Number(item.sy ?? 0);
  const sxy = Number(item.sxy ?? 0);
  const sxx = Number(item.sxx ?? 0);
  const syy = Number(item.syy ?? 0);
  const denom = n * sxx - sx * sx;
  if (Math.abs(denom) < 1e-12) return [null, n];
  const slope = (n * sxy - sx * sy) / denom;

  let shrink = 1.0;
  const cxx = sxx - (sx * sx) / n;
  const cxy = sxy - (sx * sy) / n;
  const cyy = syy - (sy * sy) / n;
  if (n > 2 && cxx > 1e-12) {
    const sse = cyy - slope * cxy;
    if (sse > 1e-10) {
      const se = Math.sqrt(sse / (n - 2) / cxx);
      if (se > 1e-9) {
        const tstat2 = (slope / se) ** 2;
        shrink = tstat2 / (tstat2 + NOW_TREND_SHRINK_K);
      }
    }
  }
  return [pyRound(slope * 10.0 * shrink, 2), n];
}

/** 按历史样本数、趋势样本数与满区释放样本支持度给粗略置信度 */
export function predictionConfidence(
  histSamples: number,
  trendN: number,
  hazExp = 0,
): 'high' | 'medium' | 'low' | null {
  let score = 0;
  if (histSamples) score += histSamples >= 6 ? 2 : 1;
  if (trendN >= 4) score += 2;
  else if (trendN >= 2) score += 1;
  if (hazExp >= 60.0) score += 1;
  if (score === 0) return null;
  if (score >= 4) return 'high';
  if (score >= 2) return 'medium';
  return 'low';
}

export interface PredictionFields {
  hist_free_rate: number | null;
  hist_samples: number | null;
  trend_10m: number | null;
  predicted_idle: number | null;
  eta_min: number | null;
  confidence: 'high' | 'medium' | 'low' | null;
  p_free_10m: number | null;
  p_free_at_arrival: number | null;
}

/** 组装单个区域的到达预测字段；无样本时对应字段为 null */
export function predictionFields(
  name: string,
  idle: number,
  stats: Record<string, AreaStat>,
  total = 0,
  walkMin: number | null = null,
): PredictionFields {
  const item = stats[name] ?? newStat();
  const histSamples = Number(item.hist_samples ?? 0);
  const histFree = Number(item.hist_free ?? 0);
  const histFreeRate = histSamples ? pyRound(histFree / histSamples, 4) : null;

  let [trend10, trendN] = trend10m(item);
  if (trend10 !== null) {
    const cap = total ? Number(total) : Number.POSITIVE_INFINITY;
    trend10 = pyRound(Math.max(-cap, Math.min(cap, trend10)), 2);
  }

  const hasData = Boolean(histSamples || trendN || item.haz_known);
  let predictedIdle: number | null = null;
  let pFree: number | null = null;
  let pFreeArrival: number | null = null;
  let idleEff: number | null = null;

  if (hasData) {
    idleEff = total ? Math.min(Math.max(Math.trunc(idle), 0), total) : Math.max(Math.trunc(idle), 0);
    predictedIdle = Number(idleEff);
    if (idleEff > 0) {
      pFree = pyRound(1.0 - (1.0 - NOW_FREE_KEEP_10M) ** Math.min(idleEff, 8), 4);
    } else {
      const base = Number(
        item.p_zero ??
          1.0 - Math.exp((-10.0 * NOW_ZERO_GLOBAL_PRIOR_EVENTS) / NOW_ZERO_GLOBAL_PRIOR_MIN),
      );
      pFree = pyRound(base, 4);
    }
  }

  if (hasData && walkMin !== null && Math.trunc(walkMin) >= 1) {
    const walk = Math.max(1, Math.trunc(walkMin));
    if (idleEff && idleEff > 0) {
      const keep = NOW_FREE_KEEP_10M ** (walk / 10.0);
      pFreeArrival = pyRound(1.0 - (1.0 - keep) ** Math.min(idleEff, 8), 4);
    } else {
      const base = Number(
        item.p_zero ??
          1.0 - Math.exp((-10.0 * NOW_ZERO_GLOBAL_PRIOR_EVENTS) / NOW_ZERO_GLOBAL_PRIOR_MIN),
      );
      if (base >= 1.0) {
        pFreeArrival = 1.0;
      } else if (base > 0.0) {
        const rate = -Math.log(1.0 - base) / 10.0;
        pFreeArrival = pyRound(1.0 - Math.exp(-rate * walk), 4);
      } else {
        pFreeArrival = 0.0;
      }
    }
  }

  let etaMin: number | null = null;
  if (hasData && idle <= 0) {
    const raw = item.eta_zero_min;
    if (raw === undefined || raw === null) {
      const hPrior = NOW_ZERO_GLOBAL_PRIOR_EVENTS / NOW_ZERO_GLOBAL_PRIOR_MIN;
      etaMin = Math.min(
        NOW_ETA_MAX_MINUTES,
        Math.max(1, Math.ceil((NOW_ETA_MEDIAN_SCALE * Math.log(2.0)) / hPrior)),
      );
    } else {
      etaMin = Math.trunc(raw);
    }
  }

  return {
    hist_free_rate: histFreeRate,
    hist_samples: histSamples || null,
    trend_10m: trend10,
    predicted_idle: predictedIdle,
    eta_min: etaMin,
    confidence: predictionConfidence(histSamples, trendN, Number(item.haz_exp ?? 0)),
    p_free_10m: pFree,
    p_free_at_arrival: pFreeArrival,
  };
}
