"""校验 charge-cloud 备份目录/完整包（manifest + sha256 + SQLite + token_key）。

用法：
    python tools/backup_check.py --dest /var/lib/charge-cloud/backups
    python tools/backup_check.py --bundle /var/lib/charge-cloud/backups/nas/daily/charge-2026-11-03-full.tar.gz

脚本只读，成功返回 0，任何校验失败返回 1；供恢复演练/巡检使用。
"""

from __future__ import annotations

import argparse
import hashlib
import io
import sqlite3
import sys
import tarfile
import tempfile
from pathlib import Path


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def parse_manifest(path: Path) -> dict:
    data = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        key, sep, value = line.partition("=")
        if sep:
            data[key.strip()] = value.strip()
    return data


def check_sqlite(path: Path) -> list:
    try:
        conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=10)
        try:
            ok = conn.execute("PRAGMA integrity_check").fetchone()[0]
        finally:
            conn.close()
    except Exception as exc:
        return [f"数据库无法打开/损坏: {path}: {exc}"]
    if ok != "ok":
        return [f"数据库 integrity_check 失败: {path}: {ok}"]
    return []


def check_config(path: Path) -> list:
    errors = []
    if not path.is_file():
        return [f"配置包不存在: {path}"]
    try:
        with tarfile.open(path, "r:gz") as tar:
            names = tar.getnames()
    except Exception as exc:
        return [f"配置包无法解压: {path}: {exc}"]
    if "token_key" not in names:
        errors.append(f"配置包缺少 token_key: {path}")
    if "version.json" not in names:
        errors.append(f"配置包缺少 version.json: {path}（警告）")
    return errors


def verify_backup_dir(dest: Path) -> tuple[list, list]:
    """返回 (errors, warnings)；校验最新一份 charge-*.manifest 及其文件。"""
    errors, warnings = [], []
    manifests = sorted(dest.glob("charge-*.manifest"))
    if not manifests:
        return [f"目录中没有 charge-*.manifest: {dest}"], warnings
    manifest_path = manifests[-1]
    data = parse_manifest(manifest_path)
    for key in ("date", "db", "config", "db_sha256", "config_sha256"):
        if not data.get(key):
            errors.append(f"manifest 缺少 {key}: {manifest_path}")
    if errors:
        return errors, warnings
    db_path = dest / data["db"]
    cfg_path = dest / data["config"]
    if not db_path.is_file():
        errors.append(f"DB 备份不存在: {db_path}")
    elif sha256_file(db_path) != data["db_sha256"]:
        errors.append(f"DB sha256 不匹配: {db_path}")
    else:
        errors.extend(check_sqlite(db_path))
    if not cfg_path.is_file():
        errors.append(f"配置包不存在: {cfg_path}")
    elif sha256_file(cfg_path) != data["config_sha256"]:
        errors.append(f"配置包 sha256 不匹配: {cfg_path}")
    else:
        cfg_errors = check_config(cfg_path)
        errors.extend([e for e in cfg_errors if "警告" not in e])
        warnings.extend([e for e in cfg_errors if "警告" in e])
    return errors, warnings


def verify_bundle(bundle: Path) -> tuple[list, list]:
    """校验 NAS 完整包：外部 .sha256、MANIFEST、DB/config、token_key。"""
    errors, warnings = [], []
    sha_path = bundle.with_suffix(bundle.suffix + ".sha256")
    if sha_path.is_file():
        parts = sha_path.read_text(encoding="utf-8").split()
        if parts and sha256_file(bundle) != parts[0]:
            errors.append(f"bundle sha256 不匹配: {bundle}")
    else:
        warnings.append(f"缺少 bundle sha256 文件: {sha_path}")
    try:
        with tempfile.TemporaryDirectory() as tmp:
            with tarfile.open(bundle, "r:gz") as tar:
                try:
                    tar.extractall(tmp, filter="data")
                except TypeError:  # Python < 3.12
                    tar.extractall(tmp)
            root = Path(tmp)
            manifest = root / "MANIFEST"
            if not manifest.is_file():
                return errors + [f"bundle 缺少 MANIFEST: {bundle}"], warnings
            data = parse_manifest(manifest)
            db_path = root / data.get("db", "db/charge.db")
            cfg_path = root / data.get("config", "config/charge-config.tgz")
            key_path = root / "config" / "token_key"
            if not key_path.is_file():
                errors.append("bundle 缺少 config/token_key")
            if db_path.is_file() and data.get("db_sha256"):
                if sha256_file(db_path) != data["db_sha256"]:
                    errors.append("bundle 内 DB sha256 不匹配")
                else:
                    errors.extend(check_sqlite(db_path))
            else:
                errors.append("bundle 内缺少 DB 或 db_sha256")
            if cfg_path.is_file() and data.get("config_sha256"):
                if sha256_file(cfg_path) != data["config_sha256"]:
                    errors.append("bundle 内 config sha256 不匹配")
                else:
                    errors.extend(check_config(cfg_path))
            else:
                errors.append("bundle 内缺少 config 或 config_sha256")
    except Exception as exc:
        errors.append(f"bundle 无法读取: {bundle}: {exc}")
    return errors, warnings


def main() -> int:
    parser = argparse.ArgumentParser(description="校验 charge-cloud 备份")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--dest", help="备份目录（含 charge-*.manifest）")
    group.add_argument("--bundle", help="完整包 .tar.gz")
    args = parser.parse_args()
    if args.dest:
        errors, warnings = verify_backup_dir(Path(args.dest))
    else:
        errors, warnings = verify_bundle(Path(args.bundle))
    for warning in warnings:
        print("WARN:", warning)
    for error in errors:
        print("ERROR:", error)
    if errors:
        return 1
    print("OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
