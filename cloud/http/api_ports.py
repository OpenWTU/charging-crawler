"""端口族（/api/areas-ports、/api/area-ports、/api/pile）"""

from __future__ import annotations
import time
from ..config import (AREAS_PORTS_CACHE, AREAS_PORTS_CACHE_LOCK, AREAS_PORTS_CACHE_TTL, AREA_PORTS_CACHE, AREA_PORTS_CACHE_LOCK, AREA_PORTS_CACHE_TTL, AREA_PORTS_DEVICE_LIMIT, AREAS_PORTS_LIMIT, PILE_HISTORY_LIMIT)
from ..ports import (_ports_health, status_group)
from urllib.parse import parse_qs
from ..config import CONTROLLERS_CACHE, CONTROLLERS_CACHE_LOCK, CONTROLLERS_CACHE_TTL, CONTROLLERS_LIMIT


def _summarize_devices(devices) -> dict:
    """把设备级健康计数汇总成区域级 summary（数据契约 v2 的新字段）。

    devices 里每项都来自 :func:`cloud.ports._ports_health`，已经带
    free / busy / unavailable / unknown / total / statuses，这里只做求和：
    恒有 ``free + busy + unavailable == total``，``unknown`` 是 busy 的子集。

    ``statuses`` 是**逐状态计数**（空闲/充电中/已充满/浮充/禁用/绑定…），
    让端口详情页能把「充电中 / 已充满 / 浮充」分别显示，而不是并成一个"占用"。
    """
    summary = {"free": 0, "busy": 0, "unavailable": 0, "unknown": 0, "total": 0,
               "statuses": {}}
    for dev in devices:
        for key in ("free", "busy", "unavailable", "unknown", "total"):
            summary[key] += int(dev.get(key) or 0)
        for status, count in (dev.get("statuses") or {}).items():
            summary["statuses"][status] = (summary["statuses"].get(status, 0)
                                           + int(count or 0))
    return summary


