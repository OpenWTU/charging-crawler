"""后台：区域 / 控制器（/admin/api/areas*、controllers*）"""

from __future__ import annotations
import hashlib
import sys
from ..config import (CONTROLLERS_CACHE, CONTROLLERS_CACHE_LOCK, QR_DEVICE_RE, SYNC_LOCK, invalidate_areas_ports_cache, now_str)
from ..geo import parse_coord
from ..ports import sync_ports


class AdminAreasMixin:
    """AdminAreas 路由族（mixin）"""

    def _api_areas(self) -> None:
        with self.server.db_lock:
            rows = self.db.execute(
                "SELECT a.area_id, a.name, a.first_seen, a.last_seen, "
                "(SELECT COUNT(*) FROM area_samples s WHERE s.area_id = a.area_id), "
                "a.lat, a.lng "
                "FROM areas a ORDER BY a.name").fetchall()
        self._json(200, {"ok": True, "rows": [
            dict(area_id=r[0], name=r[1], first_seen=r[2], last_seen=r[3],
                 samples=r[4], lat=r[5], lng=r[6]) for r in rows]})

    def _api_area_add(self) -> None:
        obj = self._json_body()
        if obj is None:
            self._error(400, "参数非法")
            return
        name = str(obj.get("name") or "").strip()
        if not name or len(name) > 80:
            self._error(400, "区域名需为 1-80 个字符")
            return
        area_id = hashlib.md5(name.encode("utf-8")).hexdigest()[:16]
        with self.server.db_lock:
            row = self.db.execute(
                "SELECT area_id FROM areas WHERE name = ?", (name,)).fetchone()
            if row:
                self._json(200, {"ok": True, "area_id": row[0], "existed": True})
                return
            self.db.execute(
                "INSERT INTO areas(area_id, name, first_seen, last_seen) VALUES (?,?,?,?)",
                (area_id, name, now_str(), now_str()))
            self.db.commit()
        self._audit(self._client_ip(), self.headers.get("User-Agent", ""), 0,
                    "area_add", name)
        self._json(200, {"ok": True, "area_id": area_id, "existed": False})

    def _api_area_coords(self) -> None:
        """管理员手工录入区域坐标（平台接口不提供经纬度）。"""
        obj = self._json_body()
        if not isinstance(obj, dict):
            self._error(400, "参数非法")
            return
        name = str(obj.get("name") or "").strip()
        if not name or len(name) > 80:
            self._error(400, "区域名需为 1-80 个字符")
            return
        lat = parse_coord(obj.get("lat"), -90.0, 90.0)
        if lat is None:
            self._error(400, "lat 需在 -90 ~ 90 之间")
            return
        lng = parse_coord(obj.get("lng"), -180.0, 180.0)
        if lng is None:
            self._error(400, "lng 需在 -180 ~ 180 之间")
            return
        with self.server.db_lock:
            row = self.db.execute(
                "SELECT area_id FROM areas WHERE name = ?", (name,)).fetchone()
            if row is None:
                self._error(404, "区域不存在")
                return
            self.db.execute(
                "UPDATE areas SET lat = ?, lng = ? WHERE name = ?",
                (lat, lng, name))
            self.db.commit()
        self._audit(self._client_ip(), self.headers.get("User-Agent", ""), 0,
                    "area_coords", f"{name} {lat},{lng}")
        self._json(200, {"ok": True, "area_id": row[0], "name": name,
                         "lat": lat, "lng": lng})

    def _api_area_delete(self) -> None:
        obj = self._json_body()
        if obj is None:
            self._error(400, "参数非法")
            return
        area_id = str(obj.get("area_id") or "").strip()
        with self.server.db_lock:
            used = self.db.execute(
                "SELECT COUNT(*) FROM area_samples WHERE area_id = ?",
                (area_id,)).fetchone()[0]
            if used:
                self._error(409, "该区域已有历史样本，不能删除")
                return
            cur = self.db.execute("DELETE FROM areas WHERE area_id = ?", (area_id,))
            self.db.commit()
        if cur.rowcount == 0:
            self._error(404, "区域不存在")
            return
        self._audit(self._client_ip(), self.headers.get("User-Agent", ""), 0,
                    "area_delete", area_id)
        self._json(200, {"ok": True})

    def _api_controllers(self) -> None:
        with self.server.db_lock:
            rows = self.db.execute(
                "SELECT c.device_hex, c.code, c.area_name, c.updated_at, "
                "(SELECT COUNT(*) FROM port_states p WHERE p.device_hex=c.device_hex), "
                "(SELECT COUNT(*) FROM port_states p WHERE p.device_hex=c.device_hex "
                "AND p.status='空闲'), "
                "(SELECT COUNT(*) FROM port_states p WHERE p.device_hex=c.device_hex "
                "AND p.status='充电中'), c.qr_device_no "
                "FROM controllers c ORDER BY c.area_name").fetchall()
            missing = [r[0] for r in self.db.execute(
                "SELECT a.name FROM areas a LEFT JOIN controllers c "
                "ON c.area_name = a.name WHERE c.device_hex IS NULL ORDER BY a.name")]
        self._json(200, {"ok": True, "rows": [
            dict(device_hex=r[0], code=r[1], area_name=r[2], updated_at=r[3],
                 port_count=r[4], idle=r[5], charging=r[6], qr_device_no=r[7])
            for r in rows],
            "missing_areas": missing})

    def _api_controller_qr(self) -> None:
        """补/改控制器二维码设备号（8 位 hex，如 acfc1a00）；不调用平台。"""
        obj = self._json_body()
        if obj is None:
            self._error(400, "参数非法")
            return
        device_hex = str(obj.get("device_hex") or "").strip()
        qr = str(obj.get("qr_device_no") or "").strip().lower()
        if not device_hex or len(device_hex) > 32:
            self._error(400, "device_hex 非法")
            return
        if not QR_DEVICE_RE.match(qr):
            self._error(400, "qr_device_no 需为 8 位十六进制")
            return
        with self.server.db_lock:
            row = self.db.execute(
                "SELECT device_hex FROM controllers "
                "WHERE upper(device_hex) = upper(?)", (device_hex,)).fetchone()
            if row is None:
                self._error(404, "设备不存在")
                return
            self.db.execute(
                "UPDATE controllers SET qr_device_no = ? WHERE device_hex = ?",
                (qr, row[0]))
            self.db.commit()
        # /api/controllers 有 30 秒缓存，改完立刻失效，避免公开接口返回旧码牌号。
        with CONTROLLERS_CACHE_LOCK:
            CONTROLLERS_CACHE.pop("data", None)
        invalidate_areas_ports_cache()
        self._audit(self._client_ip(), self.headers.get("User-Agent", ""), 0,
                    "controller_qr", f"{row[0]} qr={qr}")
        self._json(200, {"ok": True, "device_hex": row[0],
                         "qr_device_no": qr})

    def _api_controllers_sync(self) -> None:
        if not SYNC_LOCK.acquire(blocking=False):
            self._json(409, {"ok": False, "error": "正在同步，请稍候"})
            return
        try:
            result = sync_ports(self.db, self.server.db_lock)
            self._audit(self._client_ip(), self.headers.get("User-Agent", ""),
                        0, "controllers_sync", result)
            # H4：结果里带 fail 时也算未成功，避免部分失败被当成成功。
            ok = result.startswith("ok") and " fail:" not in result
            self._json(200, {"ok": ok, "result": result})
        except Exception as exc:
            sys.stderr.write(f"[sync_ports] {exc!r}\n")
            self._error(500, "同步失败")
        finally:
            SYNC_LOCK.release()
