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
    python3 scripts/sync-release-version.py v2.5.1 --cleanup-tags-dry-run   # 只看要删哪些 tag
    python3 scripts/sync-release-version.py v2.5.1 --no-cleanup-tags        # 不清理旧 tag

脚本做五件事：
  1. 从 Release 拉 version.json → 写 deploy/version.json
  2. 拉 APK → 写 deploy/app-v<version>.apk（清理旧版本文件）
  3. commit + push main，并打 cdn-v<version> 不可变引用 tag
  4. purge jsDelivr 上 version.json 的缓存
  5. **清理同一 minor 版本的旧 tag**（v2.5.5 发版时删掉 v2.5.0~2.5.4 与 cdn-v2.5.x，
     更早的 2.4.x 不动）。Release 不用管 —— tag 删掉后 GitHub 会自动把它转成 draft。

退出码：0 成功；1 失败（含任何一步出错）。
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import time
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


def list_remote_tags() -> list[str]:
    """列出远程所有 v* / cdn-v* tag 名（去掉 ^{} 解引用行）。"""
    out = subprocess.run(
        ["git", "ls-remote", "--tags", "origin"],
        check=True, text=True, capture_output=True, cwd=TARGET.parent.parent,
    ).stdout
    names: list[str] = []
    for line in out.splitlines():
        m = re.search(r"refs/tags/((?:cdn-)?v[\d.]+)$", line.strip())
        if m:
            names.append(m.group(1))
    return names


def cleanup_old_tags(current_tag: str, dry_run: bool = False) -> int:
    """
    清理**同一 minor 版本**里的旧 tag：v2.5.5 发版时删掉 v2.5.0~v2.5.4 与 cdn-v2.5.x，
    更早的 minor（2.4.x 等）不动 —— 保持「每个 minor 只留最新一个」。

    Release 不用管：GitHub 在 tag 被删后会自动把关联 Release 转成 draft，
    对公众和 API 都不可见。

    @return 删除（或 dry-run 下计划删除）的 tag 数
    """
    m = re.match(r"^v(\d+)\.(\d+)\.(\d+)$", current_tag)
    if not m:
        print(f"  ⚠ 无法从 {current_tag} 解析版本号，跳过 tag 清理")
        return 0
    minor = f"{m.group(1)}.{m.group(2)}"
    keep = {current_tag, f"cdn-{current_tag}"}

    try:
        tags = list_remote_tags()
    except subprocess.CalledProcessError as e:
        print(f"  ⚠ 列远程 tag 失败：{e.stderr or e}")
        return 0

    doomed: list[str] = []
    for name in tags:
        if name in keep:
            continue
        mm = re.match(r"^(?:cdn-)?v(\d+)\.(\d+)\.(\d+)$", name)
        if not mm:
            continue
        if f"{mm.group(1)}.{mm.group(2)}" != minor:
            continue  # 只清同 minor
        doomed.append(name)

    if not doomed:
        print(f"  无需清理（{minor}.x 只有 {current_tag}）")
        return 0

    doomed.sort()
    print(f"  {minor}.x 下的旧 tag {len(doomed)} 个：{', '.join(doomed)}")
    if dry_run:
        print("  （dry-run，未实际删除）")
        return len(doomed)

    removed = 0
    for name in doomed:
        ok = False
        for _ in range(3):
            try:
                git("push", "origin", f":refs/tags/{name}")
                ok = True
                break
            except subprocess.CalledProcessError:
                time.sleep(2)
        if ok:
            # 本地副本也删（没有就忽略）
            git("tag", "-d", name, check=False)
            removed += 1
            print(f"    已删 {name}")
        else:
            print(f"    ✗ {name} 删除失败（网络？可稍后手动删）")
    return removed


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
    ap.add_argument("--no-cleanup-tags", action="store_true",
                    help="不清理同 minor 版本的旧 tag（默认会清，如 v2.5.0~2.5.4）")
    ap.add_argument("--cleanup-tags-dry-run", action="store_true",
                    help="只列出将要删除的旧 tag，不实际删除")
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
    # 兜底绝对化：老版本 CI 生成的 apkPath 是相对路径（/download/xxx），
    # 旧版 App 会把这种写法改写成 GitHub 地址，导致 GitHub 不通时下不了包。
    # 这里统一改成绝对 URL，旧版也能直接从节点下载。
    ap = str(data.get("apkPath") or "")
    if ap.startswith("/"):
        data["apkPath"] = "https://charge.lizishuo.cn" + ap
        print(f"  apkPath 已绝对化：{data['apkPath']}")
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

    # ---- 5) 清理同 minor 版本的旧 tag ----
    if args.no_cleanup_tags:
        print("[5/5] 跳过 tag 清理（--no-cleanup-tags）")
    else:
        print(f"[5/5] 清理 {tag} 所在 minor 版本的旧 tag …")
        cleanup_old_tags(tag, dry_run=args.cleanup_tags_dry_run)

    print()
    print(f"✅ 完成：{tag} 已同步到仓库，CDN 已请求刷新")
    print("   提醒：cdn.jsdelivr.net 在部分网络下不可达，实际内容建议在手机端核对")
    return 0


if __name__ == "__main__":
    sys.exit(main())
