"""到达预测：近 14 天同时段样本 + 最近 30 分钟趋势 + 满区释放风险率。

不变量：
* 所有窗口都带 ``received_at <= now`` 上界，离线回测不会泄漏未来数据；
* ``predicted_idle`` 取当前空闲数（回测显示趋势外推在 10/15/30 分钟尺度上 MSE
  更差），趋势只以 ``trend_10m`` 暴露给客户端，并做 t 统计量收缩；
* ``prediction_stats_cached`` 是 60 秒 single-flight 缓存，重算用独立只读连接，
  不持有主库 db_lock。
"""

from __future__ import annotations

import math
import sqlite3
import time
from datetime import datetime, timedelta

from .config import (
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
    PREDICTION_CACHE,
    PREDICTION_CACHE_BUILDING,
    PREDICTION_CACHE_COND,
    PREDICTION_CACHE_GEN,
    PREDICTION_CACHE_TTL,
)


def prediction_stats(conn: sqlite3.Connection, now_dt: datetime | None = None) -> dict:
    """单次请求内聚合 area_samples，返回 {area_name: 统计}（只含有样本的区）。

    两条 SQL（不随区数增加查询次数）：
    1) hist/trend：近 14 天“同星期几 + 同小时”的样本数与空闲样本数；最近 30 分钟
       样本的 x=分钟（相对 now）、y=idle 的回归和（n/sx/sy/sxy/sxx/syy/tmin/tmax），
       供稳健斜率与 t 统计量使用；
    2) zero-release：近 14 天相邻快照中“上一时刻满区（idle=0）”的暴露分钟数与其中
       转为有空位的次数，按 (区域, 小时) 汇总，用于满区释放风险率分层收缩。

    所有窗口都带 ``received_at <= now`` 上界：生产库不会有未来样本，但离线回测
    必须显式防止未来数据泄漏。
    """
    now_dt = now_dt or datetime.now()
    now_stamp = now_dt.strftime("%Y-%m-%d %H:%M:%S")
    hist_cut = (now_dt - timedelta(days=NOW_HIST_DAYS)).strftime(
        "%Y-%m-%d %H:%M:%S")
    trend_cut = (now_dt - timedelta(minutes=NOW_TREND_MINUTES)).strftime(
        "%Y-%m-%d %H:%M:%S")
    rows = conn.execute(
        """
        SELECT 'hist' AS kind, area_name,
               COUNT(*) AS hist_samples,
               SUM(CASE WHEN idle > 0 THEN 1 ELSE 0 END) AS hist_free,
               NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
        FROM area_samples
        WHERE received_at >= ? AND received_at <= ?
          AND strftime('%w', received_at) = ?
          AND strftime('%H', received_at) = ?
        GROUP BY area_name
        UNION ALL
        SELECT 'trend' AS kind, area_name,
               NULL, NULL,
               COUNT(*) AS trend_n,
               SUM((julianday(received_at) - julianday(?)) * 1440.0) AS sx,
               SUM(idle) AS sy,
               SUM((julianday(received_at) - julianday(?)) * 1440.0 * idle) AS sxy,
               SUM(((julianday(received_at) - julianday(?)) * 1440.0)
                   * ((julianday(received_at) - julianday(?)) * 1440.0)) AS sxx,
               SUM(idle * idle) AS syy,
               MIN(julianday(received_at)) AS tmin,
               MAX(julianday(received_at)) AS tmax
        FROM area_samples
        WHERE received_at >= ? AND received_at <= ?
        GROUP BY area_name
        """,
        (hist_cut, now_stamp, now_dt.strftime("%w"), now_dt.strftime("%H"),
         now_stamp, now_stamp, now_stamp, now_stamp, trend_cut, now_stamp),
    ).fetchall()
    stats: dict = {}
    for (kind, name, hs, hf, tn, sx, sy, sxy, sxx, syy, tmin, tmax) in rows:
        item = stats.setdefault(name, {
            "hist_samples": 0, "hist_free": 0, "trend_n": 0,
            "sx": 0.0, "sy": 0.0, "sxy": 0.0, "sxx": 0.0, "syy": 0.0,
            "tmin": None, "tmax": None})
        if kind == "hist":
            item["hist_samples"] = int(hs or 0)
            item["hist_free"] = int(hf or 0)
        else:
            item["trend_n"] = int(tn or 0)
            item["sx"] = float(sx or 0.0)
            item["sy"] = float(sy or 0.0)
            item["sxy"] = float(sxy or 0.0)
            item["sxx"] = float(sxx or 0.0)
            item["syy"] = float(syy or 0.0)
            item["tmin"] = None if tmin is None else float(tmin)
            item["tmax"] = None if tmax is None else float(tmax)

    # 满区释放风险率：相邻快照 prev_idle=0、间隔 1~30 分钟；
    # 暴露分钟数把“间隔长短”计入分母，避免不同抓取节奏下的偏差。
    haz_rows = conn.execute(
        """
        WITH seq AS (
            SELECT area_name,
                   CAST(strftime('%H', received_at) AS INTEGER) AS hour,
                   received_at, idle,
                   LAG(idle) OVER (PARTITION BY area_name ORDER BY received_at)
                       AS prev_idle,
                   LAG(received_at) OVER (PARTITION BY area_name ORDER BY received_at)
                       AS prev_ts
            FROM area_samples
            WHERE received_at >= ? AND received_at <= ?
        )
        SELECT area_name, hour,
               SUM((julianday(received_at) - julianday(prev_ts)) * 1440.0)
                   AS exp_min,
               SUM(CASE WHEN idle > 0 THEN 1.0 ELSE 0 END) AS free_events
        FROM seq
        WHERE prev_idle = 0
          AND (julianday(received_at) - julianday(prev_ts)) * 1440.0
              BETWEEN 1.0 AND 30.0
        GROUP BY area_name, hour
        """,
        (hist_cut, now_stamp),
    ).fetchall()
    hour = now_dt.hour
    area_exp: dict = {}
    hour_exp = hour_free = 0.0
    total_exp = total_free = 0.0
    for name, h, exp_min, free_events in haz_rows:
        exp_min = float(exp_min or 0.0)
        free_events = float(free_events or 0.0)
        a = area_exp.setdefault(name, [0.0, 0.0])
        a[0] += exp_min
        a[1] += free_events
        total_exp += exp_min
        total_free += free_events
        if int(h or 0) == hour:
            hour_exp += exp_min
            hour_free += free_events
    # 三层收缩：全局 → 当前小时 → 区域；单位都是“空闲事件/分钟”。
    h_global = ((total_free + NOW_ZERO_GLOBAL_PRIOR_EVENTS)
                / (total_exp + NOW_ZERO_GLOBAL_PRIOR_MIN))
    h_hour = ((hour_free + NOW_ZERO_HOUR_PRIOR_MIN * h_global)
              / (hour_exp + NOW_ZERO_HOUR_PRIOR_MIN))
    for name in set(stats) | set(area_exp):
        exp_min, free_events = area_exp.get(name, (0.0, 0.0))
        h_area = ((free_events + NOW_ZERO_AREA_PRIOR_MIN * h_hour)
                  / (exp_min + NOW_ZERO_AREA_PRIOR_MIN))
        item = stats.setdefault(name, {
            "hist_samples": 0, "hist_free": 0, "trend_n": 0,
            "sx": 0.0, "sy": 0.0, "sxy": 0.0, "sxx": 0.0, "syy": 0.0,
            "tmin": None, "tmax": None})
        item["haz_exp"] = exp_min
        item["haz_known"] = total_exp > 0
        item["p_zero"] = round(1.0 - math.exp(-10.0 * h_area), 4)
        item["eta_zero_min"] = min(
            NOW_ETA_MAX_MINUTES,
            max(1, math.ceil(NOW_ETA_MEDIAN_SCALE * math.log(2.0) / h_area)))
    return stats


