"""端口详情「逐状态计数」的回归用例（2026-11-03）。

诉求：端口详情页要能分别看到 空闲 / 充电中 / 已充满 / 浮充，
而不是把后三者聚合成一个"占用"。后端提供 `summary.statuses`（状态原文 → 数量）。
"""

from __future__ import annotations

import json
import secrets
import tempfile
import threading
import unittest
import urllib.parse
import urllib.request
from pathlib import Path

from cloud import app as cloud_app
from cloud import ports


class StatusCountsUnitTest(unittest.TestCase):
    """ports.status_counts / _ports_health / ports_summary 的口径。"""

    ROWS = [("01", "空闲", "t"), ("02", "充电中", "t"), ("03", "充电中", "t"),
            ("04", "已充满", "t"), ("05", "浮充", "t"), ("06", "禁用", "t"),
            ("07", "", "t")]

    def test_status_counts_keeps_raw_status(self) -> None:
        counts = ports.status_counts(self.ROWS)
        self.assertEqual(counts["空闲"], 1)
        self.assertEqual(counts["充电中"], 2)
        self.assertEqual(counts["已充满"], 1)
        self.assertEqual(counts["浮充"], 1)
        self.assertEqual(counts["禁用"], 1)
        self.assertEqual(counts["未知"], 1)          # 空状态归到「未知」
        self.assertEqual(sum(counts.values()), len(self.ROWS))

    def test_ports_health_exposes_statuses(self) -> None:
        h = ports._ports_health(self.ROWS, "2026-11-03 12:00:00")
        self.assertEqual(h["statuses"]["充电中"], 2)
        self.assertEqual(h["statuses"]["已充满"], 1)
        self.assertEqual(h["statuses"]["浮充"], 1)
        # 分组口径不受影响：空闲 1，busy = 7 - 1 - 1(禁用) = 5
        self.assertEqual(h["free"], 1)
        self.assertEqual(h["unavailable"], 1)

    def test_ports_summary_exposes_statuses(self) -> None:
        s = ports.ports_summary(self.ROWS)
        self.assertEqual(s["statuses"]["充电中"], 2)
        self.assertEqual(s["total"], len(self.ROWS))


class AreaPortsStatusesApiTest(unittest.TestCase):
    """HTTP 层：/api/area-ports 的 summary.statuses 必须逐状态给出。"""

    AREA = "逐状态测试区"

    def setUp(self) -> None:
        cloud_app.RATE.clear()
        cloud_app.invalidate_areas_ports_cache()
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        key_file = root / "token_key"
        key_file.write_text("44" * 32, encoding="ascii")
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

    def _get(self, path: str) -> dict:
        url = "http://127.0.0.1:%d%s" % (self.port, path)
        with urllib.request.urlopen(url, timeout=5) as resp:
            return json.loads(resp.read())

    def test_summary_statuses_split_busy_substates(self) -> None:
        stamp = "2026-11-03 12:00:00"
        with self.httpd.db_lock:
            self.db.execute(
                "INSERT INTO controllers(device_hex, code, area_id, area_name, updated_at) "
                "VALUES (?,?,?,?,?)", ("DEV-S", "10021", "aid", self.AREA, stamp))
            for p, s in (("01", "空闲"), ("02", "充电中"), ("03", "已充满"),
                         ("04", "浮充"), ("05", "禁用")):
                self.db.execute(
                    "INSERT INTO port_states(device_hex, port, status, updated_at) "
                    "VALUES (?,?,?,?)", ("DEV-S", p, s, stamp))
            self.db.commit()
        cloud_app.invalidate_areas_ports_cache()
        data = self._get("/api/area-ports?area=" + urllib.parse.quote(self.AREA))
        summary = data["summary"]
        st = summary["statuses"]
        # 四种状态各自独立计数（这正是「不要聚合」的要求）
        self.assertEqual(st["空闲"], 1)
        self.assertEqual(st["充电中"], 1)
        self.assertEqual(st["已充满"], 1)
        self.assertEqual(st["浮充"], 1)
        self.assertEqual(st["禁用"], 1)
        # 分组口径同时保留
        self.assertEqual(summary["free"], 1)
        self.assertEqual(summary["busy"], 3)
        self.assertEqual(summary["unavailable"], 1)
        # 每个端口仍然带原文 + group
        dev = data["devices"][0]
        got = {p["port"]: (p["status"], p["group"]) for p in dev["ports"]}
        self.assertEqual(got["02"], ("充电中", "busy"))
        self.assertEqual(got["03"], ("已充满", "busy"))
        self.assertEqual(got["04"], ("浮充", "busy"))

    def test_areas_ports_also_carries_statuses(self) -> None:
        stamp = "2026-11-03 12:00:00"
        with self.httpd.db_lock:
            self.db.execute(
                "INSERT INTO controllers(device_hex, code, area_id, area_name, updated_at) "
                "VALUES (?,?,?,?,?)", ("DEV-T", "10022", "aid2", self.AREA, stamp))
            for p, s in (("01", "空闲"), ("02", "已充满")):
                self.db.execute(
                    "INSERT INTO port_states(device_hex, port, status, updated_at) "
                    "VALUES (?,?,?,?)", ("DEV-T", p, s, stamp))
            self.db.commit()
        cloud_app.invalidate_areas_ports_cache()
        data = self._get("/api/areas-ports")
        row = next(a for a in data["areas"] if a.get("area") == self.AREA)
        dev = row["devices"][0]
        self.assertEqual(dev["statuses"]["已充满"], 1)
        self.assertEqual(dev["statuses"]["空闲"], 1)
        # 区域级 summary 也带逐状态计数
        self.assertEqual(row["summary"]["statuses"]["已充满"], 1)
        self.assertEqual(row["summary"]["statuses"]["空闲"], 1)


if __name__ == "__main__":
    unittest.main()
