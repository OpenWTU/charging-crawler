"""历史与分析族（/api/history、/api/analytics、/api/version、/api/latest）"""

from __future__ import annotations
import json
import sqlite3
import time
from urllib.parse import parse_qs
from ..analytics import build_analytics
from ..config import (ANALYTICS_CACHE, ANALYTICS_MISS_LIMIT)
from ..security import rate_ok


class ApiAnalyticsMixin:
    """历史与分析族（/api/history、/api/analytics、/api/version、/api/latest）"""

    def _route_history(self, parsed, ip) -> bool:
        """单区历史（/api/history）。"""

        qs = parse_qs(parsed.query)
        area = (qs.get("area") or [""])[0]
        try:
            limit = max(1, min(int((qs.get("limit") or ["200"])[0]), 1000))
        except ValueError:
            limit = 200
        if not area:
            self._error(400, "缺少 area")
            return True
        with self.server.db_lock:
            rows = self.db.execute(
                """SELECT s.received_at, a.idle, a.total, a.charging, a.fault
                   FROM area_samples a JOIN snapshots s ON s.id = a.snapshot_id
                   WHERE a.area_name = ? ORDER BY a.snapshot_id DESC LIMIT ?""",
                (area, limit)).fetchall()
        self._json(200, {"ok": True, "area": area,
                         "rows": [dict(idle=r[1], total=r[2], charging=r[3],
                                       fault=r[4], t=r[0]) for r in reversed(rows)]})
        return True


    def _route_analytics(self, parsed, ip) -> bool:
        """热力图/趋势/排行（/api/analytics）。"""

        qs = parse_qs(parsed.query)
        area = (qs.get("area") or [None])[0] or None
        if area is not None:
            area = area.strip()[:80] or None
        if area is not None:
            # 反滥用：只接受 areas 表登记过的区域，避免任意 area 绕过缓存打全表聚合。
            with self.server.db_lock:
                known = self.db.execute(
                    "SELECT 1 FROM areas WHERE name = ?", (area,)).fetchone()
            if not known:
                self._error(400, "未知区域")
                return True
        try:
            weeks = max(1, min(int((qs.get("weeks") or ["8"])[0]), 52))
        except ValueError:
            weeks = 8
        key = (area or "", weeks)
        hit = ANALYTICS_CACHE.get(key)
        if hit and time.time() - hit[0] < 60:
            self._json(200, hit[1])
            return True
        # 未命中才计入配额；命中缓存仍免费。
        if not rate_ok(ip, "analytics_miss", ANALYTICS_MISS_LIMIT, 60):
            self._json(429, {"ok": False, "error": "分析请求过于频繁"})
            return True
        try:
            rconn = sqlite3.connect(str(self.server.db_path), timeout=20)
            rconn.execute("PRAGMA busy_timeout=20000")
            try:
                data = build_analytics(rconn, area, weeks)
            finally:
                rconn.close()
        except Exception:
            self._error(500, "分析数据暂不可用")
            return True
        if len(ANALYTICS_CACHE) >= 32 and key not in ANALYTICS_CACHE:
            ANALYTICS_CACHE.clear()
        ANALYTICS_CACHE[key] = (time.time(), data)
        self._json(200, data)
        return True


    def _route_version(self, parsed, ip) -> bool:
        """APK 版本元数据（/api/version）。"""

        try:
            self._send(200, self.version_file.read_bytes())
        except OSError:
            self._error(404, "version.json 未配置")
        return True


    def _route_latest(self, parsed, ip) -> bool:
        """原始快照（/api/latest）。"""

        with self.server.db_lock:
            row = self.db.execute(
                "SELECT received_at, payload FROM snapshots ORDER BY id DESC LIMIT 1"
            ).fetchone()
        if not row:
            self._error(404, "还没有数据")
        else:
            try:
                snap = json.loads(row[1])
            except Exception:
                self._error(500, "快照数据损坏")
                return True
            snap.pop("token_user", None)
            self._json(200, {"received_at": row[0], "snapshot": snap})
        return True