def invalidate_prediction_cache() -> None:
    """清空 /api/now 预测聚合缓存；写 area_samples 后调用，避免 60 秒旧值。"""
    global PREDICTION_CACHE_GEN
    with PREDICTION_CACHE_COND:
        PREDICTION_CACHE.clear()
        PREDICTION_CACHE_GEN += 1
        PREDICTION_CACHE_COND.notify_all()


def prediction_stats_cached(db_path: str) -> dict:
    """prediction_stats 的 60 秒 single-flight 缓存（键=db 路径）。

    miss 时只允许一个线程用独立只读连接重算；其它线程等待并复用结果（超时则
    退化为自行重算，避免永久阻塞）。计算不持有主库 db_lock。
    """
    global PREDICTION_CACHE_BUILDING
    key = str(db_path)
    deadline = time.time() + 10.0
    with PREDICTION_CACHE_COND:
        while True:
            now = time.time()
            fresh = (PREDICTION_CACHE.get("db") == key
                     and now - float(PREDICTION_CACHE.get("ts") or 0)
                     <= PREDICTION_CACHE_TTL)
            if fresh:
                return PREDICTION_CACHE["data"]
            if not PREDICTION_CACHE_BUILDING:
                PREDICTION_CACHE_BUILDING = True
                gen = PREDICTION_CACHE_GEN
                break
            remaining = deadline - now
            if remaining <= 0:
                # 超时兜底：允许并发重算，避免一个卡住的 builder 拖死所有请求。
                gen = PREDICTION_CACHE_GEN
                break
            PREDICTION_CACHE_COND.wait(min(remaining, 5.0))
    data = None
    try:
        conn = sqlite3.connect(key, timeout=20)
        try:
            conn.execute("PRAGMA busy_timeout=20000")
            data = prediction_stats(conn)
        finally:
            conn.close()
    finally:
        with PREDICTION_CACHE_COND:
            if data is not None and gen == PREDICTION_CACHE_GEN:
                PREDICTION_CACHE["db"] = key
                PREDICTION_CACHE["ts"] = time.time()
                PREDICTION_CACHE["data"] = data
            PREDICTION_CACHE_BUILDING = False
            PREDICTION_CACHE_COND.notify_all()
    if data is None:
        with PREDICTION_CACHE_COND:
            cached = PREDICTION_CACHE.get("data")
            if cached is not None and PREDICTION_CACHE.get("db") == key:
                return cached
        raise RuntimeError("prediction stats unavailable")
    return data


