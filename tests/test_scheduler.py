"""调度器冒烟测试：无 token 时记录 skipped 并正常退出。"""

from __future__ import annotations

import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]


class SchedulerTest(unittest.TestCase):
    def test_once_without_token_records_skip(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        db_path = Path(tmp.name) / "s.db"
        env = dict(os.environ)
        env["CHARGING_TOKEN"] = ""
        proc = subprocess.run(
            [sys.executable, "-m", "crawler.scheduler", "--once", "--db", str(db_path),
             "--token", "not-a-jwt"],
            cwd=str(PROJECT_ROOT), capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=60, env=env,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("跳过", proc.stdout)
        conn = sqlite3.connect(db_path)
        try:
            notes = [row[0] or "" for row in conn.execute("SELECT note FROM crawl_runs")]
        finally:
            conn.close()
        self.assertTrue(any(n.startswith("skipped:") for n in notes), notes)


if __name__ == "__main__":
    unittest.main()
