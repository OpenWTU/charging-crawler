#!/bin/bash
set -euo pipefail
export TZ=${TZ:-Asia/Shanghai}
SRC=${CHARGE_STATE_DIR:-/var/lib/charge-cloud}
BACKUP_SRC=${CHARGE_BACKUP_DIR:-$SRC/backups}
SOURCE_DIR=${CHARGE_SOURCE_DIR:-/opt/charge-cloud}
DEST=${CHARGE_BUNDLE_DIR:-$SRC/backups/nas}
STAMP=$(date +%F)
PYTHON=${PYTHON:-python3}
mkdir -p "$DEST/daily" "$DEST/weekly"
if [ "${CHARGE_SKIP_CHOWN:-0}" != "1" ]; then
  chown -R root:root "$DEST"
fi
chmod 700 "$DEST"

DB=$(ls -t "$BACKUP_SRC"/charge-*.db 2>/dev/null | head -1 || true)
CFG=$(ls -t "$BACKUP_SRC"/charge-config-*.tgz 2>/dev/null | head -1 || true)
[ -n "$DB" ] || { echo "no charge DB backup found in $BACKUP_SRC" >&2; exit 1; }
[ -n "$CFG" ] || { echo "no charge config backup found in $BACKUP_SRC" >&2; exit 1; }

# 只接受“今天的”DB/config，避免 03:17 备份失败时 03:20 静默打包昨天的旧数据。
[ "$(date -r "$DB" +%F)" = "$STAMP" ] \
  || { echo "DB backup is not from today: $DB" >&2; exit 1; }
[ "$(date -r "$CFG" +%F)" = "$STAMP" ] \
  || { echo "config backup is not from today: $CFG" >&2; exit 1; }
[ -f "$SRC/token_key" ] || { echo "token_key missing: $SRC/token_key" >&2; exit 1; }
tar tzf "$CFG" | grep -qx "token_key" \
  || { echo "token_key missing from config tar" >&2; exit 1; }

# 复制前先确认 DB 备份本身完整（只读打开，避免改动备份文件）。
"$PYTHON" - "$DB" <<'PY'
import sqlite3
import sys
c = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
try:
    ok = c.execute("PRAGMA integrity_check").fetchone()[0]
finally:
    c.close()
if ok != "ok":
    raise SystemExit(f"integrity check failed: {ok}")
PY

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/payload/db" "$TMP/payload/config" "$TMP/payload/source"
cp "$DB" "$TMP/payload/db/charge.db"
cp "$CFG" "$TMP/payload/config/charge-config.tgz"
cp "$SRC/token_key" "$TMP/payload/config/token_key"
cp "$SRC/version.json" "$TMP/payload/config/version.json" 2>/dev/null || true

tar czf "$TMP/payload/source/source.tar.gz" -C "$SOURCE_DIR" \
  --exclude='webui/node_modules' --exclude='android/build' \
  --exclude='cloud/data' --exclude='__pycache__' \
  --exclude='cloud/web/dist' .

{
  echo "date=$STAMP"
  echo "db=db/charge.db"
  echo "config=config/charge-config.tgz"
  echo "source=source/source.tar.gz"
  echo "db_sha256=$(sha256sum "$TMP/payload/db/charge.db" | awk '{print $1}')"
  echo "config_sha256=$(sha256sum "$TMP/payload/config/charge-config.tgz" | awk '{print $1}')"
} > "$TMP/payload/MANIFEST"

ARCHIVE="$DEST/daily/charge-$STAMP-full.tar.gz"
tar czf "$ARCHIVE" -C "$TMP/payload" .
chmod 600 "$ARCHIVE"
sha256sum "$ARCHIVE" | sed "s#$DEST/daily/##" > "$ARCHIVE.sha256"
chmod 600 "$ARCHIVE.sha256"
if [ "${CHARGE_SKIP_CHOWN:-0}" != "1" ]; then
  chown root:root "$ARCHIVE" "$ARCHIVE.sha256"
fi

if [ "$(date +%u)" = "7" ]; then
  WEEKLY="$DEST/weekly/charge-$STAMP-weekly.tar.gz"
  cp "$ARCHIVE" "$WEEKLY"
  chmod 600 "$WEEKLY"
  sha256sum "$WEEKLY" | sed "s#$DEST/weekly/##" > "$WEEKLY.sha256"
  chmod 600 "$WEEKLY.sha256"
  if [ "${CHARGE_SKIP_CHOWN:-0}" != "1" ]; then
    chown root:root "$WEEKLY" "$WEEKLY.sha256"
  fi
fi

find "$DEST/daily" -name 'charge-*-full.tar.gz' -mtime +90 -delete
find "$DEST/daily" -name 'charge-*-full.tar.gz.sha256' -mtime +90 -delete
find "$DEST/weekly" -name 'charge-*-weekly.tar.gz' -mtime +90 -delete
find "$DEST/weekly" -name 'charge-*-weekly.tar.gz.sha256' -mtime +90 -delete