def _trend_10m(item: dict) -> tuple:
    """最近 30 分钟 idle 的稳健斜率 ×10（每 10 分钟变化量）；样本不足返回 None。

    斜率先用最小二乘估计，再乘 t²/(t²+NOW_TREND_SHRINK_K) 收缩：趋势越不显著，
    收缩越强（纯噪声近似归零）；真实单调变化 t 很大，几乎保持原斜率。这样既
    保留“正在变空/变满”的信号，又避免把采样抖动放大成外推误差。
    """
    n = int(item.get("trend_n") or 0)
    if n < 3:
        return None, n
    tmin, tmax = item.get("tmin"), item.get("tmax")
    if tmin is None or tmax is None:
        return None, n
    span_min = (float(tmax) - float(tmin)) * 1440.0
    if span_min < NOW_TREND_MIN_SPAN_MIN:
        return None, n
    sx = float(item.get("sx") or 0.0)
    sy = float(item.get("sy") or 0.0)
    sxy = float(item.get("sxy") or 0.0)
    sxx = float(item.get("sxx") or 0.0)
    syy = float(item.get("syy") or 0.0)
    denom = n * sxx - sx * sx
    if abs(denom) < 1e-12:
        return None, n
    slope = (n * sxy - sx * sy) / denom
    shrink = 1.0
    cxx = sxx - sx * sx / n
    cxy = sxy - sx * sy / n
    cyy = syy - sy * sy / n
    if n > 2 and cxx > 1e-12:
        sse = cyy - slope * cxy
        if sse > 1e-10:
            se = math.sqrt(sse / (n - 2) / cxx)
            if se > 1e-9:
                tstat2 = (slope / se) ** 2
                shrink = tstat2 / (tstat2 + NOW_TREND_SHRINK_K)
    return round(slope * 10.0 * shrink, 2), n


def _prediction_confidence(hist_samples: int, trend_n: int,
                           haz_exp: float = 0.0) -> str | None:
    """按历史样本数、趋势样本数与满区释放样本支持度给粗略置信度。"""
    score = 0
    if hist_samples:
        score += 2 if hist_samples >= 6 else 1
    if trend_n >= 4:
        score += 2
    elif trend_n >= 2:
        score += 1
    if haz_exp >= 60.0:
        score += 1
    if score == 0:
        return None
    if score >= 4:
        return "high"
    if score >= 2:
        return "medium"
    return "low"


