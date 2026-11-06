"""HTTP 基类：日志、响应/重定向助手、客户端识别、审计、后台会话鉴权与路由分发。

路由分层（单向依赖 http → 领域 → config/db）：
* :class:`BaseHandler` 只做通用能力与 ``do_*`` 分发；
* ``/api/*`` 交给 :class:`cloud.http.api.ApiMixin`；
* ``/admin``、``/admin/api/*`` 交给 :class:`cloud.http.admin.AdminMixin`；
* 静态文件 / 登录页 / APK 下载 / 404 交给 :class:`cloud.http.static.StaticMixin`。

不变量：
* 所有响应都带 nosniff / DENY / no-referrer / HSTS，且 ``Cache-Control: no-store``（静态资源除外）；
* ``_pending_cookies`` 由 do_* 每轮重置，``_send`` / ``_redirect`` 负责落地并清空；
* 客户端 IP 只信任回环反代传来的 X-Real-IP / X-Forwarded-For。
"""

from __future__ import annotations

import json
import sqlite3
import sys
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse

from ..config import ADMIN_COOKIE, ADMIN_SESSION_TTL, now_str
from ..security import rate_ok, session_touch


class BaseHandler(BaseHTTPRequestHandler):
    """通用 HTTP 基类；具体路由由 api / admin / static 三个 mixin 提供。"""

    server_version = "ChargeCloud/1.0"
    timeout = 10

    db: sqlite3.Connection
    secret: str
    version_file: Path
    download_dir: Path
    web_dir: Path

    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write(f"[{self.log_date_time_string()}] {fmt % args}\n")

    def _send(self, code: int, body: bytes, ctype: str = "application/json; charset=utf-8",
              extra: dict | None = None, cache: str = "no-store") -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Strict-Transport-Security", "max-age=31536000")
        for line in getattr(self, "_pending_cookies", []):
            self.send_header("Set-Cookie", line)
        self._pending_cookies = []
        if extra:
            for key, value in extra.items():
                self.send_header(key, value)
        try:
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)
        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError, OSError):
            pass

    def _redirect(self, location: str, code: int = 302) -> None:
        self.send_response(code)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        for line in getattr(self, "_pending_cookies", []):
            self.send_header("Set-Cookie", line)
        self._pending_cookies = []
        self.end_headers()

    def _json(self, code: int, obj: object) -> None:
        self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"))

    def _error(self, code: int, msg: str) -> None:
        self._json(code, {"ok": False, "error": msg})

    def _client_ip(self) -> str:
        peer = self.client_address[0]
        if peer not in ("127.0.0.1", "::1"):
            return peer
        # 回环（经 nginx 反代）时才读转发头。
        # X-Real-IP 由 nginx 用 $remote_addr 覆盖，可信，优先。
        ip = self.headers.get("X-Real-IP")
        if ip:
            return ip.strip()
        # X-Forwarded-For 是追加语义：最右一项是「离我们最近一跳」写入的，
        # 最左才是客户端可任意伪造的。取最右，避免伪造绕过基于 IP 的限流。
        fwd = self.headers.get("X-Forwarded-For")
        if fwd:
            return fwd.split(",")[-1].strip()
        return peer

    def _audit(self, ip: str, ua: str, size: int, result: str, detail: str = "") -> None:
        try:
            with self.server.db_lock:
                self.db.execute(
                    "INSERT INTO upload_audit(ts, ip, ua, size, result, detail) VALUES (?,?,?,?,?,?)",
                    (now_str(), ip, ua[:120], size, result, detail[:200]))
                self.db.commit()
        except Exception:
            pass

    def _is_https(self) -> bool:
        """只有可信反代（回环）传来的 proto 才采信。"""
        peer = self.client_address[0]
        if peer in ("127.0.0.1", "::1"):
            proto = (self.headers.get("X-Forwarded-Proto") or "").split(",")[0].strip().lower()
            if proto:
                return proto == "https"
        cipher = getattr(self.request, "cipher", None)
        try:
            return bool(cipher and cipher())
        except Exception:
            return False

    def _cookie_line(self, token: str, max_age: int) -> str:
        line = (f"{ADMIN_COOKIE}={token}; Path=/; HttpOnly; SameSite=Lax; "
                f"Max-Age={max_age}")
        if self._is_https():
            line += "; Secure"
        return line

    def _client_cookie(self, name: str) -> str:
        raw = self.headers.get("Cookie") or ""
        for part in raw.split(";"):
            key, sep, value = part.strip().partition("=")
            if sep and key == name:
                return value.strip().strip('"')
        return ""

    def _admin_session(self) -> str:
        """校验 Cookie 会话；有效则滑动续期并写回 Cookie，返回 token，否则空串。"""
        token = self._client_cookie(ADMIN_COOKIE)
        if not token:
            return ""
        if not session_touch(token):
            self._pending_cookies.append(self._cookie_line("", 0))
            return ""
        self._pending_cookies.append(self._cookie_line(token, ADMIN_SESSION_TTL))
        return token

    def _admin_guard(self, api: bool) -> bool:
        if self._admin_session():
            return True
        if api:
            self._json(401, {"ok": False, "error": "unauthorized"})
        else:
            self._redirect("/admin/login")
        return False

    @staticmethod
    def _page_args(qs) -> tuple[int, int]:
        try:
            limit = max(1, min(int((qs.get("limit") or ["20"])[0]), 200))
            offset = max(0, int((qs.get("offset") or ["0"])[0]))
        except (TypeError, ValueError):
            limit, offset = 20, 0
        return limit, offset

    def _json_body(self, limit: int = 4096):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return None
        if length <= 0 or length > limit:
            return None
        try:
            data = json.loads(self.rfile.read(length).decode("utf-8"))
            return data if isinstance(data, dict) else None
        except Exception:
            return None

    def do_GET(self) -> None:  # noqa: N802
        self._pending_cookies: list = []
        parsed = urlparse(self.path)
        path = parsed.path
        ip = self._client_ip()
        if path == "/favicon.ico":
            self._send(204, b"", "image/x-icon")
            return
        if path == "/admin" or path.startswith("/admin/"):
            self._admin_get(parsed)
            return
        if path.startswith("/api/") and not rate_ok(ip, "get", 120, 60):
            self._json(429, {"ok": False, "error": "请求过于频繁"})
            return
        if self._api_get(parsed):
            return
        self._static_get(path)

    def do_HEAD(self) -> None:  # noqa: N802
        self.do_GET()

    def do_POST(self) -> None:  # noqa: N802
        self._pending_cookies: list = []
        parsed = urlparse(self.path)
        path = parsed.path
        if path == "/admin" or path.startswith("/admin/"):
            self._admin_post(path)
            return
        if self._api_post(path):
            return
        self._error(404, "not found")
