"""数据契约 v2 的新增回归：端口状态分组、unknown 原文化、健康口径、幂等迁移、raw_json。

这些用例对应 `docs/refactor-plan-2026-11-03.md` 第 3 节（A1 修复），全部为新增用例，
不改动既有断言的语义（既有仅按契约做「只增字段」对齐）。
"""

from __future__ import annotations

import json
import secrets
import sqlite3
import tempfile
import threading
import unittest
import urllib.parse
import urllib.request
from pathlib import Path

from cloud import app as cloud_app
from cloud import config, db as cloud_db, ports
from crawler import db as crawler_db


class PortStatusGroupTest(unittest.TestCase):
    """3.1：状态分组表 + unknown 原文保留 + _ports_health 口径。"""

    def test_status_groups_mapping(self) -> None:
        from cloud.config import PORT_CODE_GROUPS, PORT_STATUS_GROUPS

        self.assertEqual(PORT_STATUS_GROUPS["空闲"], "free")
        for status in ("充电中", "未充占用", "已充满", "充满占用", "浮充", "占用"):
            self.assertEqual(PORT_STATUS_GROUPS[status], "busy", status)
        for status in ("端口故障", "故障", "离线", "维护", "禁用", "绑定",
                       "绑定端口", "禁用端口", "存储器损坏", "安全门卡住",
                       "保险丝烧断", "继电器粘连", "门磁芯片损坏",
                       "预检-负载短路", "刷卡芯片损坏故障"):
            self.assertEqual(PORT_STATUS_GROUPS[status], "unavailable", status)
        # 数字码分组：0 空闲；1/2/3/5 占用；4/6/7/8/9/10/13/15/88/99 不可用
        self.assertEqual(PORT_CODE_GROUPS[0], "free")
        for code in (1, 2, 3, 5):
            self.assertEqual(PORT_CODE_GROUPS[code], "busy", code)
        for code in (4, 6, 7, 8, 9, 10, 13, 15, 88, 99):
            self.assertEqual(PORT_CODE_GROUPS[code], "unavailable", code)
        # 白名单不再把真实状态压成「其他」
        self.assertNotIn("其他", cloud_app.PORT_STATUSES)
        for status in ("已充满", "禁用", "绑定", "浮充", "端口故障"):
            self.assertIn(status, cloud_app.PORT_STATUSES)

    def test_unknown_status_keeps_raw_text_and_unknown_group(self) -> None:
        entries = cloud_app._clean_port_entries(
            [{"port": "01", "status": "鬼知道的新状态"},
             {"port": "02", "status": "空闲"},
             {"port": "03", "status": ""}])
        self.assertEqual([e["status"] for e in entries],
                         ["鬼知道的新状态", "空闲", ""])
        self.assertEqual([e["group"] for e in entries],
                         ["unknown", "free", "unknown"])
        self.assertEqual(ports.status_group("已充满"), "busy")
        self.assertEqual(ports.status_group("禁用"), "unavailable")
        self.assertEqual(ports.status_group(None), "unknown")
        self.assertEqual(ports.status_group("  空闲 "), "free")

    def test_ports_health_full_vs_unavailable(self) -> None:
        stamp = "2026-11-02 00:00:00"
        # 全已充满 -> full（有人占着）
        full = cloud_app._ports_health(
            [("01", "已充满", stamp), ("02", "已充满", stamp)], "")
        self.assertEqual((full["state"], full["free"], full["busy"]), ("full", 0, 2))
        # 全禁用 / 全故障 -> unavailable（free==0 且 busy==0）
        for statuses in (["禁用", "禁用"], ["端口故障", "离线"],
                         ["禁用", "绑定端口"]):
            health = cloud_app._ports_health(
                [(str(i), s, stamp) for i, s in enumerate(statuses)], "")
            self.assertEqual(health["state"], "unavailable", statuses)
            self.assertEqual(health["free"], 0)
            self.assertEqual(health["unavailable"], len(statuses))
            self.assertEqual(health["busy"], 0)
        # 有空闲 -> free；混合时 busy 不含 unavailable
        mixed = cloud_app._ports_health(
            [("01", "空闲", stamp), ("02", "充电中", stamp),
             ("03", "禁用", stamp), ("04", "莫名状态", stamp)], "")
        self.assertEqual((mixed["state"], mixed["free"], mixed["busy"],
                          mixed["unavailable"], mixed["unknown"]),
                         ("free", 1, 2, 1, 1))
        self.assertEqual(mixed["free"] + mixed["busy"] + mixed["unavailable"],
                         mixed["total"])
        # 空端口 -> unknown（无端口数据）
        empty = cloud_app._ports_health([], "")
        self.assertEqual((empty["state"], empty["total"]), ("unknown", 0))

    def test_ports_summary_and_area_port_state(self) -> None:
        stamp = "2026-11-02 00:00:00"
        rows = [("01", "空闲", stamp), ("02", "充电中", stamp),
                ("03", "已充满", stamp), ("04", "禁用", stamp)]
        summary = cloud_app.ports_summary(rows)
        self.assertEqual({k: summary[k] for k in
                          ("free", "busy", "unavailable", "unknown", "total")},
                         {"free": 1, "busy": 2, "unavailable": 1,
                          "unknown": 0, "total": 4})
        # 逐状态计数（端口详情按状态分开展示的数据来源）
        self.assertEqual(summary["statuses"],
                         {"空闲": 1, "充电中": 1, "已充满": 1, "禁用": 1})
        # /api/now 的 port_state 五值口径
        self.assertEqual(ports.area_port_state(3, 10, 0), "busy")
        self.assertEqual(ports.area_port_state(10, 10, 0), "free")
        self.assertEqual(ports.area_port_state(0, 10, 0), "full")
        self.assertEqual(ports.area_port_state(0, 10, 10), "unavailable")
        self.assertEqual(ports.area_port_state(0, 0, 0), "unknown")

    def test_pile_sample_records_unavailable(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            conn = cloud_app.init_db(Path(tmp) / "pile.db")
            try:
                cloud_app.record_pile_sample(
                    conn, "00AFEC05", "2026-11-02 00:00:00",
                    ["空闲", "充电中", "禁用", "端口故障"])
                row = conn.execute(
                    "SELECT free, total, busy, online, unavailable FROM pile_samples "
                    "WHERE device_hex = '00AFEC05'").fetchone()
                self.assertEqual(tuple(row), (1, 4, 3, 1, 2))
            finally:
                conn.close()


OLD_SCHEMA = """
CREATE TABLE snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT, received_at TEXT NOT NULL,
    captured_at TEXT, project TEXT, app_version TEXT, token_user TEXT,
    client_ip TEXT, body_sha256 TEXT NOT NULL, payload TEXT NOT NULL);
CREATE TABLE area_samples (
    snapshot_id INTEGER NOT NULL, area_id TEXT, area_name TEXT NOT NULL,
    idle INTEGER NOT NULL, total INTEGER NOT NULL, charging INTEGER NOT NULL,
    fault INTEGER NOT NULL, received_at TEXT NOT NULL);
CREATE TABLE areas (
    area_id TEXT PRIMARY KEY, name TEXT UNIQUE, first_seen TEXT, last_seen TEXT);
CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE tokens (
    user_id TEXT PRIMARY KEY, token TEXT NOT NULL, expires_at INTEGER NOT NULL,
    updated_at TEXT NOT NULL);
CREATE TABLE token_pool (
    id INTEGER PRIMARY KEY, user_id TEXT, token TEXT, expires_at INTEGER,
    updated_at TEXT, source TEXT, last_error TEXT);
CREATE TABLE devices (
    device_id TEXT PRIMARY KEY, secret_enc TEXT NOT NULL, model TEXT,
    app_version TEXT, created_at TEXT NOT NULL, last_seen TEXT,
    uploads INTEGER NOT NULL DEFAULT 0);
CREATE TABLE worker_runs (id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL, result TEXT NOT NULL);
CREATE TABLE upload_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL,
    ip TEXT, ua TEXT, size INTEGER, result TEXT, detail TEXT);
CREATE TABLE admin_users (username TEXT PRIMARY KEY, pass_hash TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    disabled INTEGER NOT NULL DEFAULT 0);
CREATE TABLE area_status (
    id INTEGER PRIMARY KEY AUTOINCREMENT, area_id TEXT NOT NULL,
    captured_at TEXT NOT NULL, total_port INTEGER, idle_port INTEGER,
    charging_port INTEGER, fault_port INTEGER, usable_port TEXT);
CREATE TABLE port_states (
    device_hex TEXT NOT NULL, port TEXT NOT NULL, status TEXT, updated_at TEXT,
    PRIMARY KEY (device_hex, port));
CREATE TABLE pile_samples (
    device_hex TEXT NOT NULL, ts TEXT NOT NULL, free INTEGER, total INTEGER,
    busy INTEGER, online INTEGER, PRIMARY KEY (device_hex, ts));
"""


class SchemaMigrationV2Test(unittest.TestCase):
    """3.2：旧库自动升级（幂等）。"""

    def _build_old_db(self, path: Path) -> None:
        raw = sqlite3.connect(path)
        try:
            raw.executescript(OLD_SCHEMA)
            raw.execute(
                "INSERT INTO area_status(area_id, captured_at, total_port) "
                "VALUES ('a1', '2026-11-01 00:00:00', 8)")
            raw.executemany(
                "INSERT INTO port_states(device_hex, port, status, updated_at) "
                "VALUES (?,?,?,?)",
                [("00AFEC05", "01", "空闲", "2026-11-01 00:00:00"),
                 ("00AFEC05", "02", "已充满", "2026-11-01 00:00:00"),
                 ("00AFEC05", "03", "端口故障", "2026-11-01 00:00:00"),
                 ("00AFEC05", "04", "莫名其妙", "2026-11-01 00:00:00")])
            raw.execute(
                "INSERT INTO pile_samples(device_hex, ts, free, total, busy, online) "
                "VALUES ('00AFEC05', '2026-11-01 00:00:00', 1, 4, 3, 1)")
            raw.commit()
        finally:
            raw.close()

    def test_migrate_schema_adds_v2_columns_idempotent(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "legacy.db"
            self._build_old_db(path)
            for _ in range(2):          # 重复执行必须安全
                conn = cloud_app.init_db(path)
                try:
                    self.assertIn("raw_json",
                                  cloud_db.table_columns(conn, "area_status"))
                    self.assertIn("status_group",
                                  cloud_db.table_columns(conn, "port_states"))
                    self.assertIn("unavailable",
                                  cloud_db.table_columns(conn, "pile_samples"))
                    groups = dict(conn.execute(
                        "SELECT status, status_group FROM port_states "
                        "WHERE device_hex = '00AFEC05'").fetchall())
                    self.assertEqual(groups, {
                        "空闲": "free", "已充满": "busy",
                        "端口故障": "unavailable", "莫名其妙": "unknown"})
                    self.assertEqual(conn.execute(
                        "SELECT unavailable FROM pile_samples").fetchone()[0], 0)
                    self.assertEqual(conn.execute(
                        "SELECT raw_json FROM area_status").fetchone()[0], None)
                    indexes = {row[0] for row in conn.execute(
                        "SELECT name FROM sqlite_master WHERE type='index'")}
                    self.assertIn("idx_port_states_group", indexes)
                finally:
                    conn.close()

    def test_crawler_insert_status_raw_json_roundtrip(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "crawl.db"
            # 老库：area_status 没有 raw_json，connect() 应原地补列
            raw = sqlite3.connect(path)
            try:
                raw.execute(
                    "CREATE TABLE area_status (id INTEGER PRIMARY KEY AUTOINCREMENT, "
                    "area_id TEXT NOT NULL, captured_at TEXT NOT NULL, "
                    "total_port INTEGER, idle_port INTEGER, charging_port INTEGER, "
                    "fault_port INTEGER, usable_port TEXT)")
                raw.commit()
            finally:
                raw.close()
            conn = crawler_db.connect(path)
            try:
                self.assertIn("raw_json",
                              {row[1] for row in conn.execute(
                                  "PRAGMA table_info(area_status)")})
                detail = {"totalPort": 8, "idlePort": 3, "chargingPort": 5,
                          "faultPort": 0, "usablePort": "1,2,3"}
                payload = json.dumps({"totalPort": 8, "extra": {"k": "v"}},
                                     ensure_ascii=False)
                crawler_db.insert_status(conn, "a1", detail, raw_json=payload)
                conn.commit()
                row = conn.execute(
                    "SELECT total_port, raw_json FROM area_status "
                    "ORDER BY id DESC LIMIT 1").fetchone()
                self.assertEqual(row[0], 8)
                self.assertEqual(json.loads(row[1])["extra"], {"k": "v"})
                # 不传 raw_json 时保持 NULL（旧调用方兼容）
                crawler_db.insert_status(conn, "a1", detail)
                conn.commit()
                self.assertIsNone(conn.execute(
                    "SELECT raw_json FROM area_status ORDER BY id DESC LIMIT 1"
                ).fetchone()[0])
            finally:
                conn.close()


class ContractV2HttpTest(unittest.TestCase):
    """3.3：HTTP 响应只增字段（ports[].group / summary / port_state）。"""

    def setUp(self) -> None:
        cloud_app.RATE.clear()
        cloud_app.invalidate_areas_ports_cache()
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        key_file = root / "token_key"
        key_file.write_text("11" * 32, encoding="ascii")
        cloud_app.TOKEN_KEY_FILE = str(key_file)
        (root / "secret.txt").write_text(secrets.token_hex(32), encoding="utf-8")
        (root / "version.json").write_text("{}", encoding="utf-8")
        (root / "download").mkdir()
        web = root / "web"
        web.mkdir()
        (web / "index.html").write_text("<html></html>", encoding="utf-8")
        self.httpd = cloud_app.create_server(
            root / "charge.db", root / "secret.txt", root / "version.json",
            root / "download", "127.0.0.1", 0, web_dir=web, workers=False)
        self.db = self.httpd.RequestHandlerClass.db
        self.port = self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def tearDown(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()
        try:
            self.db.close()
        except Exception:
            pass
        self.tmp.cleanup()

    def _get_json(self, path: str) -> dict:
        url = f"http://127.0.0.1:{self.port}{path}"
        with urllib.request.urlopen(url, timeout=5) as resp:
            return json.loads(resp.read())

    def test_area_ports_reports_group_and_summary(self) -> None:
        stamp = "2026-11-02 00:00:00"
        with self.httpd.db_lock:
            self.db.execute(
                "INSERT INTO controllers(device_hex, code, area_id, area_name, "
                "updated_at) VALUES (?,?,?,?,?)",
                ("A1", "10001", "aid", "契约测试区", stamp))
            for port, status in (("01", "空闲"), ("02", "已充满"),
                                 ("03", "禁用"), ("04", "未知新状态")):
                self.db.execute(
                    "INSERT INTO port_states(device_hex, port, status, updated_at) "
                    "VALUES (?,?,?,?)", ("A1", port, status, stamp))
            self.db.commit()
        cloud_app.invalidate_areas_ports_cache()
        data = self._get_json(
            "/api/area-ports?area=" + urllib.parse.quote("契约测试区"))
        dev = data["devices"][0]
        self.assertEqual([p["status"] for p in dev["ports"]],
                         ["空闲", "已充满", "禁用", "未知新状态"])
        self.assertEqual([p["group"] for p in dev["ports"]],
                         ["free", "busy", "unavailable", "unknown"])
        # 四分组计数（只增字段：statuses 是逐状态计数，单独在上面断言）
        self.assertEqual({k: data["summary"][k] for k in
                          ("free", "busy", "unavailable", "unknown", "total")},
                         {"free": 1, "busy": 2, "unavailable": 1,
                          "unknown": 1, "total": 4})
        self.assertEqual(data["summary"]["statuses"],
                         {"空闲": 1, "已充满": 1, "禁用": 1, "未知新状态": 1})
        areas = self._get_json("/api/areas-ports")["areas"]
        self.assertEqual(areas[0]["area"], "契约测试区")
        self.assertEqual(areas[0]["summary"]["unavailable"], 1)
        self.assertEqual([p["group"] for p in areas[0]["devices"][0]["ports"]],
                         ["free", "busy", "unavailable", "unknown"])

    def test_now_reports_port_state_and_unavailable_ports(self) -> None:
        stamp = "2026-11-02 00:00:00"
        with self.httpd.db_lock:
            cur = self.db.execute(
                "INSERT INTO snapshots(received_at, captured_at, project, "
                "app_version, token_user, client_ip, body_sha256, payload) "
                "VALUES (?,?,?,?,?,?,?,?)",
                (stamp, stamp, "P", "2.3", "", "server", "sha-contract-v2", "{}"))
            sid = cur.lastrowid
            for name, idle, total, fault in (
                    ("全空区", 10, 10, 0), ("部分占用区", 5, 10, 0),
                    ("满区区", 0, 10, 0), ("不可用区", 0, 8, 8)):
                self.db.execute(
                    "INSERT INTO area_samples(snapshot_id, area_id, area_name, idle, "
                    "total, charging, fault, received_at) VALUES (?,?,?,?,?,?,?,?)",
                    (sid, "aid-" + name, name, idle, total, total - idle - fault,
                     fault, stamp))
            self.db.commit()
        data = self._get_json("/api/now")
        by_name = {item["name"]: item for item in data["areas"]}
        self.assertEqual(by_name["全空区"]["port_state"], "free")
        self.assertEqual(by_name["部分占用区"]["port_state"], "busy")
        self.assertEqual(by_name["满区区"]["port_state"], "full")
        self.assertEqual(by_name["不可用区"]["port_state"], "unavailable")
        self.assertEqual(by_name["不可用区"]["unavailable_ports"], 8)
        self.assertEqual(by_name["满区区"]["unavailable_ports"], 0)
        # 原有字段不受影响
        for item in data["areas"]:
            self.assertIn("idle", item)
            self.assertIn("score", item)
            self.assertIn("predicted_idle", item)


if __name__ == "__main__":
    unittest.main()
