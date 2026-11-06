"""静态资源与登录页：前端产物、APK 下载、管理员登录/登出、兜底 404。

不变量：
* ``/assets/*`` 只放行单层文件名（拒绝 ``/``、``\\``、``..``），长缓存 immutable；
* 登录页是服务端渲染的独立 HTML（不带前端产物），登录失败按 IP 5 次/5 分钟限流；
* APK 下载文件名必须匹配 ``APK_NAME``，避免任意文件读取。
"""

from __future__ import annotations

import json
from html import escape as html_escape
from urllib.parse import parse_qs

from ..config import ADMIN_COOKIE, ADMIN_LOGIN_WINDOW, ADMIN_SESSION_TTL, APK_NAME
from ..security import (
    admin_configured,
    admin_credentials_ok,
    login_allowed,
    login_clear_failures,
    login_record_failure,
    session_drop,
    session_login,
    verify_password,
)


def login_page(error: str = "") -> bytes:
    err = f'<p class="err">{html_escape(error)}</p>' if error else ""
    page = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>充电桩 · 管理员登录</title>
<style>
  :root {
    --page-bg: linear-gradient(160deg, #0f766e 0%, #065f46 55%, #042f2e 100%);
    --card: #ffffff; --text: #0f172a; --text-2: #475569; --text-3: #475569;
    --border: #e2e8f0; --input-border: #cbd5e1; --primary: #059669;
    --primary-strong: #047857; --danger-bg: #fee2e2; --danger-fg: #b91c1c;
    --logo-bg: #d1fae5; --shadow: 0 20px 60px rgba(2, 44, 34, .38);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --page-bg: linear-gradient(160deg, #042f2e 0%, #052e2b 55%, #020f0d 100%);
      --card: #111c2b; --text: #f1f5f9; --text-2: #cbd5e1; --text-3: #94a3b8;
      --border: #1e293b; --input-border: #334155; --primary: #34d399;
      --primary-strong: #10b981; --danger-bg: #3f1d1d; --danger-fg: #fca5a5;
      --logo-bg: #053b31; --shadow: 0 20px 60px rgba(0, 0, 0, .5);
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center;
         justify-content: center; padding: 24px 16px;
         background: var(--page-bg);
         font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
         color: var(--text); }
  .card { width: 350px; max-width: 100%; background: var(--card); border-radius: 18px;
          padding: 28px 26px 22px; border: 1px solid var(--border);
          box-shadow: var(--shadow); }
  .brand { display: flex; align-items: center; gap: 10px; }
  .logo { width: 36px; height: 36px; border-radius: 11px; background: var(--logo-bg);
          display: flex; align-items: center; justify-content: center; font-size: 19px; }
  h1 { font-size: 17px; margin: 0; letter-spacing: .3px; }
  .sub { color: var(--text-3); font-size: 12.5px; margin: 12px 0 18px; }
  label { display: block; font-size: 12.5px; color: var(--text-2); margin-bottom: 13px; }
  input { width: 100%; min-height: 44px; margin-top: 6px; padding: 10px 12px;
          border: 1px solid var(--input-border); border-radius: 10px; font-size: 14px;
          outline: none; background: var(--card); color: var(--text);
          transition: border-color .15s, box-shadow .15s; }
  input:focus { border-color: var(--primary); box-shadow: 0 0 0 3px rgba(16, 185, 129, .16); }
  button { width: 100%; min-height: 44px; border: 0; border-radius: 10px; padding: 11px;
           margin-top: 4px; background: var(--primary); color: #fff; font-size: 14.5px;
           font-weight: 600; cursor: pointer; transition: background .15s; }
  button:hover { background: var(--primary-strong); }
  .err { background: var(--danger-bg); color: var(--danger-fg); font-size: 12.5px;
         border-radius: 9px; padding: 9px 12px; margin: 0 0 13px; line-height: 1.5; }
  .foot { margin: 16px 0 0; text-align: center; color: var(--text-3); font-size: 11.5px; }
  button:focus-visible, input:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
</style>
</head>
<body>
<main class="card">
  <div class="brand"><span class="logo">⚡</span><h1>充电桩数据后台</h1></div>
  <p class="sub">请使用管理员账号登录</p>
  __ERROR__
  <form method="post" action="/admin/login" autocomplete="on">
    <label>用户名<input name="user" autocomplete="username" required autofocus></label>
    <label>密码<input name="password" type="password" autocomplete="current-password" required></label>
    <button type="submit">登 录</button>
  </form>
  <p class="foot">Cookie 会话 · 12 小时有效 · 仅限授权管理员</p>
</main>
</body>
</html>
"""
    return page.replace("__ERROR__", err).encode("utf-8")


class StaticMixin:
    """静态资源 / 登录页 / APK 下载 / 兜底 404（与 BaseHandler 混入使用）。"""

    def _login_page(self, error: str = "", code: int = 200,
                    extra: dict | None = None) -> None:
        if not admin_configured():
            error = error or "服务端未配置管理员账号（ADMIN_USER / ADMIN_PASS）"
        self._send(code, login_page(error), "text/html; charset=utf-8", extra)

    def _login_submit(self) -> None:
        ip = self._client_ip()
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            self._login_page("请求格式非法", 400)
            return
        if length <= 0 or length > 8192:
            self._login_page("请求体为空或过大" if length > 8192 else "请输入用户名和密码", 400)
            return
        raw = self.rfile.read(length)
        ctype = (self.headers.get("Content-Type") or "").lower()
        user = password = ""
        try:
            if "application/json" in ctype:
                obj = json.loads(raw.decode("utf-8")) or {}
                user = str(obj.get("user") or "")
                password = str(obj.get("password") or "")
            else:
                form = parse_qs(raw.decode("utf-8", "replace"), keep_blank_values=True)
                user = (form.get("user") or [""])[0]
                password = (form.get("password") or [""])[0]
        except Exception:
            self._login_page("请求格式非法", 400)
            return
        if not login_allowed(ip):
            self._login_page("尝试过于频繁，请 5 分钟后再试", 429,
                             {"Retry-After": str(ADMIN_LOGIN_WINDOW)})
            return
        if not admin_configured():
            self._login_page("服务端未配置管理员账号", 503)
            return
        ok = False
        try:
            row = self.db.execute(
                "SELECT pass_hash, disabled FROM admin_users WHERE username = ?",
                (user,)).fetchone()
            ok = bool(row and not row[1] and verify_password(password, row[0]))
        except Exception:
            ok = False
        if not ok:
            try:
                has_users = self.db.execute(
                    "SELECT COUNT(*) FROM admin_users").fetchone()[0] > 0
            except Exception:
                has_users = False
            if not has_users:
                ok = admin_credentials_ok(user, password)
        if not user or not password or not ok:
            login_record_failure(ip)
            self._login_page("用户名或密码错误", 401)
            return
        login_clear_failures(ip)
        token = session_login(user)
        self._pending_cookies.append(self._cookie_line(token, ADMIN_SESSION_TTL))
        self._redirect("/admin")

    def _logout(self) -> None:
        token = self._client_cookie(ADMIN_COOKIE)
        session_drop(token)
        self._pending_cookies.append(self._cookie_line("", 0))
        self._redirect("/admin/login")

    def _static_get(self, path: str) -> None:
        """静态资源与兜底路由：命中直接发响应，未命中 404。"""
        if path.startswith("/assets/"):
            name = path[len("/assets/"):]
            if not name or "/" in name or "\\" in name or ".." in name:
                self._error(404, "not found")
                return
            try:
                data = (self.web_dir / "assets" / name).read_bytes()
            except OSError:
                self._error(404, "not found")
                return
            ctype = ("text/css" if name.endswith(".css") else
                     "application/javascript; charset=utf-8")
            self._send(200, data, ctype,
                       cache="public, max-age=31536000, immutable")
            return
        if path in ("/", "/index.html"):
            try:
                self._send(200, (self.web_dir / "index.html").read_bytes(),
                           "text/html; charset=utf-8")
            except OSError:
                self._error(500, "页面缺失")
            return

        if path.startswith("/download/"):
            name = path[len("/download/"):]
            if not APK_NAME.match(name):
                self._error(404, "not found")
                return
            try:
                data = (self.download_dir / name).read_bytes()
            except OSError:
                self._error(404, "not found")
                return
            self._send(200, data, "application/vnd.android.package-archive")

        self._error(404, "not found")