class ApiPortsMixin:
    """ApiPorts 路由族（mixin）"""

    def _api_areas_ports(self) -> None:
        """公开端口总览：单条 JOIN + 30 秒缓存 + 设备上限，替代原来的 N+1 查询。"""
        now = time.time()
        db_key = str(getattr(self.server, "db_path", ""))
        with AREAS_PORTS_CACHE_LOCK:
            if AREAS_PORTS_CACHE.get("db") != db_key:
                AREAS_PORTS_CACHE.clear()
                AREAS_PORTS_CACHE["db"] = db_key
            data = AREAS_PORTS_CACHE.get("data")
            cached_at = float(AREAS_PORTS_CACHE.get("ts") or 0.0)
        if data is not None and now - cached_at <= AREAS_PORTS_CACHE_TTL:
            self._json(200, data)
            return
        with self.server.db_lock:
            rows = self.db.execute(
                """SELECT c.device_hex, c.code, c.area_name, c.updated_at,
                          c.qr_device_no, p.port, p.status, p.updated_at
                   FROM (SELECT device_hex, code, area_name, updated_at, qr_device_no
                         FROM controllers ORDER BY area_name, device_hex LIMIT ?) c
                   JOIN port_states p ON p.device_hex = c.device_hex
                   ORDER BY c.area_name, c.device_hex, p.port""",
                (AREAS_PORTS_LIMIT,)).fetchall()
            total = self.db.execute(
                "SELECT COUNT(DISTINCT c.device_hex) FROM controllers c "
                "JOIN port_states p ON p.device_hex = c.device_hex").fetchone()[0]
        areas_map: dict = {}
        devices: dict = {}
        for device_hex, code, area_name, ctrl_at, qr_no, port, status, port_at in rows:
            dev = devices.get(device_hex)
            if dev is None:
                dev = {"device_hex": device_hex, "code": code,
                       "qr_device_no": qr_no, "updated_at": ctrl_at or "",
                       "ports": [], "_rows": []}
                devices[device_hex] = dev
                areas_map.setdefault(area_name, []).append(dev)
            dev["ports"].append(dict(port=port, status=status,
                                     group=status_group(status)))
            dev["_rows"].append((port, status, port_at))
        for dev in devices.values():
            port_rows = dev.pop("_rows")
            dev["updated_at"] = max(
                (r[2] or "" for r in port_rows), default=dev["updated_at"] or "")
            dev.update(_ports_health(port_rows, dev["updated_at"]))
        payload = {"ok": True, "total": int(total),
                   "truncated": bool(total > len(devices)),
                   "areas": [{"area": k, "devices": v,
                              "summary": _summarize_devices(v)}
                             for k, v in areas_map.items()]}
        with AREAS_PORTS_CACHE_LOCK:
            AREAS_PORTS_CACHE["ts"] = now
            AREAS_PORTS_CACHE["data"] = payload
        self._json(200, payload)

    def _api_area_ports(self, area: str) -> None:
        """单区域端口：一条 LEFT JOIN 查询 + 30 秒按 area 缓存（含无端口设备）。"""
        now = time.time()
        db_key = str(getattr(self.server, "db_path", ""))
        cache_key = (db_key, area)
        with AREA_PORTS_CACHE_LOCK:
            cached = AREA_PORTS_CACHE.get(cache_key)
            if cached and now - cached[0] <= AREA_PORTS_CACHE_TTL:
                self._json(200, cached[1])
                return
        with self.server.db_lock:
            rows = self.db.execute(
                """SELECT c.device_hex, c.code, c.area_name, c.updated_at,
                          c.qr_device_no, p.port, p.status, p.updated_at
                   FROM (SELECT device_hex, code, area_name, updated_at, qr_device_no
                         FROM controllers WHERE area_name = ?
                         ORDER BY device_hex LIMIT ?) c
                   LEFT JOIN port_states p ON p.device_hex = c.device_hex
                   ORDER BY c.device_hex, p.port""",
                (area, AREA_PORTS_DEVICE_LIMIT)).fetchall()
        devices: list = []
        by_hex: dict = {}
        for device_hex, code, _area_name, ctrl_at, qr_no, port, status, port_at in rows:
            dev = by_hex.get(device_hex)
            if dev is None:
                dev = {"device_hex": device_hex, "code": code,
                       "qr_device_no": qr_no, "updated_at": ctrl_at or "",
                       "ports": [], "_rows": []}
                by_hex[device_hex] = dev
                devices.append(dev)
            if port is not None:
                dev["ports"].append(dict(port=port, status=status,
                                         group=status_group(status)))
                dev["_rows"].append((port, status, port_at))
        for dev in devices:
            port_rows = dev.pop("_rows")
            dev["updated_at"] = max(
                (r[2] or "" for r in port_rows), default=dev["updated_at"] or "")
            dev.update(_ports_health(port_rows, dev["updated_at"]))
        latest = max((d.get("updated_at") or "" for d in devices), default=None)
        payload = {"ok": True, "area": area, "devices": devices,
                   "updated_at": latest or None,
                   "summary": _summarize_devices(devices)}
        with AREA_PORTS_CACHE_LOCK:
            if len(AREA_PORTS_CACHE) > 128:
                AREA_PORTS_CACHE.clear()
            AREA_PORTS_CACHE[cache_key] = (now, payload)
        self._json(200, payload)

    def _pile_detail(self, raw_device: str) -> None:
        """单桩详情：状态复用 _ports_health，history 最近 120 条按时间升序。"""
        device_hex = str(raw_device or "").strip()
        if not device_hex or len(device_hex) > 32:
            self._error(404, "设备不存在")
            return
        with self.server.db_lock:
            ctrl = self.db.execute(
                "SELECT device_hex, code, area_name, qr_device_no, updated_at "
                "FROM controllers WHERE upper(device_hex) = upper(?)",
                (device_hex,)).fetchone()
            if ctrl is None:
                self._error(404, "设备不存在")
                return
            ports = self.db.execute(
                "SELECT port, status, updated_at FROM port_states "
                "WHERE device_hex = ? ORDER BY port", (ctrl[0],)).fetchall()
            history = self.db.execute(
                "SELECT ts, free, total, busy, online FROM pile_samples "
                "WHERE device_hex = ? ORDER BY ts DESC LIMIT ?",
                (ctrl[0], PILE_HISTORY_LIMIT)).fetchall()
        health = _ports_health(ports, ctrl[4] or "")
        latest = max((r[2] or "" for r in ports), default=ctrl[4] or "")
        self._json(200, {"ok": True, "pile": {
            "device_hex": ctrl[0],
            "code": ctrl[1],
            "area_name": ctrl[2],
            "qr_device_no": ctrl[3],
            "state": health["state"],
            "total": health["total"],
            "free": health["free"],
            "busy": health["busy"],
            "updated_at": latest or None,
            "ports": [{"port": r[0], "status": r[1]} for r in ports],
            "history": [{"ts": h[0], "free": h[1], "total": h[2],
                         "busy": h[3], "online": bool(h[4])}
                        for h in reversed(history)],
        }})

    def _route_controllers(self, parsed, ip) -> bool:
        """控制器清单（30s 缓存）（/api/controllers）。"""

        # 30 秒缓存：首页/端口页高频拉取，避免每次全表查 controllers
        now = time.time()
        db_key = str(getattr(self.server, "db_path", ""))
        with CONTROLLERS_CACHE_LOCK:
            if CONTROLLERS_CACHE.get("db") != db_key:
                CONTROLLERS_CACHE.clear()
                CONTROLLERS_CACHE["db"] = db_key
            cached = CONTROLLERS_CACHE.get("data")
            cached_at = float(CONTROLLERS_CACHE.get("ts") or 0.0)
        if cached is None or now - cached_at > CONTROLLERS_CACHE_TTL:
            with self.server.db_lock:
                rows = self.db.execute(
                    "SELECT area_name, device_hex, code, qr_device_no "
                    "FROM controllers "
                    "WHERE code IS NOT NULL AND code <> '' "
                    "ORDER BY area_name, device_hex LIMIT ?",
                    (CONTROLLERS_LIMIT,)).fetchall()
            cached = [{"area_name": r[0], "device_hex": r[1], "code": r[2],
                       "qr_device_no": r[3]} for r in rows]
            with CONTROLLERS_CACHE_LOCK:
                CONTROLLERS_CACHE["ts"] = now
                CONTROLLERS_CACHE["data"] = cached
        self._json(200, {"ok": True, "count": len(cached),
                         "controllers": cached})
        return True


    def _route_area_coords(self, parsed, ip) -> bool:
        """区域坐标（/api/area-coords）。"""

        with self.server.db_lock:
            rows = self.db.execute(
                "SELECT name, lat, lng FROM areas "
                "WHERE lat IS NOT NULL AND lng IS NOT NULL").fetchall()
        self._json(200, {"ok": True, "areas": [
            {"name": r[0], "lat": r[1], "lng": r[2]} for r in rows]})
        return True


    def _route_areas_ports(self, parsed, ip) -> bool:
        """全区端口总览（/api/areas-ports）。"""

        self._api_areas_ports()
        return True


    def _route_area_ports(self, parsed, ip) -> bool:
        """单区端口明细（/api/area-ports）。"""

        qs = parse_qs(parsed.query)
        area = (qs.get("area") or [""])[0].strip()
        if not area:
            self._error(400, "缺少 area")
            return True
        self._api_area_ports(area)
        return True


    def _route_pile(self, parsed, ip) -> bool:
        """单桩详情（/api/pile/）。"""
        path = parsed.path

        self._pile_detail(path[len("/api/pile/"):])
        return True
