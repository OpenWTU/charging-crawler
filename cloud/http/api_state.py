"""实时状态族（/api/now、/api/overview、/api/free-rate、/health）"""

from __future__ import annotations
import json
import math
import sys
import time
from urllib.parse import parse_qs
from ..config import (NOW_WALK_M_PER_MIN, WORKER_INTERVAL, WORKER_STATE, now_str)
from ..geo import haversine_m, parse_coord
from ..health import health_stats_cached
from ..ports import (_ports_health, area_port_group_counts, area_port_state)
from ..prediction import (prediction_fields, prediction_stats_cached)
from ..tokens import token_pool_stats


class ApiStateMixin:
    """实时状态族（/api/now、/api/overview、/api/free-rate、/health）"""

    def _route_now(self, parsed, ip) -> bool:
        """当前空闲 + 预测（/api/now）。"""

        qs = parse_qs(parsed.query)
        user_lat = parse_coord((qs.get("lat") or [""])[0], -90.0, 90.0)
        user_lng = parse_coord((qs.get("lng") or [""])[0], -180.0, 180.0)
        use_coords = user_lat is not None and user_lng is not None
        with self.server.db_lock:
            cur_id = self.db.execute(
                "SELECT MAX(id) FROM snapshots").fetchone()[0]
            rows = []
            if cur_id:
                rows = self.db.execute(
                    "SELECT area_name, idle, total, charging, fault "
                    "FROM area_samples WHERE snapshot_id = ?",
                    (cur_id,)).fetchall()
            cutoff = time.strftime("%Y-%m-%d %H:%M:%S",
                                   time.localtime(time.time() - 1800))
            old_id = self.db.execute(
                "SELECT MAX(id) FROM snapshots WHERE received_at < ?",
                (cutoff,)).fetchone()[0]
            old = {}
            if old_id:
                old = dict(self.db.execute(
                    "SELECT area_name, idle FROM area_samples "
                    "WHERE snapshot_id = ?", (old_id,)).fetchall())
            coords = {row[0]: (row[1], row[2]) for row in self.db.execute(
                "SELECT name, lat, lng FROM areas")}
            # 数据契约 v2：不可用端口数优先取端口级明细（含禁用/绑定/维护/硬件故障），
            # 该区没有端口明细时回退到平台 faultPort。
            try:
                port_counts = area_port_group_counts(self.db)
            except Exception:  # 明细表缺失时不影响 /api/now 主流程
                port_counts = {}
        # 预测聚合移到主库锁之外（独立只读连接 + single-flight 60s 缓存）。
        try:
            prediction = prediction_stats_cached(str(self.server.db_path))
        except Exception as exc:
            sys.stderr.write(f"[prediction] {exc!r}\n")
            prediction = {}
        max_idle = max((int(r[1]) for r in rows), default=0)
        items = []
        for name, idle, total, _charging, fault in rows:
            idle = int(idle)
            total = int(total)
            # 数据契约 v2：不可用端口数取端口级明细（含禁用/绑定/维护等）优先，
            # 无明细时回退平台 fault_port；port_state 与 _ports_health 同口径
            # （free / busy / full / unavailable / unknown）。
            detail_total, detail_bad = port_counts.get(name, (0, 0))
            unavailable_ports = (detail_bad if detail_total > 0
                                 else int(fault or 0))
            delta = idle - int(old.get(name, idle))
            distance_m = None
            score = idle  # 无坐标/未传经纬度：回退为纯空闲
            point = coords.get(name)
            if (use_coords and point is not None
                    and point[0] is not None and point[1] is not None):
                dist = haversine_m(user_lat, user_lng,
                                   float(point[0]), float(point[1]))
                distance_m = int(round(dist))
                score = round(
                    0.65 * (idle / max(1, max_idle))
                    + 0.35 * (1 - min(distance_m, 3000) / 3000), 3)
            elif use_coords:
                score = round(0.65 * (idle / max(1, max_idle)), 3)
            items.append({"name": name, "idle": idle, "total": total,
                          "delta": delta, "distance_m": distance_m,
                          "score": score,
                          "unavailable_ports": unavailable_ports,
                          "port_state": area_port_state(
                              idle, total, unavailable_ports),
                          **prediction_fields(
                              name, idle, prediction, total,
                              (max(1, math.ceil(distance_m / NOW_WALK_M_PER_MIN))
                               if distance_m is not None else None))})
        items.sort(key=lambda x: x["score"], reverse=True)
        self._json(200, {"ok": True, "areas": items})
        return True


    def _route_overview(self, parsed, ip) -> bool:
        """最新快照概览（/api/overview）。"""

        with self.server.db_lock:
            latest = self.db.execute(
                "SELECT received_at, payload FROM snapshots ORDER BY id DESC LIMIT 1").fetchone()
            count = self.db.execute("SELECT COUNT(*) FROM snapshots").fetchone()[0]
            coords = {row[0]: (row[1], row[2]) for row in self.db.execute(
                "SELECT name, lat, lng FROM areas")}
        now_ts = int(time.time())
        pool = token_pool_stats(self.db, self.server.db_lock)
        health = health_stats_cached(
            self.db, self.server.db_lock,
            str(getattr(self.server, "db_path", "")))
        # token_ready / token_valid / earliest_exp 保留原语义，改为以池为准。
        common = {
            "token_ready": bool(pool["valid"]),
            "token_valid": pool["valid"],
            "earliest_exp": pool["earliest_exp"],
            "token_pool": pool,
            "interval": WORKER_INTERVAL,
            "error_count": health["error_count"],
        }
        if not latest:
            self._json(200, {"ok": True, "uploads": 0, "areas": [], **common})
            return True
        try:
            snap = json.loads(latest[1])
        except Exception:
            self._error(500, "快照数据损坏")
            return True
        snap.pop("token_user", None)
        areas = snap.get("areas")
        if isinstance(areas, list):
            for area in areas:
                if not isinstance(area, dict):
                    continue
                point = coords.get(area.get("name")) or (None, None)
                area["lat"] = point[0]
                area["lng"] = point[1]
        self._json(200, {"ok": True, "uploads": count,
                         "received_at": latest[0],
                         "generated_at": now_ts,
                         "last_scan_at": latest[0],
                         "adapter": "haokuaichong",
                         "coord_system": "gcj02",
                         **common,
                         "snapshot": snap})
        return True


    def _route_free_rate(self, parsed, ip) -> bool:
        """分时段空闲率（/api/free-rate）。"""

        qs = parse_qs(parsed.query)
        try:
            days = int((qs.get("days") or ["14"])[0])
        except (TypeError, ValueError):
            days = 14
        days = max(1, min(days, 30))
        cutoff = time.strftime("%Y-%m-%d %H:%M:%S",
                               time.localtime(time.time() - days * 86400))
        with self.server.db_lock:
            total = self.db.execute(
                "SELECT COUNT(*) FROM area_samples WHERE received_at >= ?",
                (cutoff,)).fetchone()[0]
            rows = self.db.execute(
                "SELECT CAST(strftime('%H', received_at) AS INTEGER), COUNT(*), "
                "SUM(CASE WHEN idle > 0 THEN 1 ELSE 0 END) "
                "FROM area_samples WHERE received_at >= ? GROUP BY 1",
                (cutoff,)).fetchall()
        buckets = {h: (0, 0) for h in range(24)}
        for hour, samples, free in rows:
            buckets[int(hour)] = (int(samples), int(free or 0))
        points = []
        for hour in range(24):
            samples, free = buckets[hour]
            points.append({
                "hour": hour,
                "samples": samples,
                "free_rate": round(free / samples, 4) if samples else None,
            })
        self._json(200, {"ok": True, "days": days,
                         "total_samples": int(total), "points": points})
        return True


    def _route_health(self, parsed, ip) -> bool:
        """健康摘要（/health）。"""

        try:
            with self.server.db_lock:
                last = self.db.execute(
                    "SELECT MAX(received_at) FROM snapshots").fetchone()[0]
                pool = token_pool_stats(self.db, self.server.db_lock)
            health = health_stats_cached(
                self.db, self.server.db_lock,
                str(getattr(self.server, "db_path", "")))
            worker = dict(WORKER_STATE)
            self._json(200, {
                "ok": True, "db": "ok", "server_time": now_str(),
                "last_snapshot": last,
                "worker": {"last_run": worker.get("last_run"),
                           "last_result": worker.get("last_result"),
                           "runs": worker.get("runs", 0)},
                "token_pool": {"count": pool["count"],
                               "valid": pool["valid"],
                               "earliest_exp": pool["earliest_exp"]},
                "error_count": health["error_count"],
            })
        except Exception as exc:
            sys.stderr.write(f"[health] {exc!r}\n")
            self._json(503, {"ok": False, "db": "error"})
        return True
