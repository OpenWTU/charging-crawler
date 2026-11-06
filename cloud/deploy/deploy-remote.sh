#!/bin/bash
# 远端部署（由 deploy.ps1 上传后执行）
#   用法: bash deploy-remote.sh <tarball 路径>
# 内容: 备份数据库与代码 -> 同步后端模块/抓取侧/前端产物 -> 重启 -> 自检
set -euo pipefail

TARBALL="${1:-/tmp/charge-deploy.tgz}"
STAGE=/tmp/charge-deploy-stage
APP=/opt/charge-cloud
BK=/var/lib/charge-cloud/backups
TS=$(date +%Y%m%d-%H%M%S)

test -f "$TARBALL" || { echo "缺少 $TARBALL"; exit 1; }

echo "===== 0. 前置检查 ====="
python3 -V
systemctl is-active charge-cloud

echo
echo "===== 1. 备份数据库（在线备份，兼容 WAL）====="
mkdir -p "$BK"
python3 - "$BK/pre-deploy-$TS.db" <<'PY'
import sqlite3, sys
src = sqlite3.connect('/var/lib/charge-cloud/charge.db')
dst = sqlite3.connect(sys.argv[1])
with dst:
    src.backup(dst)
dst.close(); src.close()
PY
chmod 600 "$BK/pre-deploy-$TS.db"
ls -lh "$BK/pre-deploy-$TS.db"

echo
echo "===== 2. 备份当前代码与配置（回滚用）====="
tar czf "/root/charge-cloud-code-$TS.tgz" -C / \
    opt/charge-cloud/cloud opt/charge-cloud/crawler etc/charge-cloud
ls -lh "/root/charge-cloud-code-$TS.tgz"

echo
echo "===== 3. 解包到 staging ====="
rm -rf "$STAGE"; mkdir -p "$STAGE"
tar xzf "$TARBALL" -C "$STAGE"
echo "staging: $(find "$STAGE" -type f | wc -l) 个文件"

echo
echo "===== 4. 同步后端代码（多模块）====="
rsync -a "$STAGE/cloud/" "$APP/cloud/"
rsync -a "$STAGE/crawler/" "$APP/crawler/"
echo "cloud/*.py: $(ls "$APP/cloud"/*.py | wc -l) 个 | cloud/http/*.py: $(ls "$APP/cloud/http"/*.py 2>/dev/null | wc -l) 个"

echo
echo "===== 5. 同步前端产物（--delete 清掉旧 hash）====="
BEFORE=$(ls "$APP/cloud/web/assets" 2>/dev/null | wc -l)
rsync -a --delete "$STAGE/web/" "$APP/cloud/web/"
AFTER=$(ls "$APP/cloud/web/assets" | wc -l)
echo "assets: $BEFORE -> $AFTER"

echo
echo "===== 6. 清 pycache + 权限归一 ====="
find "$APP/cloud" "$APP/crawler" -name '__pycache__' -type d -prune -exec rm -rf {} + 2>/dev/null || true
find "$APP/cloud" "$APP/crawler" -type d -exec chmod 755 {} +
find "$APP/cloud" "$APP/crawler" -type f -exec chmod 644 {} +
chown -R www-data:www-data "$APP/cloud" "$APP/crawler"

echo
echo "===== 7. 重启服务 ====="
systemctl restart charge-cloud
sleep 4
echo "状态: $(systemctl is-active charge-cloud)"

echo
echo "===== 8. 启动日志（查 traceback）====="
journalctl -u charge-cloud --since "-60s" --no-pager | tail -12

echo
echo "===== 9. 自检 ====="
for p in /health /api/overview /api/now /api/areas-ports /api/version; do
  printf "  %-20s %s\n" "$p" "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8788$p)"
done
printf "  %-20s %s\n" "https /" "$(curl -s -o /dev/null -w '%{http_code}' https://charge.example.com/)"
python3 - <<'PY'
import sqlite3
c = sqlite3.connect('/var/lib/charge-cloud/charge.db')
print("  integrity:", c.execute("PRAGMA integrity_check").fetchone()[0])
print("  port_states 行:", c.execute("SELECT COUNT(*) FROM port_states").fetchone()[0],
      "| 分组:", c.execute("SELECT status_group, COUNT(*) FROM port_states GROUP BY 1").fetchall())
PY

echo
echo "===== 10. 回滚命令 ====="
echo "代码: tar xzf /root/charge-cloud-code-$TS.tgz -C / && systemctl restart charge-cloud"
echo "数据: systemctl stop charge-cloud && cp $BK/pre-deploy-$TS.db /var/lib/charge-cloud/charge.db"
echo "      rm -f /var/lib/charge-cloud/charge.db-wal /var/lib/charge-cloud/charge.db-shm"
echo "      systemctl start charge-cloud"
echo "TS=$TS"
