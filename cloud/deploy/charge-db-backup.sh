#!/bin/bash
set -euo pipefail
export TZ=${TZ:-Asia/Shanghai}
DB=${CHARGE_DB:-/var/lib/charge-cloud/charge.db}
DEST=${CHARGE_BACKUP_DIR:-/var/lib/charge-cloud/backups}
CONFIG_DIR=${CHARGE_CONFIG_DIR:-/etc}
STATE_DIR=${CHARGE_STATE_DIR:-/var/lib/charge-cloud}
STAMP=$(date +%F)
PYTHON=${PYTHON:-python3}
mkdir -p "$DEST"
if [ "${CHARGE_SKIP_CHOWN:-0}" != "1" ]; then
  chown root:root "$DEST"
fi
chmod 700 "$DEST"

"$PYTHON" - "$DB" "$DEST" "$STAMP" <<'PY'
import sqlite3
import sys

db_path, dest, stamp = sys.argv[1], sys.argv[2], sys.argv[3]
src = sqlite3.connect(db_path, timeout=30)
src.execute("PRAGMA wal_checkpoint(TRUNCATE)")
dst_path = f"{dest}/charge-{stamp}.db"
dst = sqlite3.connect(dst_path)
with dst:
    src.backup(dst)
ok = dst.execute("PRAGMA integrity_check").fetchone()[0]
dst.close()
src.close()
if ok != "ok":
    raise SystemExit(f"integrity check failed: {ok}")
print("backup:", dst_path, "integrity:", ok)
PY

# 配置 + 加密密钥 + 版本文件：恢复时必须同批
TOKEN_KEY="$STATE_DIR/token_key"
[ -f "$TOKEN_KEY" ] || { echo "token_key missing: $TOKEN_KEY" >&2; exit 1; }
tar czf "$DEST/charge-config-$STAMP.tgz" \
  -C "$CONFIG_DIR" charge-cloud \
  -C "$STATE_DIR" token_key version.json
tar tzf "$DEST/charge-config-$STAMP.tgz" | grep -qx "token_key" \
  || { echo "token_key missing from config tar" >&2; exit 1; }
chmod 600 "$DEST"/charge-*.db "$DEST"/charge-config-*.tgz
if [ "${CHARGE_SKIP_CHOWN:-0}" != "1" ]; then
  chown root:root "$DEST"/charge-*.db "$DEST"/charge-config-*.tgz
fi

# manifest/checksum：恢复前先校验，避免拿到半成品备份
MANIFEST="$DEST/charge-$STAMP.manifest"
{
  echo "date=$STAMP"
  echo "db=charge-$STAMP.db"
  echo "config=charge-config-$STAMP.tgz"
  echo "db_sha256=$(sha256sum "$DEST/charge-$STAMP.db" | awk '{print $1}')"
  echo "config_sha256=$(sha256sum "$DEST/charge-config-$STAMP.tgz" | awk '{print $1}')"
} > "$MANIFEST"
chmod 600 "$MANIFEST"
if [ "${CHARGE_SKIP_CHOWN:-0}" != "1" ]; then
  chown root:root "$MANIFEST"
fi

find "$DEST" -name 'charge-*.db' -mtime +90 -delete
find "$DEST" -name 'charge-config-*.tgz' -mtime +90 -delete
find "$DEST" -name 'charge-*.manifest' -mtime +90 -delete
