"""枚举控制器设备号：前缀 × 后缀 调 charge/info，命中的写入 controllers。

在服务器上运行（tokens 表里要有有效 token）：
    python3 tools/sync_controllers.py
    python3 tools/sync_controllers.py --start 0x00 --end 0x1F
    python3 tools/sync_controllers.py --suffix AFEC05,AFEC04 --dry-run

只写 controllers 表，不改动 snapshots / area_samples / areas 等区域抓取数据。
每个候选请求之间间隔 0.25s，避免把平台打爆。
"""

from __future__ import annotations

import argparse
import os
import sqlite3
import sys
import time

CHARGE_ROOT = os.environ.get("CHARGE_ROOT", "/opt/charge-cloud")
if CHARGE_ROOT not in sys.path:
    sys.path.insert(0, CHARGE_ROOT)

DEFAULT_DB = os.environ.get("CHARGE_DB", "/var/lib/charge-cloud/charge.db")
DEFAULT_SUFFIXES = ("AFEC05", "AFEC04", "AFEC06", "AFEC00", "AFED05",
                    "AFFC05", "AFEC07", "AFEC08", "AFEC09")
REQUEST_INTERVAL = 0.25

CONTROLLERS_DDL = """CREATE TABLE IF NOT EXISTS controllers (
    device_hex TEXT PRIMARY KEY,
    code       TEXT,
    area_id    TEXT,
    area_name  TEXT,
    updated_at TEXT
)"""


def parse_byte(text: str) -> int:
    """接受 00 / 0x00 / FF 形式的单字节前缀。"""
    try:
        value = int(str(text).strip(), 16)
    except ValueError:
        raise argparse.ArgumentTypeError(f"非法字节值: {text!r}（应为 00-FF）")
    if not 0 <= value <= 0xFF:
        raise argparse.ArgumentTypeError(f"字节越界: {text!r}（应为 00-FF）")
    return value


def parse_suffixes(values: list[str] | None) -> list[str]:
    out: list[str] = []
    for raw in values or ():
        for part in str(raw).split(","):
            suffix = part.strip().upper()
            if not suffix:
                continue
            if len(suffix) != 6 or any(c not in "0123456789ABCDEF"
                                       for c in suffix):
                raise SystemExit(f"后缀需为 6 位十六进制: {suffix!r}")
            if suffix not in out:
                out.append(suffix)
    return out or list(DEFAULT_SUFFIXES)


def load_token(conn: sqlite3.Connection) -> tuple[str, str]:
    from cloud.app import decrypt_token
    row = conn.execute(
        "SELECT user_id, token FROM tokens WHERE expires_at > ? "
        "ORDER BY updated_at DESC LIMIT 1", (int(time.time()),)).fetchone()
    if not row:
        raise SystemExit("tokens 表没有有效 token：请先用 App 上传一次快照")
    return row[0], decrypt_token(row[1])


def upsert_controller(conn: sqlite3.Connection, device: str, data: dict) -> None:
    conn.execute(
        """INSERT INTO controllers(device_hex, code, area_id, area_name, updated_at)
           VALUES (?,?,?,?,datetime('now','localtime'))
           ON CONFLICT(device_hex) DO UPDATE SET code = excluded.code,
               area_id = excluded.area_id, area_name = excluded.area_name,
               updated_at = excluded.updated_at""",
        (device, str(data.get("code") or "").strip(),
         str(data.get("areaId") or "").strip(),
         str(data.get("areaName") or "").strip()))
    conn.commit()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="枚举控制器设备号并登记到 controllers 表")
    parser.add_argument("--db", default=DEFAULT_DB, help="SQLite 数据库路径")
    parser.add_argument("--start", type=parse_byte, default=0x00,
                        help="起始前缀（默认 00）")
    parser.add_argument("--end", type=parse_byte, default=0xFF,
                        help="结束前缀（默认 FF，含）")
    parser.add_argument("--suffix", action="append", metavar="HEX6",
                        help="6 位后缀，可重复或逗号分隔（默认内置 9 个）")
    parser.add_argument("--dry-run", action="store_true",
                        help="只打印命中，不写数据库")
    parser.add_argument("--sleep", type=float, default=REQUEST_INTERVAL,
                        help="每次请求间隔秒数（默认 0.25）")
    args = parser.parse_args(argv)
    if args.end < args.start:
        raise SystemExit("--end 不能小于 --start")

    suffixes = parse_suffixes(args.suffix)
    from crawler.api import AuthExpired, call

    conn = sqlite3.connect(args.db, timeout=10)
    try:
        conn.execute(CONTROLLERS_DDL)
        conn.commit()
        user_id, token = load_token(conn)
        scanned = found = 0
        for prefix in range(args.start, args.end + 1):
            for suffix in suffixes:
                device = "%02X%s" % (prefix, suffix)
                scanned += 1
                try:
                    try:
                        resp = call("charge/info",
                                    {"device": device, "port": "00", "cmd": 0},
                                    token=token, user_id=user_id)
                    except AuthExpired:
                        raise SystemExit("token 已失效：请先用 App 重新上传一次快照")
                    except Exception as exc:
                        print(f"[warn] {device}: {exc}", flush=True)
                        continue
                    data = resp.get("data")
                    if not isinstance(data, dict):
                        continue
                    area_name = str(data.get("areaName") or "").strip()
                    if resp.get("code") != 200 or not area_name:
                        continue
                    code = str(data.get("code") or "").strip()
                    found += 1
                    print(f"{device} -> {area_name} -> {code}", flush=True)
                    if not args.dry_run:
                        upsert_controller(conn, device, data)
                finally:
                    time.sleep(args.sleep)
        print(f"扫描 {scanned} 个候选，命中 {found} 个控制器"
              + ("（dry-run，未写入）" if args.dry_run else ""), flush=True)
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
