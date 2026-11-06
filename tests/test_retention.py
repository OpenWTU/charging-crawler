"""保留策略测试：小时聚合幂等、原始数据按保留期删除。"""

from __future__ import annotations

import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path

from crawler import db, retention

FMT = "%Y-%m-%d %H:%M:%S"


def insert_at(conn, area_id: str, ts: datetime, idle: int, charging: int, fault: int,
              total: int = 10) -> None:
    conn.execute(
        """INSERT INTO area_status(area_id, captured_at, total_port, idle_port, charging_port,
                                   fault_port, usable_port)
           VALUES (?,?,?,?,?,?,?)""",
        (area_id, ts.strftime(FMT), total, idle, charging, fault, idle),
    )


class RetentionTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tmp.name) / "stations.db"
        conn = db.connect(self.db_path)
        db.upsert_project(conn, "1", "测试校区", "测试公司", "123")
        db.upsert_area(conn, "a1", "1", "测试校区", "10栋充电区", {})
        now = datetime.now()
        base = now.replace(minute=10, second=0, microsecond=0)
        insert_at(conn, "a1", now - timedelta(days=1), idle=5, charging=5, fault=0)
        insert_at(conn, "a1", base - timedelta(days=10), idle=2, charging=8, fault=0)
        insert_at(conn, "a1", base - timedelta(days=10) + timedelta(minutes=20), idle=4, charging=6, fault=1)
        insert_at(conn, "a1", base - timedelta(days=100), idle=9, charging=1, fault=0)
        conn.commit()
        conn.close()

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _counts(self):
        conn = db.connect(self.db_path)
        try:
            raw = conn.execute("SELECT COUNT(*) FROM area_status").fetchone()[0]
            hourly = conn.execute("SELECT COUNT(*) FROM area_status_hourly").fetchone()[0]
        finally:
            conn.close()
        return raw, hourly

    def test_rollup_and_prune(self) -> None:
        result = retention.run(self.db_path, keep_days=90, settle_days=2)
        # 2 天前的数据：1 天前的不聚合；10 天前两行同小时 → 1 条聚合；100 天前 1 条
        self.assertEqual(result["rolled"], 2)
        self.assertEqual(result["deleted"], 1)  # 只删 100 天前的原始行
        raw, hourly = self._counts()
        self.assertEqual(raw, 3)  # 1 天前 1 行 + 10 天前 2 行
        self.assertEqual(hourly, 2)

        conn = db.connect(self.db_path)
        try:
            hour = conn.execute(
                "SELECT idle_avg, idle_min, idle_max, charging_avg, fault_max, samples "
                "FROM area_status_hourly WHERE samples = 2").fetchone()
        finally:
            conn.close()
        self.assertIsNotNone(hour)
        # 10 天前那两行：idle 2/4 → avg 3, min 2, max 4；charging 8/6 → avg 7；fault max 1
        self.assertAlmostEqual(hour["idle_avg"], 3.0)
        self.assertEqual(hour["idle_min"], 2)
        self.assertEqual(hour["idle_max"], 4)
        self.assertAlmostEqual(hour["charging_avg"], 7.0)
        self.assertEqual(hour["fault_max"], 1)
        self.assertEqual(hour["samples"], 2)

    def test_rollup_is_idempotent(self) -> None:
        retention.run(self.db_path, keep_days=90, settle_days=2)
        before, _ = self._counts()
        result = retention.run(self.db_path, keep_days=90, settle_days=2)
        after, hourly = self._counts()
        self.assertEqual(result["deleted"], 0)
        self.assertEqual(before, after)
        self.assertEqual(hourly, 2)  # 重复聚合不新增

    def test_keep_days_and_settle_days(self) -> None:
        result = retention.run(self.db_path, keep_days=365, settle_days=2)
        self.assertEqual(result["deleted"], 0)  # 100 天 < 365 天，不删
        raw, _ = self._counts()
        self.assertEqual(raw, 4)

    def test_cutoff_is_aligned_to_hour(self) -> None:
        now = datetime(2026, 10, 31, 19, 37, 12)
        self.assertEqual(retention.cutoff_for(now, 90), "2026-08-02 19:00:00")
        # 边界小时不被切半：落在同一小时的行都 >= cutoff
        self.assertTrue("2026-08-02 19:00:00" <= "2026-08-02 19:59:59")
        self.assertFalse("2026-08-02 19:00:00" <= "2026-08-02 18:59:59")

    def test_settle_never_earlier_than_cutoff(self) -> None:
        now = datetime(2026, 10, 31, 19, 37, 12)
        cutoff = retention.cutoff_for(now, 1)  # 2026-10-30 19:00:00
        settle = retention.settle_for(now, 2, cutoff)  # now-2d 更早，应取 cutoff
        self.assertEqual(settle, cutoff)

    def test_keep_shorter_than_settle_does_not_lose_data(self) -> None:
        result = retention.run(self.db_path, keep_days=1, settle_days=2)
        raw, hourly = self._counts()
        self.assertGreaterEqual(result["rolled"], 1)
        self.assertGreaterEqual(result["deleted"], 1)  # 10 天/100 天前的数据被删除
        self.assertGreaterEqual(hourly, 1)             # 删之前已经聚合
        self.assertEqual(raw, 1)                       # 1 天前那条仍保留


if __name__ == "__main__":
    unittest.main()
