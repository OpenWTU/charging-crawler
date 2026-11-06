"""P7 遗留风险修复的回归用例（2026-11-03）。

对应 `docs/refactor-plan-2026-11-03.md` 第 8 节「遗留风险」四条中的三条：

1. `_FacadeModule` 广播收窄为白名单（非白名单名字不再外溢到实现模块）；
2. `port_states.status_group` 由数据库触发器维护（直接 SQL 改 status 也会复算）；
3. `/api/now` 的 `unavailable_ports` 优先取端口级明细（含禁用/绑定/维护），
   无明细时回退平台 `faultPort`。

全部为新增用例，不改动既有断言语义。
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


class FacadeBroadcastWhitelistTest(unittest.TestCase):
    """风险 1：门面赋值只对白名单名字广播。"""

    def test_non_whitelisted_name_does_not_leak(self) -> None:
        # sqlite3 在多个模块里都存在，但**不在**白名单里：赋值不应外溢。
        original = cloud_db.sqlite3
        try:
            cloud_app.sqlite3 = "SENTINEL-NOT-BROADCAST"
            self.assertEqual(cloud_db.sqlite3, original)
        finally:
            cloud_app.sqlite3 = original

    def test_whitelisted_name_broadcasts(self) -> None:
        original = config.AREAS_PORTS_LIMIT
        try:
            cloud_app.AREAS_PORTS_LIMIT = 4242
            self.assertEqual(config.AREAS_PORTS_LIMIT, 4242)
        finally:
            cloud_app.AREAS_PORTS_LIMIT = original

    def test_dunder_assignment_is_never_broadcast(self) -> None:
        original = getattr(cloud_db, "__doc__", None)
        try:
            cloud_app.__doc__ = "facade-doc"
            self.assertEqual(getattr(cloud_db, "__doc__", None), original)
        finally:
            cloud_app.__doc__ = original


class PortGroupTriggerTest(unittest.TestCase):
    """风险 2：status_group 由触发器维护，直接 SQL 也不会漂移。"""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "charge.db"
        self.conn = cloud_app.init_db(self.path)

    def tearDown(self) -> None:
        try:
            self.conn.close()
        finally:
            self.tmp.cleanup()

    def _group(self, device: str, port: str) -> str:
        row = self.conn.execute(
            "SELECT status_group FROM port_states WHERE device_hex = ? AND port = ?",
            (device, port)).fetchone()
        return None if row is None else row[0]

    def test_insert_ignores_wrong_group_and_recomputes(self) -> None:
        # 应用层写错分组（这里故意写成 free），触发器应就地纠正为 busy
        self.conn.execute(
            "INSERT INTO port_states(device_hex, port, status, status_group, updated_at) "
            "VALUES ('TRG1','01','已充满','free','2026-11-03 00:00:00')")
        self.conn.commit()
        self.assertEqual(self._group("TRG1", "01"), "busy")

    def test_direct_status_update_recomputes_group(self) -> None:
        self.conn.execute(
            "INSERT INTO port_states(device_hex, port, status, updated_at) "
            "VALUES ('TRG1','02','空闲','2026-11-03 00:00:00')")
        self.conn.commit()
        self.assertEqual(self._group("TRG1", "02"), "free")

        # 运维/脚本直接改 status（不经过应用写入路径）
        self.conn.execute(
            "UPDATE port_states SET status = '禁用' "
            "WHERE device_hex = 'TRG1' AND port = '02'")
        self.conn.commit()
        self.assertEqual(self._group("TRG1", "02"), "unavailable")

    def test_unknown_status_becomes_unknown_group(self) -> None:
        self.conn.execute(
            "INSERT INTO port_states(device_hex, port, status, updated_at) "
            "VALUES ('TRG1','03','莫名其妙','2026-11-03 00:00:00')")
        self.conn.commit()
        self.assertEqual(self._group("TRG1", "03"), "unknown")

    def test_triggers_are_idempotent_across_migrations(self) -> None:
        names = lambda: {row[0] for row in self.conn.execute(
            "SELECT name FROM sqlite_master WHERE type='trigger'")}
        first = names()
        self.assertIn("trg_port_states_group_ins", first)
        self.assertIn("trg_port_states_group_upd", first)
        for _ in range(2):
            cloud_db.migrate_schema(self.conn)
        self.assertEqual(names(), first)  # 重复迁移不产生重复触发器

    def test_trigger_case_matches_python_mapping(self) -> None:
        # 触发器里渲染的 CASE 必须与 PORT_STATUS_GROUPS 一致（同一真相源）
        sql = self.conn.execute(
            "SELECT sql FROM sqlite_master WHERE name='trg_port_states_group_ins'"
        ).fetchone()[0]
        for status, group in config.PORT_STATUS_GROUPS.items():
            if group == "unknown":
                continue
            self.assertIn("WHEN '%s' THEN '%s'" % (status, group), sql, status)


class AreaUnavailableTest(unittest.TestCase):
    """风险 4：/api/now 的 unavailable_ports 取明细优先、fault 回退。"""

    AREA_DETAIL = "明细优先区"
    AREA_FALLBACK = "回退区"

    def setUp(self) -> None:
        cloud_app.RATE.clear()
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        key_file = root / "token_key"
        key_file.write_text("22" * 32, encoding="ascii")
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

    def _seed(self, fault: int, detail_statuses) -> None:
        stamp = "2026-11-03 12:00:00"
        with self.httpd.db_lock:
            self.db.execute(
                "INSERT INTO snapshots(received_at, captured_at, body_sha256, payload) "
                "VALUES (?,?,?,?)", (stamp, stamp, "a" * 64, "{}"))
            sid = self.db.execute("SELECT MAX(id) FROM snapshots").fetchone()[0]
            self.db.execute(
                "INSERT INTO area_samples(snapshot_id, area_id, area_name, idle, total, "
                "charging, fault, received_at) VALUES (?,?,?,?,?,?,?,?)",
                (sid, "aid1", self.AREA_DETAIL, 0, 4, 2, fault, stamp))
            self.db.execute(
                "INSERT INTO area_samples(snapshot_id, area_id, area_name, idle, total, "
                "charging, fault, received_at) VALUES (?,?,?,?,?,?,?,?)",
                (sid, "aid2", self.AREA_FALLBACK, 3, 10, 4, fault, stamp))
            if detail_statuses:
                self.db.execute(
                    "INSERT INTO controllers(device_hex, code, area_id, area_name, "
                    "updated_at) VALUES (?,?,?,?,?)",
                    ("DEV-D1", "10009", "aid1", self.AREA_DETAIL, stamp))
                for port, status in detail_statuses:
                    self.db.execute(
                        "INSERT INTO port_states(device_hex, port, status, updated_at) "
                        "VALUES (?,?,?,?)", ("DEV-D1", port, status, stamp))
            self.db.commit()

    def _now(self) -> dict:
        url = "http://127.0.0.1:%d/api/now" % self.port
        with urllib.request.urlopen(url, timeout=5) as resp:
            return json.loads(resp.read())

    def test_detail_wins_over_fault(self) -> None:
        # faultPort 只报 1，但明细里有 2 个不可用（禁用 + 绑定）→ 以明细为准
        self._seed(fault=1, detail_statuses=[
            ("01", "禁用"), ("02", "绑定"), ("03", "充电中"), ("04", "充电中")])
        areas = {a["name"]: a for a in self._now()["areas"]}
        self.assertEqual(areas[self.AREA_DETAIL]["unavailable_ports"], 2)
        # idle=0、busy=4-0-2=2 → full（不是 unavailable）
        self.assertEqual(areas[self.AREA_DETAIL]["port_state"], "full")

    def test_area_without_detail_falls_back_to_fault(self) -> None:
        self._seed(fault=3, detail_statuses=[
            ("01", "禁用"), ("02", "绑定"), ("03", "充电中"), ("04", "充电中")])
        areas = {a["name"]: a for a in self._now()["areas"]}
        # 该区没有端口明细 → 回退平台 faultPort
        self.assertEqual(areas[self.AREA_FALLBACK]["unavailable_ports"], 3)
        self.assertEqual(areas[self.AREA_FALLBACK]["port_state"], "busy")

    def test_all_ports_unavailable_reports_unavailable_state(self) -> None:
        stamp = "2026-11-03 12:00:00"
        with self.httpd.db_lock:
            self.db.execute(
                "INSERT INTO snapshots(received_at, captured_at, body_sha256, payload) "
                "VALUES (?,?,?,?)", (stamp, stamp, "b" * 64, "{}"))
            sid = self.db.execute("SELECT MAX(id) FROM snapshots").fetchone()[0]
            self.db.execute(
                "INSERT INTO area_samples(snapshot_id, area_id, area_name, idle, total, "
                "charging, fault, received_at) VALUES (?,?,?,?,?,?,?,?)",
                (sid, "aid3", self.AREA_DETAIL, 0, 2, 0, 0, stamp))
            self.db.execute(
                "INSERT INTO controllers(device_hex, code, area_id, area_name, updated_at) "
                "VALUES (?,?,?,?,?)", ("DEV-D2", "10010", "aid3", self.AREA_DETAIL, stamp))
            for port, status in (("01", "禁用"), ("02", "端口故障")):
                self.db.execute(
                    "INSERT INTO port_states(device_hex, port, status, updated_at) "
                    "VALUES (?,?,?,?)", ("DEV-D2", port, status, stamp))
            self.db.commit()
        areas = {a["name"]: a for a in self._now()["areas"]}
        self.assertEqual(areas[self.AREA_DETAIL]["unavailable_ports"], 2)
        self.assertEqual(areas[self.AREA_DETAIL]["port_state"], "unavailable")

    def test_group_counts_helper_contract(self) -> None:
        stamp = "2026-11-03 12:00:00"
        with self.httpd.db_lock:
            self.db.execute(
                "INSERT INTO controllers(device_hex, code, area_id, area_name, updated_at) "
                "VALUES (?,?,?,?,?)",
                ("DEV-H1", "10011", "aid9", "统计区", stamp))
            for port, status in (("01", "空闲"), ("02", "已充满"), ("03", "禁用")):
                self.db.execute(
                    "INSERT INTO port_states(device_hex, port, status, updated_at) "
                    "VALUES (?,?,?,?)", ("DEV-H1", port, status, stamp))
            self.db.commit()
            counts = ports.area_port_group_counts(self.db)
        self.assertEqual(counts["统计区"], (3, 1))


if __name__ == "__main__":
    unittest.main()
