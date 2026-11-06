"""云端上传接口测试：签名、时间窗、重放、版本、下载与管理后台网页登录。"""

from __future__ import annotations

import base64
import contextlib
import hashlib
import hmac
import json
import math
import re
import secrets
import sqlite3
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import patch

from cloud.app import create_server


def sign(secret: str, ts: str, nonce: str, body: bytes) -> str:
    return hmac.new(secret.encode(), ts.encode() + b"\n" + nonce.encode() + b"\n" + body,
                    hashlib.sha256).hexdigest()


class NoRedirect(urllib.request.HTTPRedirectHandler):
    """测试里自己处理 302，避免 urllib 自动跟随。"""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class CloudTest(unittest.TestCase):
    def setUp(self) -> None:
        from cloud import app as cloud_app
        cloud_app.RATE.clear()
        cloud_app.ANALYTICS_CACHE.clear()
        cloud_app.SESSIONS.clear()
        cloud_app.AREA_PORT_LAST.clear()
        cloud_app.CONTROLLERS_CACHE.clear()
        cloud_app.AREAS_PORTS_CACHE.clear()
        cloud_app.WORKER_STATE.update(last_run=None, last_result=None, runs=0)
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        key_file = root / "token_key"
        key_file.write_text("11" * 32, encoding="ascii")
        cloud_app.TOKEN_KEY_FILE = str(key_file)
        self.secret = secrets.token_hex(32)
        (root / "secret.txt").write_text(self.secret, encoding="utf-8")
        (root / "version.json").write_text(
            json.dumps({"versionCode": 14, "versionName": "2.3"}), encoding="utf-8")
        (root / "download").mkdir()
        (root / "download" / "app-v2.3.apk").write_bytes(b"APKDATA")
        web = root / "web"
        web.mkdir()
        (web / "admin.html").write_text(
            '<!DOCTYPE html><html><body><div id="app"></div></body></html>',
            encoding="utf-8")
        self.httpd = create_server(root / "charge.db", root / "secret.txt",
                                   root / "version.json", root / "download",
                                   "127.0.0.1", 0, web_dir=web, workers=False)
        self.httpd.RequestHandlerClass.db.execute(
            "UPDATE app_settings SET value='off' WHERE key='device_approval'")
        self.httpd.RequestHandlerClass.db.commit()
        self.port = self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.opener = urllib.request.build_opener(NoRedirect)
        self.device_id = "a" * 32
        self.device_secret = "b" * 64
        reg = json.dumps({"device_id": self.device_id,
                          "secret": self.device_secret}).encode()
        req = urllib.request.Request(self.url("/api/device/register"), data=reg,
                                     method="POST",
                                     headers={"Content-Type": "application/json"})
        urllib.request.urlopen(req, timeout=5).close()

    def tearDown(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()
        try:
            self.httpd.RequestHandlerClass.db.close()
        except Exception:
            pass
        self.tmp.cleanup()

    def url(self, path: str) -> str:
        return f"http://127.0.0.1:{self.port}{path}"

    def post(self, body: bytes, *, ts: str | None = None, nonce: str | None = None,
             sig: str | None = None):
        return self.post_as(self.device_id, self.device_secret, body,
                            ts=ts, nonce=nonce, sig=sig)

    def post_as(self, device_id: str, device_secret: str, body: bytes, *,
                ts: str | None = None, nonce: str | None = None,
                sig: str | None = None):
        ts = ts or str(int(time.time()))
        nonce = nonce or secrets.token_hex(8)
        sig = sig if sig is not None else sign(device_secret, ts, nonce, body)
        req = urllib.request.Request(
            self.url("/api/snapshot"), data=body, method="POST",
            headers={"Content-Type": "application/json", "X-Device-Id": device_id,
                     "X-Charge-Timestamp": ts,
                     "X-Charge-Nonce": nonce, "X-Charge-Signature": sig})
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                return resp.status, json.loads(resp.read())
        except urllib.error.HTTPError as exc:
            return exc.code, json.loads(exc.read())

    def register(self, device_id: str, secret: str):
        body = json.dumps({"device_id": device_id, "secret": secret}).encode()
        req = urllib.request.Request(self.url("/api/device/register"), data=body,
                                     method="POST",
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status, json.loads(resp.read())

    @staticmethod
    def payload() -> bytes:
        return json.dumps({
            "captured_at": "2026-10-31 23:00:00", "project": "纺织大学阳光校区",
            "app_version": "2.3", "token_user": "12345678",
            "areas": [{"id": "1", "name": "6号充电区", "address": "x",
                       "total_port": 16, "idle_port": 7, "charging_port": 9, "fault_port": 0}],
        }, ensure_ascii=False).encode()

    # ------------------------------------------------------------------
    # 管理后台测试辅助
    # ------------------------------------------------------------------
    @contextlib.contextmanager
    def admin_env(self, user: str = "t", password: str = "t", pass_hash: str = ""):
        from cloud import app as cloud_app
        old = (cloud_app.ADMIN_USER, cloud_app.ADMIN_PASS, cloud_app.ADMIN_PASS_HASH)
        cloud_app.ADMIN_USER = user
        cloud_app.ADMIN_PASS = password
        cloud_app.ADMIN_PASS_HASH = pass_hash
        try:
            yield
        finally:
            cloud_app.ADMIN_USER, cloud_app.ADMIN_PASS, cloud_app.ADMIN_PASS_HASH = old

    def _open(self, req):
        try:
            with self.opener.open(req, timeout=5) as resp:
                return resp.status, resp.headers, resp.read()
        except urllib.error.HTTPError as exc:
            try:
                body = exc.read()
                return exc.code, exc.headers, body
            finally:
                exc.close()

    def admin_req(self, path: str, *, token: str = "", data: bytes | None = None,
                  method: str | None = None, headers: dict | None = None):
        hdrs = dict(headers or {})
        if token:
            hdrs["Cookie"] = f"charge_admin={token}"
        req = urllib.request.Request(self.url(path), data=data, method=method,
                                     headers=hdrs)
        return self._open(req)

    def admin_login(self, user: str = "t", password: str = "t"):
        body = urllib.parse.urlencode({"user": user, "password": password}).encode()
        return self.admin_req("/admin/login", data=body, method="POST",
                              headers={"Content-Type": "application/x-www-form-urlencoded"})

    def admin_json(self, path: str, payload: dict, token: str = ""):
        return self.admin_req(path, token=token, method="POST",
                              data=json.dumps(payload).encode(),
                              headers={"Content-Type": "application/json"})

    @staticmethod
    def session_cookie(headers) -> str:
        match = re.search(r"charge_admin=([0-9a-f]{32})",
                          headers.get("Set-Cookie") or "")
        return match.group(1) if match else ""

    def admin_token(self, user: str = "t", password: str = "t") -> str:
        code, headers, _ = self.admin_login(user, password)
        self.assertEqual(code, 302)
        token = self.session_cookie(headers)
        self.assertTrue(token)
        return token

    @staticmethod
    def area(name: str, idle: int, total: int = 10) -> dict:
        return {"id": name, "name": name, "address": "x",
                "total_port": total, "idle_port": idle,
                "charging_port": total - idle, "fault_port": 0}

    def upload_areas(self, *areas: dict) -> None:
        payload = {"captured_at": "2026-10-31 23:00:00",
                   "project": "纺织大学阳光校区", "app_version": "2.3",
                   "areas": list(areas)}
        code, resp = self.post(json.dumps(payload, ensure_ascii=False).encode())
        self.assertEqual(code, 200, resp)

    # ------------------------------------------------------------------
    # 端口上传测试辅助
    # ------------------------------------------------------------------
    def add_controller(self, device_hex: str = "00AFEC05", code: str | None = "10001",
                       area_name: str = "6号充电区",
                       updated_at: str = "2026-01-01 00:00:00") -> None:
        with self.httpd.db_lock:
            conn = self.httpd.RequestHandlerClass.db
            conn.execute(
                "INSERT INTO controllers(device_hex, code, area_id, area_name, "
                "updated_at) VALUES (?,?,?,?,?) ON CONFLICT(device_hex) DO UPDATE "
                "SET code=excluded.code, area_name=excluded.area_name, "
                "updated_at=excluded.updated_at",
                (device_hex, code, "aid1", area_name, updated_at))
            conn.commit()

    def ports_body(self, ports, areas: list | None = None) -> bytes:
        payload = {
            "captured_at": "2026-10-31 23:00:00",
            "project": "纺织大学阳光校区", "app_version": "2.3",
            "areas": areas if areas is not None else
            [self.area("6号充电区", idle=7, total=16)],
            "ports": ports,
        }
        return json.dumps(payload, ensure_ascii=False).encode()

    @staticmethod
    def port_list(*statuses: str) -> list[dict]:
        return [{"port": "%02d" % (index + 1), "status": status}
                for index, status in enumerate(statuses)]

    def db_rows(self, sql: str, params: tuple = ()) -> list:
        with self.httpd.db_lock:
            return self.httpd.RequestHandlerClass.db.execute(sql, params).fetchall()

    def last_audit(self) -> tuple:
        return self.db_rows(
            "SELECT result, detail FROM upload_audit ORDER BY id DESC LIMIT 1")[0]

    def controller_updated_at(self, device_hex: str = "00AFEC05") -> str | None:
        row = self.db_rows(
            "SELECT updated_at FROM controllers WHERE device_hex = ?",
            (device_hex,))
        return row[0][0] if row else None

    # ------------------------------------------------------------------
    # token 池 / 端口采样测试辅助
    # ------------------------------------------------------------------
    @staticmethod
    def make_token(user_id: str = "12345", ttl: int = 3600) -> str:
        claims = {"aud": "quick_user_api", "exp": int(time.time()) + ttl,
                  "encryId": base64.b64encode(user_id.encode()).decode()}
        middle = base64.urlsafe_b64encode(
            json.dumps(claims).encode()).decode().rstrip("=")
        return "eyJhbGciOiJub25lIn0." + middle + ".sig"

    def upload_token(self, user_id: str = "12345", ttl: int = 3600) -> str:
        payload = json.loads(self.payload())
        token = self.make_token(user_id, ttl)
        payload["token"] = token
        code, resp = self.post(json.dumps(payload).encode())
        self.assertEqual(code, 200, resp)
        return token

    def add_pool_token(self, user_id: str, ttl: int = 3600,
                       last_error: str | None = None) -> str:
        """直接写池（加密后落库），返回明文 token。"""
        from cloud import app as cloud_app
        token = self.make_token(user_id, ttl)
        with self.httpd.db_lock:
            conn = self.httpd.RequestHandlerClass.db
            conn.execute(
                "INSERT INTO token_pool(user_id, token, expires_at, updated_at, "
                "source, last_error) VALUES (?,?,?,?,?,?)",
                (user_id, cloud_app.encrypt_token(token),
                 int(time.time()) + ttl, time.strftime("%Y-%m-%d %H:%M:%S"),
                 "test", last_error))
            conn.commit()
        return token

    def get_json(self, path: str) -> dict:
        with urllib.request.urlopen(self.url(path), timeout=5) as resp:
            return json.loads(resp.read())

    def post_ports(self, device_hex: str = "00AFEC05",
                   *statuses: str) -> None:
        code, resp = self.post(self.ports_body(
            [{"device_hex": device_hex, "ports": self.port_list(*statuses)}]))
        self.assertEqual(code, 200, resp)

    @staticmethod
    def stamp_at(hour: int, minutes: int = 0) -> str:
        base = datetime.now().replace(hour=hour, minute=minutes, second=0,
                                      microsecond=0)
        return base.strftime("%Y-%m-%d %H:%M:%S")

    def add_area_sample(self, hour: int, idle: int, total: int = 10,
                        minutes: int = 0) -> None:
        with self.httpd.db_lock:
            conn = self.httpd.RequestHandlerClass.db
            conn.execute(
                "INSERT INTO area_samples(snapshot_id, area_id, area_name, idle, "
                "total, charging, fault, received_at) VALUES (?,?,?,?,?,?,?,?)",
                (1, "aid1", "6号充电区", idle, total, total - idle, 0,
                 self.stamp_at(hour, minutes)))
            conn.commit()

    def add_now_snapshot(self, areas, sample_age: timedelta | None = None) -> int:
        """直接造一条最新快照（当前时间），区域样本时间默认 1 天前，避免污染 30 分钟趋势。"""
        stamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        sample_stamp = (datetime.now() - (sample_age or timedelta(days=1))).strftime(
            "%Y-%m-%d %H:%M:%S")
        with self.httpd.db_lock:
            conn = self.httpd.RequestHandlerClass.db
            cur = conn.execute(
                "INSERT INTO snapshots(received_at, captured_at, project, app_version, "
                "token_user, client_ip, body_sha256, payload) VALUES (?,?,?,?,?,?,?,?)",
                (stamp, stamp, "P", "server", "", "server",
                 secrets.token_hex(16), "{}"))
            sid = cur.lastrowid
            for name, idle, total in areas:
                conn.execute(
                    "INSERT INTO area_samples(snapshot_id, area_id, area_name, idle, "
                    "total, charging, fault, received_at) VALUES (?,?,?,?,?,?,?,?)",
                    (sid, "aid-" + name, name, idle, total, total - idle, 0,
                     sample_stamp))
            conn.commit()
        return sid

    def insert_area_sample(self, name: str, received_at: str, idle: int,
                           total: int = 10) -> None:
        with self.httpd.db_lock:
            conn = self.httpd.RequestHandlerClass.db
            conn.execute(
                "INSERT INTO area_samples(snapshot_id, area_id, area_name, idle, "
                "total, charging, fault, received_at) VALUES (?,?,?,?,?,?,?,?)",
                (999, "aid-" + name, name, idle, total, total - idle, 0,
                 received_at))
            conn.commit()

    # ------------------------------------------------------------------
    # 上传链路
    # ------------------------------------------------------------------
    def test_valid_upload_and_latest(self) -> None:
        code, body = self.post(self.payload())
        self.assertEqual(code, 200)
        self.assertTrue(body["ok"])
        with urllib.request.urlopen(self.url("/api/latest"), timeout=5) as resp:
            latest = json.loads(resp.read())
        self.assertEqual(latest["snapshot"]["areas"][0]["name"], "6号充电区")

    def test_overview_history_analytics(self) -> None:
        self.assertEqual(self.post(self.payload())[0], 200)
        with urllib.request.urlopen(self.url("/api/overview"), timeout=5) as resp:
            overview = json.loads(resp.read())
        self.assertEqual(overview["uploads"], 1)
        self.assertEqual(overview["snapshot"]["areas"][0]["name"], "6号充电区")
        area = urllib.parse.quote("6号充电区")
        with urllib.request.urlopen(self.url("/api/history?area=" + area), timeout=5) as resp:
            history = json.loads(resp.read())
        self.assertEqual(len(history["rows"]), 1)
        with urllib.request.urlopen(self.url("/api/analytics"), timeout=5) as resp:
            analytics = json.loads(resp.read())
        self.assertEqual(analytics["samples"], 1)
        self.assertEqual(len(analytics["heatmap"]), 7)
        self.assertEqual(len(analytics["ranking"]), 1)

    def test_rate_limit(self) -> None:
        codes = [self.post(self.payload())[0] for _ in range(13)]
        self.assertEqual(codes[-1], 429)

    def test_token_upload(self) -> None:
        payload = json.loads(self.payload())
        enc = base64.b64encode(b"12345").decode()
        claims = {"aud": "quick_user_api", "exp": int(time.time()) + 3600,
                  "encryId": enc}
        body_mid = base64.urlsafe_b64encode(
            json.dumps(claims).encode()).decode().rstrip("=")
        payload["token"] = "eyJhbGciOiJub25lIn0." + body_mid + ".sig"
        code, resp = self.post(json.dumps(payload).encode())
        self.assertEqual(code, 200)
        conn = self.httpd.RequestHandlerClass.db
        count = conn.execute("SELECT COUNT(*) FROM tokens").fetchone()[0]
        self.assertEqual(count, 1)

    def test_device_register_and_upload(self) -> None:
        did = "0123456789abcdef"
        secret = "a" * 64
        body = json.dumps({"device_id": did, "secret": secret}).encode()
        req = urllib.request.Request(self.url("/api/device/register"), data=body,
                                     method="POST",
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=5) as resp:
            self.assertEqual(resp.status, 200)
        ts = str(int(time.time()))
        nonce = secrets.token_hex(8)
        raw = self.payload()
        sig = hmac.new(secret.encode(), ts.encode() + b"\n" + nonce.encode()
                       + b"\n" + raw, hashlib.sha256).hexdigest()
        req = urllib.request.Request(
            self.url("/api/snapshot"), data=raw, method="POST",
            headers={"Content-Type": "application/json", "X-Device-Id": did,
                     "X-Charge-Timestamp": ts, "X-Charge-Nonce": nonce,
                     "X-Charge-Signature": sig})
        with urllib.request.urlopen(req, timeout=5) as resp:
            self.assertEqual(resp.status, 200)

    def test_upload_unknown_area_400(self) -> None:
        # 首次上传把「6号充电区」登记进 areas
        self.assertEqual(self.post(self.payload())[0], 200)
        body = json.loads(self.payload())
        body["areas"][0]["name"] = "火星充电区"
        code, resp = self.post(json.dumps(body, ensure_ascii=False).encode())
        self.assertEqual(code, 400)
        self.assertEqual(resp["error"], "未知充电区")
        with self.httpd.db_lock:
            row = self.httpd.RequestHandlerClass.db.execute(
                "SELECT result FROM upload_audit ORDER BY id DESC LIMIT 1").fetchone()
        self.assertEqual(row[0], "invalid")

    def test_upload_conservation_400(self) -> None:
        body = json.loads(self.payload())
        body["areas"][0]["fault_port"] = 2  # 7 + 9 + 2 != 16
        code, resp = self.post(json.dumps(body, ensure_ascii=False).encode())
        self.assertEqual(code, 400)
        self.assertEqual(resp["error"], "数据不守恒")
        with self.httpd.db_lock:
            row = self.httpd.RequestHandlerClass.db.execute(
                "SELECT result FROM upload_audit ORDER BY id DESC LIMIT 1").fetchone()
        self.assertEqual(row[0], "invalid")

    def test_bad_signature_401(self) -> None:
        code, _ = self.post(self.payload(), sig="0" * 64)
        self.assertEqual(code, 401)

    def test_stale_timestamp_401(self) -> None:
        code, _ = self.post(self.payload(), ts=str(int(time.time()) - 3600))
        self.assertEqual(code, 401)

    def test_replay_nonce_409(self) -> None:
        body = self.payload()
        ts = str(int(time.time()))
        nonce = secrets.token_hex(8)
        self.assertEqual(self.post(body, ts=ts, nonce=nonce)[0], 200)
        self.assertEqual(self.post(body, ts=ts, nonce=nonce)[0], 409)

    def test_invalid_payload_400(self) -> None:
        code, _ = self.post(b'{"areas": []}')
        self.assertEqual(code, 400)

    # ------------------------------------------------------------------
    # 端口上传校验（H1/M1/M3/M5）
    # ------------------------------------------------------------------
    def test_upload_ports_ok_dedup_and_queryable(self) -> None:
        self.add_controller()
        ports = [{"device_hex": "00AFEC05", "ports": [
            {"port": "01", "status": " 空闲 "},
            {"port": "02", "status": "充电中"},
            {"port": "01", "status": "故障"},
        ]}]
        code, resp = self.post(self.ports_body(ports))
        self.assertEqual(code, 200, resp)
        self.assertTrue(resp["ok"])
        rows = self.db_rows(
            "SELECT port, status FROM port_states WHERE device_hex = ? "
            "ORDER BY port", ("00AFEC05",))
        self.assertEqual(rows, [("01", "故障"), ("02", "充电中")])
        self.assertNotEqual(self.controller_updated_at(), "2026-01-01 00:00:00")
        self.assertEqual(self.last_audit()[0], "ok")
        # 通过公开接口也能查到端口
        area = urllib.parse.quote("6号充电区")
        with urllib.request.urlopen(self.url("/api/area-ports?area=" + area),
                                    timeout=5) as resp_obj:
            data = json.loads(resp_obj.read())
        self.assertEqual(data["devices"][0]["device_hex"], "00AFEC05")
        self.assertEqual(data["devices"][0]["ports"],
                         [{"port": "01", "status": "故障", "group": "unavailable"},
                          {"port": "02", "status": "充电中", "group": "busy"}])

    def test_upload_ports_unknown_device_400_no_write(self) -> None:
        self.add_controller()
        body = self.ports_body([{"device_hex": "DEADBEEF", "ports":
                                 self.port_list("空闲")}])
        ts = str(int(time.time()))
        nonce = secrets.token_hex(8)
        code, resp = self.post(body, ts=ts, nonce=nonce)
        self.assertEqual(code, 400)
        self.assertEqual(resp["error"], "端口数据非法")
        self.assertEqual(self.db_rows("SELECT COUNT(*) FROM snapshots")[0][0], 0)
        self.assertEqual(self.db_rows("SELECT COUNT(*) FROM port_states")[0][0], 0)
        self.assertEqual(self.db_rows("SELECT COUNT(*) FROM areas")[0][0], 0)
        self.assertEqual(self.controller_updated_at(), "2026-01-01 00:00:00")
        result, detail = self.last_audit()
        self.assertEqual(result, "invalid_ports")
        self.assertIn("DEADBEEF", detail)
        # 校验失败不消耗 nonce：同一 ts/nonce 换成合法设备仍可成功
        good = self.ports_body([{"device_hex": "00AFEC05", "ports":
                                 self.port_list("空闲")}])
        code, resp = self.post(good, ts=ts, nonce=nonce)
        self.assertEqual(code, 200, resp)

    def test_upload_ports_malformed_types_400(self) -> None:
        self.add_controller()
        for ports in (5, {}, "abc", [5],
                      [{"device_hex": 123, "ports": []}],
                      [{"device_hex": "00AFEC05", "ports": 5}],
                      [{"device_hex": "00AFEC05", "ports": [5]}]):
            code, resp = self.post(self.ports_body(ports))
            self.assertEqual(code, 400, ports)
            self.assertEqual(resp["error"], "端口数据非法", ports)
            self.assertEqual(self.last_audit()[0], "invalid_ports", ports)
        self.assertEqual(self.db_rows("SELECT COUNT(*) FROM snapshots")[0][0], 0)

    def test_upload_ports_field_rules_400(self) -> None:
        self.add_controller()
        long_port = [{"device_hex": "00AFEC05", "ports":
                      [{"port": "123456789", "status": "空闲"}]}]
        bad_char_port = [{"device_hex": "00AFEC05", "ports":
                          [{"port": "01/2", "status": "空闲"}]}]
        long_status = [{"device_hex": "00AFEC05", "ports":
                        [{"port": "01", "status": "x" * 17}]}]
        too_many = [{"device_hex": "00AFEC05", "ports":
                     [{"port": "%02d" % i, "status": "空闲"} for i in range(33)]}]
        too_many_items = [{"device_hex": "00AFEC05",
                           "ports": [{"port": "01", "status": "空闲"}]}] * 501
        cases = {"long_port": long_port, "bad_char_port": bad_char_port,
                 "long_status": long_status, "too_many": too_many,
                 "too_many_items": too_many_items}
        for name, ports in cases.items():
            code, resp = self.post(self.ports_body(ports))
            self.assertEqual(code, 400, name)
            self.assertEqual(resp["error"], "端口数据非法", name)
            self.assertEqual(self.last_audit()[0], "invalid_ports", name)
        self.assertEqual(self.db_rows("SELECT COUNT(*) FROM snapshots")[0][0], 0)
        self.assertEqual(self.db_rows("SELECT COUNT(*) FROM port_states")[0][0], 0)

    def test_upload_ports_boundary_ok(self) -> None:
        self.add_controller()
        ports = [{"device_hex": "00AFEC05", "ports":
                  [{"port": "%02d" % i, "status": "空闲"} for i in range(32)]}]
        code, resp = self.post(self.ports_body(ports))
        self.assertEqual(code, 200, resp)
        self.assertEqual(self.db_rows("SELECT COUNT(*) FROM port_states")[0][0], 32)

    def test_upload_duplicate_area_400(self) -> None:
        same = self.area("6号充电区", idle=7, total=16)
        body = self.ports_body([], areas=[same, dict(same)])
        code, resp = self.post(body)
        self.assertEqual(code, 400)
        self.assertEqual(resp["error"], "区域重复")
        self.assertEqual(self.db_rows("SELECT COUNT(*) FROM snapshots")[0][0], 0)
        self.assertEqual(self.db_rows("SELECT COUNT(*) FROM areas")[0][0], 0)
        self.assertEqual(self.last_audit()[0], "invalid")

    def test_upload_empty_ports_updates_updated_at(self) -> None:
        stamp = "2026-01-01 00:00:00"
        self.add_controller(updated_at=stamp)
        code, resp = self.post(self.ports_body([]))
        self.assertEqual(code, 200, resp)
        code, resp = self.post(self.ports_body(
            [{"device_hex": "00AFEC05", "ports": []}]))
        self.assertEqual(code, 200, resp)
        self.assertNotEqual(self.controller_updated_at(), stamp)
        self.assertEqual(self.db_rows("SELECT COUNT(*) FROM port_states")[0][0], 0)
        # 真有端口时才刷新更新时间
        code, resp = self.post(self.ports_body(
            [{"device_hex": "00AFEC05", "ports": self.port_list("空闲")}]))
        self.assertEqual(code, 200, resp)
        self.assertNotEqual(self.controller_updated_at(), stamp)

    def test_version_and_download(self) -> None:
        with urllib.request.urlopen(self.url("/api/version"), timeout=5) as resp:
            self.assertEqual(json.loads(resp.read())["versionCode"], 14)
        with urllib.request.urlopen(self.url("/download/app-v2.3.apk"), timeout=5) as resp:
            self.assertEqual(resp.read(), b"APKDATA")
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            urllib.request.urlopen(self.url("/download/../secret.txt"), timeout=5)
        self.assertEqual(ctx.exception.code, 404)

    # ------------------------------------------------------------------
    # 管理后台：网页登录 + Cookie 会话
    # ------------------------------------------------------------------
    def test_admin_requires_login(self) -> None:
        with self.admin_env():
            code, headers, _ = self.admin_req("/admin")
            self.assertEqual(code, 302)
            self.assertEqual(headers["Location"], "/admin/login")
            code, headers, _ = self.admin_req("/admin/")
            self.assertEqual(code, 302)
            self.assertEqual(headers["Location"], "/admin/login")
            code, headers, body = self.admin_req("/admin/login")
            self.assertEqual(code, 200)
            page = body.decode("utf-8")
            self.assertIn('name="user"', page)
            self.assertIn('name="password"', page)
            self.assertIn('action="/admin/login"', page)
            for path in ("/admin/api/summary", "/admin/api/audit",
                         "/admin/api/server-snapshots", "/admin/api/devices",
                         "/admin/api/tokens", "/admin/api/system"):
                code, _, body = self.admin_req(path)
                self.assertEqual(code, 401, path)
                self.assertEqual(json.loads(body)["error"], "unauthorized", path)
            code, headers, _ = self.admin_req(
                "/admin/api/device/revoke", data=b"{}", method="POST",
                headers={"Content-Type": "application/json"})
            self.assertEqual(code, 401)

    def test_admin_login_logout_session(self) -> None:
        from cloud import app as cloud_app
        with self.admin_env():
            code, _, body = self.admin_login("t", "bad")
            self.assertEqual(code, 401)
            self.assertIn("用户名或密码错误", body.decode("utf-8"))
            self.assertNotIn("charge_admin", body.decode("utf-8"))

            code, headers, _ = self.admin_login("t", "t")
            self.assertEqual(code, 302)
            self.assertEqual(headers["Location"], "/admin")
            set_cookie = headers["Set-Cookie"]
            self.assertIn("HttpOnly", set_cookie)
            self.assertIn("SameSite=Lax", set_cookie)
            token = self.session_cookie(headers)
            self.assertRegex(token, r"^[0-9a-f]{32}$")

            code, _, body = self.admin_req("/admin", token=token)
            self.assertEqual(code, 200)
            self.assertIn(b'id="app"', body)

            # 带斜杠的 /admin/ 归一化，保证相对 assets 路径正确
            code, headers, _ = self.admin_req("/admin/", token=token)
            self.assertEqual(code, 302)
            self.assertEqual(headers["Location"], "/admin")

            # 已登录访问登录页直接回后台
            code, headers, _ = self.admin_req("/admin/login", token=token)
            self.assertEqual(code, 302)
            self.assertEqual(headers["Location"], "/admin")

            # 滑动续期：把过期时间压到 5 秒后，再访问应续到 12 小时
            with cloud_app.SESSION_LOCK:
                cloud_app.SESSIONS[token]["expires"] = time.time() + 5
            code, headers, body = self.admin_req("/admin/api/summary", token=token)
            self.assertEqual(code, 200)
            self.assertTrue(json.loads(body)["ok"])
            self.assertIn("Max-Age=43200", headers.get("Set-Cookie") or "")
            with cloud_app.SESSION_LOCK:
                self.assertGreater(cloud_app.SESSIONS[token]["expires"],
                                   time.time() + 3600)

            # 退出登录：清会话并回登录页
            code, headers, _ = self.admin_req("/admin/logout", token=token,
                                              data=b"", method="POST")
            self.assertEqual(code, 302)
            self.assertEqual(headers["Location"], "/admin/login")
            self.assertIn("Max-Age=0", headers["Set-Cookie"])
            code, _, _ = self.admin_req("/admin/api/summary", token=token)
            self.assertEqual(code, 401)

            # 过期会话同样 401
            code, headers, _ = self.admin_login("t", "t")
            token2 = self.session_cookie(headers)
            with cloud_app.SESSION_LOCK:
                cloud_app.SESSIONS[token2]["expires"] = time.time() - 1
            code, _, _ = self.admin_req("/admin/api/devices", token=token2)
            self.assertEqual(code, 401)

    def test_admin_login_rate_limit(self) -> None:
        with self.admin_env():
            for _ in range(5):
                code, _, _ = self.admin_login("t", "bad")
                self.assertEqual(code, 401)
            code, headers, body = self.admin_login("t", "t")
            self.assertEqual(code, 429)
            self.assertIn("频繁", body.decode("utf-8"))
            self.assertIsNotNone(headers.get("Retry-After"))
            # 换一个 IP（X-Real-IP）不受影响
            code, headers, _ = self.admin_req(
                "/admin/login",
                data=urllib.parse.urlencode({"user": "t", "password": "t"}).encode(),
                method="POST",
                headers={"Content-Type": "application/x-www-form-urlencoded",
                         "X-Real-IP": "10.0.0.9"})
            self.assertEqual(code, 302)
            self.assertEqual(headers["Location"], "/admin")

    def test_admin_password_hash_login(self) -> None:
        salt = "00112233445566778899aabbccddeeff"
        digest = hashlib.scrypt(b"secret", salt=bytes.fromhex(salt),
                                n=16384, r=8, p=1, dklen=32).hex()
        with self.admin_env(user="admin", password="",
                            pass_hash=f"scrypt:{salt}:{digest}"):
            code, headers, _ = self.admin_login("admin", "secret")
            self.assertEqual(code, 302)
            self.assertEqual(headers["Location"], "/admin")
            code, _, _ = self.admin_login("admin", "wrong")
            self.assertEqual(code, 401)

    def test_admin_data_apis(self) -> None:
        from cloud import app as cloud_app
        with self.admin_env():
            code, headers, _ = self.admin_login("t", "t")
            self.assertEqual(code, 302)
            token = self.session_cookie(headers)

            # 一次 App 设备上传（带有效 token）
            payload = json.loads(self.payload())
            claims = {"aud": "quick_user_api", "exp": int(time.time()) + 3600,
                      "encryId": base64.b64encode(b"12345").decode()}
            middle = base64.urlsafe_b64encode(
                json.dumps(claims).encode()).decode().rstrip("=")
            payload["token"] = "eyJhbGciOiJub25lIn0." + middle + ".sig"
            self.assertEqual(self.post(json.dumps(payload).encode())[0], 200)

            # 一条服务器 worker 抓取记录
            clean = cloud_app.validate_payload(json.loads(self.payload()))
            clean["app_version"] = "server"
            cloud_app.store_snapshot(self.httpd.RequestHandlerClass.db,
                                     self.httpd.db_lock, clean, "server")

            code, _, body = self.admin_req("/admin/api/summary", token=token)
            self.assertEqual(code, 200)
            summary = json.loads(body)
            self.assertTrue(summary["ok"])
            self.assertEqual(summary["uploads_ok"], 1)
            self.assertEqual(summary["user_uploads"], 1)
            self.assertEqual(summary["server_snapshots"], 1)
            self.assertEqual(summary["devices"], 1)
            self.assertEqual(summary["devices_revoked"], 0)
            self.assertEqual(summary["tokens"], 1)
            self.assertEqual(summary["tokens_valid"], 1)
            self.assertIsNotNone(summary["last_capture_at"])

            # 上传审计分页 + 来源标注
            code, _, body = self.admin_req("/admin/api/audit?limit=1&offset=0",
                                           token=token)
            page = json.loads(body)
            self.assertEqual(code, 200)
            self.assertEqual(page["total"], 3)  # setUp 注册 + 一次成功上传
            self.assertEqual(page["limit"], 1)
            self.assertEqual(len(page["rows"]), 1)
            latest = page["rows"][0]
            self.assertEqual(latest["result"], "token_update")  # 上传后写入令牌审计
            self.assertEqual(latest["source"], "device")
            self.assertEqual(latest["device"], self.device_id[:12])
            code, _, body = self.admin_req("/admin/api/audit?limit=1&offset=1",
                                           token=token)
            upload = json.loads(body)["rows"][0]
            self.assertEqual(upload["result"], "ok")
            self.assertEqual(upload["source"], "device")
            code, _, body = self.admin_req("/admin/api/audit?limit=1&offset=2",
                                           token=token)
            older = json.loads(body)["rows"][0]
            self.assertEqual(older["source"], "register")

            # 服务器抓取记录
            code, _, body = self.admin_req(
                "/admin/api/server-snapshots?limit=10&offset=0", token=token)
            snaps = json.loads(body)
            self.assertEqual(code, 200)
            self.assertEqual(snaps["total"], 1)
            self.assertEqual(len(snaps["rows"]), 1)
            self.assertEqual(snaps["rows"][0]["area_count"], 1)
            self.assertEqual(snaps["rows"][0]["areas"][0]["name"], "6号充电区")
            self.assertEqual(snaps["rows"][0]["captured_at"], "2026-10-31 23:00:00")

            # 设备分页 + 撤销/恢复
            code, _, body = self.admin_req("/admin/api/devices", token=token)
            devices = json.loads(body)
            self.assertEqual(devices["total"], 1)
            self.assertEqual(devices["rows"][0]["device_id"], self.device_id)
            self.assertFalse(devices["rows"][0]["revoked"])
            code, _, body = self.admin_req(
                "/admin/api/device/revoke", token=token, method="POST",
                data=json.dumps({"device_id": self.device_id,
                                 "revoked": True}).encode(),
                headers={"Content-Type": "application/json"})
            self.assertEqual(code, 200)
            self.assertTrue(json.loads(body)["revoked"])
            code, _, body = self.admin_req("/admin/api/summary", token=token)
            self.assertEqual(json.loads(body)["devices_revoked"], 1)
            code, _, body = self.admin_req(
                "/admin/api/device/revoke", token=token, method="POST",
                data=json.dumps({"device_id": self.device_id,
                                 "revoked": False}).encode(),
                headers={"Content-Type": "application/json"})
            self.assertFalse(json.loads(body)["revoked"])

            # 令牌：只回元数据，不回 token 内容
            code, _, body = self.admin_req("/admin/api/tokens", token=token)
            tokens = json.loads(body)
            self.assertEqual(code, 200)
            self.assertEqual(tokens["total"], 1)
            self.assertEqual(tokens["valid"], 1)
            self.assertEqual(tokens["rows"][0]["user_id"], "12345")
            self.assertTrue(tokens["rows"][0]["valid"])
            self.assertNotIn("token", tokens["rows"][0])
            self.assertFalse(any("eyJ" in str(v) for v in tokens["rows"][0].values()))

            # 系统信息
            code, _, body = self.admin_req("/admin/api/system", token=token)
            system = json.loads(body)
            self.assertEqual(code, 200)
            self.assertEqual(system["version"]["versionName"], "2.3")
            self.assertEqual(system["version"]["versionCode"], 14)
            self.assertTrue(system["admin_configured"])
            self.assertIn("worker", system)

    def test_admin_settings_read_write(self) -> None:
        with self.admin_env():
            code, headers, _ = self.admin_login("t", "t")
            self.assertEqual(code, 302)
            token = self.session_cookie(headers)

            code, _, body = self.admin_req("/admin/api/settings", token=token)
            self.assertEqual(code, 200)
            self.assertEqual(json.loads(body), {"device_approval": False})

            code, _, body = self.admin_json(
                "/admin/api/settings", {"device_approval": True}, token)
            self.assertEqual(code, 200)
            self.assertTrue(json.loads(body)["device_approval"])
            code, _, body = self.admin_req("/admin/api/settings", token=token)
            self.assertTrue(json.loads(body)["device_approval"])

            # 非法入参被拒
            code, _, _ = self.admin_json(
                "/admin/api/settings", {"device_approval": "yes"}, token)
            self.assertEqual(code, 400)
            code, _, _ = self.admin_json(
                "/admin/api/device/approve",
                {"device_id": "not-exists", "approved": True}, token)
            self.assertEqual(code, 404)

            # 关闭后新设备注册即 approved（无感）
            code, _, body = self.admin_json(
                "/admin/api/settings", {"device_approval": False}, token)
            self.assertFalse(json.loads(body)["device_approval"])
            did = "0123456789abcdef"
            status, reg = self.register(did, "a" * 64)
            self.assertEqual(status, 200)
            self.assertEqual(reg, {"ok": True, "device_id": did})
            with self.httpd.db_lock:
                row = self.httpd.RequestHandlerClass.db.execute(
                    "SELECT status FROM devices WHERE device_id = ?", (did,)).fetchone()
            self.assertEqual(row[0], "approved")

            # 未登录不可读写
            code, _, _ = self.admin_req("/admin/api/settings")
            self.assertEqual(code, 401)
            code, _, _ = self.admin_json(
                "/admin/api/settings", {"device_approval": True})
            self.assertEqual(code, 401)

    def test_device_approval_flow(self) -> None:
        with self.admin_env():
            code, headers, _ = self.admin_login("t", "t")
            self.assertEqual(code, 302)
            token = self.session_cookie(headers)

            code, _, body = self.admin_json(
                "/admin/api/settings", {"device_approval": True}, token)
            self.assertEqual(code, 200)
            self.assertTrue(json.loads(body)["device_approval"])

            did = "fedcba9876543210"
            secret = "c" * 64
            status, reg = self.register(did, secret)
            self.assertEqual(status, 200)
            self.assertEqual(reg, {"ok": True, "pending": True})

            # pending：有效签名也返回 403
            code, resp = self.post_as(did, secret, self.payload())
            self.assertEqual(code, 403)
            self.assertEqual(resp["error"], "设备待管理员审批")

            # 拒绝（approved=false）仍是 pending
            code, _, body = self.admin_json(
                "/admin/api/device/approve",
                {"device_id": did, "approved": False}, token)
            self.assertEqual(code, 200)
            self.assertEqual(json.loads(body)["status"], "pending")
            self.assertEqual(self.post_as(did, secret, self.payload())[0], 403)

            # 通过后恢复上传
            code, _, body = self.admin_json(
                "/admin/api/device/approve",
                {"device_id": did, "approved": True}, token)
            self.assertEqual(code, 200)
            self.assertEqual(json.loads(body)["status"], "approved")
            code, resp = self.post_as(did, secret, self.payload())
            self.assertEqual(code, 200, resp)

            # 设备列表带 status
            code, _, body = self.admin_req("/admin/api/devices", token=token)
            rows = {r["device_id"]: r for r in json.loads(body)["rows"]}
            self.assertEqual(rows[did]["status"], "approved")
            self.assertEqual(rows[self.device_id]["status"], "approved")

    def test_admin_bad_credentials_do_not_login(self) -> None:
        with self.admin_env(user="t", password="t"):
            code, headers, _ = self.admin_login("other", "t")
            self.assertEqual(code, 401)
            self.assertFalse(self.session_cookie(headers))
            code, _, _ = self.admin_req("/admin/api/summary")
            self.assertEqual(code, 401)

    def test_admin_non_ascii_credentials(self) -> None:
        with self.admin_env(user="管理员", password="密码-123"):
            code, headers, _ = self.admin_login("管理员", "密码-123")
            self.assertEqual(code, 302)
            self.assertEqual(headers["Location"], "/admin")
            code, _, _ = self.admin_login("管理员", "错误密码")
            self.assertEqual(code, 401)

    def test_admin_unconfigured_credentials_deny(self) -> None:
        with self.admin_env(user="", password=""):
            code, _, body = self.admin_req("/admin/login")
            self.assertEqual(code, 200)
            self.assertIn("未配置", body.decode("utf-8"))
            code, _, body = self.admin_login("", "")
            self.assertIn(code, (401, 503))
            self.assertNotIn("charge_admin", body.decode("utf-8"))

    # ------------------------------------------------------------------
    # 控制器 / 端口数据
    # ------------------------------------------------------------------
    def test_controllers_migration_idempotent(self) -> None:
        from cloud import app as cloud_app
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "legacy.db"
            raw = sqlite3.connect(path)
            # 模拟生产库：controllers 已存在且缺 updated_at
            raw.execute(
                "CREATE TABLE controllers (device_hex TEXT PRIMARY KEY, code TEXT, "
                "area_id TEXT, area_name TEXT)")
            raw.execute(
                "INSERT INTO controllers(device_hex, code, area_name) VALUES (?,?,?)",
                ("00AFEC05", "10001", "6号充电区"))
            raw.commit()
            raw.close()
            for _ in range(2):
                conn = cloud_app.init_db(path)
                try:
                    cols = {row[1] for row in conn.execute(
                        "PRAGMA table_info(controllers)")}
                    self.assertTrue({"device_hex", "code", "area_id",
                                     "area_name", "updated_at"} <= cols)
                    port_cols = {row[1] for row in conn.execute(
                        "PRAGMA table_info(port_states)")}
                    # 数据契约 v2：port_states 增加 status_group（与 status 原文并存）
                    self.assertEqual(port_cols, {"device_hex", "port", "status",
                                                 "status_group", "updated_at"})
                    tables = {row[0] for row in conn.execute(
                        "SELECT name FROM sqlite_master WHERE type='table'")}
                    self.assertIn("port_states", tables)
                    # 迁移不得改动已有控制器数据
                    self.assertEqual(
                        conn.execute("SELECT device_hex, code FROM controllers")
                        .fetchone(), ("00AFEC05", "10001"))
                finally:
                    conn.close()

    def test_area_ports_structure(self) -> None:
        stamp = time.strftime("%Y-%m-%d %H:%M:%S")
        with self.httpd.db_lock:
            conn = self.httpd.RequestHandlerClass.db
            conn.executemany(
                "INSERT INTO controllers(device_hex, code, area_id, area_name, "
                "updated_at) VALUES (?,?,?,?,?)",
                [("01AFEC05", "10001", "aid1", "6号充电区", stamp),
                 ("02AFEC05", "10002", "aid1", "6号充电区", stamp)])
            conn.executemany(
                "INSERT INTO port_states(device_hex, port, status, updated_at) "
                "VALUES (?,?,?,?)",
                [("01AFEC05", "01", "空闲", stamp),
                 ("01AFEC05", "02", "充电中", stamp),
                 ("02AFEC05", "01", "充电中", stamp)])
            conn.commit()
        area = urllib.parse.quote("6号充电区")
        with urllib.request.urlopen(self.url("/api/area-ports?area=" + area),
                                    timeout=5) as resp:
            data = json.loads(resp.read())
        self.assertTrue(data["ok"])
        self.assertEqual(data["area"], "6号充电区")
        self.assertEqual(data["updated_at"], stamp)
        self.assertEqual([d["device_hex"] for d in data["devices"]],
                         ["01AFEC05", "02AFEC05"])
        first = data["devices"][0]
        self.assertEqual(first["code"], "10001")
        self.assertEqual(first["updated_at"], stamp)
        self.assertEqual(first["ports"],
                         [{"port": "01", "status": "空闲", "group": "free"},
                          {"port": "02", "status": "充电中", "group": "busy"}])
        self.assertEqual(data["devices"][1]["ports"],
                         [{"port": "01", "status": "充电中", "group": "busy"}])
        # 没有控制器/端口数据的区域返回空列表，而不是报错
        with urllib.request.urlopen(
                self.url("/api/area-ports?area=" + urllib.parse.quote("9号充电区")),
                timeout=5) as resp:
            empty = json.loads(resp.read())
        self.assertEqual(empty["devices"], [])
        self.assertIsNone(empty["updated_at"])
        # 缺少 area 参数
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            urllib.request.urlopen(self.url("/api/area-ports"), timeout=5)
        self.assertEqual(ctx.exception.code, 400)

    def test_admin_controllers_list_and_missing(self) -> None:
        stamp = time.strftime("%Y-%m-%d %H:%M:%S")
        with self.httpd.db_lock:
            conn = self.httpd.RequestHandlerClass.db
            conn.executemany(
                "INSERT INTO areas(area_id, name, first_seen, last_seen) "
                "VALUES (?,?,?,?)",
                [("aid1", "6号充电区", stamp, stamp),
                 ("aid2", "9号充电区", stamp, stamp)])
            conn.execute(
                "INSERT INTO controllers(device_hex, code, area_id, area_name, "
                "updated_at) VALUES (?,?,?,?,?)",
                ("00AFEC05", "10001", "aid1", "6号充电区", stamp))
            conn.executemany(
                "INSERT INTO port_states(device_hex, port, status, updated_at) "
                "VALUES (?,?,?,?)",
                [("00AFEC05", "01", "空闲", stamp),
                 ("00AFEC05", "02", "空闲", stamp),
                 ("00AFEC05", "03", "充电中", stamp)])
            conn.commit()
        with self.admin_env():
            code, headers, _ = self.admin_login("t", "t")
            self.assertEqual(code, 302)
            token = self.session_cookie(headers)
            code, _, body = self.admin_req("/admin/api/controllers", token=token)
        self.assertEqual(code, 200)
        payload = json.loads(body)
        self.assertTrue(payload["ok"])
        self.assertEqual(len(payload["rows"]), 1)
        row = payload["rows"][0]
        self.assertEqual(row["device_hex"], "00AFEC05")
        self.assertEqual(row["code"], "10001")
        self.assertEqual(row["area_name"], "6号充电区")
        self.assertEqual(row["port_count"], 3)
        self.assertEqual(row["idle"], 2)
        self.assertEqual(row["charging"], 1)
        self.assertEqual(row["updated_at"], stamp)
        # areas 左连 controllers：没有控制器的区域进入 missing
        self.assertEqual(payload["missing_areas"], ["9号充电区"])

    def test_controllers_sync_without_token(self) -> None:
        with self.httpd.db_lock:
            conn = self.httpd.RequestHandlerClass.db
            conn.execute(
                "INSERT INTO controllers(device_hex, code, area_id, area_name, "
                "updated_at) VALUES (?,?,?,?,?)",
                ("00AFEC05", "10001", "aid1", "6号充电区",
                 time.strftime("%Y-%m-%d %H:%M:%S")))
            conn.commit()
        with self.admin_env():
            code, headers, _ = self.admin_login("t", "t")
            self.assertEqual(code, 302)
            token = self.session_cookie(headers)
            code, _, body = self.admin_req(
                "/admin/api/controllers/sync", token=token, method="POST",
                data=b"", headers={"Content-Type": "application/json"})
        self.assertEqual(code, 200)
        payload = json.loads(body)
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["result"], "no-token")

    def test_controllers_api_requires_admin(self) -> None:
        with self.admin_env():
            code, _, body = self.admin_req("/admin/api/controllers")
            self.assertEqual(code, 401)
            self.assertEqual(json.loads(body)["error"], "unauthorized")
            code, _, body = self.admin_req(
                "/admin/api/controllers/sync", method="POST", data=b"")
            self.assertEqual(code, 401)
            self.assertEqual(json.loads(body)["error"], "unauthorized")

    def test_public_controllers_shape_filter_and_cache(self) -> None:
        from cloud import app as cloud_app
        self.add_controller("00AFEC05", "10001", "9号充电区")
        self.add_controller("00AFEC06", "", "6号充电区")
        self.add_controller("00AFEC07", None, "6号充电区")
        with urllib.request.urlopen(self.url("/api/controllers"), timeout=5) as resp:
            data = json.loads(resp.read())
        self.assertTrue(data["ok"])
        self.assertEqual(data["count"], 1)
        self.assertEqual(len(data["controllers"]), 1)
        self.assertEqual(data["controllers"], [
            {"area_name": "9号充电区", "device_hex": "00AFEC05",
             "code": "10001", "qr_device_no": None}])
        # 30 秒缓存：直接改库后短时间仍返回旧值
        with self.httpd.db_lock:
            conn = self.httpd.RequestHandlerClass.db
            conn.execute("UPDATE controllers SET code = '10002' "
                         "WHERE device_hex = '00AFEC05'")
            conn.commit()
        with urllib.request.urlopen(self.url("/api/controllers"), timeout=5) as resp:
            cached = json.loads(resp.read())
        self.assertEqual(cached["controllers"][0]["code"], "10001")
        cloud_app.CONTROLLERS_CACHE.clear()
        with urllib.request.urlopen(self.url("/api/controllers"), timeout=5) as resp:
            fresh = json.loads(resp.read())
        self.assertEqual(fresh["controllers"][0]["code"], "10002")

    def test_public_controllers_limit_500(self) -> None:
        stamp = time.strftime("%Y-%m-%d %H:%M:%S")
        with self.httpd.db_lock:
            conn = self.httpd.RequestHandlerClass.db
            conn.executemany(
                "INSERT INTO controllers(device_hex, code, area_id, area_name, "
                "updated_at) VALUES (?,?,?,?,?)",
                [("A%07d" % i, str(20000 + i), "aid1", "6号充电区", stamp)
                 for i in range(505)])
            conn.commit()
        with urllib.request.urlopen(self.url("/api/controllers"), timeout=5) as resp:
            data = json.loads(resp.read())
        self.assertEqual(data["count"], 500)
        self.assertEqual(len(data["controllers"]), 500)

    # ------------------------------------------------------------------
    # 区域坐标 + 距离权重
    # ------------------------------------------------------------------
    def test_areas_coords_migration_idempotent(self) -> None:
        from cloud import app as cloud_app
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "legacy.db"
            raw = sqlite3.connect(path)
            raw.execute(
                "CREATE TABLE areas (area_id TEXT PRIMARY KEY, name TEXT UNIQUE, "
                "first_seen TEXT, last_seen TEXT)")
            raw.execute(
                "INSERT INTO areas(area_id, name, first_seen, last_seen) "
                "VALUES (?,?,?,?)",
                ("aid1", "6号充电区", "2026-01-01 00:00:00",
                 "2026-01-01 00:00:00"))
            raw.commit()
            raw.close()
            for _ in range(2):
                conn = cloud_app.init_db(path)
                try:
                    cols = {row[1] for row in conn.execute(
                        "PRAGMA table_info(areas)")}
                    self.assertTrue({"lat", "lng"} <= cols)
                    row = conn.execute(
                        "SELECT area_id, name, lat, lng FROM areas").fetchone()
                    self.assertEqual(row[:2], ("aid1", "6号充电区"))
                    self.assertIsNone(row[2])
                    self.assertIsNone(row[3])
                finally:
                    conn.close()

    def test_admin_area_coords_write_validate_and_404(self) -> None:
        self.upload_areas(self.area("6号充电区", idle=7, total=16))
        with self.admin_env():
            token = self.admin_token()
            code, _, body = self.admin_json(
                "/admin/api/areas/coords",
                {"name": "6号充电区", "lat": 30.123, "lng": 114.456}, token)
            self.assertEqual(code, 200, body)
            self.assertTrue(json.loads(body)["ok"])

            code, _, body = self.admin_req("/admin/api/areas", token=token)
            rows = {r["name"]: r for r in json.loads(body)["rows"]}
            self.assertAlmostEqual(rows["6号充电区"]["lat"], 30.123, places=6)
            self.assertAlmostEqual(rows["6号充电区"]["lng"], 114.456, places=6)

            # 越界 / 非数字 / 缺字段
            for payload in (
                {"name": "6号充电区", "lat": 90.5, "lng": 114.0},
                {"name": "6号充电区", "lat": 30.0, "lng": -180.5},
                {"name": "6号充电区", "lat": "abc", "lng": 114.0},
                {"name": "6号充电区", "lat": 30.0},
            ):
                code, _, _ = self.admin_json(
                    "/admin/api/areas/coords", payload, token)
                self.assertEqual(code, 400, payload)

            code, _, body = self.admin_json(
                "/admin/api/areas/coords",
                {"name": "火星充电区", "lat": 30.0, "lng": 114.0}, token)
            self.assertEqual(code, 404)
            self.assertEqual(json.loads(body)["error"], "区域不存在")

            # 校验失败不得覆盖已写入的坐标
            code, _, body = self.admin_req("/admin/api/areas", token=token)
            rows = {r["name"]: r for r in json.loads(body)["rows"]}
            self.assertAlmostEqual(rows["6号充电区"]["lat"], 30.123, places=6)

        with self.httpd.db_lock:
            row = self.httpd.RequestHandlerClass.db.execute(
                "SELECT result, detail FROM upload_audit "
                "ORDER BY id DESC LIMIT 1").fetchone()
        self.assertEqual(row[0], "area_coords")
        self.assertIn("6号充电区", row[1])

    def test_now_with_coords_distance_score_and_order(self) -> None:
        self.upload_areas(
            self.area("6号充电区", idle=8),
            self.area("9号充电区", idle=2),
            self.area("10号充电区", idle=5),
        )
        with self.admin_env():
            token = self.admin_token()
            for name, lat, lng in (("6号充电区", 0.0, 0.0),
                                   ("9号充电区", 0.0, 0.01),
                                   ("10号充电区", 0.01, 0.0)):
                code, _, body = self.admin_json(
                    "/admin/api/areas/coords",
                    {"name": name, "lat": lat, "lng": lng}, token)
                self.assertEqual(code, 200, body)

        with urllib.request.urlopen(
                self.url("/api/now?lat=0&lng=0"), timeout=5) as resp:
            areas = json.loads(resp.read())["areas"]
        self.assertEqual([a["name"] for a in areas],
                         ["6号充电区", "10号充电区", "9号充电区"])
        scores = [a["score"] for a in areas]
        self.assertEqual(scores, sorted(scores, reverse=True))

        by_name = {a["name"]: a for a in areas}
        self.assertEqual(by_name["6号充电区"]["distance_m"], 0)
        self.assertEqual(by_name["6号充电区"]["score"], 1.0)
        for name in ("9号充电区", "10号充电区"):
            item = by_name[name]
            self.assertIsNotNone(item["distance_m"])
            self.assertTrue(1100 <= item["distance_m"] <= 1130, item)
            expected = round(0.65 * (item["idle"] / 8)
                             + 0.35 * (1 - min(item["distance_m"], 3000) / 3000), 3)
            self.assertEqual(item["score"], expected)

    def test_now_without_coords_falls_back_to_idle(self) -> None:
        self.upload_areas(
            self.area("6号充电区", idle=3),
            self.area("9号充电区", idle=9),
        )
        for path in ("/api/now", "/api/now?lat=30.0",
                     "/api/now?lat=abc&lng=114.0"):
            with urllib.request.urlopen(self.url(path), timeout=5) as resp:
                areas = json.loads(resp.read())["areas"]
            self.assertEqual([a["name"] for a in areas],
                             ["9号充电区", "6号充电区"], path)
            for item in areas:
                self.assertIsNone(item["distance_m"], path)
                self.assertEqual(item["score"], item["idle"], path)

    def test_overview_areas_include_coords(self) -> None:
        self.upload_areas(
            self.area("6号充电区", idle=7, total=16),
            self.area("9号充电区", idle=5),
        )
        with self.admin_env():
            token = self.admin_token()
            code, _, _ = self.admin_json(
                "/admin/api/areas/coords",
                {"name": "6号充电区", "lat": 30.123, "lng": 114.456}, token)
            self.assertEqual(code, 200)

        with urllib.request.urlopen(self.url("/api/overview"), timeout=5) as resp:
            overview = json.loads(resp.read())
        areas = {a["name"]: a for a in overview["snapshot"]["areas"]}
        self.assertAlmostEqual(areas["6号充电区"]["lat"], 30.123, places=6)
        self.assertAlmostEqual(areas["6号充电区"]["lng"], 114.456, places=6)
        self.assertIsNone(areas["9号充电区"]["lat"])
        self.assertIsNone(areas["9号充电区"]["lng"])
        # 现有字段保持不变
        self.assertEqual(areas["6号充电区"]["idle_port"], 7)
        self.assertEqual(areas["6号充电区"]["total_port"], 16)
        self.assertEqual(areas["6号充电区"]["charging_port"], 9)

    # ------------------------------------------------------------------
    # P1 token 池
    # ------------------------------------------------------------------
    def test_token_pool_migrates_legacy_tokens_idempotent(self) -> None:
        from cloud import app as cloud_app
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "legacy.db"
            raw = sqlite3.connect(path)
            raw.execute("CREATE TABLE tokens (user_id TEXT PRIMARY KEY, "
                        "token TEXT NOT NULL, expires_at INTEGER NOT NULL, "
                        "updated_at TEXT NOT NULL)")
            exp = int(time.time()) + 3600
            raw.execute(
                "INSERT INTO tokens(user_id, token, expires_at, updated_at) "
                "VALUES (?,?,?,?)",
                ("12345678", "v1:legacycipher", exp, "2026-01-01 00:00:00"))
            raw.commit()
            raw.close()
            for _ in range(2):  # 两次初始化：迁移必须幂等
                conn = cloud_app.init_db(path)
                try:
                    rows = conn.execute(
                        "SELECT user_id, token, expires_at, updated_at, source, "
                        "last_error FROM token_pool").fetchall()
                finally:
                    conn.close()
                self.assertEqual(len(rows), 1)
                self.assertEqual(rows[0][0], "12345678")
                self.assertEqual(rows[0][1], "v1:legacycipher")  # 原样搬运（已加密）
                self.assertEqual(rows[0][2], exp)
                self.assertEqual(rows[0][4], "migrate")
                self.assertIsNone(rows[0][5])

    def test_token_pool_upload_upsert_and_multi_candidates(self) -> None:
        from cloud import app as cloud_app
        self.upload_token("111", ttl=1200)
        token_b = self.upload_token("111", ttl=5400)  # 同 user_id 覆盖更新
        self.upload_token("222", ttl=3600)

        rows = self.db_rows(
            "SELECT user_id, expires_at FROM token_pool ORDER BY user_id")
        self.assertEqual([r[0] for r in rows], ["111", "222"])
        self.assertEqual(self.db_rows("SELECT COUNT(*) FROM tokens")[0][0], 2)

        conn = self.httpd.RequestHandlerClass.db
        candidates = cloud_app._pick_token(conn, self.httpd.db_lock)
        self.assertEqual(len(candidates), 2)
        exps = [c[3] for c in candidates]
        self.assertEqual(exps, sorted(exps, reverse=True))  # expires_at DESC
        self.assertEqual(candidates[0][1], "111")  # 同 user 取最新 token
        stored = self.db_rows(
            "SELECT token FROM token_pool WHERE user_id = '111'")[0][0]
        self.assertEqual(cloud_app.decrypt_token(stored), token_b)

    def test_token_pool_skips_expired_and_stops_when_all_expired(self) -> None:
        from cloud import app as cloud_app
        self.add_pool_token("expired", ttl=-10)
        valid = self.add_pool_token("valid", ttl=3600)
        conn = self.httpd.RequestHandlerClass.db
        candidates = cloud_app._pick_token(conn, self.httpd.db_lock)
        self.assertEqual(len(candidates), 1)
        self.assertEqual(candidates[0][1], "valid")
        self.assertEqual(cloud_app.decrypt_token(candidates[0][2]), valid)

        with self.httpd.db_lock:
            conn.execute(
                "UPDATE token_pool SET expires_at = ? WHERE user_id = 'valid'",
                (int(time.time()) - 1,))
            conn.commit()
        self.assertEqual(cloud_app._pick_token(conn, self.httpd.db_lock), [])
        self.assertEqual(
            cloud_app.server_refresh_once(conn, self.httpd.db_lock), "no-token")

    def test_auth_expired_marks_pool_and_switches_token(self) -> None:
        from cloud import app as cloud_app
        from crawler.api import AuthExpired
        self.add_pool_token("111", ttl=5400)  # expires_at 更大 → 先尝试
        self.add_pool_token("222", ttl=3600)
        calls: list = []

        def fake_call(path, params=None, **kwargs):
            uid = kwargs.get("user_id")
            calls.append((path, uid))
            if path == "user/userInfo":
                if uid == "111":
                    raise AuthExpired("登录态失效（code=20001）")
                return {"data": {"projectId": "p1", "projectName": "纺织大学"}}
            if path == "nearArea/list":
                return {"data": [{"id": 9, "areaName": "9号充电区"}]}
            if path == "nearArea/9":
                return {"data": [{"address": "x", "totalPort": 10,
                                  "idlePort": 4, "chargingPort": 5,
                                  "faultPort": 1}]}
            raise AssertionError(path)

        conn = self.httpd.RequestHandlerClass.db
        with patch("crawler.api.call", side_effect=fake_call):
            result = cloud_app.server_refresh_once(conn, self.httpd.db_lock)
        self.assertTrue(result.startswith("ok:"), result)
        self.assertEqual(self.db_rows("SELECT COUNT(*) FROM snapshots")[0][0], 1)
        failed = self.db_rows(
            "SELECT last_error, expires_at FROM token_pool "
            "WHERE user_id = '111'")[0]
        self.assertIn("auth-expired", failed[0])
        self.assertEqual(failed[1], 0)  # 失效 token 不再被选中
        self.assertIsNone(self.db_rows(
            "SELECT last_error FROM token_pool WHERE user_id = '222'")[0][0])
        self.assertIn(("user/userInfo", "111"), calls)
        self.assertIn(("user/userInfo", "222"), calls)

    def test_sync_ports_rotates_token_and_records_pile_samples(self) -> None:
        from cloud import app as cloud_app
        from crawler.api import AuthExpired
        self.add_controller()
        self.add_pool_token("111", ttl=5400)
        self.add_pool_token("222", ttl=3600)

        def fake_call(path, params=None, **kwargs):
            if kwargs.get("user_id") == "111":
                raise AuthExpired("登录态失效")
            return {"data": {"ports": [{"port": "01", "status": "空闲"},
                                       {"port": "02", "status": "充电中"}]}}

        conn = self.httpd.RequestHandlerClass.db
        with patch("crawler.api.call", side_effect=fake_call):
            result = cloud_app.sync_ports(conn, self.httpd.db_lock)
        self.assertEqual(result, "ok:1/2")
        self.assertEqual(self.db_rows("SELECT COUNT(*) FROM port_states")[0][0], 2)
        samples = self.db_rows(
            "SELECT free, total, busy, online FROM pile_samples "
            "WHERE device_hex = '00AFEC05'")
        self.assertEqual(len(samples), 1)
        self.assertEqual(samples[0], (1, 2, 1, 1))
        self.assertIn("auth-expired", self.db_rows(
            "SELECT last_error FROM token_pool WHERE user_id = '111'")[0][0])
        pile = self.get_json("/api/pile/00AFEC05")["pile"]
        self.assertEqual(pile["state"], "free")
        self.assertEqual(len(pile["history"]), 1)
        self.assertEqual(pile["history"][0]["free"], 1)

    def test_pile_samples_replace_same_second(self) -> None:
        from cloud import app as cloud_app
        self.add_controller()
        conn = self.httpd.RequestHandlerClass.db
        ts = time.strftime("%Y-%m-%d %H:%M:%S")
        with self.httpd.db_lock:
            cloud_app.record_pile_sample(conn, "00AFEC05", ts,
                                         ["空闲", "充电中"])
            cloud_app.record_pile_sample(
                conn, "00AFEC05", ts, ["充电中", "充电中", "故障"])
            conn.commit()
        rows = self.db_rows(
            "SELECT ts, free, total, busy, online FROM pile_samples")
        self.assertEqual(len(rows), 1)  # 同一秒 REPLACE
        self.assertEqual(rows[0][1:], (0, 3, 3, 1))

    # ------------------------------------------------------------------
    # P2 二维码设备号
    # ------------------------------------------------------------------
    def test_admin_controller_qr_update_validate_and_audit(self) -> None:
        self.add_controller()
        # 先填充 /api/controllers 的 30 秒缓存，稍后验证改码牌号会立即失效
        cached = self.get_json("/api/controllers")["controllers"]
        self.assertIsNone(cached[0]["qr_device_no"])
        with self.admin_env():
            token = self.admin_token()
            code, _, body = self.admin_json(
                "/admin/api/controllers/qr",
                {"device_hex": "00afec05", "qr_device_no": "ACFC1A00"}, token)
            self.assertEqual(code, 200, body)
            self.assertEqual(json.loads(body)["qr_device_no"], "acfc1a00")
            for bad in ("xyz", "acfc1a0", "acfc1a000", "zzzzzzzz", ""):
                code, _, _ = self.admin_json(
                    "/admin/api/controllers/qr",
                    {"device_hex": "00AFEC05", "qr_device_no": bad}, token)
                self.assertEqual(code, 400, bad)
            code, _, body = self.admin_json(
                "/admin/api/controllers/qr",
                {"device_hex": "DEADBEEF", "qr_device_no": "acfc1a00"}, token)
            self.assertEqual(code, 404)
            code, _, _ = self.admin_req(
                "/admin/api/controllers/qr", method="POST",
                data=json.dumps({"device_hex": "00AFEC05",
                                 "qr_device_no": "acfc1a00"}).encode(),
                headers={"Content-Type": "application/json"})
            self.assertEqual(code, 401)

        self.assertEqual(self.db_rows(
            "SELECT qr_device_no FROM controllers WHERE device_hex = '00AFEC05'"
        )[0][0], "acfc1a00")
        result, detail = self.last_audit()
        self.assertEqual(result, "controller_qr")
        self.assertIn("00AFEC05", detail)

        self.post_ports("00AFEC05", "空闲")
        self.assertEqual(self.get_json(
            "/api/area-ports?area=" + urllib.parse.quote("6号充电区")
        )["devices"][0]["qr_device_no"], "acfc1a00")
        areas_ports = self.get_json("/api/areas-ports")
        self.assertEqual(areas_ports["areas"][0]["devices"][0]["qr_device_no"],
                         "acfc1a00")
        # 改码牌号后 /api/controllers 的缓存立即失效，不用等 30 秒
        controllers = self.get_json("/api/controllers")["controllers"]
        self.assertEqual(controllers[0]["qr_device_no"], "acfc1a00")
        self.assertEqual(
            self.get_json("/api/pile/00AFEC05")["pile"]["qr_device_no"],
            "acfc1a00")

    # ------------------------------------------------------------------
    # P3 空闲率 / P4 单桩详情
    # ------------------------------------------------------------------
    def test_free_rate_empty_and_shape(self) -> None:
        data = self.get_json("/api/free-rate")
        self.assertTrue(data["ok"])
        self.assertEqual(data["days"], 14)
        self.assertEqual(data["total_samples"], 0)
        self.assertEqual([p["hour"] for p in data["points"]], list(range(24)))
        self.assertTrue(all(p["samples"] == 0 for p in data["points"]))
        self.assertTrue(all(p["free_rate"] is None for p in data["points"]))

    def test_free_rate_hourly_aggregation_and_days_clamp(self) -> None:
        for idle in (5, 3, 0):
            self.add_area_sample(10, idle)
        for _ in range(2):
            self.add_area_sample(11, 0)
        data = self.get_json("/api/free-rate?days=14")
        self.assertTrue(data["ok"])
        self.assertEqual(data["total_samples"], 5)
        self.assertEqual(len(data["points"]), 24)
        by_hour = {p["hour"]: p for p in data["points"]}
        self.assertEqual(by_hour[10]["samples"], 3)
        self.assertAlmostEqual(by_hour[10]["free_rate"], round(2 / 3, 4), places=6)
        self.assertEqual(by_hour[11]["samples"], 2)
        self.assertEqual(by_hour[11]["free_rate"], 0.0)
        self.assertIsNone(by_hour[12]["free_rate"])
        # days 越界夹紧到 1..30；非法回退默认 14
        self.assertEqual(self.get_json("/api/free-rate?days=99")["days"], 30)
        self.assertEqual(self.get_json("/api/free-rate?days=0")["days"], 1)
        self.assertEqual(self.get_json("/api/free-rate?days=abc")["days"], 14)

    def test_pile_detail_404(self) -> None:
        for path in ("/api/pile/DEADBEEF", "/api/pile/"):
            with self.assertRaises(urllib.error.HTTPError) as ctx:
                urllib.request.urlopen(self.url(path), timeout=5)
            try:
                self.assertEqual(ctx.exception.code, 404, path)
                body = json.loads(ctx.exception.read())
                self.assertEqual(body["error"], "设备不存在", path)
            finally:
                ctx.exception.close()

    def test_pile_detail_ok_after_upload(self) -> None:
        self.add_controller()
        self.post_ports("00AFEC05", "空闲", "充电中")
        data = self.get_json("/api/pile/00AFEC05")
        self.assertTrue(data["ok"])
        pile = data["pile"]
        self.assertEqual(pile["device_hex"], "00AFEC05")
        self.assertEqual(pile["code"], "10001")
        self.assertEqual(pile["area_name"], "6号充电区")
        self.assertIsNone(pile["qr_device_no"])
        self.assertEqual(pile["state"], "free")
        self.assertEqual((pile["total"], pile["free"], pile["busy"]), (2, 1, 1))
        self.assertTrue(pile["updated_at"])
        self.assertEqual(pile["ports"], [{"port": "01", "status": "空闲"},
                                        {"port": "02", "status": "充电中"}])
        self.assertEqual(len(pile["history"]), 1)
        item = pile["history"][0]
        self.assertEqual(set(item), {"ts", "free", "total", "busy", "online"})
        self.assertEqual((item["free"], item["total"], item["busy"]), (1, 2, 1))
        self.assertTrue(item["online"])
        # 设备号大小写不敏感
        self.assertEqual(
            self.get_json("/api/pile/00afec05")["pile"]["device_hex"], "00AFEC05")

    # ------------------------------------------------------------------
    # P5 健康 / P6 刷新周期
    # ------------------------------------------------------------------
    def test_overview_token_pool_interval_and_health(self) -> None:
        from cloud import app as cloud_app
        empty = self.get_json("/api/overview")
        self.assertEqual(empty["uploads"], 0)
        self.assertEqual(empty["interval"], 600)
        self.assertEqual(empty["token_pool"]["count"], 0)
        self.assertEqual(empty["error_count"], 0)

        self.upload_areas(self.area("6号充电区", idle=7, total=16))
        token = self.upload_token("12345678", ttl=3600)
        middle = token.split(".")[1]
        pad = "=" * (-len(middle) % 4)
        exp = json.loads(base64.urlsafe_b64decode(middle + pad))["exp"]

        overview = self.get_json("/api/overview")
        self.assertEqual(overview["interval"], cloud_app.WORKER_INTERVAL)
        self.assertEqual(overview["interval"], 600)
        self.assertEqual(overview["error_count"], 0)  # 无控制器、无坏 token
        self.assertTrue(overview["token_ready"])
        self.assertEqual(overview["token_valid"], 1)
        self.assertEqual(overview["earliest_exp"], exp)
        pool = overview["token_pool"]
        self.assertEqual(pool["count"], 1)
        self.assertEqual(pool["valid"], 1)
        self.assertEqual(pool["earliest_exp"], exp)
        self.assertEqual(pool["cover_until"], pool["earliest_exp"])
        self.assertEqual(pool["long_lived"], 1)  # 剩余 > 30 分钟

        # 从未抓到端口数据的控制器计入 stale 设备
        self.add_controller()
        self.assertEqual(self.get_json("/api/overview")["error_count"], 1)
        # 池里 last_error 非空再 +1
        with self.httpd.db_lock:
            conn = self.httpd.RequestHandlerClass.db
            conn.execute("UPDATE token_pool SET last_error = 'auth-expired'")
            conn.commit()
        self.assertEqual(self.get_json("/api/overview")["error_count"], 2)

    def test_admin_tokens_pool_health(self) -> None:
        self.upload_token("12345", ttl=3600)
        with self.admin_env():
            token = self.admin_token()
            code, _, body = self.admin_req("/admin/api/tokens", token=token)
        self.assertEqual(code, 200)
        payload = json.loads(body)
        self.assertEqual(payload["total"], 1)
        self.assertEqual(payload["valid"], 1)
        self.assertEqual(payload["pool"]["count"], 1)
        self.assertEqual(payload["pool"]["valid"], 1)
        self.assertEqual(payload["pool"]["earliest_exp"],
                         payload["rows"][0]["expires_at"])
        self.assertNotIn("token", payload["rows"][0])

    def test_worker_interval_merged_round(self) -> None:
        from cloud import app as cloud_app
        self.assertEqual(cloud_app.WORKER_INTERVAL, 600)
        self.assertTrue(hasattr(cloud_app, "start_worker"))
        self.assertFalse(hasattr(cloud_app, "start_port_worker"))  # 不再有 30 分钟端口循环
        self.assertEqual(self.get_json("/api/overview")["interval"], 600)

        conn = self.httpd.RequestHandlerClass.db
        calls: list = []

        def fake_areas(conn_, lock_):
            calls.append("areas")
            return "no-token"

        def fake_ports(conn_, lock_, only_devices=None):
            calls.append("ports")
            return "no-token"

        with patch.object(cloud_app, "server_refresh_once",
                          side_effect=fake_areas), \
                patch.object(cloud_app, "sync_ports", side_effect=fake_ports):
            result = cloud_app.refresh_round(conn, self.httpd.db_lock)
            self.assertEqual(result, "areas=no-token|ports=no-token")
            self.assertEqual(calls, ["areas", "ports"])  # 同一轮先区域后端口
            self.assertFalse(cloud_app._round_ok(result))
            self.assertTrue(cloud_app._round_ok("areas=no-token|ports=ok:1/2"))
            cloud_app.WORKER_STATE.update(last_run=None, last_result=None, runs=0)
            cloud_app.worker_round(self.httpd)
            self.assertEqual(calls, ["areas", "ports", "areas", "ports"])
        self.assertEqual(cloud_app.WORKER_STATE["runs"], 1)
        self.assertEqual(cloud_app.WORKER_STATE["last_result"],
                         "areas=no-token|ports=no-token")
        self.assertEqual(self.db_rows("SELECT COUNT(*) FROM worker_runs")[0][0], 1)

    def test_worker_runs_first_round_at_startup(self) -> None:
        from cloud import app as cloud_app
        calls: list = []

        def fake_round(conn_, lock_):
            calls.append(time.time())
            return "areas=no-token|ports=no-token"

        cloud_app.WORKER_STATE.update(last_run=None, last_result=None, runs=0)
        started = time.time()
        with patch.object(cloud_app, "refresh_round", side_effect=fake_round):
            cloud_app.start_worker(self.httpd)
            deadline = time.time() + 5
            while time.time() < deadline and cloud_app.WORKER_STATE["runs"] < 1:
                time.sleep(0.02)
        self.assertGreaterEqual(cloud_app.WORKER_STATE["runs"], 1)
        self.assertTrue(calls, "start_worker 启动后应先跑一轮")
        # 首轮在启动瞬间执行，不会先等一个周期（旧实现会先 sleep 30 秒）
        self.assertLess(calls[0] - started, 2.0)

    # ------------------------------------------------------------------
    # task-9 回归：H1 区域容错 / H2 解密失败不清池 / H4 失败语义
    # ------------------------------------------------------------------
    def test_upload_mixed_unknown_area_accepts_valid_and_skips(self) -> None:
        self.assertEqual(self.post(self.payload())[0], 200)  # 登记 6号充电区
        body = json.loads(self.payload())
        body["areas"].append(self.area("火星充电区", idle=1, total=2))
        code, resp = self.post(json.dumps(body, ensure_ascii=False).encode())
        self.assertEqual(code, 200, resp)
        self.assertEqual(resp["accepted"], 1)
        self.assertEqual(resp["skipped"], 1)
        self.assertIn("skipped=1", self.last_audit()[1])
        self.assertEqual(self.db_rows("SELECT COUNT(*) FROM area_samples")[0][0], 2)
        names = [r[0] for r in self.db_rows("SELECT name FROM areas")]
        self.assertIn("6号充电区", names)
        self.assertNotIn("火星充电区", names)

    def test_server_refresh_skips_unknown_area_but_keeps_valid(self) -> None:
        from cloud import app as cloud_app
        self.assertEqual(self.post(self.payload())[0], 200)  # 登记 6号充电区
        self.add_pool_token("u1", ttl=3600)
        conn = self.httpd.RequestHandlerClass.db

        def fake_call(path, params=None, **kwargs):
            if path == "user/userInfo":
                return {"data": {"projectId": "p1", "projectName": "P"}}
            if path == "nearArea/list":
                return {"data": [{"id": 1, "areaName": "6号充电区"},
                                 {"id": 2, "areaName": "平台新区域"}]}
            if path == "nearArea/1":
                return {"data": [{"address": "a", "totalPort": 10, "idlePort": 3,
                                  "chargingPort": 7, "faultPort": 0}]}
            if path == "nearArea/2":
                return {"data": [{"address": "b", "totalPort": 5, "idlePort": 1,
                                  "chargingPort": 4, "faultPort": 0}]}
            raise AssertionError(path)

        with patch("crawler.api.call", side_effect=fake_call):
            result = cloud_app.server_refresh_once(conn, self.httpd.db_lock)
        self.assertTrue(result.startswith("ok:1"), result)
        self.assertIn("skipped:1", result)
        # 1 条来自上传登记、1 条来自本轮刷新
        self.assertEqual(self.db_rows("SELECT COUNT(*) FROM snapshots")[0][0], 2)
        self.assertEqual(self.db_rows("SELECT COUNT(*) FROM area_samples")[0][0], 2)
        names = [r[0] for r in self.db_rows("SELECT name FROM areas")]
        self.assertNotIn("平台新区域", names)
        # 全部区非法才失败（不再整轮丢弃，但会明确返回 no-valid-area）
        def fake_unknown(path, params=None, **kwargs):
            if path == "user/userInfo":
                return {"data": {"projectId": "p1"}}
            if path == "nearArea/list":
                return {"data": [{"id": 9, "areaName": "另一个新区域"}]}
            return {"data": [{"address": "a", "totalPort": 1, "idlePort": 0,
                              "chargingPort": 1, "faultPort": 0}]}

        with patch("crawler.api.call", side_effect=fake_unknown):
            result = cloud_app.server_refresh_once(conn, self.httpd.db_lock)
        self.assertEqual(result, "no-valid-area:1")

    def test_server_refresh_retries_failed_area_on_next_token(self) -> None:
        from cloud import app as cloud_app
        self.assertEqual(self.post(self.payload())[0], 200)
        self.add_pool_token("111", ttl=5400)
        self.add_pool_token("222", ttl=3600)
        conn = self.httpd.RequestHandlerClass.db

        def fake_call(path, params=None, **kwargs):
            if path == "user/userInfo":
                return {"data": {"projectId": "p1", "projectName": "P"}}
            if path == "nearArea/list":
                return {"data": [{"id": 1, "areaName": "6号充电区"}]}
            if path == "nearArea/1":
                if kwargs.get("user_id") == "111":
                    raise RuntimeError("平台 500")
                return {"data": [{"address": "a", "totalPort": 10,
                                  "idlePort": 3, "chargingPort": 7, "faultPort": 0}]}
            raise AssertionError(path)

        with patch("crawler.api.call", side_effect=fake_call):
            result = cloud_app.server_refresh_once(conn, self.httpd.db_lock)
        self.assertTrue(result.startswith("ok:1"), result)
        self.assertNotIn("fail:", result)
        # 上传 1 条 + 本轮刷新 1 条
        self.assertEqual(self.db_rows("SELECT COUNT(*) FROM snapshots")[0][0], 2)
        exp = self.db_rows("SELECT expires_at FROM token_pool WHERE user_id='111'")[0][0]
        self.assertGreater(exp, int(time.time()))  # 非认证失败不打死 token

    def test_decrypt_fail_keeps_pool_row_and_uses_next_token(self) -> None:
        from cloud import app as cloud_app
        self.assertEqual(self.post(self.payload())[0], 200)  # 登记区域
        bad_exp = int(time.time()) + 5400
        with self.httpd.db_lock:
            conn = self.httpd.RequestHandlerClass.db
            conn.execute(
                "INSERT INTO token_pool(user_id, token, expires_at, updated_at, "
                "source, last_error) VALUES (?,?,?,?,?,?)",
                ("bad", "v1:not-a-valid-cipher", bad_exp,
                 time.strftime("%Y-%m-%d %H:%M:%S"), "test", None))
            conn.commit()
        self.add_pool_token("good", ttl=3600)
        conn = self.httpd.RequestHandlerClass.db

        def fake_call(path, params=None, **kwargs):
            if path == "user/userInfo":
                return {"data": {"projectId": "p1", "projectName": "P"}}
            if path == "nearArea/list":
                return {"data": [{"id": 1, "areaName": "6号充电区"}]}
            if path == "nearArea/1":
                return {"data": [{"address": "a", "totalPort": 10,
                                  "idlePort": 3, "chargingPort": 7, "faultPort": 0}]}
            raise AssertionError(path)

        with patch("crawler.api.call", side_effect=fake_call):
            result = cloud_app.server_refresh_once(conn, self.httpd.db_lock)
        self.assertTrue(result.startswith("ok:1"), result)
        row = self.db_rows(
            "SELECT expires_at, last_error FROM token_pool WHERE user_id='bad'")[0]
        self.assertEqual(row[0], bad_exp)       # H2：不把 expires_at 置 0
        self.assertIn("decrypt-fail", row[1])
        self.assertEqual(self.db_rows("SELECT COUNT(*) FROM snapshots")[0][0], 2)
        # 坏 token 不删除，但排在健康 token 之后
        candidates = cloud_app._pick_token(conn, self.httpd.db_lock)
        self.assertEqual(candidates[0][1], "good")

    def test_sync_ports_retries_next_token_on_platform_error(self) -> None:
        from cloud import app as cloud_app
        self.add_controller()
        self.add_pool_token("111", ttl=5400)
        self.add_pool_token("222", ttl=3600)

        def fake_call(path, params=None, **kwargs):
            if kwargs.get("user_id") == "111":
                raise RuntimeError("平台 500")
            return {"data": {"ports": [{"port": "01", "status": "空闲"}]}}

        conn = self.httpd.RequestHandlerClass.db
        with patch("crawler.api.call", side_effect=fake_call):
            result = cloud_app.sync_ports(conn, self.httpd.db_lock)
        self.assertEqual(result, "ok:1/1")
        self.assertEqual(self.db_rows("SELECT COUNT(*) FROM port_states")[0][0], 1)
        exp = self.db_rows("SELECT expires_at FROM token_pool WHERE user_id='111'")[0][0]
        self.assertGreater(exp, int(time.time()))

    def test_sync_ports_partial_failure_reports_fail(self) -> None:
        from cloud import app as cloud_app
        self.add_controller()  # 00AFEC05 / code 10001
        with self.httpd.db_lock:
            conn = self.httpd.RequestHandlerClass.db
            conn.execute(
                "INSERT INTO controllers(device_hex, code, area_id, area_name, "
                "updated_at) VALUES (?,?,?,?,?)",
                ("01AFEC05", "10002", "aid1", "6号充电区", "2026-01-01 00:00:00"))
            conn.commit()
        self.add_pool_token("111", ttl=3600)

        def fake_call(path, params=None, **kwargs):
            if params and params.get("deviceId") == "10002":
                raise RuntimeError("平台 500")
            return {"data": {"ports": [{"port": "01", "status": "空闲"}]}}

        with patch("crawler.api.call", side_effect=fake_call):
            result = cloud_app.sync_ports(conn, self.httpd.db_lock)
        self.assertTrue(result.startswith("ok:1/1"), result)
        self.assertIn("fail:1", result)
        self.assertFalse(cloud_app._round_ok("areas=ok:1|ports=" + result))

    def test_round_ok_requires_no_fail(self) -> None:
        from cloud import app as cloud_app
        self.assertTrue(cloud_app._round_ok("areas=ok:2|ports=ok:10/40"))
        self.assertTrue(cloud_app._round_ok(
            "areas=ok:2 skipped:1|ports=ok:10/40"))
        self.assertFalse(cloud_app._round_ok(
            "areas=ok:2 skipped:1 fail:1|ports=ok:10/40"))
        self.assertFalse(cloud_app._round_ok("areas=ok:2|ports=ok:10/40 fail:3"))
        self.assertFalse(cloud_app._round_ok("areas=no-token|ports=fail:3"))
        self.assertFalse(cloud_app._round_ok("areas=all-invalid:2|ports=no-token"))

    def test_refresh_partial_ports_failure_not_ok(self) -> None:
        from cloud import app as cloud_app
        cloud_app.REFRESH_LAST = 0.0
        with self.admin_env():
            code, headers, _ = self.admin_login("t", "t")
            self.assertEqual(code, 302)
            token = self.session_cookie(headers)
            with patch.object(cloud_app, "server_refresh_once", return_value="ok:1"), \
                    patch.object(cloud_app, "sync_ports", return_value="ok:2/20 fail:3"):
                req = urllib.request.Request(self.url("/api/refresh"), data=b"",
                                             method="POST")
                req.add_header("Cookie", "charge_admin=" + token)
                with urllib.request.urlopen(req, timeout=5) as resp:
                    data = json.loads(resp.read())
        self.assertFalse(data["ok"])
        self.assertIn("fail:3", data["result"])
        # A 方案：匿名请求必须被拒绝
        req = urllib.request.Request(self.url("/api/refresh"), data=b"", method="POST")
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            urllib.request.urlopen(req, timeout=5)
        self.assertEqual(ctx.exception.code, 401)

    # ------------------------------------------------------------------
    # task-9 回归：H5 状态白名单 / 重复设备合并
    # ------------------------------------------------------------------
    def test_upload_ports_status_whitelist_and_duplicate_device_merge(self) -> None:
        from cloud import app as cloud_app
        self.add_controller()
        ports = [
            {"device_hex": "00AFEC05", "ports": [
                {"port": "01", "status": "空闲"},
                {"port": "02", "status": "未知状态"}]},
            {"device_hex": "00afec05", "ports": [
                {"port": "01", "status": "故障"},
                {"port": "03", "status": "离线"}]},
        ]
        code, resp = self.post(self.ports_body(ports))
        self.assertEqual(code, 200, resp)
        rows = self.db_rows(
            "SELECT port, status FROM port_states WHERE device_hex = ? "
            "ORDER BY port", ("00AFEC05",))
        self.assertEqual(rows, [("01", "故障"), ("02", "未知状态"),
                                ("03", "离线")])
        data = self.get_json("/api/areas-ports")
        devices = {d["device_hex"]: d for area in data["areas"]
                   for d in area["devices"]}
        # 数据契约 v2：无法识别的状态保留原文，只把分组判为 unknown（不再是「其他」）
        self.assertEqual([p["status"] for p in devices["00AFEC05"]["ports"]],
                         ["故障", "未知状态", "离线"])
        self.assertEqual([p["group"] for p in devices["00AFEC05"]["ports"]],
                         ["unavailable", "unknown", "unavailable"])
        # 统计只用精确状态：含“空闲”子串的都不算空闲
        self.assertEqual(cloud_app._pile_counts(["空闲(故障)", "不空闲", "充电中"]),
                         (0, 3, 3))
        health = cloud_app._ports_health(
            [("01", "空闲(故障)", "2026-11-02 00:00:00")], "")
        self.assertEqual(health["free"], 0)
        self.assertEqual(health["state"], "full")

    # ------------------------------------------------------------------
    # task-9 回归：M3 areas-ports 单查询 + 缓存 + 上限
    # ------------------------------------------------------------------
    def test_areas_ports_join_cache_and_limit(self) -> None:
        from cloud import app as cloud_app
        stamp = "2026-11-02 00:00:00"
        with self.httpd.db_lock:
            conn = self.httpd.RequestHandlerClass.db
            for index in range(4):
                dev = "A%07d" % index
                conn.execute(
                    "INSERT INTO controllers(device_hex, code, area_id, area_name, "
                    "updated_at) VALUES (?,?,?,?,?)",
                    (dev, str(20000 + index), "a1", "6号充电区", stamp))
                for port in range(2):
                    conn.execute(
                        "INSERT INTO port_states(device_hex, port, status, updated_at) "
                        "VALUES (?,?,?,?)", (dev, "P%d" % port, "空闲", stamp))
            conn.commit()
        data = self.get_json("/api/areas-ports")
        self.assertTrue(data["ok"])
        devices = data["areas"][0]["devices"]
        self.assertEqual(len(devices), 4)
        self.assertEqual([d["device_hex"] for d in devices],
                         ["A0000000", "A0000001", "A0000002", "A0000003"])
        self.assertEqual(devices[0]["ports"],
                         [{"port": "P0", "status": "空闲", "group": "free"},
                          {"port": "P1", "status": "空闲", "group": "free"}])
        self.assertEqual((devices[0]["total"], devices[0]["free"]), (2, 2))
        # 30 秒缓存：绕过接口直接改库，第二次仍返回缓存值
        with self.httpd.db_lock:
            conn.execute("UPDATE port_states SET status='充电中'")
            conn.commit()
        cached = self.get_json("/api/areas-ports")
        self.assertEqual(
            cached["areas"][0]["devices"][0]["ports"][0]["status"], "空闲")
        cloud_app.invalidate_areas_ports_cache()
        fresh = self.get_json("/api/areas-ports")
        self.assertEqual(
            fresh["areas"][0]["devices"][0]["ports"][0]["status"], "充电中")
        # TTL：把缓存时间推回 60 秒前，第二次应重新查询
        with cloud_app.AREAS_PORTS_CACHE_LOCK:
            cloud_app.AREAS_PORTS_CACHE["ts"] = time.time() - 60
        expired = self.get_json("/api/areas-ports")
        self.assertEqual(
            expired["areas"][0]["devices"][0]["ports"][0]["status"], "充电中")
        # 设备上限
        cloud_app.invalidate_areas_ports_cache()
        with patch.object(cloud_app, "AREAS_PORTS_LIMIT", 2):
            limited = self.get_json("/api/areas-ports")
        self.assertEqual(len(limited["areas"][0]["devices"]), 2)

    def test_areas_ports_cache_invalidated_by_upload(self) -> None:
        self.add_controller()
        self.post_ports("00AFEC05", "空闲")
        first = self.get_json("/api/areas-ports")
        self.assertEqual(
            first["areas"][0]["devices"][0]["ports"][0]["status"], "空闲")
        self.post_ports("00AFEC05", "充电中")
        second = self.get_json("/api/areas-ports")
        self.assertEqual(
            second["areas"][0]["devices"][0]["ports"][0]["status"], "充电中")

    # ------------------------------------------------------------------
    # task-9 追加：/api/device/register 409 细分 code
    # ------------------------------------------------------------------
    def test_register_409_codes(self) -> None:
        def register(device_id: str, secret: str):
            body = json.dumps({"device_id": device_id, "secret": secret}).encode()
            req = urllib.request.Request(
                self.url("/api/device/register"), data=body, method="POST",
                headers={"Content-Type": "application/json"})
            try:
                with urllib.request.urlopen(req, timeout=5) as resp:
                    return resp.status, json.loads(resp.read())
            except urllib.error.HTTPError as exc:
                return exc.code, json.loads(exc.read())

        code, payload = register(self.device_id, "c" * 64)
        self.assertEqual(code, 409)
        self.assertEqual(payload["code"], "secret_mismatch")
        self.assertEqual(payload["error"], "device_id 已被注册，请联系管理员重置")

        with self.httpd.db_lock:
            conn = self.httpd.RequestHandlerClass.db
            conn.execute("UPDATE devices SET revoked=1 WHERE device_id=?",
                         (self.device_id,))
            conn.commit()
        code, payload = register(self.device_id, self.device_secret)
        self.assertEqual(code, 409)
        self.assertEqual(payload["code"], "revoked")
        self.assertEqual(payload["error"], "设备已被撤销，请联系管理员")

    # ------------------------------------------------------------------
    # task-12：/api/now 到达预测字段
    # ------------------------------------------------------------------
    def test_now_prediction_fields_normal_and_eta(self) -> None:
        from cloud import app as cloud_app
        # 固定到整点后的第 30 分钟：既避开小时/星期边界，也让趋势样本全部落在同一窗口。
        fixed = datetime.now().replace(minute=30, second=0, microsecond=0)

        class FixedDateTime:
            @staticmethod
            def now():
                return fixed

        now = fixed
        trend_times = [now - timedelta(minutes=minutes)
                       for minutes in (27, 19, 11, 3)]
        # 当前快照：A 有空位、B/C 满；快照样本在 1 天前，避免污染趋势窗口
        self.add_now_snapshot([("预测区A", 7, 16), ("预测区B", 0, 10),
                               ("预测区C", 0, 10)])
        # A：idle 1,2,3,4 → 斜率 0.125/分钟 → trend_10m=1.25
        for ts, idle in zip(trend_times, (1, 2, 3, 4)):
            self.insert_area_sample("预测区A", ts.strftime("%Y-%m-%d %H:%M:%S"),
                                    idle, 16)
        # B：idle 0,0,1,2 → 0.875/10 分钟
        for ts, idle in zip(trend_times, (0, 0, 1, 2)):
            self.insert_area_sample("预测区B", ts.strftime("%Y-%m-%d %H:%M:%S"),
                                    idle, 10)
        # A/B/C 历史样本：7 天前同一星期+小时（不进趋势窗口）
        hist_stamp = (now - timedelta(days=7)).strftime("%Y-%m-%d %H:%M:%S")
        for _ in range(6):
            self.insert_area_sample("预测区A", hist_stamp, 2, 16)
            self.insert_area_sample("预测区B", hist_stamp, 0, 10)
        for idle in (1, 1, 1, 0, 0, 0):
            self.insert_area_sample("预测区C", hist_stamp, idle, 10)

        with patch.object(cloud_app, "datetime", FixedDateTime):
            areas = {item["name"]: item for item in
                     self.get_json("/api/now")["areas"]}
        self.assertEqual(set(areas), {"预测区A", "预测区B", "预测区C"})

        a = areas["预测区A"]
        self.assertAlmostEqual(a["hist_free_rate"], 1.0, places=4)
        self.assertGreaterEqual(a["hist_samples"], 6)
        # 完全线性的 1,2,3,4：t 统计量极大，收缩几乎为 0，趋势仍是 1.25/10 分钟
        self.assertAlmostEqual(a["trend_10m"], 1.25, delta=0.02)
        # 新版点估计=持久化值：10 分钟尺度上 MAE 最优（见 tools/backtest_prediction.py）
        self.assertEqual(a["predicted_idle"], 7.0)
        self.assertIsNone(a["eta_min"])            # 已有空位时不计算等待时间
        self.assertEqual(a["confidence"], "high")
        self.assertAlmostEqual(a["p_free_10m"], 1.0, delta=0.001)
        # 旧字段保持不变
        self.assertEqual((a["idle"], a["total"]), (7, 16))
        self.assertIn("score", a)
        self.assertIn("delta", a)

        b = areas["预测区B"]
        # 0,0,1,2：残差不为 0，t 统计量约 4，斜率被收缩到 0.56 左右
        self.assertLess(b["trend_10m"], 0.875)
        self.assertGreater(b["trend_10m"], 0.3)
        # 预测空闲数不再用趋势外推：满区的最好点估计仍是 0
        self.assertEqual(b["predicted_idle"], 0.0)
        # 满区概率/ETA 来自释放风险率，落在 (0, 0.5) 且 ETA 为正
        self.assertGreater(b["p_free_10m"], 0.0)
        self.assertLess(b["p_free_10m"], 0.5)
        self.assertGreaterEqual(b["eta_min"], 1)
        self.assertLessEqual(b["eta_min"], 120)
        self.assertEqual(b["confidence"], "high")

        c = areas["预测区C"]
        self.assertIsNone(c["trend_10m"])          # 无近 30 分钟样本
        self.assertEqual(c["predicted_idle"], 0.0)  # 有历史即给持久化点估计
        self.assertEqual(c["hist_samples"], 6)
        self.assertAlmostEqual(c["hist_free_rate"], 0.5, places=4)
        # 满区 ETA 不再用同星期同小时空闲率（n=1 时 0/1 极端值），改用释放风险率
        self.assertGreaterEqual(c["eta_min"], 1)
        self.assertLessEqual(c["eta_min"], 120)
        self.assertGreater(c["p_free_10m"], 0.0)
        self.assertLess(c["p_free_10m"], 0.5)
        self.assertEqual(c["confidence"], "medium")

    def test_now_prediction_fields_types(self) -> None:
        from cloud import app as cloud_app
        fixed = datetime.now().replace(minute=30, second=0, microsecond=0)

        class FixedDateTime:
            @staticmethod
            def now():
                return fixed

        now = fixed
        self.add_now_snapshot([("类型区", 0, 10)])
        for minutes, idle in ((20, 2), (10, 1), (0, 3)):
            self.insert_area_sample(
                "类型区", (now - timedelta(minutes=minutes)).strftime(
                    "%Y-%m-%d %H:%M:%S"), idle, 10)
        hist_stamp = (now - timedelta(days=7)).strftime("%Y-%m-%d %H:%M:%S")
        for _ in range(3):
            self.insert_area_sample("类型区", hist_stamp, 1, 10)

        with patch.object(cloud_app, "datetime", FixedDateTime):
            item = self.get_json("/api/now")["areas"][0]
        self.assertIsInstance(item["hist_free_rate"], float)
        self.assertTrue(0.0 <= item["hist_free_rate"] <= 1.0)
        self.assertIsInstance(item["hist_samples"], int)
        self.assertGreater(item["hist_samples"], 0)
        self.assertIsInstance(item["trend_10m"], float)
        self.assertIsInstance(item["predicted_idle"], float)
        self.assertGreaterEqual(item["predicted_idle"], 0.0)
        self.assertIsInstance(item["eta_min"], int)
        self.assertIsInstance(item["p_free_10m"], float)
        self.assertTrue(0.0 <= item["p_free_10m"] <= 1.0)
        self.assertIn(item["confidence"], ("high", "medium", "low"))
        for key in ("name", "idle", "total", "delta", "distance_m", "score"):
            self.assertIn(key, item)

    def test_now_prediction_fields_empty_without_samples(self) -> None:
        old_stamp = (datetime.now() - timedelta(days=20)).strftime(
            "%Y-%m-%d %H:%M:%S")
        with self.httpd.db_lock:
            conn = self.httpd.RequestHandlerClass.db
            cur = conn.execute(
                "INSERT INTO snapshots(received_at, captured_at, project, "
                "app_version, token_user, client_ip, body_sha256, payload) "
                "VALUES (?,?,?,?,?,?,?,?)",
                (old_stamp, old_stamp, "P", "server", "", "server",
                 secrets.token_hex(16), "{}"))
            sid = cur.lastrowid
            conn.execute(
                "INSERT INTO area_samples(snapshot_id, area_id, area_name, idle, "
                "total, charging, fault, received_at) VALUES (?,?,?,?,?,?,?,?)",
                (sid, "aid", "无历史区", 3, 10, 7, 0, old_stamp))
            conn.commit()
        items = self.get_json("/api/now")["areas"]
        self.assertEqual(len(items), 1)
        item = items[0]
        for key in ("hist_free_rate", "hist_samples", "trend_10m",
                    "predicted_idle", "eta_min", "confidence", "p_free_10m"):
            self.assertIsNone(item[key], key)
        # 旧字段不受影响
        self.assertEqual((item["idle"], item["total"]), (3, 10))
        self.assertEqual(item["delta"], 0)

    def test_now_prediction_no_n_plus_one_39_areas(self) -> None:
        names = ["%02d号预测区" % index for index in range(39)]
        self.add_now_snapshot([(name, 5, 10) for name in names])
        now = datetime.now()
        for name in names:
            self.insert_area_sample(
                name, (now - timedelta(minutes=20)).strftime(
                    "%Y-%m-%d %H:%M:%S"), 3, 10)
            self.insert_area_sample(
                name, (now - timedelta(minutes=5)).strftime(
                    "%Y-%m-%d %H:%M:%S"), 5, 10)

        conn = self.httpd.RequestHandlerClass.db
        statements: list = []
        conn.set_trace_callback(statements.append)
        try:
            data = self.get_json("/api/now")
        finally:
            conn.set_trace_callback(None)
        self.assertEqual(len(data["areas"]), 39)
        for item in data["areas"]:
            for key in ("hist_free_rate", "hist_samples", "trend_10m",
                        "predicted_idle", "eta_min", "confidence", "p_free_10m"):
                self.assertIn(key, item)
        area_sql = [s for s in statements if "FROM area_samples" in s]
        # 当前快照 + 30 分钟基线 + 两条聚合（hist/trend + 满区释放风险率），
        # 不随 39 个区增加；第二条聚合用 LAG 窗口函数一次扫表。
        self.assertLessEqual(len(area_sql), 4, area_sql)
        self.assertLessEqual(len(statements), 8, statements)

    def test_prediction_fields_formula_and_trend_shrink(self) -> None:
        """模型公式单测：持久化点估计、p_free、ETA 与 t 统计量收缩。"""
        from cloud import app as cloud_app

        # 无任何样本：全部预测字段为 None（含新增 p_free_10m）
        empty = cloud_app.prediction_fields("无样本区", 3, {}, 10)
        for key in ("hist_free_rate", "hist_samples", "trend_10m",
                    "predicted_idle", "eta_min", "confidence", "p_free_10m"):
            self.assertIsNone(empty[key], key)

        stats = {"某区": {"hist_samples": 10, "hist_free": 5, "trend_n": 0,
                          "haz_known": True, "haz_exp": 0.0,
                          "p_zero": 0.2, "eta_zero_min": 17}}
        free = cloud_app.prediction_fields("某区", 4, stats, 10)
        self.assertEqual(free["predicted_idle"], 4.0)
        self.assertAlmostEqual(free["p_free_10m"],
                               round(1.0 - (1.0 - cloud_app.NOW_FREE_KEEP_10M) ** 4, 4),
                               places=4)
        self.assertIsNone(free["eta_min"])       # 有空位时不给等待时间
        self.assertAlmostEqual(free["hist_free_rate"], 0.5, places=4)
        full = cloud_app.prediction_fields("某区", 0, stats, 10)
        self.assertEqual(full["predicted_idle"], 0.0)
        self.assertAlmostEqual(full["p_free_10m"], 0.2, places=4)
        self.assertEqual(full["eta_min"], 17)
        self.assertTrue(0.0 <= full["p_free_10m"] <= 1.0)

        # 干净线性关系 y=1,2,3,4（x=-27,-19,-11,-3 分钟）：t 很大 → 不收缩
        clean = {"trend_n": 4, "tmin": 0.0, "tmax": 24.0 / 1440.0,
                 "sx": -60.0, "sy": 10.0, "sxy": -110.0, "sxx": 1220.0,
                 "syy": 30.0}
        trend, n = cloud_app._trend_10m(clean)
        self.assertEqual(n, 4)
        self.assertAlmostEqual(trend, 1.25, places=2)
        # 同跨度但残差很大：t 小 → 斜率被显著收缩（|trend| < 0.2）
        noisy = dict(clean, sy=10.0, sxy=-126.0, syy=34.0)
        trend_noisy, _ = cloud_app._trend_10m(noisy)
        self.assertLess(abs(trend_noisy), 0.2)
        # 样本不足 / 跨度不足：返回 None
        self.assertIsNone(cloud_app._trend_10m(
            {"trend_n": 2, "tmin": 0.0, "tmax": 24.0 / 1440.0})[0])
        self.assertIsNone(cloud_app._trend_10m(
            {"trend_n": 4, "tmin": 0.0, "tmax": 2.0 / 1440.0})[0])

    # ------------------------------------------------------------------
    # task-25：p_free_at_arrival / 预测 single-flight / analytics 固定槽
    # ------------------------------------------------------------------
    def test_p_free_at_arrival_distance_and_null(self) -> None:
        from cloud import app as cloud_app
        stamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        self.add_now_snapshot([("到达区", 5, 10)])
        hist_stamp = (datetime.now() - timedelta(days=7)).strftime(
            "%Y-%m-%d %H:%M:%S")
        for _ in range(3):
            self.insert_area_sample("到达区", hist_stamp, 2, 10)
        with self.httpd.db_lock:
            conn = self.httpd.RequestHandlerClass.db
            conn.execute(
                "INSERT INTO areas(area_id, name, first_seen, last_seen, lat, lng) "
                "VALUES (?,?,?,?,?,?)",
                ("aid-到达区", "到达区", stamp, stamp, 0.0072, 0.0))
            conn.commit()

        with urllib.request.urlopen(
                self.url("/api/now?lat=0&lng=0"), timeout=5) as resp:
            item = json.loads(resp.read())["areas"][0]
        self.assertEqual(item["name"], "到达区")
        self.assertTrue(800 <= item["distance_m"] <= 810, item["distance_m"])
        self.assertAlmostEqual(item["p_free_10m"],
                               round(1 - (1 - cloud_app.NOW_FREE_KEEP_10M) ** 5, 4),
                               places=4)
        walk = max(1, math.ceil(item["distance_m"] / cloud_app.NOW_WALK_M_PER_MIN))
        keep = cloud_app.NOW_FREE_KEEP_10M ** (walk / 10.0)
        self.assertAlmostEqual(
            item["p_free_at_arrival"],
            round(1 - (1 - keep) ** 5, 4), places=4)

        with urllib.request.urlopen(self.url("/api/now"), timeout=5) as resp:
            plain = json.loads(resp.read())["areas"][0]
        self.assertIsNone(plain["distance_m"])
        self.assertIsNone(plain["p_free_at_arrival"])  # 无坐标不猜到达概率

    def test_prediction_cache_single_flight_and_invalidate(self) -> None:
        from cloud import app as cloud_app
        tmp = tempfile.TemporaryDirectory()
        db_path = Path(tmp.name) / "predict.db"
        conn = cloud_app.init_db(db_path)
        conn.close()
        cloud_app.invalidate_prediction_cache()
        calls: list = []

        def slow(_db_path):
            calls.append(1)
            time.sleep(0.2)
            return {"shared": {"hist_samples": 1}}

        orig = cloud_app.prediction_stats
        cloud_app.prediction_stats = slow
        try:
            results: list = []
            barrier = threading.Barrier(6)

            def worker():
                barrier.wait()
                results.append(cloud_app.prediction_stats_cached(str(db_path)))

            threads = [threading.Thread(target=worker) for _ in range(6)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(timeout=5)
        finally:
            cloud_app.prediction_stats = orig
            tmp.cleanup()
        self.assertEqual(len(calls), 1)
        self.assertEqual(len(results), 6)
        self.assertTrue(all(item == results[0] for item in results))
        cloud_app.invalidate_prediction_cache()

    def test_analytics_fixed_15min_slots_and_empty_ratios(self) -> None:
        from cloud import app as cloud_app
        conn = self.httpd.RequestHandlerClass.db
        now = datetime.now().replace(second=0, microsecond=0)
        slot = now.replace(minute=(now.minute // 15) * 15)
        with self.httpd.db_lock:
            conn.execute(
                "INSERT INTO areas(area_id, name, first_seen, last_seen) "
                "VALUES (?,?,?,?)", ("aid1", "6号充电区", slot, slot))
            for ts, idle in ((slot, 3), (slot - timedelta(minutes=30), 5)):
                conn.execute(
                    "INSERT INTO area_samples(snapshot_id, area_id, area_name, "
                    "idle, total, charging, fault, received_at) "
                    "VALUES (?,?,?,?,?,?,?,?)",
                    (1, "aid1", "6号充电区", idle, 10, 10 - idle, 0,
                     ts.strftime("%Y-%m-%d %H:%M:%S")))
            conn.commit()
        data = cloud_app.build_analytics(conn, "6号充电区", 8)
        self.assertEqual(len(data["trend_24h"]), 96)
        self.assertEqual(len(data["trend_7d"]), 7)
        self.assertTrue(all(re.match(r"^\d{2}:\d{2}$", p["t"])
                            for p in data["trend_24h"]))
        nonempty = [p for p in data["trend_24h"] if p["ratio"] is not None]
        self.assertGreaterEqual(len(nonempty), 2)
        self.assertGreater(len(data["trend_24h"]) - len(nonempty), 0)

    def test_area_ports_join_cache_and_invalidation(self) -> None:
        from cloud import app as cloud_app
        self.add_controller()
        self.post_ports("00AFEC05", "空闲")
        area = urllib.parse.quote("6号充电区")
        first = self.get_json("/api/area-ports?area=" + area)
        self.assertEqual(first["devices"][0]["ports"][0]["status"], "空闲")
        with self.httpd.db_lock:
            self.httpd.RequestHandlerClass.db.execute(
                "UPDATE port_states SET status='充电中'")
            self.httpd.RequestHandlerClass.db.commit()
        cached = self.get_json("/api/area-ports?area=" + area)
        self.assertEqual(cached["devices"][0]["ports"][0]["status"], "空闲")
        cloud_app.invalidate_areas_ports_cache()
        fresh = self.get_json("/api/area-ports?area=" + area)
        self.assertEqual(fresh["devices"][0]["ports"][0]["status"], "充电中")

    def test_areas_ports_truncated_total(self) -> None:
        from cloud import app as cloud_app
        stamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        with self.httpd.db_lock:
            conn = self.httpd.RequestHandlerClass.db
            for index in range(3):
                dev = "T%07d" % index
                conn.execute(
                    "INSERT INTO controllers(device_hex, code, area_id, area_name, "
                    "updated_at) VALUES (?,?,?,?,?)",
                    (dev, str(40000 + index), "aid", "截断区", stamp))
                conn.execute(
                    "INSERT INTO port_states(device_hex, port, status, updated_at) "
                    "VALUES (?,?,?,?)", (dev, "01", "空闲", stamp))
            conn.commit()
        cloud_app.invalidate_areas_ports_cache()
        with patch.object(cloud_app, "AREAS_PORTS_LIMIT", 2):
            data = self.get_json("/api/areas-ports")
        self.assertEqual(data["total"], 3)
        self.assertTrue(data["truncated"])
        self.assertEqual(sum(len(area["devices"]) for area in data["areas"]), 2)

    # ------------------------------------------------------------------
    # task-25：token_key fail-fast / admin reset-secret
    # ------------------------------------------------------------------
    def test_token_key_fail_fast_when_missing_or_mismatched(self) -> None:
        from cloud import app as cloud_app
        tmp = tempfile.TemporaryDirectory()
        root = Path(tmp.name)
        db_path = root / "charge.db"
        key_a = root / "key_a"
        key_a.write_text("aa" * 32, encoding="ascii")
        old_key = cloud_app.TOKEN_KEY_FILE
        cloud_app.TOKEN_KEY_FILE = str(key_a)
        conn = cloud_app.init_db(db_path)
        secret_enc = cloud_app.encrypt_token("b" * 64)
        with conn:
            conn.execute(
                "INSERT INTO devices(device_id, secret_enc, created_at, status) "
                "VALUES (?,?,?,?)", ("dev-1", secret_enc,
                                     time.strftime("%Y-%m-%d %H:%M:%S"), "approved"))
        conn.close()

        (root / "secret.txt").write_text("s" * 64, encoding="utf-8")
        (root / "version.json").write_text("{}", encoding="utf-8")
        (root / "download").mkdir()
        web = root / "web"
        web.mkdir()
        (web / "admin.html").write_text("<html></html>", encoding="utf-8")

        def server():
            return cloud_app.create_server(
                db_path, root / "secret.txt", root / "version.json",
                root / "download", "127.0.0.1", 0, web_dir=web, workers=False)

        try:
            cloud_app.TOKEN_KEY_FILE = str(root / "missing_key")
            with self.assertRaises(RuntimeError):
                server()
            key_b = root / "key_b"
            key_b.write_text("bb" * 32, encoding="ascii")
            cloud_app.TOKEN_KEY_FILE = str(key_b)
            with self.assertRaises(RuntimeError):
                server()
        finally:
            cloud_app.TOKEN_KEY_FILE = old_key
            tmp.cleanup()

    def test_admin_reset_secret_allows_reregister(self) -> None:
        from cloud import app as cloud_app
        with self.admin_env():
            token = self.admin_token()
            code, _, body = self.admin_json(
                "/admin/api/devices/reset-secret",
                {"device_id": self.device_id}, token)
            self.assertEqual(code, 200, body)
        new_secret = "c" * 64
        body = json.dumps({"device_id": self.device_id,
                           "secret": new_secret}).encode()
        req = urllib.request.Request(
            self.url("/api/device/register"), data=body, method="POST",
            headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=5) as resp:
            self.assertEqual(resp.status, 200)
        # 旧 secret 已失效；新 secret 可正常上传
        code, _ = self.post_as(self.device_id, self.device_secret,
                               self.payload())
        self.assertEqual(code, 401)
        code, _ = self.post_as(self.device_id, new_secret, self.payload())
        self.assertEqual(code, 200)

    def test_admin_reset_secret_requires_admin_and_404(self) -> None:
        req = urllib.request.Request(
            self.url("/admin/api/devices/reset-secret"),
            data=json.dumps({"device_id": self.device_id}).encode(),
            method="POST", headers={"Content-Type": "application/json"})
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            urllib.request.urlopen(req, timeout=5)
        self.assertEqual(ctx.exception.code, 401)
        with self.admin_env():
            token = self.admin_token()
            code, _, _ = self.admin_json(
                "/admin/api/devices/reset-secret",
                {"device_id": "does-not-exist"}, token)
            self.assertEqual(code, 404)

    # ------------------------------------------------------------------
    # task-25：CSV / revoke / audit / health / refresh / anomalies
    # ------------------------------------------------------------------
    def test_export_csv_injection_and_revoke_validation(self) -> None:
        with self.httpd.db_lock:
            conn = self.httpd.RequestHandlerClass.db
            conn.execute(
                "INSERT INTO upload_audit(ts, ip, ua, size, result, detail) "
                "VALUES (?,?,?,?,?,?)",
                (datetime.now().strftime("%Y-%m-%d %H:%M:%S"), "127.0.0.1",
                 "ua", 1, "ok", " =cmd|' /C calc'!A0"))
            conn.commit()
        with self.admin_env():
            token = self.admin_token()
            code, _, body = self.admin_req(
                "/admin/api/export.csv?table=audit", token=token)
            self.assertEqual(code, 200)
            text = body.decode("utf-8-sig")
            self.assertIn("' =cmd", text)
            for payload in ({}, {"device_id": self.device_id,
                                 "revoked": "false"},
                            {"device_id": "missing-device", "revoked": True}):
                code, _, _ = self.admin_json(
                    "/admin/api/device/revoke", payload, token)
                self.assertEqual(code, 404 if payload.get("device_id") == "missing-device"
                                 else 400, payload)

    def test_worker_prunes_old_upload_audit(self) -> None:
        from cloud import app as cloud_app
        old = (datetime.now() - timedelta(days=91)).strftime(
            "%Y-%m-%d %H:%M:%S")
        with self.httpd.db_lock:
            conn = self.httpd.RequestHandlerClass.db
            conn.execute(
                "INSERT INTO upload_audit(ts, ip, ua, size, result, detail) "
                "VALUES (?,?,?,?,?,?)", (old, "1.1.1.1", "ua", 1, "ok", "old"))
            conn.commit()
        with patch.object(cloud_app, "refresh_round",
                          return_value="areas=no-token|ports=no-token"):
            cloud_app.worker_round(self.httpd)
        rows = self.db_rows("SELECT COUNT(*) FROM upload_audit WHERE ts = ?",
                            (old,))
        self.assertEqual(rows[0][0], 0)

    def test_health_summary_and_cache(self) -> None:
        from cloud import app as cloud_app
        with urllib.request.urlopen(self.url("/health"), timeout=5) as resp:
            data = json.loads(resp.read())
        self.assertTrue(data["ok"])
        self.assertEqual(data["db"], "ok")
        for key in ("worker", "token_pool", "last_snapshot", "error_count"):
            self.assertIn(key, data)
        cloud_app.HEALTH_CACHE.clear()
        calls: list = []
        original = cloud_app.health_stats
        cloud_app.health_stats = lambda conn, lock: (calls.append(1), {
            "stale_devices": 0, "error_tokens": 0, "error_count": 0})[1]
        try:
            conn = self.httpd.RequestHandlerClass.db
            cloud_app.health_stats_cached(conn, self.httpd.db_lock,
                                          str(self.httpd.db_path))
            cloud_app.health_stats_cached(conn, self.httpd.db_lock,
                                          str(self.httpd.db_path))
        finally:
            cloud_app.health_stats = original
            cloud_app.HEALTH_CACHE.clear()
        self.assertEqual(len(calls), 1)

    def test_refresh_failure_does_not_consume_cooldown_and_origin(self) -> None:
        from cloud import app as cloud_app
        with self.admin_env():
            token = self.admin_token()

            def refresh(origin=None):
                req = urllib.request.Request(self.url("/api/refresh"), data=b"",
                                             method="POST")
                req.add_header("Cookie", "charge_admin=" + token)
                if origin:
                    req.add_header("Origin", origin)
                try:
                    with urllib.request.urlopen(req, timeout=5) as resp:
                        return resp.status, json.loads(resp.read())
                except urllib.error.HTTPError as exc:
                    return exc.code, json.loads(exc.read())

            cloud_app.REFRESH_LAST = 0.0
            cloud_app.RATE.clear()
            with patch.object(cloud_app, "refresh_round",
                              return_value="areas=no-token|ports=no-token"):
                self.assertEqual(refresh()[0], 200)
                self.assertEqual(refresh()[0], 200)  # 失败不占冷却
            cloud_app.REFRESH_LAST = 0.0
            cloud_app.RATE.clear()
            with patch.object(cloud_app, "refresh_round",
                              return_value="areas=ok:1|ports=ok:1/1"):
                self.assertEqual(refresh()[0], 200)
                self.assertEqual(refresh()[0], 429)  # 成功后冷却
            cloud_app.REFRESH_LAST = 0.0
            cloud_app.RATE.clear()
            self.assertEqual(refresh("http://evil.example")[0], 403)

    def test_anomalies_snapshot_threshold_1800(self) -> None:
        stamp = (datetime.now() - timedelta(minutes=16)).strftime(
            "%Y-%m-%d %H:%M:%S")
        with self.httpd.db_lock:
            conn = self.httpd.RequestHandlerClass.db
            conn.execute(
                "INSERT INTO snapshots(received_at, captured_at, project, "
                "app_version, token_user, client_ip, body_sha256, payload) "
                "VALUES (?,?,?,?,?,?,?,?)",
                (stamp, stamp, "P", "server", "", "server", "sha-health", "{}"))
            conn.commit()
        with self.admin_env():
            token = self.admin_token()
            code, _, body = self.admin_req("/admin/api/anomalies", token=token)
            self.assertEqual(code, 200)
            titles = [item["title"] for item in json.loads(body)["items"]]
            self.assertFalse(any("数据超过" in title for title in titles))
            with self.httpd.db_lock:
                self.httpd.RequestHandlerClass.db.execute(
                    "UPDATE snapshots SET received_at = ?",
                    ((datetime.now() - timedelta(minutes=31)).strftime(
                        "%Y-%m-%d %H:%M:%S"),))
                self.httpd.RequestHandlerClass.db.commit()
            code, _, body = self.admin_req("/admin/api/anomalies", token=token)
            titles = [item["title"] for item in json.loads(body)["items"]]
            self.assertTrue(any("数据超过 30 分钟" in title for title in titles))

    def test_anonymous_area_ports_does_not_trigger_sync(self) -> None:
        from cloud import app as cloud_app
        self.add_controller()
        old = (datetime.now() - timedelta(minutes=20)).strftime(
            "%Y-%m-%d %H:%M:%S")
        with self.httpd.db_lock:
            conn = self.httpd.RequestHandlerClass.db
            conn.execute(
                "INSERT INTO port_states(device_hex, port, status, updated_at) "
                "VALUES (?,?,?,?)", ("00AFEC05", "01", "空闲", old))
            conn.commit()
        called: list = []
        original = cloud_app.sync_ports
        cloud_app.sync_ports = lambda *args, **kwargs: (called.append(1), "ok")[1]
        try:
            self.get_json("/api/area-ports?area=" +
                          urllib.parse.quote("6号充电区"))
            time.sleep(0.3)
        finally:
            cloud_app.sync_ports = original
        self.assertEqual(called, [])

    def test_analytics_unknown_area_and_miss_quota(self) -> None:
        from cloud import app as cloud_app
        stamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        with self.httpd.db_lock:
            conn = self.httpd.RequestHandlerClass.db
            conn.execute(
                "INSERT INTO areas(area_id, name, first_seen, last_seen) "
                "VALUES (?,?,?,?)", ("aid1", "6号充电区", stamp, stamp))
            conn.commit()
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            urllib.request.urlopen(
                self.url("/api/analytics?area=" + urllib.parse.quote("不存在区")),
                timeout=5)
        self.assertEqual(ctx.exception.code, 400)
        cloud_app.ANALYTICS_CACHE.clear()
        cloud_app.RATE.clear()
        with patch.object(cloud_app, "ANALYTICS_MISS_LIMIT", 1):
            self.assertEqual(self.get_json("/api/analytics")["ok"], True)
            self.assertEqual(self.get_json("/api/analytics")["ok"], True)  # 命中缓存
            cloud_app.ANALYTICS_CACHE.clear()
            with self.assertRaises(urllib.error.HTTPError) as ctx:
                urllib.request.urlopen(self.url("/api/analytics"), timeout=5)
            self.assertEqual(ctx.exception.code, 429)

    def test_register_invalid_does_not_consume_quota(self) -> None:
        def register(device_id: str, secret: str):
            body = json.dumps({"device_id": device_id, "secret": secret}).encode()
            req = urllib.request.Request(
                self.url("/api/device/register"), data=body, method="POST",
                headers={"Content-Type": "application/json"})
            try:
                with urllib.request.urlopen(req, timeout=5) as resp:
                    return resp.status, json.loads(resp.read())
            except urllib.error.HTTPError as exc:
                return exc.code, json.loads(exc.read())

        for index in range(6):
            code, _ = register("bad-%d" % index, "d" * 64)
            self.assertEqual(code, 400)
        code, _ = register("0011223344556677", "e" * 64)
        self.assertEqual(code, 200)

    def test_prediction_cache_invalidated_by_upload(self) -> None:
        from cloud import app as cloud_app
        cloud_app.invalidate_prediction_cache()
        self.assertEqual(self.post(self.payload())[0], 200)
        first = self.get_json("/api/now")["areas"][0]["hist_samples"]
        self.assertEqual(first, 1)
        self.assertEqual(self.post(self.payload())[0], 200)
        second = self.get_json("/api/now")["areas"][0]["hist_samples"]
        self.assertEqual(second, 2)

    def test_backup_scripts_with_temp_dirs(self) -> None:
        import os
        import shutil
        import subprocess
        import sys
        from tools import backup_check

        bash = shutil.which("bash")
        if not bash:
            candidate = Path(r"C:\Program Files\Git\bin\bash.exe")
            if candidate.exists():
                bash = str(candidate)
        if not bash:
            self.skipTest("bash unavailable")

        root = Path(tempfile.mkdtemp())
        try:
            db_path = root / "charge.db"
            conn = sqlite3.connect(db_path)
            conn.execute("CREATE TABLE sample(id INTEGER PRIMARY KEY)")
            conn.commit()
            conn.close()
            config_root = root / "etc"
            (config_root / "charge-cloud").mkdir(parents=True)
            (config_root / "charge-cloud" / "admin.env").write_text(
                "ADMIN_USER=admin\n", encoding="utf-8")
            state = root / "state"
            state.mkdir()
            (state / "token_key").write_text("11" * 32, encoding="ascii")
            (state / "version.json").write_text("{}", encoding="utf-8")
            source = root / "source"
            (source / "cloud").mkdir(parents=True)
            (source / "cloud" / "app.py").write_text("# x\n", encoding="utf-8")
            backups = root / "backups"
            bundle_dest = backups / "nas"
            deploy = Path(__file__).resolve().parents[1] / "cloud" / "deploy"
            env = dict(os.environ,
                       CHARGE_DB=str(db_path),
                       CHARGE_BACKUP_DIR=str(backups),
                       CHARGE_CONFIG_DIR=str(config_root),
                       CHARGE_STATE_DIR=str(state),
                       CHARGE_SOURCE_DIR=str(source),
                       CHARGE_BUNDLE_DIR=str(bundle_dest),
                       CHARGE_SKIP_CHOWN="1",
                       PYTHON=str(Path(sys.executable)),
                       TZ="Asia/Shanghai")

            def run(script_name: str) -> None:
                script = str(deploy / script_name)
                if os.name == "nt":
                    wrapper = (
                        'for v in CHARGE_DB CHARGE_BACKUP_DIR CHARGE_CONFIG_DIR '
                        'CHARGE_STATE_DIR CHARGE_SOURCE_DIR CHARGE_BUNDLE_DIR PYTHON; do '
                        'eval export "$v=$(cygpath -u "${!v}")"; done; '
                        f'bash "{script}"')
                else:
                    wrapper = f'bash "{script}"'
                subprocess.run([bash, "-lc", wrapper], env=env, check=True,
                               capture_output=True, text=True)

            run("charge-db-backup.sh")
            errors, warnings = backup_check.verify_backup_dir(backups)
            self.assertEqual(errors, [], (errors, warnings))
            run("charge-backup-bundle.sh")
            bundles = sorted(bundle_dest.glob("daily/*.tar.gz"))
            self.assertTrue(bundles)
            errors, warnings = backup_check.verify_bundle(bundles[-1])
            self.assertEqual(errors, [], (errors, warnings))
        finally:
            import shutil as _shutil
            _shutil.rmtree(root, ignore_errors=True)

    def test_register_encrypt_error_returns_503(self) -> None:
        from cloud import app as cloud_app
        original = cloud_app.encrypt_token
        cloud_app.encrypt_token = lambda token: (_ for _ in ()).throw(
            RuntimeError("key lost"))
        try:
            body = json.dumps({"device_id": "0011223344556688",
                               "secret": "f" * 64}).encode()
            req = urllib.request.Request(
                self.url("/api/device/register"), data=body, method="POST",
                headers={"Content-Type": "application/json"})
            with self.assertRaises(urllib.error.HTTPError) as ctx:
                urllib.request.urlopen(req, timeout=5)
            self.assertEqual(ctx.exception.code, 503)
        finally:
            cloud_app.encrypt_token = original

    def test_backup_manifest_verifier(self) -> None:
        import io as _io
        import tarfile as _tarfile
        from tools import backup_check

        tmp = tempfile.TemporaryDirectory()
        root = Path(tmp.name)
        db_path = root / "charge-2026-11-03.db"
        conn = sqlite3.connect(db_path)
        conn.execute("CREATE TABLE sample(id INTEGER PRIMARY KEY)")
        conn.commit()
        conn.close()
        cfg_path = root / "charge-config-2026-11-03.tgz"
        with _tarfile.open(cfg_path, "w:gz") as tar:
            for name, payload in (("token_key", b"k" * 64),
                                  ("version.json", b"{}")):
                info = _tarfile.TarInfo(name)
                info.size = len(payload)
                tar.addfile(info, _io.BytesIO(payload))
        manifest = root / "charge-2026-11-03.manifest"
        manifest.write_text(
            "date=2026-11-03\n"
            f"db={db_path.name}\n"
            f"config={cfg_path.name}\n"
            f"db_sha256={backup_check.sha256_file(db_path)}\n"
            f"config_sha256={backup_check.sha256_file(cfg_path)}\n",
            encoding="utf-8")
        errors, _warnings = backup_check.verify_backup_dir(root)
        self.assertEqual(errors, [])
        with db_path.open("ab") as fh:
            fh.write(b"tamper")
        errors, _warnings = backup_check.verify_backup_dir(root)
        self.assertTrue(errors)
        tmp.cleanup()


if __name__ == "__main__":
    unittest.main()
