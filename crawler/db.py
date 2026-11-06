"""SQLite 存储层：站点（充电区）主表 + 每次抓取的状态快照表 + 抓取记录表。"""

from __future__ import annotations

import json
import os
import secrets
import sqlite3
import time
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS projects (
    id          TEXT PRIMARY KEY,
    name        TEXT,
    company     TEXT,
    phone       TEXT,
    updated_at  TEXT
);

CREATE TABLE IF NOT EXISTS areas (
    id              TEXT PRIMARY KEY,
    project_id      TEXT,
    project_name    TEXT,
    name            TEXT NOT NULL,
    address         TEXT,
    subject         TEXT,
    service_phone   TEXT,
    first_seen      TEXT,
    last_seen       TEXT
);

CREATE TABLE IF NOT EXISTS area_status (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    area_id         TEXT NOT NULL REFERENCES areas(id),
    captured_at     TEXT NOT NULL,
    total_port      INTEGER,
    idle_port       INTEGER,
    charging_port   INTEGER,
    fault_port      INTEGER,
    usable_port     TEXT,
    -- 数据契约 v2：nearArea/{id} 的完整原始响应（data[0]），供后续结构化解析
    raw_json        TEXT
);
CREATE INDEX IF NOT EXISTS idx_status_area_time ON area_status(area_id, captured_at);

CREATE TABLE IF NOT EXISTS crawl_runs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at  TEXT,
    finished_at TEXT,
    areas_ok    INTEGER DEFAULT 0,
    areas_error INTEGER DEFAULT 0,
    note        TEXT
);

