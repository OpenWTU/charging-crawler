"""领域写读：区域登记/播种、设置项、设备审批开关、上传数据逐区校验。

不变量：
* 全部函数都要求调用方持有 ``httpd.db_lock``（除了显式说明的只读助手）；
* :func:`split_valid_areas` 是上传/刷新的唯一校验入口：未知区、「数据不守恒」
  只跳过本区，同名重复则整包拒绝（duplicate=True）；
* ``device_approval`` 默认 "on"，关闭后会顺手把 pending 设备批量批准。
"""

from __future__ import annotations

import sqlite3

from .config import now_str
from .geo import area_id_for_name


DEVICE_STATUSES = ("approved", "pending", "revoked")
DEVICE_APPROVAL_KEY = "device_approval"


def seed_areas(conn: sqlite3.Connection) -> None:
    """从历史 area_samples 播种 areas，并回填 area_samples.area_id（幂等）。"""
    names = [row[0] for row in conn.execute(
        "SELECT DISTINCT area_name FROM area_samples "
        "WHERE area_name IS NOT NULL AND area_name <> ''")]
    for name in names:
        conn.execute(
            "INSERT OR IGNORE INTO areas(area_id, name, first_seen, last_seen) "
            "VALUES (?,?,?,?)",
            (area_id_for_name(name), name, now_str(), now_str()))
        row = conn.execute("SELECT area_id FROM areas WHERE name = ?",
                           (name,)).fetchone()
        if row:
            conn.execute(
                "UPDATE area_samples SET area_id = ? "
                "WHERE area_name = ? AND area_id IS NULL", (row[0], name))


def upsert_area(conn: sqlite3.Connection, name: str) -> str:
    """按 name 登记区域并刷新 last_seen，返回 area_id。调用方持有 db_lock。"""
    aid = area_id_for_name(name)
    stamp = now_str()
    conn.execute(
        "INSERT INTO areas(area_id, name, first_seen, last_seen) VALUES (?,?,?,?) "
        "ON CONFLICT(name) DO UPDATE SET last_seen = excluded.last_seen",
        (aid, name, stamp, stamp))
    row = conn.execute("SELECT area_id FROM areas WHERE name = ?",
                       (name,)).fetchone()
    return row[0] if row else aid


def split_valid_areas(conn: sqlite3.Connection, areas: list) -> tuple:
    """逐区校验并拆分：返回 (valid, skipped, duplicate)。

    skipped 为 [(name, reason)]；duplicate=True 表示同一批里区名重复，
    属于客户端错误，调用方应整包拒绝（保持旧契约）。
    未知区/不守恒的区只跳过本区，不再让整轮抓取或整包上传失败。
    """
    valid: list = []
    skipped: list = []
    seen: set = set()
    known = {row[0] for row in conn.execute("SELECT name FROM areas")}
    for area in areas:
        name = area["name"]
        if name in seen:
            return [], [], True
        seen.add(name)
        idle = int(area["idle_port"])
        total = int(area["total_port"])
        charging = int(area["charging_port"])
        fault = int(area["fault_port"])
        if min(idle, total, charging, fault) < 0:
            skipped.append((name, "数据不守恒"))
            continue
        if idle + charging + fault != total:
            skipped.append((name, "数据不守恒"))
            continue
        if known and name not in known:
            skipped.append((name, "未知充电区"))
            continue
        valid.append(area)
    return valid, skipped, False


def check_areas(conn: sqlite3.Connection, areas: list) -> str:
    """兼容入口：返回首个错误文案（空串=全部通过）。新代码用 split_valid_areas。"""
    _valid, skipped, duplicate = split_valid_areas(conn, areas)
    if duplicate:
        return "区域重复"
    return skipped[0][1] if skipped else ""


def get_setting(conn: sqlite3.Connection, key: str, default: str = "") -> str:
    row = conn.execute("SELECT value FROM app_settings WHERE key = ?",
                       (key,)).fetchone()
    return row[0] if row else default


def set_setting(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute(
        "INSERT INTO app_settings(key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value", (key, value))


def device_approval_enabled(conn: sqlite3.Connection) -> bool:
    value = get_setting(conn, DEVICE_APPROVAL_KEY, "on")
    return str(value).strip().lower() in ("on", "1", "true", "yes")
