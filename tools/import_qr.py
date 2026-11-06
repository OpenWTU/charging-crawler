"""把二维码设备号（CSV）导入 controllers.qr_device_no。

CSV 表头：qr_device_no,pile_code
    qr_device_no  8 位十六进制码牌号（如 acfc1a00）
    pile_code     平台十进制桩号（controllers.code，如 10001）

按 pile_code 找 controllers.code，更新对应设备的 qr_device_no；纯本地操作，
不调用平台接口。表头也接受常见别名（qr / code / 桩号 等）。

用法：
    python tools/import_qr.py qr.csv
    python tools/import_qr.py qr.csv --db cloud/data/charge.db
    python tools/import_qr.py qr.csv --dry-run

输出每条明细（[ok] / [未匹配] / [跳过]）和末尾汇总；存在未匹配或非法行时
退出码为 1，全部成功为 0。
"""

from __future__ import annotations

import argparse
import csv
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from cloud import app as cloud_app  # noqa: E402

QR_ALIASES = ("qr_device_no", "qr", "qr_code", "二维码设备号", "码牌号")
CODE_ALIASES = ("pile_code", "code", "device_code", "桩号", "设备编号")


def _norm_header(name: str) -> str:
    return str(name or "").strip().lower().lstrip("\ufeff")


def _pick_column(fieldnames: list[str], aliases: tuple[str, ...]) -> str:
    for alias in aliases:
        if alias in fieldnames:
            return alias
    return ""


def import_csv(db_path: Path, csv_path: Path, *, dry_run: bool = False) -> int:
    if not csv_path.is_file():
        print(f"[错误] CSV 不存在: {csv_path}", file=sys.stderr)
        return 2
    conn = cloud_app.init_db(db_path)
    updated = unmatched = skipped = 0
    try:
        with csv_path.open("r", encoding="utf-8-sig", newline="") as handle:
            reader = csv.DictReader(handle)
            fieldnames = [_norm_header(name) for name in (reader.fieldnames or [])]
            reader.fieldnames = fieldnames
            qr_col = _pick_column(fieldnames, QR_ALIASES)
            code_col = _pick_column(fieldnames, CODE_ALIASES)
            if not qr_col or not code_col:
                print(f"[错误] 表头需包含 qr_device_no,pile_code，实际: {fieldnames}",
                      file=sys.stderr)
                return 2
            for line_no, row in enumerate(reader, start=2):
                qr = str(row.get(qr_col) or "").strip().lower()
                code = str(row.get(code_col) or "").strip()
                if not qr and not code:
                    continue
                if not cloud_app.QR_DEVICE_RE.match(qr):
                    print(f"[跳过] 第 {line_no} 行 qr_device_no 非 8 位十六进制: "
                          f"{qr or '-'}")
                    skipped += 1
                    continue
                if not code:
                    print(f"[跳过] 第 {line_no} 行缺少 pile_code")
                    skipped += 1
                    continue
                devices = [r[0] for r in conn.execute(
                    "SELECT device_hex FROM controllers WHERE code = ?", (code,))]
                if not devices:
                    print(f"[未匹配] code={code} qr={qr}（controllers 里没有该桩号）")
                    unmatched += 1
                    continue
                for device_hex in devices:
                    if not dry_run:
                        conn.execute(
                            "UPDATE controllers SET qr_device_no = ? "
                            "WHERE device_hex = ?", (qr, device_hex))
                    print(f"[ok] {device_hex} code={code} qr={qr}"
                          + ("（dry-run 未写库）" if dry_run else ""))
                    updated += 1
        if not dry_run:
            conn.commit()
    finally:
        conn.close()
    print(f"汇总: 更新 {updated} 台, 未匹配 {unmatched} 行, 跳过 {skipped} 行"
          + ("（dry-run）" if dry_run else ""))
    return 0 if not (unmatched or skipped) else 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="导入二维码设备号到 controllers")
    parser.add_argument("csv", help="CSV 文件（表头 qr_device_no,pile_code）")
    parser.add_argument("--db", default="cloud/data/charge.db",
                        help="sqlite 数据库路径（默认 cloud/data/charge.db）")
    parser.add_argument("--dry-run", action="store_true",
                        help="只打印匹配结果，不写库")
    args = parser.parse_args(argv)
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    return import_csv(Path(args.db), Path(args.csv), dry_run=args.dry_run)


if __name__ == "__main__":
    raise SystemExit(main())
