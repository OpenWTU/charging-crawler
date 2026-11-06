#!/bin/bash
# 安装 charge-node systemd 服务（只读连接生产库，端口 8791）
#
# 用途：让 Node 版与现有 Python 版并行常驻，供 Nginx 灰度分流。
# Node 只读打开数据库，不写，因此不会与 Python 抢写锁。
#
# 用法（在服务器上）：
#   sudo bash setup-service.sh            # 安装并启动
#   sudo bash setup-service.sh --dry-run  # 只看会做什么
#
# 回滚：
#   systemctl disable --now charge-node && rm /etc/systemd/system/charge-node.service

set -euo pipefail

DRY_RUN=false
[ "${1:-}" = "--dry-run" ] && DRY_RUN=true

DEPLOY_DIR=/opt/charge-node
DB_PATH=/var/lib/charge-cloud/charge.db
PORT=8791
SERVICE=/etc/systemd/system/charge-node.service

if [ ! -f "$DEPLOY_DIR/dist/server.js" ]; then
  echo "错误：$DEPLOY_DIR/dist/server.js 不存在，请先部署代码" >&2
  exit 1
fi

if [ ! -f "$DB_PATH" ]; then
  echo "错误：数据库 $DB_PATH 不存在" >&2
  exit 1
fi

cat > /tmp/charge-node.service <<EOF
[Unit]
Description=Charge pile cloud (Node/TypeScript, read-only)
After=network.target charge-cloud.service
# 内存保护：这台机器只有 1.6G，Node 实测 ~90MB，给 256M 上限足够且能兜住泄漏
Wants=charge-cloud.service

[Service]
Type=simple
User=www-data
Group=www-data
WorkingDirectory=$DEPLOY_DIR
Environment=NODE_ENV=production
Environment=PORT=$PORT
Environment=HOST=127.0.0.1
Environment=DATABASE_PATH=$DB_PATH
# 只读：绝不与 Python 抢写锁
Environment=DATABASE_READONLY=true
Environment=LOG_LEVEL=info
# node:sqlite 在 Node 22 上仍是实验特性，抑制警告避免刷日志
Environment=NODE_OPTIONS=--no-warnings
ExecStart=/usr/bin/node dist/server.js
Restart=always
RestartSec=3
MemoryMax=256M
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=/var/lib/charge-cloud
# 只读库，允许严格保护
ProtectHome=true

[Install]
WantedBy=multi-user.target
EOF

echo "=== 将安装的服务配置 ==="
cat /tmp/charge-node.service
echo ""

if [ "$DRY_RUN" = true ]; then
  echo "[dry-run] 未做任何修改"
  exit 0
fi

install -m 644 /tmp/charge-node.service "$SERVICE"
chown -R www-data:www-data "$DEPLOY_DIR"
systemctl daemon-reload
systemctl enable --now charge-node

sleep 5
echo "=== 状态 ==="
systemctl is-active charge-node
systemctl status charge-node --no-pager -l | head -12

echo ""
echo "=== 健康检查 ==="
curl -s -m 5 "http://127.0.0.1:$PORT/health" || echo "健康检查失败"
echo ""
echo "=== 内存 ==="
systemctl show charge-node -p MemoryCurrent | sed 's/MemoryCurrent=//' | \
  awk '{ if ($1 > 0) printf "  %.1f MB\n", $1/1024/1024; else print "  (尚未统计)" }'

echo ""
echo "完成。回滚：systemctl disable --now charge-node"
