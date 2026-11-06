"""离线统计：热力图 / 24h-7d 趋势 / 区域排行 / 同时段预测，全部按端口数加权。

不变量：15 分钟固定槽（24h = 96 槽）、天粒度 7 天；没有样本的槽 ratio 为 None
而不是 0；只接受 areas 表登记过的区域由调用方把关。
"""

from __future__ import annotations

import sqlite3
from datetime import datetime, timedelta

from .config import (
    ANALYTICS_SLOT_MINUTES,
    ANALYTICS_TREND_DAYS,
    ANALYTICS_TREND_SLOTS,
)


def build_analytics(conn: sqlite3.Connection, area: str | None = None,
                    weeks: int = 8) -> dict:
    """SQL 聚合计算热力图/趋势/排行/预测；比例按端口数加权。"""
    cutoff = (datetime.now() - timedelta(days=weeks * 7)).strftime("%Y-%m-%d %H:%M:%S")
    where = "received_at >= ?"
    params: list = [cutoff]
    if area:
        where += " AND area_name = ?"
        params.append(area)

    def rows(sql, extra=None):
        return conn.execute(sql, params + (extra or [])).fetchall()

    samples = rows(f"SELECT COUNT(*) FROM area_samples WHERE {where}")[0][0]

    heat = [[[0.0, 0] for _ in range(24)] for _ in range(7)]
    for dow, hour, idle, total in rows(
            f"SELECT CAST(strftime('%w', received_at) AS INTEGER), "
            f"CAST(strftime('%H', received_at) AS INTEGER), SUM(idle), SUM(total) "
            f"FROM area_samples WHERE {where} GROUP BY 1, 2"):
        d = (int(dow) + 6) % 7
        heat[d][int(hour)][0] += float(idle or 0)
        heat[d][int(hour)][1] += int(total or 0)

    now_dt = datetime.now()
    end_slot = now_dt.replace(
        minute=(now_dt.minute // ANALYTICS_SLOT_MINUTES) * ANALYTICS_SLOT_MINUTES,
        second=0, microsecond=0)
    start_slot = end_slot - timedelta(
        minutes=ANALYTICS_SLOT_MINUTES * (ANALYTICS_TREND_SLOTS - 1))
    start_slot_stamp = start_slot.strftime("%Y-%m-%d %H:%M:%S")
    hourly = rows(
        "SELECT substr(received_at, 1, 14) || printf('%02d', "
        "(CAST(substr(received_at, 15, 2) AS INTEGER) / 15) * 15), "
        f"SUM(idle), SUM(total) FROM area_samples WHERE {where} "
        "AND received_at >= ? GROUP BY 1 ORDER BY 1", [start_slot_stamp])
    hourly_map = {str(k): (float(idle or 0), int(total or 0))
                  for k, idle, total in hourly}
    hourly = []
    for index in range(ANALYTICS_TREND_SLOTS):
        key = (start_slot + timedelta(minutes=ANALYTICS_SLOT_MINUTES * index)).strftime(
            "%Y-%m-%d %H:%M")
        idle, total = hourly_map.get(key, (0.0, 0))
        hourly.append((key, idle, total))

    today = now_dt.replace(hour=0, minute=0, second=0, microsecond=0)
    start_day = today - timedelta(days=ANALYTICS_TREND_DAYS - 1)
    daily_rows = rows(
        f"SELECT strftime('%Y-%m-%d', received_at), SUM(idle), SUM(total) "
        f"FROM area_samples WHERE {where} AND received_at >= ? "
        "GROUP BY 1 ORDER BY 1", [start_day.strftime("%Y-%m-%d %H:%M:%S")])
    daily_map = {str(k): (float(idle or 0), int(total or 0))
                 for k, idle, total in daily_rows}
    daily = []
    for index in range(ANALYTICS_TREND_DAYS):
        key = (start_day + timedelta(days=index)).strftime("%Y-%m-%d")
        idle, total = daily_map.get(key, (0.0, 0))
        daily.append((key, idle, total))

    def ratio(pair):
        return round(pair[0] / pair[1], 4) if pair[1] else None

    wd_idle = sum(heat[d][h][0] for d in range(5) for h in range(24))
    wd_total = sum(heat[d][h][1] for d in range(5) for h in range(24))
    we_idle = sum(heat[d][h][0] for d in range(5, 7) for h in range(24))
    we_total = sum(heat[d][h][1] for d in range(5, 7) for h in range(24))

    last = {}
    for name, idle, total in rows(
            "SELECT a.area_name, a.idle, a.total FROM area_samples a "
            "JOIN (SELECT area_name, MAX(snapshot_id) mid FROM area_samples "
            f"WHERE {where} GROUP BY area_name) m "
            "ON a.area_name = m.area_name AND a.snapshot_id = m.mid"):
        last[name] = (int(idle or 0), int(total or 0))

    ranking = []
    for name, n, idle_sum, total_sum, fault_sum in rows(
            "SELECT area_name, COUNT(*), SUM(idle), SUM(total), SUM(fault) "
            f"FROM area_samples WHERE {where} GROUP BY area_name"):
        cur = last.get(name, (0, 0))
        ranking.append({
            "name": name,
            "samples": int(n),
            "avg_idle_ratio": ratio([float(idle_sum or 0), float(total_sum or 0)]) or 0,
            "avg_fault_ratio": ratio([float(fault_sum or 0), float(total_sum or 0)]) or 0,
            "idle": cur[0], "total": cur[1],
        })
    ranking.sort(key=lambda x: x["avg_idle_ratio"], reverse=True)

    best = []
    for d in range(7):
        for h in range(24):
            idle_sum, total_sum = heat[d][h]
            if total_sum >= 20:
                best.append({"dow": d, "hour": h,
                             "ratio": round(idle_sum / total_sum, 3)})
    best.sort(key=lambda x: x["ratio"], reverse=True)

    now = datetime.now()
    slots = {}
    for name, dow, hour, idle, total in rows(
            "SELECT area_name, CAST(strftime('%w', received_at) AS INTEGER), "
            "CAST(strftime('%H', received_at) AS INTEGER), SUM(idle), SUM(total) "
            f"FROM area_samples WHERE {where} GROUP BY 1, 2, 3"):
        slots[(name, (int(dow) + 6) % 7, int(hour))] = (float(idle or 0),
                                                         int(total or 0))
    forecast = []
    for name, cur in last.items():
        idle_sum = total_sum = 0.0
        for h in (now.hour, (now.hour + 1) % 24):
            slot = slots.get((name, now.weekday(), h))
            if slot:
                idle_sum += slot[0]
                total_sum += slot[1]
        r = idle_sum / total_sum if total_sum else 0.0
        forecast.append({
            "name": name,
            "predicted_idle": round(r * cur[1]),
            "total": cur[1],
            "samples": int(cur[1]),
            "basis": "同星期同时段均值（按端口加权）",
        })
    forecast.sort(key=lambda x: x["predicted_idle"], reverse=True)

    return {
        "ok": True,
        "area": area,
        "samples": int(samples),
        "heatmap": [[round(cell[0] / cell[1], 3) if cell[1] else None for cell in day]
                    for day in heat],
        "trend_24h": [{"t": str(k)[-5:],
                       "ratio": round(float(idle) / total, 3) if total else None}
                      for k, idle, total in hourly],
        "trend_7d": [{"t": str(k)[5:],
                      "ratio": round(float(idle) / total, 3) if total else None}
                     for k, idle, total in daily],
        "weekday_weekend": {"weekday": ratio([wd_idle, wd_total]),
                            "weekend": ratio([we_idle, we_total])},
        "ranking": ranking,
        "forecast": forecast,
        "best_slots": best[:3],
    }
