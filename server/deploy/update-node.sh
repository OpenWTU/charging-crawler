#!/bin/bash
# 凌晨静默更新：拉 GHCR 新镜像 → 重建容器 → 健康检查 → 失败自动回退旧镜像。
#
# 用法（systemd timer 调用）：
#   bash update-node.sh            # 跟进 latest
#   bash update-node.sh v1.11.40   # 跟进指定 tag
#
# 回退原理：旧镜像仍在本地，回退 = 把旧镜像 ID 重新 tag 回目标标签，再重建容器。
# 日志：/var/log/charge-update.log（回退/失败也会写，供第二天人工查看）。

set -uo pipefail

IMAGE="ghcr.io/openwtu/charging-crawler"
TAG="${1:-latest}"
CONTAINER="charge-node"
COMPOSE_DIR="/opt/charge-node"
LOG="/var/log/charge-update.log"
HEALTH_URL="http://127.0.0.1:8791/health"

log() {
  echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"
}

log "==== 开始更新（tag=$TAG）===="

# 0. 前置检查
if ! command -v docker >/dev/null 2>&1; then
  log "docker 不存在，跳过"
  exit 0
fi
if [ ! -f "$COMPOSE_DIR/docker-compose.yml" ]; then
  log "未找到 $COMPOSE_DIR/docker-compose.yml，跳过"
  exit 1
fi

# 1. 记录当前镜像 ID（回退依据）
OLD_ID=$(docker inspect --format '{{.Image}}' "$CONTAINER" 2>/dev/null || echo "")
if [ -z "$OLD_ID" ]; then
  log "容器 $CONTAINER 不存在，跳过"
  exit 0
fi
log "旧镜像 ID: ${OLD_ID:0:12}"

# 2. 拉新镜像（失败则保持旧版，容器不动）
if ! docker pull "$IMAGE:$TAG"; then
  log "拉取镜像失败，保持旧版本"
  exit 1
fi
NEW_ID=$(docker inspect --format '{{.Id}}' "$IMAGE:$TAG" 2>/dev/null || echo "")
if [ "$NEW_ID" = "$OLD_ID" ]; then
  log "镜像无变化，无需更新"
  exit 0
fi

# 3. 重建容器
cd "$COMPOSE_DIR" || exit 1
if ! docker compose up -d 2>&1; then
  log "重建失败，开始回退"
  docker tag "$OLD_ID" "$IMAGE:$TAG"
  docker compose up -d 2>&1 || log "!! 回退重建也失败，需人工介入"
  log "已回退到旧镜像"
  exit 1
fi

# 4. 健康检查（最多 45 秒）
sleep 15
OK=0
for i in 1 2 3 4 5 6; do
  if curl -sf --max-time 3 "$HEALTH_URL" >/dev/null 2>&1; then
    OK=1
    break
  fi
  sleep 5
done

if [ "$OK" != "1" ]; then
  log "健康检查失败，开始回退"
  docker tag "$OLD_ID" "$IMAGE:$TAG"
  docker compose up -d 2>&1 || log "!! 回退重建也失败，需人工介入"
  sleep 5
  log "已回退到旧镜像 ${OLD_ID:0:12}"
  exit 1
fi

log "更新成功（新镜像 ${NEW_ID:0:12}），容器已重建"
log "==== 更新结束 ===="
exit 0
