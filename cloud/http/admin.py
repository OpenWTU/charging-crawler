"""`/admin` 与 `/admin/api/*` 入口（组合各面板 mixin）。

面板实现分别位于 :mod:`admin_areas` / :mod:`admin_account` /
:mod:`admin_ops`，这里只保留分发与组合。
"""

from __future__ import annotations
import csv
from ..security import (rate_ok)


from .admin_account import AdminAccountMixin
from .admin_areas import AdminAreasMixin
from .admin_ops import AdminOpsMixin

class AdminMixin(AdminAreasMixin, AdminAccountMixin, AdminOpsMixin):
    """后台分发 + 组合各面板 mixin。"""

    def _admin_get(self, parsed) -> None:
        path = parsed.path
        ip = self._client_ip()
        if path == "/admin/login":
            if self._admin_session():
                self._redirect("/admin")
                return
            self._login_page()
            return
        if path in ("/admin/", "/admin/index.html"):
            if self._admin_session():
                self._redirect("/admin")
            else:
                self._redirect("/admin/login")
            return
        if path == "/admin":
            if not self._admin_guard(api=False):
                return
            try:
                body = (self.web_dir / "admin.html").read_bytes()
            except OSError:
                self._error(500, "管理页缺失")
                return
            self._send(200, body, "text/html; charset=utf-8")
            return
        if path.startswith("/admin/api/"):
            if not self._admin_guard(api=True):
                return
            if not rate_ok(ip, "admin_api", 600, 60):
                self._json(429, {"ok": False, "error": "请求过于频繁"})
                return
            api = path[len("/admin/api/"):]
            if api == "summary":
                self._api_summary()
            elif api == "audit":
                self._api_audit(parsed)
            elif api == "server-snapshots":
                self._api_server_snapshots(parsed)
            elif api == "devices":
                self._api_devices(parsed)
            elif api == "settings":
                self._api_settings_get()
            elif api == "tokens":
                self._api_tokens(parsed)
            elif api == "system":
                self._api_system()
            elif api == "me":
                self._api_me()
            elif api == "users":
                self._api_users()
            elif api == "areas":
                self._api_areas()
            elif api == "controllers":
                self._api_controllers()
            elif api == "anomalies":
                self._api_anomalies()
            elif api == "export.csv":
                self._api_export(parsed)
            else:
                self._error(404, "not found")
            return
        if self._admin_guard(api=False):
            self._error(404, "not found")

    def _admin_post(self, path: str) -> None:
        if path == "/admin/login":
            self._login_submit()
            return
        if path == "/admin/logout":
            self._logout()
            return
        if path.startswith("/admin/api/"):
            if not self._admin_guard(api=True):
                return
            origin = self.headers.get("Origin")
            host = self.headers.get("Host", "")
            if origin and origin not in ("http://" + host, "https://" + host):
                self._error(403, "origin 校验失败")
                return
            if path == "/admin/api/users":
                self._api_user_create()
            elif path == "/admin/api/password":
                self._api_password()
            elif path == "/admin/api/settings":
                self._api_settings_set()
            elif path == "/admin/api/areas":
                self._api_area_add()
            elif path == "/admin/api/areas/coords":
                self._api_area_coords()
            elif path == "/admin/api/areas/delete":
                self._api_area_delete()
            elif path == "/admin/api/controllers/sync":
                self._api_controllers_sync()
            elif path == "/admin/api/controllers/qr":
                self._api_controller_qr()
            elif path == "/admin/api/device/revoke":
                self._api_device_revoke()
            elif path == "/admin/api/device/approve":
                self._api_device_approve()
            elif path == "/admin/api/devices/reset-secret":
                self._api_device_reset_secret()
            else:
                self._error(404, "not found")
            return
        if self._admin_guard(api=False):
            self._error(404, "not found")
