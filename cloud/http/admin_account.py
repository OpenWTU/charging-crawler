"""后台：账户 / 设备审批（users、password、devices*）"""

from __future__ import annotations
import re
import sqlite3
from urllib.parse import parse_qs
from ..config import (ADMIN_COOKIE, now_str)
from ..security import (hash_password, password_weak, session_user, verify_password)


class AdminAccountMixin:
    """AdminAccount 路由族（mixin）"""

    def _api_me(self) -> None:
        token = self._client_cookie(ADMIN_COOKIE)
        self._json(200, {"ok": True, "user": session_user(token) if token else ""})

    def _api_users(self) -> None:
        with self.server.db_lock:
            rows = self.db.execute(
                "SELECT username, created_at, updated_at, disabled FROM admin_users "
                "ORDER BY created_at").fetchall()
        self._json(200, {"ok": True, "rows": [
            dict(username=r[0], created_at=r[1], updated_at=r[2],
                 disabled=bool(r[3])) for r in rows]})

    def _api_user_create(self) -> None:
        obj = self._json_body()
        if obj is None:
            self._error(400, "参数非法")
            return
        name = str(obj.get("username") or "").strip()
        pw = str(obj.get("password") or "")
        if not re.fullmatch(r"[A-Za-z0-9_.-]{3,32}", name):
            self._error(400, "用户名需为 3-32 位字母、数字或 ._-")
            return
        msg = password_weak(pw, name)
        if msg:
            self._error(400, msg)
            return
        with self.server.db_lock:
            try:
                self.db.execute(
                    "INSERT INTO admin_users(username, pass_hash, created_at, updated_at) "
                    "VALUES (?,?,?,?)", (name, hash_password(pw), now_str(), now_str()))
                self.db.commit()
            except sqlite3.IntegrityError:
                self._error(409, "用户名已存在")
                return
        self._audit(self._client_ip(), self.headers.get("User-Agent", ""), 0,
                    "admin_create", name)
        self._json(200, {"ok": True, "username": name})

    def _api_password(self) -> None:
        obj = self._json_body()
        if obj is None:
            self._error(400, "参数非法")
            return
        token = self._client_cookie(ADMIN_COOKIE)
        user = session_user(token) if token else ""
        old = str(obj.get("old") or "")
        new = str(obj.get("new") or "")
        msg = password_weak(new, user)
        if msg:
            self._error(400, msg)
            return
        with self.server.db_lock:
            row = self.db.execute(
                "SELECT pass_hash FROM admin_users WHERE username = ?", (user,)).fetchone()
            if not row or not verify_password(old, row[0]):
                self._error(400, "原密码不正确")
                return
            self.db.execute(
                "UPDATE admin_users SET pass_hash = ?, updated_at = ? WHERE username = ?",
                (hash_password(new), now_str(), user))
            self.db.commit()
        self._audit(self._client_ip(), self.headers.get("User-Agent", ""), 0,
                    "admin_password", user)
        self._json(200, {"ok": True})

    def _api_devices(self, parsed) -> None:
        qs = parse_qs(parsed.query)
        limit, offset = self._page_args(qs)
        with self.server.db_lock:
            rows = self.db.execute(
                "SELECT device_id, model, app_version, created_at, last_seen, uploads, revoked, status "
                "FROM devices ORDER BY created_at DESC LIMIT ? OFFSET ?",
                (limit, offset)).fetchall()
            total = self.db.execute("SELECT COUNT(*) FROM devices").fetchone()[0]
        self._json(200, {"ok": True, "limit": limit, "offset": offset, "total": total,
                         "rows": [dict(device_id=r[0], model=r[1], app_version=r[2],
                                       created_at=r[3], last_seen=r[4], uploads=r[5],
                                       revoked=bool(r[6]), status=r[7] or "approved")
                                  for r in rows]})

    def _api_device_approve(self) -> None:
        obj = self._json_body()
        if obj is None or not isinstance(obj.get("approved"), bool):
            self._error(400, "approved 需为布尔值")
            return
        did = str(obj.get("device_id") or "").strip()
        if not did:
            self._error(400, "缺少 device_id")
            return
        approved = bool(obj["approved"])
        new_status = "approved" if approved else "pending"
        with self.server.db_lock:
            row = self.db.execute(
                "SELECT device_id FROM devices WHERE device_id = ?", (did,)).fetchone()
            if row is None:
                self._error(404, "设备不存在")
                return
            with self.db:
                self.db.execute("UPDATE devices SET status = ? WHERE device_id = ?",
                                (new_status, did))
        self._audit(self._client_ip(), self.headers.get("User-Agent", ""), 0,
                    "device_approve" if approved else "device_pending", did)
        self._json(200, {"ok": True, "device_id": did, "status": new_status})

    def _api_device_revoke(self) -> None:
        obj = self._json_body()
        if obj is None:
            self._error(400, "参数非法")
            return
        did = str(obj.get("device_id") or "").strip()
        if not did:
            self._error(400, "缺少 device_id")
            return
        if not isinstance(obj.get("revoked", True), bool):
            self._error(400, "revoked 需为布尔值")
            return
        rev = 1 if obj.get("revoked", True) else 0
        with self.server.db_lock:
            row = self.db.execute(
                "SELECT device_id FROM devices WHERE device_id = ?", (did,)).fetchone()
            if row is None:
                self._error(404, "设备不存在")
                return
            with self.db:
                self.db.execute("UPDATE devices SET revoked=? WHERE device_id=?",
                                (rev, did))
        self._audit(self._client_ip(), self.headers.get("User-Agent", ""), 0,
                    "device_revoke" if rev else "device_revoke_undo", did)
        self._json(200, {"ok": True, "device_id": did, "revoked": bool(rev)})

    def _api_device_reset_secret(self) -> None:
        """管理员清空设备 secret，让该设备用新 secret 重新注册（fleet 的恢复入口）。"""
        obj = self._json_body()
        if obj is None:
            self._error(400, "参数非法")
            return
        did = str(obj.get("device_id") or "").strip()
        if not did:
            self._error(400, "缺少 device_id")
            return
        with self.server.db_lock:
            row = self.db.execute(
                "SELECT device_id FROM devices WHERE device_id = ?", (did,)).fetchone()
            if row is None:
                self._error(404, "设备不存在")
                return
            with self.db:
                self.db.execute(
                    "UPDATE devices SET secret_enc = '', status = 'pending', "
                    "revoked = 0 WHERE device_id = ?", (did,))
        self._audit(self._client_ip(), self.headers.get("User-Agent", ""), 0,
                    "device_reset_secret", did)
        self._json(200, {"ok": True, "device_id": did, "status": "pending",
                         "action": "reset_secret"})