def prediction_fields(name: str, idle: int, stats: dict, total: int = 0,
                      walk_min: int | None = None) -> dict:
    """组装单个区域的到达预测字段；无样本时对应字段为 None。

    回测结论（3.4 天、39 区、451 个历史时刻）：10/15/30 分钟尺度上空闲数的最优
    MAE 点估计就是当前空闲数（近期 OLS 趋势的 MSE 最优系数仅 0.23，整数舍入后
    净值变为负），因此 predicted_idle 取持久化值；趋势只保留在 trend_10m 供客户端
    按步行时间外推，并做 t 统计量收缩。到达概率/ETA 走满区释放风险率：
    空闲区 P(≥1) = 1-(1-0.76)^idle；满区用 14 天相邻快照的零状态释放风险率
    分层收缩（全局→当前小时→区域）估计 p_zero 与中位等待 ETA。

    p_free_10m 固定为“未来 10 分钟至少 1 个空位”的概率；walk_min 给出时额外返回
    p_free_at_arrival（按 80 m/min 步行时间折算的到达概率），无坐标/无样本为 null。
    """
    item = stats.get(name) or {}
    hist_samples = int(item.get("hist_samples") or 0)
    hist_free = int(item.get("hist_free") or 0)
    hist_free_rate = round(hist_free / hist_samples, 4) if hist_samples else None
    trend_10m, trend_n = _trend_10m(item)
    if trend_10m is not None:
        cap = float(total) if total else float("inf")
        trend_10m = round(max(-cap, min(cap, trend_10m)), 2)
    has_data = bool(hist_samples or trend_n or item.get("haz_known"))
    predicted_idle = None
    p_free = None
    p_free_arrival = None
    idle_eff = None
    if has_data:
        idle_eff = min(max(int(idle), 0), total) if total else max(int(idle), 0)
        predicted_idle = float(idle_eff)
        if idle_eff > 0:
            p_free = round(1.0 - (1.0 - NOW_FREE_KEEP_10M) ** min(idle_eff, 8), 4)
        else:
            base = float(item.get("p_zero") or (
                1.0 - math.exp(-10.0 * NOW_ZERO_GLOBAL_PRIOR_EVENTS
                               / NOW_ZERO_GLOBAL_PRIOR_MIN)))
            p_free = round(base, 4)
    if has_data and walk_min is not None and int(walk_min) >= 1:
        walk = max(1, int(walk_min))
        if idle_eff and idle_eff > 0:
            keep = NOW_FREE_KEEP_10M ** (walk / 10.0)
            p_free_arrival = round(
                1.0 - (1.0 - keep) ** min(idle_eff, 8), 4)
        else:
            base = float(item.get("p_zero") or (
                1.0 - math.exp(-10.0 * NOW_ZERO_GLOBAL_PRIOR_EVENTS
                               / NOW_ZERO_GLOBAL_PRIOR_MIN)))
            if base >= 1.0:
                p_free_arrival = 1.0
            elif base > 0.0:
                rate = -math.log(1.0 - base) / 10.0
                p_free_arrival = round(1.0 - math.exp(-rate * walk), 4)
            else:
                p_free_arrival = 0.0
    eta_min = None
    if has_data and idle <= 0:
        eta_min = item.get("eta_zero_min")
        if eta_min is None:
            h_prior = NOW_ZERO_GLOBAL_PRIOR_EVENTS / NOW_ZERO_GLOBAL_PRIOR_MIN
            eta_min = min(NOW_ETA_MAX_MINUTES, max(
                1, math.ceil(NOW_ETA_MEDIAN_SCALE * math.log(2.0) / h_prior)))
        eta_min = int(eta_min)
    return {
        "hist_free_rate": hist_free_rate,
        "hist_samples": hist_samples or None,
        "trend_10m": trend_10m,
        "predicted_idle": predicted_idle,
        "eta_min": eta_min,
        "confidence": _prediction_confidence(
            hist_samples, trend_n, float(item.get("haz_exp") or 0.0)),
        "p_free_10m": p_free,
        "p_free_at_arrival": p_free_arrival,
    }
