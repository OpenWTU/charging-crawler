#!/usr/bin/env python3
"""
发版后把 GitHub Release 里的 version.json 同步进仓库，并 purge jsDelivr 缓存。

为什么需要这个脚本
------------------
App 的「检查更新」是三层降级：GitHub Releases API → jsDelivr CDN → 节点 /api/version。
中间那层 CDN 读的是**仓库里的** `deploy/version.json`（jsDelivr 只能代理仓库文件，
代理不了 Release 附件），而：

  ① 这个文件必须有人提交进 main —— CI 里自动做试过 4 种写法全部失败
     （git checkout / heredoc Python / gh CLI / curl+jq），且拿不到 CI 日志，
     所以挪到这里手工触发；
  ② jsDelivr 对 `@main` 这类分支引用**缓存 12 小时**，光提交不会立刻生效，
     必须调 purge 接口主动刷新，否则 App 走 CDN 会拿到上一个版本。

用法
----
    python3 scripts/sync-release-version.py v2.5.1
    python3 scripts/sync-release-version.py v2.5.1 --no-push     # 只改文件不提交
    python3 scripts/sync-release-version.py v2.5.1 --no-purge    # 不刷新 CDN

退出码：0 成功；1 失败（含任何一步出错）。
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

REPO = "OpenWTU/charging-crawler"
UA = "charge-release-sync/1.0"
TARGET = Path(__file__).resolve().parent.parent / "deploy" / "version.json"


def http_json(url: str, timeout: int = 25) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/vnd.github+json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def http_text(url: str, timeout: int = 25) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8")


def git(*args: str, check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], check=check, text=True,
                          capture_output=True, cwd=TARGET.parent.parent)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("tag", help="要同步的 tag，例如 v2.5.1")
    ap.add_argument("--no-push", action="store_true", help="只写文件，不 git commit/push")
    ap.add_argument("--no-purge", action="store_true", help="不调 jsDelivr purge")
    args = ap.parse_args()

    tag = args.tag if args.tag.startswith("v") else "v" + args.tag

    # ---- 1) 从 Release 取 version.json ----
    print(f"[1/4] 读取 Release {tag} 的 version.json …")
    try:
        rel = http_json(f"https://api.github.com/repos/{REPO}/releases/tags/{tag}")
    except urllib.error.HTTPError as e:
        print(f"  ✗ Release 不存在或不可访问：HTTP {e.code}")
        return 1
    asset = next((a for a in rel.get("assets", []) if a.get("name") == "version.json"), None)
    if not asset:
        print("  ✗ 该 Release 里没有 version.json 资产（release-apk 可能没跑完）")
        return 1
    data = json.loads(http_text(asset["browser_download_url"]))
    print(f"  versionName={data.get('versionName')} versionCode={data.get('versionCode')} "
          f"sha={str(data.get('sha256'))[:16]}…")

    # ---- 2) 写入 deploy/version.json（无 BOM、LF 结尾）----
    print(f"[2/4] 写入 {TARGET} …")
    TARGET.parent.mkdir(parents=True, exist_ok=True)
    TARGET.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    print(f"  {TARGET.stat().st_size} B")

    # ---- 3) git commit + push ----
    if args.no_push:
        print("[3/4] 跳过提交（--no-push）")
    else:
        print("[3/4] 提交并推送 …")
        rel_path = "deploy/version.json"
        git("add", rel_path)
        # 无变化就别提交
        diff = git("diff", "--cached", "--quiet", check=False)
        if diff.returncode == 0:
            print("  内容无变化，跳过提交")
        else:
            git("-c", "user.name=test19124", "-c", "user.email=test19124@sina.com",
                "commit", "-q", "-m",
                f"chore(release): 同步 deploy/version.json 到 {tag}")
            git("push", "origin", "main")
            print("  已提交并推送")

    # ---- 4) purge jsDelivr ----
    if args.no_purge:
        print("[4/4] 跳过 purge（--no-purge）")
    else:
        print("[4/4] purge jsDelivr 缓存 …")
        purge = f"https://purge.jsdelivr.net/gh/{REPO}@main/deploy/version.json"
        try:
            body = http_text(purge, timeout=30)
            j = json.loads(body)
            print(f"  HTTP 200 status={j.get('status')} throttled={j.get('throttled')} "
                  f"providers={j.get('providers')}")
            if j.get("status") != "finished":
                print("  ⚠ purge 未完成，CDN 可能要等缓存自然过期（最多 12h）")
        except Exception as e:  # noqa: BLE001
            print(f"  ⚠ purge 失败：{e}（CDN 最多等 12h 自然过期）")

    print()
    print(f"✅ 完成：{tag} 已同步到仓库，CDN 已请求刷新")
    print("   提醒：cdn.jsdelivr.net 在部分网络下不可达，实际内容建议在手机端核对")
    return 0


if __name__ == "__main__":
    sys.exit(main())