CREATE TABLE IF NOT EXISTS area_status_hourly (
    area_id       TEXT NOT NULL,
    hour          TEXT NOT NULL,
    samples       INTEGER,
    idle_avg      REAL,
    idle_min      INTEGER,
    idle_max      INTEGER,
    charging_avg  REAL,
    charging_min  INTEGER,
    charging_max  INTEGER,
    fault_max     INTEGER,
    total_port    INTEGER,
    PRIMARY KEY (area_id, hour)
);
"""


def connect(db_path: str | Path) -> sqlite3.Connection:
    path = Path(db_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=10000")
    conn.executescript(SCHEMA)
    migrate(conn)
    return conn


def migrate(conn: sqlite3.Connection) -> None:
    """幂等补列：老库（没有 raw_json）原地升级到数据契约 v2。

    ``SCHEMA`` 里的 ``CREATE TABLE IF NOT EXISTS`` 不会改已存在的表，所以新增列
    必须靠这里：先 ``PRAGMA table_info`` 判重再 ``ALTER TABLE``，重复执行安全。
    """
    columns = {row[1] for row in conn.execute("PRAGMA table_info(area_status)")}
    if columns and "raw_json" not in columns:
        conn.execute("ALTER TABLE area_status ADD COLUMN raw_json TEXT")
    conn.commit()


class CrawlBusy(RuntimeError):
    """另一轮抓取正在进行（跨进程锁被占用）。"""


def crawl_lock_path(db_path: str | Path) -> Path:
    return Path(str(db_path) + ".crawl.lock")


def _pid_alive(pid: int) -> bool:
    """判断进程是否存活。Windows 上绝不能用 os.kill(pid, 0)——那会 TerminateProcess。"""
    if pid <= 0:
        return False
    if os.name == "nt":
        import ctypes

        kernel32 = ctypes.windll.kernel32
        handle = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not handle:
            return False
        try:
            code = ctypes.c_ulong()
            if not kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
                return False
            return code.value == 259  # STILL_ACTIVE
        finally:
            kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


@contextmanager
def crawl_lock(db_path: str | Path, stale_seconds: int = 300):
    """跨进程互斥：scheduler 与「立即抓取」不会同时抓取。

    锁文件内容为 `pid:owner`；只有持有者才能删除锁。进程已退出或锁文件超时才视为陈旧。
    """
    path = crawl_lock_path(db_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    owner = f"{os.getpid()}:{secrets.token_hex(8)}"
    fd = None
    for _ in range(3):
        try:
            fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            break
        except FileExistsError:
            try:
                st = path.stat()
                content = path.read_text(encoding="ascii", errors="ignore").strip()
                pid = int(content.split(":")[0]) if content else 0
            except (OSError, ValueError):
                pid = 0
                st = None
            stale = st is None or time.time() - st.st_mtime > stale_seconds
            if stale or not _pid_alive(pid):
                try:
                    path.unlink()
                except OSError:
                    pass
                continue
            raise CrawlBusy(f"另一轮抓取正在进行（锁 {path}）")
    if fd is None:
        raise CrawlBusy("无法获取抓取锁")
    os.write(fd, owner.encode("ascii"))
    os.close(fd)
    try:
        yield
    finally:
        try:
            current = path.read_text(encoding="ascii", errors="ignore").strip()
        except OSError:
            current = ""
        if current == owner:
            try:
                path.unlink()
            except OSError:
                pass


def now() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def upsert_project(conn: sqlite3.Connection, project_id: str, name: str, company: str, phone: str) -> None:
    conn.execute(
        """INSERT INTO projects(id, name, company, phone, updated_at)
           VALUES (?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET name=excluded.name, company=excluded.company,
                                         phone=excluded.phone, updated_at=excluded.updated_at""",
        (project_id, name, company, phone, now()),
    )


def upsert_area(conn: sqlite3.Connection, area_id: str, project_id: str, project_name: str,
                name: str, detail: dict) -> None:
    ts = now()
    conn.execute(
        """INSERT INTO areas(id, project_id, project_name, name, address, subject, service_phone,
                             first_seen, last_seen)
           VALUES (?,?,?,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id,
                                         project_name=excluded.project_name,
                                         name=excluded.name,
                                         address=COALESCE(excluded.address, areas.address),
                                         subject=COALESCE(excluded.subject, areas.subject),
                                         service_phone=COALESCE(excluded.service_phone, areas.service_phone),
                                         last_seen=excluded.last_seen""",
        (area_id, project_id, project_name, name, detail.get("address"), detail.get("subject"),
         detail.get("servicePhone"), ts, ts),
    )


def insert_status(conn: sqlite3.Connection, area_id: str, detail: dict,
                  raw_json: str | None = None) -> int:
    """写一条区域状态快照，返回自增 id。

    ``raw_json``：``nearArea/{id}`` 的完整原始响应（JSON 字符串，数据契约 v2），
    与结构化字段并存，供后续新增字段的结构化解析回溯。
    """
    cur = conn.execute(
        """INSERT INTO area_status(area_id, captured_at, total_port, idle_port, charging_port,
                                   fault_port, usable_port, raw_json)
           VALUES (?,?,?,?,?,?,?,?)""",
        (area_id, now(), _int(detail.get("totalPort")), _int(detail.get("idlePort")),
         _int(detail.get("chargingPort")), _int(detail.get("faultPort")),
         detail.get("usablePort"), raw_json),
    )
    return cur.lastrowid


def start_run(conn: sqlite3.Connection, note: str = "") -> int:
    cur = conn.execute("INSERT INTO crawl_runs(started_at, note) VALUES (?,?)", (now(), note))
    return cur.lastrowid


def finish_run(conn: sqlite3.Connection, run_id: int, ok: int, errors: list[str]) -> None:
    conn.execute(
        "UPDATE crawl_runs SET finished_at=?, areas_ok=?, areas_error=?, note=COALESCE(note,'') || ? WHERE id=?",
        (now(), ok, len(errors), json.dumps(errors[:20], ensure_ascii=False), run_id),
    )


def record_skip(conn: sqlite3.Connection, reason: str) -> None:
    """记录一轮「跳过」（token 缺失/过期等），让分析时能区分「没数据」和「没抓取」。"""
    ts = now()
    conn.execute(
        "INSERT INTO crawl_runs(started_at, finished_at, areas_ok, areas_error, note) "
        "VALUES (?,?,0,0,?)",
        (ts, ts, f"skipped: {reason}"),
    )


def rollup_hourly(conn: sqlite3.Connection, settled_before: str) -> int:
    """把「已沉降」的原始快照聚合成小时表（幂等，可重复执行，重复会覆盖同一小时）。"""
    cur = conn.execute(
        """INSERT OR REPLACE INTO area_status_hourly
               (area_id, hour, samples, idle_avg, idle_min, idle_max,
                charging_avg, charging_min, charging_max, fault_max, total_port)
           SELECT area_id,
                  substr(captured_at, 1, 13) || ':00' AS hour,
                  COUNT(*), AVG(idle_port), MIN(idle_port), MAX(idle_port),
                  AVG(charging_port), MIN(charging_port), MAX(charging_port),
                  MAX(fault_port), MAX(total_port)
           FROM area_status
           WHERE captured_at < ?
           GROUP BY area_id, substr(captured_at, 1, 13)""",
        (settled_before,),
    )
    return cur.rowcount


def prune_raw(conn: sqlite3.Connection, cutoff: str) -> int:
    cur = conn.execute("DELETE FROM area_status WHERE captured_at < ?", (cutoff,))
    return cur.rowcount


def prune_crawl_runs(conn: sqlite3.Connection, cutoff: str) -> int:
    cur = conn.execute(
        "DELETE FROM crawl_runs WHERE COALESCE(finished_at, started_at) < ?", (cutoff,)
    )
    return cur.rowcount


def latest_status(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    return conn.execute(
        """SELECT a.project_name, a.name, s.captured_at, s.total_port, s.idle_port,
                  s.charging_port, s.fault_port
           FROM areas a
           JOIN area_status s ON s.id = (
               SELECT id FROM area_status WHERE area_id = a.id ORDER BY captured_at DESC, id DESC LIMIT 1
           )
           ORDER BY a.project_name, a.name"""
    ).fetchall()


def _int(value) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None
