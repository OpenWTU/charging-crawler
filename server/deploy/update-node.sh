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

# M4：管理后台的「锁版本 / 回滚到指定 tag」只写 /data/update.request，这里原来从不读它
# —— 后台操作是空操作，宿主机每晚仍跟 latest（运维会以为锁了版本）。
# 只有在没显式传参（TAG 仍是 latest）时才消费请求文件，消费后删除避免一直生效。
REQUEST_FILE="${DATA_DIR:-/var/lib/charge-cloud}/update.request"
if [ "$TAG" = "latest" ] && [ -f "$REQUEST_FILE" ]; then
  REQ_TAG="$(head -n1 "$REQUEST_FILE" | tr -d '[:space:]')"
  if [ -n "$REQ_TAG" ]; then
    echo "[update-node] 检测到后台请求的版本：$REQ_TAG（已消费并删除请求文件）"
    TAG="$REQ_TAG"
    rm -f "$REQUEST_FILE"
  fi
fi
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

# 2.5 同步 version.json + APK（发版时 release-apk 会把两者作为 Release asset 发布）

# ⚠️ L8：本脚本先替换 version.json / APK，再更新容器。
# 若容器更新失败并回滚镜像，version.json 仍指向新版 → App 会被引导"升级"到新 APK 配旧服务端。
# 回滚分支必须同时回滚 version.json/APK（或接受这个短暂不一致）。

# 版本名（v2.5.5 → 2.5.5）：APK 资产名带版本，避免不同版本互相覆盖 / 被缓存串版本
VER="${TAG#v}"
VERSION_JSON_URL="https://github.com/OpenWTU/charging-crawler/releases/download/$TAG/version.json"
APK_URL="https://github.com/OpenWTU/charging-crawler/releases/download/$TAG/app-v$VER.apk"
DATA_DIR="${DATA_DIR:-/var/lib/charge-cloud}"
mkdir -p "$DATA_DIR/download"
if curl -fsSL --max-time 20 -o /tmp/version.json.new "$VERSION_JSON_URL"; then
  if [ -s /tmp/version.json.new ]; then
    cp /tmp/version.json.new "$DATA_DIR/version.json"
    chown 33:33 "$DATA_DIR/version.json" 2>/dev/null || true
    log "version.json 已同步（$TAG）"
  fi
else
  log "version.json 下载失败（跳过，保持现有）"
fi
if curl -fsSL --max-time 120 -o "$DATA_DIR/download/app-v$VER.apk" "$APK_URL"; then
  chown 33:33 "$DATA_DIR/download/app-v$VER.apk" 2>/dev/null || true
  # 兼容副本：≤v2.5.3 的旧 App 仍按 /download/app-debug.apk 下载，
  # 保留一份同名副本，避免老设备更新时 404。
  cp -f "$DATA_DIR/download/app-v$VER.apk" "$DATA_DIR/download/app-debug.apk" 2>/dev/null || true
  chown 33:33 "$DATA_DIR/download/app-debug.apk" 2>/dev/null || true
  # 清理旧版本的带版本名 APK（只留当前 + app-debug.apk 兼容副本）
  for old_apk in "$DATA_DIR"/download/app-v*.apk; do
    [ -e "$old_apk" ] || continue
    [ "$old_apk" = "$DATA_DIR/download/app-v$VER.apk" ] && continue
    rm -f "$old_apk"
  done
  log "APK 已同步到本地 download（$TAG）"
else
  log "APK 下载失败（跳过，App 将沿用旧包）"
fi

# 3. 更新：新镜像 tag 到 latest（compose 统一用 latest），重建容器
cd "$COMPOSE_DIR" || exit 1
export DATA_DIR="${DATA_DIR:-/var/lib/charge-cloud}"
docker tag "$IMAGE:$TAG" "$IMAGE:latest"
if ! docker compose up -d 2>&1; then
  log "重建失败，开始回退"
  docker tag "$OLD_ID" "$IMAGE:latest"
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
  docker tag "$OLD_ID" "$IMAGE:latest"
  docker compose up -d 2>&1 || log "!! 回退重建也失败，需人工介入"
  sleep 5
  log "已回退到旧镜像 ${OLD_ID:0:12}"
  exit 1
fi

log "更新成功（新镜像 ${NEW_ID:0:12}），容器已重建"
log "==== 更新结束 ===="
exit 0
