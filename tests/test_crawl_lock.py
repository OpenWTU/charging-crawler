"""跨进程抓取锁测试。"""

from __future__ import annotations

import os
import tempfile
import time
import unittest
from pathlib import Path

from crawler import db


class CrawlLockTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tmp.name) / "stations.db"

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_lock_is_exclusive_and_released(self) -> None:
        with db.crawl_lock(self.db_path):
            self.assertTrue(db.crawl_lock_path(self.db_path).exists())
            with self.assertRaises(db.CrawlBusy):
                with db.crawl_lock(self.db_path):
                    pass
        self.assertFalse(db.crawl_lock_path(self.db_path).exists())
        # 释放后可以再次获取
        with db.crawl_lock(self.db_path):
            pass

    def test_stale_lock_is_reclaimed(self) -> None:
        path = db.crawl_lock_path(self.db_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("99999", encoding="ascii")
        old = time.time() - 999
        os.utime(path, (old, old))
        with db.crawl_lock(self.db_path, stale_seconds=300):
            pass
        self.assertFalse(path.exists())


if __name__ == "__main__":
    unittest.main()
