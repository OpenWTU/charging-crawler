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

**同时把 APK 也同步进 `deploy/app-v<version>.apk`**（文件名带版本，旧版本自动清理）：
jsDelivr 只能代理仓库文件，
Release 附件它取不到。App 的下载逻辑是「version.json 从哪个通道拿到，就优先从哪个
通道下包」，所以 CDN 通道必须仓库里真的有包可下。

**再打一个 `cdn-v<version>` tag**：App 下载 APK 时用**不可变引用**
`cdn.jsdelivr.net/gh/.../@cdn-v2.5.3/deploy/app-debug.apk`，而不是 `@main`。

- `@main` 是分支引用 → jsDelivr **缓存 12 小时**且内容会变 → 必须每次 purge
- `@cdn-v2.5.3` 是 tag 引用 → **不可变、永久缓存** → 不用 purge，且不会出现
  「CDN 上是上一个版本的包」这种问题
- 为什么不直接用 `v2.5.3`：那个 tag 指向发版时的 commit，而 APK 是**发版后**才提交的，
  tag 里没有这个文件 → 会 404。`cdn-v` 前缀同时避开了 workflow 的 `tags: ['v*']` 触发。

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


def purge_one(name: str) -> None:
    """purge 单个文件；失败只提示，不影响主流程。"""
    purge = f"https://purge.jsdelivr.net/gh/{REPO}@main/deploy/{name}"
    try:
        body = http_text(purge, timeout=30)
        j = json.loads(body)
        print(f"  {name}: HTTP 200 status={j.get('status')} providers={j.get('providers')}")
        if j.get("status") != "finished":
            print(f"  ⚠ {name} purge 未完成，CDN 可能要等缓存自然过期（最多 12h）")
    except Exception as e:  # noqa: BLE001
        print(f"  ⚠ {name} purge 失败：{e}（CDN 最多等 12h 自然过期）")


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

    # ---- 2.5) 同步 APK 到 deploy/app-v<version>.apk（供 CDN 通道下载）----
    # 文件名带版本号：
    #   · CDN 上不同版本互不覆盖，`@cdn-v2.5.3/deploy/app-v2.5.3.apk` 语义自解释
    #   · 排查时一眼能看出某个 URL 是哪个版本的包
    # 只保留最新一份：旧的 app-v*.apk 在提交前删掉，避免仓库里堆一堆 476KB 二进制。
    ver = str(data.get("versionName") or "").strip()
    apk_name = f"app-v{ver}.apk" if ver else "app-debug.apk"
    apk_target = TARGET.parent / apk_name
    # 资产名从 v2.5.5 起带版本（app-v<version>.apk）；老版本回落到 app-debug.apk
    want_apk = f"app-v{ver}.apk" if ver else "app-debug.apk"
    apk_asset = next((a for a in rel.get("assets", []) if a.get("name") == want_apk), None)
    if not apk_asset:
        apk_asset = next((a for a in rel.get("assets", []) if a.get("name") == "app-debug.apk"), None)
    if not apk_asset:
        names = ", ".join(a.get("name", "?") for a in rel.get("assets", []))
        print(f"  ⚠ Release 里没有 {want_apk}，跳过（现有资产：{names}）")
    else:
        print(f"[2.5] 下载 APK → deploy/{apk_name} …")
        try:
            req = urllib.request.Request(apk_asset["browser_download_url"], headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=120) as r:
                blob = r.read()
            apk_target.write_bytes(blob)
            import hashlib
            got = hashlib.sha256(blob).hexdigest()
            want = str(data.get("sha256") or "")
            ok = (got == want)
            print(f"  {len(blob)} B  sha256={got[:24]}…  {'✓ 与 version.json 一致' if ok else '✗ 与 version.json 不一致！'}")
            if not ok:
                print("  ✗ APK 校验失败，终止（避免把坏包提交进仓库）")
                return 1

            # 清理旧版本的 APK（含早期固定名 app-debug.apk）
            removed = []
            for old in list(TARGET.parent.glob("app-v*.apk")) + [TARGET.parent / "app-debug.apk"]:
                if old.exists() and old.resolve() != apk_target.resolve():
                    try:
                        git("rm", "--cached", "--ignore-unmatch", "-q", str(old.relative_to(TARGET.parent.parent)), check=False)
                    except Exception:  # noqa: BLE001
                        pass
                    old.unlink()
                    removed.append(old.name)
            if removed:
                print(f"  已清理旧版本 APK：{', '.join(removed)}")
        except Exception as e:  # noqa: BLE001
            print(f"  ✗ APK 下载失败：{e}")
            return 1

    # ---- 3) git commit + push ----
    if args.no_push:
        print("[3/4] 跳过提交（--no-push）")
    else:
        print("[3/4] 提交并推送 …")
        git("add", "-A", "deploy/")
        if apk_target.exists():
            print(f"  将提交 deploy/{apk_name}")
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

            # 打不可变 CDN 引用 tag（cdn-v 前缀不匹配 workflow 的 tags: ['v*']，不会触发 CI）
            ver = str(data.get("versionName") or "").strip()
            if ver:
                cdn_tag = f"cdn-v{ver}"
                print(f"[3.5] 打 CDN 引用 tag {cdn_tag} …")
                git("tag", "-f", "-a", cdn_tag, "-m", f"CDN 引用：{tag} 的安装包与版本信息")
                try:
                    git("push", "-f", "origin", f"refs/tags/{cdn_tag}")
                    print(f"  {cdn_tag} 已推送（App 将从 @{cdn_tag} 下载 APK，永久缓存无需 purge）")
                except subprocess.CalledProcessError as e:
                    print(f"  ⚠ {cdn_tag} 推送失败：{e.stderr or e}")
            else:
                print("  ⚠ version.json 里没有 versionName，跳过 cdn-v tag")

    # ---- 4) purge jsDelivr ----
    if args.no_purge:
        print("[4/4] 跳过 purge（--no-purge）")
    else:
        print("[4/4] purge jsDelivr 缓存 …")
        # 一次 purge 目录下两个文件（jsDelivr 支持对单个 URL purge，逐个调）
        # APK 走 @cdn-v<version> 不可变引用，永久缓存，不需要 purge；
        # 只有 version.json 在 @main 上，必须刷新。
        purge_one("version.json")

    print()
    print(f"✅ 完成：{tag} 已同步到仓库，CDN 已请求刷新")
    print("   提醒：cdn.jsdelivr.net 在部分网络下不可达，实际内容建议在手机端核对")
    return 0


if __name__ == "__main__":
    sys.exit(main())
