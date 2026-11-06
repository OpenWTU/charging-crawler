"""后台：概览 / 审计 / 系统 / 设置 / 导出"""

from __future__ import annotations
import csv
import io
import json
import re
import sys
import time
from datetime import datetime
from urllib.parse import parse_qs
from ..config import (ADMIN_USER, ANOMALY_SNAPSHOT_SECONDS, WORKER_STATE, now_str)
from ..health import worker_log_info
from ..security import (admin_configured)
from ..store import DEVICE_APPROVAL_KEY, device_approval_enabled, set_setting
from ..tokens import token_pool_stats


class AdminOpsMixin:
    """AdminOps 路由族（mixin）"""

    def _api_summary(self) -> None:
        now = int(time.time())
        with self.server.db_lock:
            uploads_total = self.db.execute(
                "SELECT COUNT(*) FROM upload_audit WHERE result IN "
                "('ok','bad_sig','bad_body','replay','rate_limited','invalid',"
                "'invalid_ports','store_error')"
            ).fetchone()[0]
            uploads_ok = self.db.execute(
                "SELECT COUNT(*) FROM upload_audit WHERE result='ok'").fetchone()[0]
            uploads_failed = self.db.execute(
                "SELECT COUNT(*) FROM upload_audit WHERE result IN "
                "('bad_sig','bad_body','replay','rate_limited','invalid',"
                "'invalid_ports','store_error')"
            ).fetchone()[0]
            admin_events = self.db.execute(
                "SELECT COUNT(*) FROM upload_audit WHERE result LIKE 'admin%' "
                "OR result IN ('area_add','area_delete','area_coords',"
                "'controllers_sync','controller_qr','device_revoke',"
                "'device_revoke_undo','device_approve','device_pending')"
            ).fetchone()[0]
            user_uploads = self.db.execute(
                "SELECT COUNT(*) FROM snapshots WHERE client_ip <> 'server'").fetchone()[0]
            server_snapshots = self.db.execute(
                "SELECT COUNT(*) FROM snapshots WHERE client_ip='server'").fetchone()[0]
            devices = self.db.execute("SELECT COUNT(*) FROM devices").fetchone()[0]
            devices_revoked = self.db.execute(
                "SELECT COUNT(*) FROM devices WHERE revoked=1").fetchone()[0]
            tokens = self.db.execute("SELECT COUNT(*) FROM tokens").fetchone()[0]
            tokens_valid = self.db.execute(
                "SELECT COUNT(*) FROM tokens WHERE expires_at > ?", (now,)).fetchone()[0]
            last_capture = self.db.execute(
                "SELECT MAX(received_at) FROM snapshots").fetchone()[0]
            last_server_capture = self.db.execute(
                "SELECT MAX(received_at) FROM snapshots WHERE client_ip='server'"
            ).fetchone()[0]
            last_upload_ok = self.db.execute(
                "SELECT MAX(ts) FROM upload_audit WHERE result='ok'").fetchone()[0]
        self._json(200, {
            "ok": True,
            "uploads_total": uploads_total,
            "uploads_ok": uploads_ok,
            "uploads_failed": uploads_failed,
            "admin_events": admin_events,
            "user_uploads": user_uploads,
            "server_snapshots": server_snapshots,
            "devices": devices,
            "devices_revoked": devices_revoked,
            "tokens": tokens,
            "tokens_valid": tokens_valid,
            "last_capture_at": last_capture,
            "last_server_capture_at": last_server_capture,
            "last_upload_ok_at": last_upload_ok,
            "server_time": now_str(),
        })

    def _api_audit(self, parsed) -> None:
        qs = parse_qs(parsed.query)
        limit, offset = self._page_args(qs)
        with self.server.db_lock:
            rows = self.db.execute(
                "SELECT id, ts, ip, ua, size, result, detail FROM upload_audit "
                "ORDER BY id DESC LIMIT ? OFFSET ?", (limit, offset)).fetchall()
            total = self.db.execute("SELECT COUNT(*) FROM upload_audit").fetchone()[0]
        out = []
        for r in rows:
            detail = r[6] or ""
            match = re.search(r"dev=([0-9a-fA-F-]{1,64})", detail)
            device = match.group(1) if match and match.group(1) != "-" else ""
            result = r[5]
            if result in ("register", "register_rate"):
                source = "register"
            elif device:
                source = "device"
            elif result in ("ok", "bad_body", "replay", "bad_sig", "bad_ts",
                            "rate_limited", "invalid", "invalid_ports",
                            "store_error", "too_large"):
                source = "user"
            else:
                source = "other"
            out.append(dict(id=r[0], ts=r[1], ip=r[2], ua=r[3], size=r[4],
                            result=result, detail=detail, source=source,
                            device=device))
        self._json(200, {"ok": True, "limit": limit, "offset": offset,
                         "total": total, "rows": out})

    def _api_server_snapshots(self, parsed) -> None:
        qs = parse_qs(parsed.query)
        limit, offset = self._page_args(qs)
        with self.server.db_lock:
            rows = self.db.execute(
                """SELECT id, received_at, captured_at, project, token_user, payload
                   FROM snapshots WHERE client_ip='server'
                   ORDER BY id DESC LIMIT ? OFFSET ?""", (limit, offset)).fetchall()
            total = self.db.execute(
                "SELECT COUNT(*) FROM snapshots WHERE client_ip='server'").fetchone()[0]
        out = []
        for r in rows:
            try:
                obj = json.loads(r[5])
            except Exception:
                obj = {}
            raw_areas = obj.get("areas") if isinstance(obj, dict) else None
            areas = []
            if isinstance(raw_areas, list):
                for a in raw_areas[:100]:
                    if not isinstance(a, dict):
                        continue
                    areas.append(dict(name=a.get("name") or "-",
                                      total=a.get("total_port"),
                                      idle=a.get("idle_port"),
                                      charging=a.get("charging_port"),
                                      fault=a.get("fault_port")))
            out.append(dict(id=r[0], received_at=r[1], captured_at=r[2],
                            project=r[3], token_user=r[4],
                            area_count=len(raw_areas) if isinstance(raw_areas, list) else 0,
                            size=len(r[5] or ""), areas=areas))
        self._json(200, {"ok": True, "limit": limit, "offset": offset,
                         "total": total, "rows": out})

    def _api_tokens(self, parsed) -> None:
        qs = parse_qs(parsed.query)
        limit, offset = self._page_args(qs)
        now = int(time.time())
        with self.server.db_lock:
            rows = self.db.execute(
                "SELECT user_id, expires_at, updated_at FROM tokens "
                "ORDER BY updated_at DESC LIMIT ? OFFSET ?", (limit, offset)).fetchall()
            total = self.db.execute("SELECT COUNT(*) FROM tokens").fetchone()[0]
            valid = self.db.execute(
                "SELECT COUNT(*) FROM tokens WHERE expires_at > ?", (now,)).fetchone()[0]
        pool = token_pool_stats(self.db, self.server.db_lock)
        self._json(200, {
            "ok": True, "limit": limit, "offset": offset,
            "total": total, "valid": valid,
            "rows": [dict(user_id=r[0], expires_at=r[1], updated_at=r[2],
                          valid=int(r[1] or 0) > now) for r in rows],
            # 池健康：多 token 轮换的实际可用性（tokens 只是兼容镜像）
            "pool": {"count": pool["count"], "valid": pool["valid"],
                     "earliest_exp": pool["earliest_exp"],
                     "cover_until": pool["cover_until"],
                     "long_lived": pool["long_lived"]},
        })

    def _api_system(self) -> None:
        version = {}
        try:
            version = json.loads(self.version_file.read_text(encoding="utf-8"))
            if not isinstance(version, dict):
                version = {}
        except Exception:
            version = {}
        worker = dict(WORKER_STATE)
        source = "memory" if worker.get("last_run") else "none"
        if not worker.get("last_run"):
            info = worker_log_info()
            if info:
                worker.update(info)
                source = "log"
        with self.server.db_lock:
            snapshot_count = self.db.execute(
                "SELECT COUNT(*) FROM snapshots").fetchone()[0]
        self._json(200, {
            "ok": True,
            "version": {"versionName": version.get("versionName") or "—",
                        "versionCode": version.get("versionCode")},
            "worker": {"last_run": worker.get("last_run") or None,
                       "last_result": worker.get("last_result") or None,
                       "runs": worker.get("runs", 0),
                       "started_at": worker.get("started_at"),
                       "source": source},
            "admin_configured": admin_configured(),
            "admin_user": ADMIN_USER or "",
            "server_time": now_str(),
            "python": "%d.%d.%d" % sys.version_info[:3],
            "snapshot_count": snapshot_count,
        })

    def _api_settings_get(self) -> None:
        with self.server.db_lock:
            enabled = device_approval_enabled(self.db)
        self._json(200, {"device_approval": enabled})

    def _api_settings_set(self) -> None:
        obj = self._json_body()
        if obj is None or not isinstance(obj.get("device_approval"), bool):
            self._error(400, "device_approval 需为布尔值")
            return
        enabled = bool(obj["device_approval"])
        approved_count = 0
        with self.server.db_lock:
            with self.db:
                set_setting(self.db, DEVICE_APPROVAL_KEY, "on" if enabled else "off")
                if not enabled:
                    cur = self.db.execute(
                        "UPDATE devices SET status='approved' "
                        "WHERE status='pending' AND revoked=0")
                    approved_count = cur.rowcount
        self._audit(self._client_ip(), self.headers.get("User-Agent", ""), 0,
                    "admin_settings", "device_approval=" + ("on" if enabled else "off")
                    + (f" auto_approved={approved_count}" if approved_count else ""))
        self._json(200, {"ok": True, "device_approval": enabled,
                         "auto_approved": approved_count})

    def _api_anomalies(self) -> None:
        items = []
        with self.server.db_lock:
            last = self.db.execute(
                "SELECT received_at FROM snapshots ORDER BY id DESC LIMIT 1").fetchone()
            invalid = self.db.execute(
                "SELECT COUNT(*) FROM tokens WHERE expires_at <= ?",
                (int(time.time()),)).fetchone()[0]
            revoked = self.db.execute(
                "SELECT COUNT(*) FROM devices WHERE revoked = 1").fetchone()[0]
            runs = self.db.execute(
                "SELECT result FROM worker_runs ORDER BY id DESC LIMIT 3").fetchall()
        if not last:
            items.append({"level": "error", "title": "还没有任何快照"})
        else:
            try:
                age = (datetime.now() - datetime.strptime(
                    last[0], "%Y-%m-%d %H:%M:%S")).total_seconds()
            except ValueError:
                age = 0
            if age > ANOMALY_SNAPSHOT_SECONDS:
                items.append({"level": "warn", "title": "数据超过 30 分钟未更新",
                              "detail": last[0]})
        if runs and any("error" in str(r[0]) for r in runs):
            items.append({"level": "warn", "title": "worker 最近出现错误",
                          "detail": str(runs[0][0])})
        if invalid:
            items.append({"level": "warn", "title": f"{invalid} 个令牌已过期"})
        if revoked:
            items.append({"level": "info", "title": f"{revoked} 台设备已被撤销"})
        self._json(200, {"ok": True, "items": items})

    def _api_export(self, parsed) -> None:
        qs = parse_qs(parsed.query)
        table = (qs.get("table") or ["audit"])[0]
        if table not in ("audit", "snapshots", "devices"):
            table = "audit"
        try:
            limit = max(1, min(int((qs.get("limit") or ["5000"])[0]), 20000))
        except ValueError:
            limit = 5000

        def safe(v):
            if isinstance(v, str) and v.lstrip()[:1] in ("=", "+", "-", "@",
                                                         "\t", "\r"):
                return "'" + v
            return v
        buf = io.StringIO()
        w = csv.writer(buf)
        with self.server.db_lock:
            if table == "snapshots":
                w.writerow(["id", "received_at", "captured_at", "project",
                            "app_version", "token_user", "client_ip"])
                for r in self.db.execute(
                        "SELECT id, received_at, captured_at, project, app_version, "
                        "token_user, client_ip FROM snapshots ORDER BY id DESC LIMIT ?",
                        (limit,)):
                    w.writerow([safe(x) for x in r])
            elif table == "devices":
                w.writerow(["device_id", "model", "app_version", "created_at",
                            "last_seen", "uploads", "revoked"])
                for r in self.db.execute(
                        "SELECT device_id, model, app_version, created_at, last_seen, "
                        "uploads, revoked FROM devices ORDER BY created_at DESC LIMIT ?",
                        (limit,)):
                    w.writerow([safe(x) for x in r])
            else:
                w.writerow(["id", "ts", "ip", "ua", "size", "result", "detail"])
                for r in self.db.execute(
                        "SELECT id, ts, ip, ua, size, result, detail FROM upload_audit "
                        "ORDER BY id DESC LIMIT ?", (limit,)):
                    w.writerow([safe(x) for x in r])
        self._send(200, buf.getvalue().encode("utf-8-sig"), "text/csv; charset=utf-8",
                   extra={"Content-Disposition": f'attachment; filename="charge-{table}.csv"'})
