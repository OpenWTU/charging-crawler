#!/bin/bash
# charge-node 一键部署（含凌晨静默自动更新）
#
# 用法：
#   curl -fsSL https://api.github.com/repos/OpenWTU/charging-crawler/contents/server/deploy/install.sh \
#     -H "Accept: application/vnd.github.raw" | bash
#
# 可选环境变量：
#   NODE_NAME   节点名称（默认取主机名）
#   NODE_URL    节点 HTTP 地址（默认空，状态页不可点切换）
#   NODE_P2P_ADDR 节点公网 P2P 地址（如 /ip4/1.2.3.4/tcp/4001）
#   DATA_DIR    数据目录（默认 /var/lib/charge-cloud）
#   P2P_ENABLED 是否启用 P2P（默认 true）

set -euo pipefail

DEPLOY_DIR=/opt/charge-node
DATA_DIR="${DATA_DIR:-/var/lib/charge-cloud}"
NODE_NAME="${NODE_NAME:-$(hostname -s 2>/dev/null || echo charge-node)}"
NODE_URL="${NODE_URL:-}"
NODE_P2P_ADDR="${NODE_P2P_ADDR:-}"
RAW_BASE="https://api.github.com/repos/OpenWTU/charging-crawler/contents"
GH_HEADER="Accept: application/vnd.github.raw"

say() { echo -e "\033[1;32m==>\033[0m $*"; }

say "1/6 检查 Docker"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker >/dev/null 2>&1 || true
docker --version

say "2/6 准备数据目录 $DATA_DIR"
mkdir -p "$DEPLOY_DIR" "$DATA_DIR/download"
chown -R 33:33 "$DATA_DIR" 2>/dev/null || true

say "3/6 下载 docker-compose.yml"
curl -fsSL -H "$GH_HEADER" "$RAW_BASE/server/deploy/docker-compose.node.yml" \
  -o "$DEPLOY_DIR/docker-compose.yml"

say "4/6 下载 update-node.sh（自动更新脚本）"
curl -fsSL -H "$GH_HEADER" "$RAW_BASE/server/deploy/update-node.sh" \
  -o "$DEPLOY_DIR/update-node.sh"
chmod +x "$DEPLOY_DIR/update-node.sh"
bash -n "$DEPLOY_DIR/update-node.sh"

say "5/6 启动容器（NODE_NAME=$NODE_NAME）"
cd "$DEPLOY_DIR"
DATA_DIR="$DATA_DIR" NODE_NAME="$NODE_NAME" NODE_URL="$NODE_URL" \
  NODE_P2P_ADDR="$NODE_P2P_ADDR" docker compose up -d

say "6/6 安装凌晨自动更新 timer（每天 03:00，失败自动回退）"
cat > /etc/systemd/system/charge-node-update.service <<EOF
[Unit]
Description=charge-node 每日静默更新（拉 GHCR 新镜像，失败自动回退）
After=docker.service
Wants=docker.service

[Service]
Type=oneshot
Environment=UPDATE_TAG=latest
Environment=DATA_DIR=$DATA_DIR
ExecStart=/bin/bash $DEPLOY_DIR/update-node.sh \${UPDATE_TAG}
EOF

cat > /etc/systemd/system/charge-node-update.timer <<'EOF'
[Unit]
Description=charge-node 每日凌晨 3 点静默更新

[Timer]
OnCalendar=*-*-* 03:00:00
Persistent=true
RandomizedDelaySec=300

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now charge-node-update.timer >/dev/null 2>&1

say "完成。等待健康检查…"
for i in $(seq 1 12); do
  if curl -sf --max-time 3 http://127.0.0.1:8791/health >/dev/null 2>&1; then
    echo ""
    echo "✅ 节点已就绪："
    curl -s http://127.0.0.1:8791/status | python3 -c "
import sys, json
d = json.load(sys.stdin)
print('  版本:', d['server']['version'])
print('  peerId:', d['peers']['self'])
print('  名称:', d['peers'].get('self_name'))
" 2>/dev/null || true
    echo ""
    echo "自动更新: systemctl list-timers charge-node-update.timer"
    echo "日志:     /var/log/charge-update.log"
    exit 0
  fi
  sleep 5
done
echo "⚠️  健康检查超时，查看日志： docker logs charge-node"
exit 1
