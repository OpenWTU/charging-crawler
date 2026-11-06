"""数据保留：原始快照保留 N 天，更早的数据聚合为小时表永久保留。"""

from __future__ import annotations

import argparse
import sys
from datetime import datetime, timedelta
from pathlib import Path

from . import db

FMT = "%Y-%m-%d %H:%M:%S"


def cutoff_for(now: datetime, keep_days: int) -> str:
    """保留边界对齐到整点：整点之前的小时才整小时删除，避免把边界小时切半。"""
    return (now - timedelta(days=keep_days)).strftime("%Y-%m-%d %H:00:00")


def settle_for(now: datetime, settle_days: int, cutoff: str) -> str:
    """聚合边界不早于删除边界：keep_days < settle_days 时也先聚合再删。"""
    return max((now - timedelta(days=settle_days)).strftime(FMT), cutoff)


def run(db_path: str | Path, *, keep_days: int = 90, settle_days: int = 2) -> dict:
    """先把「已沉降」的原始数据聚合成小时表（幂等），再删除超过保留期的原始行。

    两个关键约束（审查发现）：
    - cutoff 对齐整点：避免把边界那一小时切成两半，下一轮用残缺样本覆盖完整聚合；
    - settle_before 不早于 cutoff：keep_days < settle_days 时也先聚合再删除，不丢数据。
    """
    conn = db.connect(db_path)
    try:
        now = datetime.now()
        cutoff = cutoff_for(now, keep_days)
        settle_before = settle_for(now, settle_days, cutoff)
        rolled = db.rollup_hourly(conn, settle_before)
        deleted = db.prune_raw(conn, cutoff)
        runs_deleted = db.prune_crawl_runs(conn, (now - timedelta(days=365)).strftime(FMT))
        conn.commit()
    finally:
        conn.close()
    return {"rolled": rolled, "deleted": deleted, "runs_deleted": runs_deleted,
            "keep_days": keep_days}


def main() -> int:
    parser = argparse.ArgumentParser(description="原始快照保留 + 小时聚合")
    parser.add_argument("--db", default="data/stations.db")
    parser.add_argument("--keep-days", type=int, default=90, help="原始 5 分钟数据保留天数")
    parser.add_argument("--settle-days", type=int, default=2, help="只聚合 N 天前的数据，避免聚合到半截小时")
    args = parser.parse_args()
    if args.keep_days < 1:
        parser.error("--keep-days 必须 >= 1（负数会删除全部原始数据）")
    if args.settle_days < 0:
        parser.error("--settle-days 不能为负")

    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    result = run(args.db, keep_days=args.keep_days, settle_days=args.settle_days)
    print(f"小时聚合 {result['rolled']} 行，删除原始数据 {result['deleted']} 行，"
          f"删除抓取记录 {result['runs_deleted']} 行（保留 {result['keep_days']} 天）-> {args.db}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
