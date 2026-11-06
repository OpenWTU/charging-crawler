"""定时抓取：每 N 秒一轮（带抖动）；token 失效时记录跳过；每天执行一次数据保留。

用法：
    python -m crawler.scheduler --every 300 --jitter 30 --db data/stations.db
token 来源：--token > 环境变量 CHARGING_TOKEN > 自动扫描微信本地存储（每轮重新读，刷新后下一轮生效）。
"""

from __future__ import annotations

import argparse
import os
import random
import sys
import time

from . import api, crawl, db, retention
from .token import Token, find_latest, parse_jwt

RETENTION_INTERVAL = 24 * 3600


def _resolve_token(args: argparse.Namespace) -> Token | None:
    raw = (args.token or os.environ.get("CHARGING_TOKEN", "")).strip()
    if raw:
        return parse_jwt(raw)
    return find_latest(args.wechat_root, user_id=args.user)


def _record_skip(db_path: str, reason: str) -> None:
    conn = db.connect(db_path)
    try:
        db.record_skip(conn, reason)
        conn.commit()
    finally:
        conn.close()


def _safe_skip(db_path: str, reason: str) -> None:
    """skip 记录失败（例如数据库被锁）不能让守护进程退出。"""
    try:
        _record_skip(db_path, reason)
    except Exception as exc:
        print(f"[{_ts()}] 跳过记录写入失败（继续运行）：{exc!r}", file=sys.stderr, flush=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="快充充电桩状态定时抓取")
    parser.add_argument("--db", default="data/stations.db")
    parser.add_argument("--every", type=int, default=300, help="抓取间隔秒数（默认 300 = 5 分钟）")
    parser.add_argument("--jitter", type=int, default=30, help="每轮随机抖动上限秒数")
    parser.add_argument("--delay", type=float, default=1.0, help="单个请求间隔秒数")
    parser.add_argument("--keep-days", type=int, default=90, help="原始数据保留天数")
    parser.add_argument("--limit", type=int, default=None, help="调试：只抓前 N 个充电区")
    parser.add_argument("--project", type=int, default=None, help="强制指定 projectId")
    parser.add_argument("--token", default="", help="手动指定 token（不传则自动从微信读取）")
    parser.add_argument("--wechat-root", default=None, help="自定义微信 XWeb profiles 目录")
    parser.add_argument("--user", default=None, help="多账号时指定 userId")
    parser.add_argument("--once", action="store_true", help="只跑一轮（调试）")
    args = parser.parse_args()

    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if args.every < 60:
        print("--every 不能小于 60 秒（保护平台）", file=sys.stderr, flush=True)
        return 2

    last_retention = 0.0
    print(f"定时抓取启动：每 {args.every}s ± {args.jitter}s，db={args.db}，Ctrl+C 退出", flush=True)

    while True:
        now = time.time()
        if now - last_retention >= RETENTION_INTERVAL:
            try:
                result = retention.run(args.db, keep_days=args.keep_days)
                print(f"[{_ts()}] 数据保留：聚合 {result['rolled']} 行，删除 {result['deleted']} 行", flush=True)
                last_retention = now
            except Exception as exc:
                print(f"[{_ts()}] 数据保留失败（1 小时后重试）：{exc!r}", file=sys.stderr, flush=True)
                last_retention = now - RETENTION_INTERVAL + 3600

        token = _resolve_token(args)
        if token is None or token.expired:
            reason = "token 缺失或已过期，需在微信里重新打开快充页面"
            _safe_skip(args.db, reason)
            print(f"[{_ts()}] 跳过：{reason}", flush=True)
        else:
            try:
                result = crawl.run(args.db, token, delay=args.delay, limit=args.limit,
                                   project_override=args.project, verbose=False)
                print(f"[{_ts()}] 抓取完成 user={token.user_id} ok={result['areas_ok']} "
                      f"errors={len(result['errors'])}", flush=True)
            except db.CrawlBusy as exc:
                _safe_skip(args.db, f"另一轮抓取进行中：{exc}")
                print(f"[{_ts()}] 跳过：{exc}", flush=True)
            except api.AuthExpired as exc:
                _safe_skip(args.db, f"token 失效：{exc}")
                print(f"[{_ts()}] 跳过：token 失效（{exc}）", flush=True)
            except Exception as exc:
                _safe_skip(args.db, f"抓取异常：{exc}")
                print(f"[{_ts()}] 抓取异常：{exc!r}", file=sys.stderr, flush=True)

        if args.once:
            return 0
        try:
            time.sleep(args.every + random.uniform(0, max(0, args.jitter)))
        except KeyboardInterrupt:
            print("\n已停止", flush=True)
            return 0


def _ts() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")


if __name__ == "__main__":
    raise SystemExit(main())
