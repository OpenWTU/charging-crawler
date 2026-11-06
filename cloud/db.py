"""SQLite 建库与幂等迁移。

不变量：
* :data:`SCHEMA` 用 ``CREATE TABLE IF NOT EXISTS`` 建全套表，``init_db`` 先执行
  SCHEMA 再执行 :func:`migrate_schema`，任何旧库都能原地升级；
* :func:`migrate_schema` 必须**幂等**：补列前用 ``table_columns()`` 判重，补表前
  用 ``sqlite_master`` 判存在，重复执行不会改数据；
* 连接固定 WAL + busy_timeout，WAL 未启用时只告警不失败。
"""

from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

from .config import PORT_STATUS_GROUPS
from .security import ensure_default_admin
from .store import DEVICE_APPROVAL_KEY, seed_areas


SCHEMA = """
CREATE TABLE IF NOT EXISTS snapshots (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    received_at  TEXT NOT NULL,
    captured_at  TEXT,
    project      TEXT,
    app_version  TEXT,
    token_user   TEXT,
    client_ip    TEXT,
    device_id    TEXT,
    real_ip      TEXT,
    body_sha256  TEXT NOT NULL,
    payload      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snapshots_received ON snapshots(received_at);
CREATE INDEX IF NOT EXISTS idx_snapshots_sha ON snapshots(body_sha256);
CREATE TABLE IF NOT EXISTS nonces (
    nonce    TEXT PRIMARY KEY,
    seen_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS area_samples (
    snapshot_id  INTEGER NOT NULL,
    area_id      TEXT,
    area_name    TEXT NOT NULL,
    idle         INTEGER NOT NULL,
    total        INTEGER NOT NULL,
    charging     INTEGER NOT NULL,
    fault        INTEGER NOT NULL,
    received_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_samples_area ON area_samples(area_name, snapshot_id);
CREATE INDEX IF NOT EXISTS idx_samples_received ON area_samples(received_at);
CREATE TABLE IF NOT EXISTS areas (
    area_id    TEXT PRIMARY KEY,
    name       TEXT UNIQUE,
    first_seen TEXT,
    last_seen  TEXT,
    lat        REAL,
    lng        REAL
);
CREATE TABLE IF NOT EXISTS app_settings (
    key   TEXT PRIMARY KEY,
    value TEXT
);
CREATE TABLE IF NOT EXISTS worker_runs (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    ts     TEXT NOT NULL,
    result TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS upload_audit (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    ts       TEXT NOT NULL,
    ip       TEXT,
    ua       TEXT,
    size     INTEGER,
    result   TEXT,
    detail   TEXT
);
CREATE TABLE IF NOT EXISTS admin_users (
    username   TEXT PRIMARY KEY,
    pass_hash  TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    disabled   INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS tokens (
    user_id     TEXT PRIMARY KEY,
    token       TEXT NOT NULL,
    expires_at  INTEGER NOT NULL,
    updated_at  TEXT NOT NULL
);
-- token 池：多 token 轮换来源（tokens 只做兼容写入），token 已加密。
CREATE TABLE IF NOT EXISTS token_pool (
    id         INTEGER PRIMARY KEY,
    user_id    TEXT,
    token      TEXT,
    expires_at INTEGER,
    updated_at TEXT,
    source     TEXT,
    last_error TEXT
);
CREATE TABLE IF NOT EXISTS devices (
    device_id   TEXT PRIMARY KEY,
    secret_enc  TEXT NOT NULL,
    model       TEXT,
    app_version TEXT,
    created_at  TEXT NOT NULL,
    last_seen   TEXT,
    uploads     INTEGER NOT NULL DEFAULT 0,
    revoked     INTEGER NOT NULL DEFAULT 0,
    status      TEXT NOT NULL DEFAULT 'approved'
);
-- 控制器：device_hex 形如 00AFEC05，code 为平台十进制桩号，qr_device_no 为码牌
CREATE TABLE IF NOT EXISTS controllers (
    device_hex TEXT PRIMARY KEY,
    code       TEXT,
    area_id    TEXT,
    area_name  TEXT,
    updated_at TEXT,
    qr_device_no TEXT
);
-- 端口实时状态：每个控制器每个端口一行，由 sync_ports 维护
-- status_group：free/busy/unavailable/unknown（数据契约 v2），与原文 status 并存
CREATE TABLE IF NOT EXISTS port_states (
    device_hex TEXT NOT NULL,
    port       TEXT NOT NULL,
    status     TEXT,
    status_group TEXT NOT NULL DEFAULT 'unknown',
    updated_at TEXT,
    PRIMARY KEY (device_hex, port)
);
CREATE INDEX IF NOT EXISTS idx_port_states_device ON port_states(device_hex);
-- 注：idx_port_states_group 只在 migrate_schema 里建，因为老库的 port_states 还没有
-- status_group，直接在这里建索引会让 executescript(SCHEMA) 报 no such column。
-- 单桩采样：每设备每次抓取一条（同一秒 REPLACE），供单桩详情趋势使用
-- unavailable：不可用端口数（数据契约 v2 新增列）
CREATE TABLE IF NOT EXISTS pile_samples (
    device_hex TEXT NOT NULL,
    ts         TEXT NOT NULL,
    free       INTEGER,
    total      INTEGER,
    busy       INTEGER,
    online     INTEGER,
    unavailable INTEGER DEFAULT 0,
    PRIMARY KEY (device_hex, ts)
);
CREATE INDEX IF NOT EXISTS idx_pile_samples_ts ON pile_samples(ts);
"""


