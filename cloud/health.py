"""健康摘要：error_count = stale_devices + error_tokens，以及 30 秒摘要缓存。

不变量：``/api/overview.error_count`` 的唯一来源；缓存键附 ``conn.total_changes``，
同连接上任何写入都会立刻失效，避免运维/测试写库后读到 30 秒前的旧状态。
"""

from __future__ import annotations

import os
import re
import sqlite3
import time
from pathlib import Path

from .config import (
    HEALTH_CACHE,
    HEALTH_CACHE_LOCK,
    HEALTH_CACHE_TTL,
    HEALTH_STALE_SECONDS,
)


def worker_log_info() -> dict:
    """worker 状态兜底：进程重启后从日志文件读最后一次抓取记录。"""
    paths = []
    env_path = os.environ.get("WORKER_LOG_FILE")
    if env_path:
        paths.append(Path(env_path))
    paths.extend([Path("/var/log/charge-cloud-worker.log"),
                  Path.cwd() / "worker.log"])
    for path in paths:
        try:
            if not path.is_file():
                continue
            lines = path.read_text(encoding="utf-8", errors="replace").strip().splitlines()
        except OSError:
            continue
        for line in reversed(lines[-200:]):
            if "[worker]" not in line:
                continue
            tail = line.split("[worker]", 1)[1].strip()
            stamp = re.match(r"\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}", tail)
            if stamp:
                return {"last_run": stamp.group(0),
                        "last_result": tail[stamp.end():].strip() or None,
                        "runs": 0, "log_file": str(path)}
            return {"last_run": None, "last_result": tail or None,
                    "runs": 0, "log_file": str(path)}
    return {}


def health_stats(conn: sqlite3.Connection, lock) -> dict:
    """健康计数（/api/overview.error_count 的唯一来源）。

    error_count = stale_devices + error_tokens
    - stale_devices：controllers 中最近一次端口更新时间超过 HEALTH_STALE_SECONDS
      （worker 600s + 300s 余量 = 900 秒），或从未抓到端口数据的设备数；
    - error_tokens：token_pool 中 last_error 非空且仍有效的条数。
    """
    now = time.time()
    with lock:
        rows = conn.execute(
            "SELECT c.device_hex, c.updated_at, "
            "(SELECT MAX(p.updated_at) FROM port_states p "
            " WHERE p.device_hex = c.device_hex) "
            "FROM controllers c").fetchall()
        error_tokens = conn.execute(
            "SELECT COUNT(*) FROM token_pool WHERE last_error IS NOT NULL "
            "AND last_error <> '' AND expires_at > ?", (int(time.time()),)).fetchone()[0]
    stale = 0
    for _device, ctrl_at, port_at in rows:
        latest = port_at or ctrl_at or ""
        try:
            fresh = bool(latest) and now - time.mktime(
                time.strptime(latest, "%Y-%m-%d %H:%M:%S")) <= HEALTH_STALE_SECONDS
        except Exception:
            fresh = False
        if not fresh:
            stale += 1
    return {"stale_devices": stale, "error_tokens": int(error_tokens),
            "error_count": stale + int(error_tokens)}


def health_stats_cached(conn: sqlite3.Connection, lock, db_key: str) -> dict:
    """/api/health /api/overview 用的 30 秒健康摘要缓存。

    缓存键附 `conn.total_changes`：同一连接上的任何写入都会让缓存立即失效，
    避免直接 DB 运维/测试写入后仍读到 30 秒前的健康状态。
    """
    now = time.time()
    changes = conn.total_changes
    with HEALTH_CACHE_LOCK:
        data = HEALTH_CACHE.get("data")
        fresh = (HEALTH_CACHE.get("db") == db_key
                 and HEALTH_CACHE.get("changes") == changes
                 and data is not None
                 and now - float(HEALTH_CACHE.get("ts") or 0)
                 <= HEALTH_CACHE_TTL)
    if fresh:
        return data
    data = health_stats(conn, lock)
    with HEALTH_CACHE_LOCK:
        HEALTH_CACHE["db"] = db_key
        HEALTH_CACHE["changes"] = conn.total_changes
        HEALTH_CACHE["ts"] = now
        HEALTH_CACHE["data"] = data
    return data
