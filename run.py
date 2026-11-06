"""入口：python run.py [--token ...] [--limit N] [--db data/stations.db]

token 获取优先级：--token 参数 > 环境变量 CHARGING_TOKEN > 自动从微信 PC 内嵌浏览器
（XWeb）的 Local Storage 里读取最近一次登录签发的 JWT。
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

from crawler import api, crawl, db
from crawler.token import Token, find_latest, parse_jwt


def main() -> int:
    parser = argparse.ArgumentParser(description="快充充电桩状态爬虫")
    parser.add_argument("--token", help="userToken（JWT）；不传则自动从微信本地存储找")
    parser.add_argument("--token-file", help="从文件读 token")
    parser.add_argument("--db", default="data/stations.db", help="SQLite 文件路径")
    parser.add_argument("--limit", type=int, default=None, help="只抓前 N 个充电区（调试用）")
    parser.add_argument("--project", type=int, default=None,
                        help="强制指定 projectId（新账号未绑定小区时用，默认为账号绑定的项目）")
    parser.add_argument("--delay", type=float, default=0.25, help="每个请求间隔秒数")
    parser.add_argument("--wechat-root", default=None, help="自定义微信 XWeb profiles 目录")
    parser.add_argument("--user", default=None, help="指定自动扫描时要用的 userId（多账号时用）")
    parser.add_argument("--show", action="store_true", help="抓完后打印最新状态表")
    args = parser.parse_args()

    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    raw = args.token
    if not raw and args.token_file:
        raw = Path(args.token_file).read_text(encoding="utf-8").strip()
    if not raw:
        raw = os.environ.get("CHARGING_TOKEN", "").strip()

    token: Token | None = None
    if raw:
        token = parse_jwt(raw)
        if token is None:
            print("提供的 token 无效：不是快充的 JWT（需要 3 段、aud=quick_user_api、"
                  "含 encryId/iat/exp）。", file=sys.stderr)
            return 2
    if token is None:
        found = find_latest(args.wechat_root, user_id=args.user)
        if found is None:
            print("找不到可用的 userToken。请先在『微信 PC 版』里打开快充页面（公众号入口）完成登录，"
                  "或通过 --token 手动传入。", file=sys.stderr)
            return 2
        token = found
        print(f"已从微信本地存储读取 token（userId={token.user_id}，"
              f"签发 {token.issued_at}，过期 {token.expires_at}）")

    if token.expired:
        print("token 已过期：请在微信里重新打开快充页面刷新，再运行本脚本。", file=sys.stderr)
        return 3

    try:
        result = crawl.run(args.db, token, delay=args.delay, limit=args.limit,
                           project_override=args.project)
    except db.CrawlBusy as exc:
        print(f"已有另一轮抓取在进行：{exc}", file=sys.stderr)
        return 4
    except api.AuthExpired as exc:
        print(f"登录态失效：{exc}\n请在微信里重新打开快充页面刷新 token。", file=sys.stderr)
        return 3

    print(f"\n完成：成功 {result['areas_ok']} 个充电区，失败 {len(result['errors'])} 个 -> {result['db']}")
    if result["errors"]:
        print("失败明细:")
        for line in result["errors"][:10]:
            print("  -", line)

    if args.show:
        conn = db.connect(args.db)
        rows = db.latest_status(conn)
        print("\n最新状态：")
        for row in rows[:40]:
            print(f"  {row['project_name']} / {row['name']}: 空闲 {row['idle_port']}，"
                  f"充电中 {row['charging_port']}，故障 {row['fault_port']}（总 {row['total_port']}）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