def table_columns(conn: sqlite3.Connection, table: str) -> set:
    return {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}


CONTROLLER_COLUMNS = (
    ("device_hex", "TEXT"),
    ("code", "TEXT"),
    ("area_id", "TEXT"),
    ("area_name", "TEXT"),
    ("updated_at", "TEXT"),
    ("qr_device_no", "TEXT"),
)


def ensure_controller_tables(conn: sqlite3.Connection) -> None:
    """幂等创建 controllers / port_states，并给历史 controllers 补列。

    生产库已有 controllers（字段齐全），这里用 sqlite_master 判断建表、
    用 PRAGMA table_info 判断补列，重复执行不会改数据、不会重复建。
    """
    tables = {row[0] for row in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'")}
    if "controllers" not in tables:
        conn.execute(
            """CREATE TABLE controllers (
                   device_hex TEXT PRIMARY KEY,
                   code       TEXT,
                   area_id    TEXT,
                   area_name  TEXT,
                   updated_at TEXT
               )""")
    else:
        have = table_columns(conn, "controllers")
        for column, decl in CONTROLLER_COLUMNS:
            if column not in have:
                conn.execute(
                    f"ALTER TABLE controllers ADD COLUMN {column} {decl}")
    if "port_states" not in tables:
        conn.execute(
            """CREATE TABLE port_states (
                   device_hex TEXT NOT NULL,
                   port       TEXT NOT NULL,
                   status     TEXT,
                   status_group TEXT NOT NULL DEFAULT 'unknown',
                   updated_at TEXT,
                   PRIMARY KEY (device_hex, port)
               )""")
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_port_states_device "
        "ON port_states(device_hex)")


def _backfill_status_group(conn: sqlite3.Connection) -> None:
    """旧行回填 ``port_states.status_group``（幂等，重复执行结果不变）。

    只回填「还没分组」的行（NULL / 空 / unknown），因此新代码写入的正确分组不会被
    覆盖；映射不到的状态保持 'unknown'。
    """
    for status, group in PORT_STATUS_GROUPS.items():
        if group == "unknown":
            continue
        conn.execute(
            "UPDATE port_states SET status_group = ? WHERE status = ? "
            "AND (status_group IS NULL OR status_group = '' "
            "OR status_group = 'unknown')", (group, status))
    conn.execute(
        "UPDATE port_states SET status_group = 'unknown' "
        "WHERE status_group IS NULL OR status_group = ''")


def _port_group_case(expr: str = "NEW.status") -> str:
    """把 ``PORT_STATUS_GROUPS`` 渲染成 SQL 的 CASE 表达式（单一真相源）。

    映射只存在于 Python 侧；触发器的 WHEN 分支由它生成，因此改映射表不会造成
    「Python 一套、SQL 一套」的漂移——只要 migrate_schema 再跑一次就会重建触发器。
    """
    whens = " ".join(
        "WHEN '%s' THEN '%s'" % (status.replace("'", "''"), group)
        for status, group in PORT_STATUS_GROUPS.items() if group != "unknown")
    return "CASE %s %s ELSE 'unknown' END" % (expr, whens)


def ensure_port_group_triggers(conn: sqlite3.Connection) -> None:
    """让 ``port_states.status_group`` 由数据库自己维护（幂等：先 DROP 再 CREATE）。

    修复的问题：原先 ``status_group`` 只在应用写入路径（上传 / sync / 迁移回填）里赋值，
    运维或脚本直接 ``UPDATE port_states SET status = ...`` 时分组不会跟着变，
    于是「按组聚合」的口径会和 ``status`` 原文打架。

    实现要点：
    - SQLite 触发器不能给 ``NEW.x`` 赋值，只能 AFTER INSERT/UPDATE 后回写；
    - 只监听 ``UPDATE OF status``，所以触发器内部的 ``SET status_group = ...``
      不会自我递归（默认 recursive_triggers 关闭，且列不匹配）；
    - ``port_states`` 的主键是 ``(device_hex, port)``，回写条件用主键精确定位一行。
    """
    case = _port_group_case()
    conn.execute("DROP TRIGGER IF EXISTS trg_port_states_group_ins")
    conn.execute("DROP TRIGGER IF EXISTS trg_port_states_group_upd")
    conn.execute(
        "CREATE TRIGGER trg_port_states_group_ins AFTER INSERT ON port_states "
        "BEGIN UPDATE port_states SET status_group = %s "
        "WHERE device_hex = NEW.device_hex AND port = NEW.port; END;" % case)
    conn.execute(
        "CREATE TRIGGER trg_port_states_group_upd AFTER UPDATE OF status ON port_states "
        "BEGIN UPDATE port_states SET status_group = %s "
        "WHERE device_hex = NEW.device_hex AND port = NEW.port; END;" % case)


def migrate_schema(conn: sqlite3.Connection) -> None:
    """对已有库幂等补列 / 补表 / 播种 area_id / 迁移 token 池。

    数据契约 v2 的新增列都在这里补（``ALTER TABLE ADD COLUMN`` + ``table_columns``
    判重），并且在 ``port_states`` 上建 ``idx_port_states_group`` 供按组聚合；
    可选表（如只存在于爬虫/历史库的 ``area_status``）不存在时跳过，不在此建表。
    """
    ensure_controller_tables(conn)
    tables = {row[0] for row in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'")}
    wanted = (
        ("snapshots", "device_id", "TEXT"),
        ("snapshots", "real_ip", "TEXT"),
        ("area_samples", "area_id", "TEXT"),
        ("devices", "status", "TEXT NOT NULL DEFAULT 'approved'"),
        ("areas", "lat", "REAL"),
        ("areas", "lng", "REAL"),
        # 数据契约 v2
        ("area_status", "raw_json", "TEXT"),
        ("port_states", "status_group", "TEXT NOT NULL DEFAULT 'unknown'"),
        ("pile_samples", "unavailable", "INTEGER DEFAULT 0"),
    )
    for table, column, decl in wanted:
        if table not in tables:
            continue
        if column not in table_columns(conn, table):
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {decl}")
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_samples_area_id "
        "ON area_samples(area_id, snapshot_id)")
    if "port_states" in tables:
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_port_states_group "
            "ON port_states(device_hex, status_group)")
        _backfill_status_group(conn)
        # 修复「status_group 无触发器同步」：任何直接 SQL 改 status 也会自动复算分组。
        ensure_port_group_triggers(conn)
    conn.execute(
        "INSERT OR IGNORE INTO app_settings(key, value) VALUES (?, ?)",
        (DEVICE_APPROVAL_KEY, "on"))
    # P1：把历史 tokens 行原样搬进 token_pool（token 已加密，不再解包）。
    # token_pool 没有 user_id 唯一约束，用 NOT EXISTS 保证重复初始化不产生重复行。
    conn.execute(
        "INSERT OR IGNORE INTO token_pool(user_id, token, expires_at, updated_at, source) "
        "SELECT t.user_id, t.token, t.expires_at, t.updated_at, 'migrate' FROM tokens t "
        "WHERE t.user_id IS NOT NULL AND NOT EXISTS ("
        "SELECT 1 FROM token_pool p WHERE p.user_id = t.user_id)")
    seed_areas(conn)
    conn.commit()


def init_db(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, timeout=10, check_same_thread=False)
    _wal = conn.execute("PRAGMA journal_mode=WAL").fetchone()
    if not _wal or str(_wal[0]).lower() != "wal":
        sys.stderr.write(f"[db] WAL 未启用: {_wal}\n")
    conn.execute("PRAGMA busy_timeout=20000")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.executescript(SCHEMA)
    conn.commit()
    migrate_schema(conn)
    ensure_default_admin(conn)
    return conn
