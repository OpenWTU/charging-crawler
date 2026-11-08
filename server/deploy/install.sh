#!/bin/bash
# charge-node 交互式一键部署
#
# 用法：
#   交互式（推荐）：
#     bash install.sh
#   或远程：
#     curl -fsSL https://api.github.com/repos/OpenWTU/charging-crawler/contents/server/deploy/install.sh \
#       -H "Accept: application/vnd.github.raw" | bash
#   全默认、不问任何问题：
#     bash install.sh --yes        （或 ASSUME_YES=1 bash install.sh）
#   先看一眼会做什么（不写文件、不启动）：
#     bash install.sh --dry-run
#
# 也可以在调用前用环境变量预设任意参数（设了就不再询问）：
#   NODE_NAME / NODE_URL / NODE_P2P_ADDR / DATA_DIR / P2P_ENABLED / TRUST_PROXY
#   IMAGE_TAG / ADMIN_INIT_PASSWORD / UPDATE_AT / HTTP_PORT / P2P_PORT
#
# 设计要点：
#   - 每一步都先"检查"，缺什么装什么，不会盲目覆盖已有配置
#   - 参数全部有默认值，回车即用默认
#   - 支持 `curl | bash`（stdin 被管道占用时从 /dev/tty 读）
#   - 幂等：重复执行不会破坏已有数据和 .env（.env 会先备份）

set -uo pipefail

# ============================================================
# 常量
# ============================================================
DEPLOY_DIR="${DEPLOY_DIR:-/opt/charge-node}"
COMPOSE_FILE="$DEPLOY_DIR/docker-compose.yml"
ENV_FILE="$DEPLOY_DIR/.env"
RAW_BASE="https://api.github.com/repos/OpenWTU/charging-crawler/contents"
GH_HEADER="Accept: application/vnd.github.raw"
IMAGE="ghcr.io/openwtu/charging-crawler"

# 颜色（无 TTY 时自动关闭）
if [ -t 1 ] || [ -t 2 ]; then
  C_RESET=$'\033[0m'; C_B=$'\033[1m'; C_G=$'\033[1;32m'
  C_Y=$'\033[1;33m'; C_R=$'\033[1;31m'; C_C=$'\033[1;36m'; C_D=$'\033[2m'
else
  C_RESET=""; C_B=""; C_G=""; C_Y=""; C_R=""; C_C=""; C_D=""
fi

say()  { echo "${C_G}==>${C_RESET} $*"; }
info() { echo "    $*"; }
warn() { echo "${C_Y}  ! ${C_RESET}$*"; }
err()  { echo "${C_R}  ✗ ${C_RESET}$*" >&2; }
die()  { err "$*"; exit 1; }
hr()   { echo "${C_D}────────────────────────────────────────────────────────${C_RESET}"; }
step() { echo ""; echo "${C_B}${C_C}[$1]${C_RESET} ${C_B}$2${C_RESET}"; }

# 非交互模式（ASSUME_YES=1 环境变量也生效，脚本不覆盖它）
ASSUME_YES="${ASSUME_YES:-0}"
# 干跑：只做环境/依赖检查 + 参数收集，打印将要写入的配置，不写文件、不启动容器
DRY_RUN="${DRY_RUN:-0}"
for a in "$@"; do
  case "$a" in
    -y|--yes|-f|--force) ASSUME_YES=1 ;;
    -n|--dry-run) DRY_RUN=1 ;;
    -h|--help)
      # 只打印文件开头的注释块（遇到第一行非注释就停）
      awk 'NR>1 { if (/^#/) { sub(/^# ?/, ""); print } else { exit } }' "$0"
      exit 0 ;;
    *) warn "忽略未知参数：$a" ;;
  esac
done

# ============================================================
# 交互输入
# ============================================================
# 能否交互：有 /dev/tty 且不是在 --yes 模式
can_prompt() {
  [ "$ASSUME_YES" = "1" ] && return 1
  [ -e /dev/tty ] && [ -r /dev/tty ] || return 1
  return 0
}

# ask <提示> <默认值> <变量名>
# 变量已有非空值（来自环境变量）时不询问
ask() {
  local prompt="$1" def="$2" var="$3"
  local cur="${!var-}"
  if [ -n "$cur" ]; then
    info "$prompt = $cur ${C_D}(来自环境变量)${C_RESET}"
    return 0
  fi
  if ! can_prompt; then
    printf -v "$var" '%s' "$def"
    info "$prompt = $def ${C_D}(默认)${C_RESET}"
    return 0
  fi
  local ans=""
  printf '  %s %s[%s]%s: ' "$prompt" "$C_D" "$def" "$C_RESET"
  # shellcheck disable=SC2162
  read -r ans < /dev/tty || ans=""
  printf -v "$var" '%s' "${ans:-$def}"
}

# ask_yn <提示> <y|n 默认> <变量名>   → 变量得到 1/0
ask_yn() {
  local prompt="$1" def="$2" var="$3"
  local cur="${!var-}"
  if [ -n "$cur" ]; then
    case "$cur" in
      1|y|Y|yes|true|on)  printf -v "$var" '1'; info "$prompt = 开 ${C_D}(来自环境变量)${C_RESET}" ;;
      *)                  printf -v "$var" '0'; info "$prompt = 关 ${C_D}(来自环境变量)${C_RESET}" ;;
    esac
    return 0
  fi
  if ! can_prompt; then
    [ "$def" = "y" ] && printf -v "$var" '1' || printf -v "$var" '0'
    info "$prompt = $([ "$def" = y ] && echo 开 || echo 关) ${C_D}(默认)${C_RESET}"
    return 0
  fi
  local hint="y/n"; [ "$def" = "y" ] && hint="Y/n" || hint="y/N"
  local ans=""
  while :; do
    printf '  %s %s[%s]%s: ' "$prompt" "$C_D" "$hint" "$C_RESET"
    read -r ans < /dev/tty || ans=""
    ans="${ans:-$def}"
    case "$ans" in
      y|Y|yes|YES|1) printf -v "$var" '1'; return 0 ;;
      n|N|no|NO|0)   printf -v "$var" '0'; return 0 ;;
      *) warn "请输入 y 或 n" ;;
    esac
  done
}

# ============================================================
# 小工具
# ============================================================
have() { command -v "$1" >/dev/null 2>&1; }

gen_pw() { tr -dc 'A-Za-z0-9' < /dev/urandom 2>/dev/null | head -c "${1:-16}"; }

detect_pub_ip() {
  local ip=""
  for u in https://api.ipify.org https://ipv4.icanhazip.com https://ifconfig.me/ip; do
    ip=$(curl -fsS --max-time 6 "$u" 2>/dev/null | tr -d '\r\n[:space:]' || true)
    case "$ip" in
      [0-9]*.[0-9]*.[0-9]*.[0-9]*) echo "$ip"; return 0 ;;
    esac
  done
  return 1
}

mem_mb() {
  if [ -r /proc/meminfo ]; then
    awk '/^MemTotal:/ {printf "%d", $2/1024}' /proc/meminfo
  else
    echo 0
  fi
}

disk_mb() {
  df -Pm "${1:-/}" 2>/dev/null | awk 'NR==2 {print $4}' || echo 0
}

# 端口是否被占用（只看监听）
port_busy() {
  local p="$1"
  if have ss; then
    ss -ltnH 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${p}$"
  elif have netstat; then
    netstat -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${p}$"
  else
    return 1
  fi
}

gh_raw() {
  # gh_raw <仓库相对路径> <输出文件>
  curl -fsSL --max-time 60 -H "$GH_HEADER" "$RAW_BASE/$1" -o "$2"
}

# ============================================================
# 开场
# ============================================================
echo ""
echo "${C_B}charge-node 一键部署${C_RESET}"
echo "${C_D}校园充电桩空位查询 · 单节点（Docker + 可选 P2P）${C_RESET}"
hr
echo "  流程：环境检查 → 依赖安装 → 参数确认 → 部署 → 健康检查"
if can_prompt; then
  echo "  ${C_D}括号里是默认值，直接回车即用默认；Ctrl+C 随时退出${C_RESET}"
else
  echo "  ${C_Y}非交互模式${C_RESET}（--yes 或没有 TTY）：全部使用默认值/环境变量"
fi
hr

# ============================================================
# 1. 环境检查
# ============================================================
step "1/7" "环境检查"
ENV_FAIL=0

# 1.1 root
if [ "$(id -u)" != "0" ]; then
  die "需要 root 权限：请用 root 或 sudo 运行"
fi
info "权限      root ✓"

# 1.2 OS
if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  info "系统      ${PRETTY_NAME:-$NAME $VERSION_ID}"
else
  info "系统      $(uname -s)（无 /etc/os-release）"
fi

# 1.3 架构
ARCH=$(uname -m)
case "$ARCH" in
  x86_64|amd64)  ARCH_TAG=amd64 ;;
  aarch64|arm64) ARCH_TAG=arm64 ;;
  *)
    warn "架构 $ARCH 可能没有预构建镜像（只有 amd64 / arm64）"
    ARCH_TAG=unknown
    ENV_FAIL=1
    ;;
esac
info "架构      $ARCH → $ARCH_TAG"

# 1.4 内核 / cgroup（Docker 需要）
if [ -r /proc/version ]; then
  info "内核      $(uname -r)"
fi

# 1.5 内存
MEM=$(mem_mb)
if [ "$MEM" -lt 400 ]; then
  warn "内存只有 ${MEM}MB，容器限制 512m，可能启动困难"
  ENV_FAIL=1
else
  info "内存      ${MEM}MB ✓"
fi

# 1.6 磁盘（数据目录所在分区）
DISK=$(disk_mb /var)
if [ "$DISK" -lt 1024 ]; then
  warn "/var 可用空间只有 ${DISK}MB（建议 ≥2GB，SQLite + APK 需要空间）"
  ENV_FAIL=1
else
  info "磁盘      /var 可用 ${DISK}MB ✓"
fi

# 1.7 出站网络（拉镜像/下载脚本都靠它）
if curl -fsS --max-time 8 -o /dev/null https://ghcr.io/v2/ 2>/dev/null \
   || curl -fsS --max-time 8 -o /dev/null https://api.github.com/ 2>/dev/null; then
  info "网络      GitHub / GHCR 可达 ✓"
else
  warn "访问 GitHub / GHCR 失败 —— 拉不到镜像，请检查出站网络或代理"
  ENV_FAIL=1
fi

if [ "$ENV_FAIL" = "1" ]; then
  echo ""
  warn "环境检查有警告项（见上）。"
  if can_prompt; then
    ans=""
    printf '  %s [%s]: ' "环境检查有警告，仍要继续吗？" "y/N"
    read -r ans < /dev/tty || ans=""
    case "${ans:-n}" in y|Y|yes) ;; *) die "已取消" ;; esac
  fi
fi

# ============================================================
# 2. 依赖检查与安装
# ============================================================
step "2/7" "依赖检查"

# 2.1 curl / wget
if have curl; then
  info "curl      $(curl --version | head -1 | awk '{print $2}') ✓"
else
  warn "缺 curl，尝试安装…"
  if have apt-get; then apt-get update -qq && apt-get install -y -qq curl
  elif have dnf; then dnf install -y -q curl
  elif have yum; then yum install -y -q curl
  elif have apk; then apk add --no-cache curl
  else die "缺 curl 且无包管理器，请手动安装 curl 后重试"
  fi
  have curl || die "curl 安装失败"
  info "curl      已安装 ✓"
fi

# 2.2 解压类（部分系统需要）
have tar || warn "缺 tar（一般不影响）"

# 2.3 Docker
if have docker; then
  info "docker    $(docker --version | awk '{print $3}' | tr -d ,) ✓"
else
  warn "未检测到 Docker，开始安装（官方脚本）…"
  curl -fsSL https://get.docker.com -o /tmp/get-docker.sh || die "下载 Docker 安装脚本失败"
  sh /tmp/get-docker.sh || die "Docker 安装失败"
  rm -f /tmp/get-docker.sh
  have docker || die "Docker 装完仍不可用"
  info "docker    已安装 ✓"
fi

# 2.4 docker 守护进程
if ! systemctl is-active --quiet docker 2>/dev/null; then
  warn "docker 服务未运行，启动中…"
  systemctl enable --now docker >/dev/null 2>&1 || true
  sleep 2
fi
if docker info >/dev/null 2>&1; then
  info "守护进程  运行中 ✓"
else
  die "docker 守护进程不可用：systemctl status docker 查看原因"
fi

# 2.5 compose 插件
if docker compose version >/dev/null 2>&1; then
  info "compose   $(docker compose version --short 2>/dev/null || echo ok) ✓"
else
  warn "缺 docker compose 插件，尝试安装…"
  if have apt-get; then
    apt-get install -y -qq docker-compose-plugin 2>/dev/null || \
      apt-get install -y -qq docker-compose 2>/dev/null || true
  elif have dnf; then dnf install -y -q docker-compose-plugin 2>/dev/null || true
  elif have yum; then yum install -y -q docker-compose-plugin 2>/dev/null || true
  elif have apk; then apk add --no-cache docker-cli-compose 2>/dev/null || true
  fi
  docker compose version >/dev/null 2>&1 || die "docker compose 插件不可用，请手动安装 docker-compose-plugin"
  info "compose   已安装 ✓"
fi

# 2.6 python3（只用来看健康检查结果，没有就降级）
if have python3; then
  info "python3   $(python3 -V 2>&1 | awk '{print $2}') ✓"
else
  warn "缺 python3，健康检查会退化成原始 JSON（不影响部署）"
fi

# ============================================================
# 3. 交互式参数
# ============================================================
step "3/7" "参数（回车用默认）"

if can_prompt; then
  echo ""
fi

# 3.1 节点名
DEFAULT_NAME="$(hostname -s 2>/dev/null || echo charge-node)"
# 云主机的随机实例名（如 iZn4ackrpe565mfjqdbjl2Z、ecs-1234abcd）对用户没意义 → 换友好默认
if [ "${#DEFAULT_NAME}" -gt 12 ] \
   && printf '%s' "$DEFAULT_NAME" | grep -qE '[A-Z]' \
   && printf '%s' "$DEFAULT_NAME" | grep -qE '[0-9]' \
   && ! printf '%s' "$DEFAULT_NAME" | grep -q -- '-'; then
  DEFAULT_NAME=charge-node
fi
ask "节点名称" "$DEFAULT_NAME" NODE_NAME

# 3.2 数据目录
ask "数据目录" "/var/lib/charge-cloud" DATA_DIR

# 3.3 端口
ask "HTTP 端口" "8791" HTTP_PORT
ask "P2P 端口" "4001" P2P_PORT

# 3.4 公网 IP（用于生成节点地址，也用于 P2P 公告地址）
info "探测公网 IP…"
PUB_IP="$(detect_pub_ip || true)"
if [ -n "$PUB_IP" ]; then
  info "公网 IP   $PUB_IP"
else
  warn "探测不到公网 IP（可能在内网/有代理），下面可以手动填"
fi

ask "节点 HTTP 地址（状态页展示用，留空则不显示）" \
    "${PUB_IP:+http://$PUB_IP:$HTTP_PORT}" NODE_URL

ask "节点 P2P 公告地址（填错不影响本体，只影响点对点发现）" \
    "${PUB_IP:+/ip4/$PUB_IP/tcp/$P2P_PORT}" NODE_P2P_ADDR

# 3.5 前面有没有反代
ask_yn "前面有 Nginx/Caddy 等反向代理吗（决定是否信任 X-Forwarded-For）" "n" TRUST_PROXY_ON

# 3.6 P2P
ask_yn "启用 P2P 多节点同步" "y" P2P_ON

# 3.7 镜像 tag（固定版本 or latest 跟随自动更新）
ask "镜像版本（latest = 每天自动跟随最新；也可填 v2.4.7 之类的固定版本）" "latest" IMAGE_TAG

# 3.8 自动更新时间
ask "每天自动更新时刻（24 小时制 HH:MM，留空表示不装自动更新）" "03:00" UPDATE_AT
if [ -z "$UPDATE_AT" ]; then
  AUTO_UPDATE=0
else
  AUTO_UPDATE=1
fi

# 3.9 管理后台初始口令
echo ""
info "管理后台（/admin）需要一个初始管理员账号。"
info "口令不填则自动生成一个随机的，部署完会打印出来（首次登录必须改密）。"
ask "管理后台初始口令" "$(gen_pw 16)" ADMIN_INIT_PASSWORD

# 3.10 汇总确认
echo ""
hr
echo "${C_B}即将部署${C_RESET}"
echo "  节点名称      $NODE_NAME"
echo "  数据目录      $DATA_DIR"
echo "  HTTP 端口     $HTTP_PORT"
echo "  P2P           $([ "$P2P_ON" = 1 ] && echo "启用（端口 $P2P_PORT）" || echo 关闭)"
echo "  反代/信任XFF  $([ "$TRUST_PROXY_ON" = 1 ] && echo 是 || echo 否)"
echo "  镜像版本      $IMAGE_TAG"
echo "  自动更新      $([ "$AUTO_UPDATE" = 1 ] && echo "每天 $UPDATE_AT" || echo 关闭)"
echo "  节点地址      ${NODE_URL:-（空）}"
echo "  P2P 公告地址  ${NODE_P2P_ADDR:-（空）}"
echo "  管理后台口令  ${ADMIN_INIT_PASSWORD}"
echo "  部署目录      $DEPLOY_DIR"
hr
if can_prompt; then
  ans=""
  printf '  %s [%s]: ' "确认开始部署？" "Y/n"
  read -r ans < /dev/tty || ans=""
  case "${ans:-y}" in n|N|no) die "已取消" ;; esac
fi

# ============================================================
# 4. 端口占用检查
# ============================================================
step "4/7" "端口检查"

# 已经有我们的容器在跑 → 认为占用是自己的，允许继续（幂等重装）
OURS_RUNNING=0
if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx charge-node; then
  OURS_RUNNING=1
fi

for pair in "HTTP_PORT:$HTTP_PORT" "P2P_PORT:$P2P_PORT"; do
  name="${pair%%:*}"; val="${pair#*:}"
  if port_busy "$val"; then
    if [ "$OURS_RUNNING" = "1" ] && docker ps --format '{{.Ports}}' 2>/dev/null | grep -q ":$val->"; then
      info "$val 已被现有 charge-node 占用（将重建容器）✓"
    else
      warn "端口 $val 已被其他进程占用"
      if have ss; then info "  占用者: $(ss -ltnp 2>/dev/null | grep -E "[:.]$val " | head -1)"; fi
      die "请先释放端口 $val，或重新运行并改端口"
    fi
  else
    info "$val 空闲 ✓"
  fi
done

# ============================================================
# 4.5 干跑：到这儿就停，打印将要写的东西
# ============================================================
if [ "$DRY_RUN" = "1" ]; then
  step "5/7" "干跑（不写文件、不启动）"
  echo ""
  echo "  将要写入 $ENV_FILE ："
  cat <<EOF | sed 's/^/    /'
DATA_DIR=$DATA_DIR
NODE_NAME=$NODE_NAME
NODE_URL=$NODE_URL
NODE_P2P_ADDR=$NODE_P2P_ADDR
P2P_ENABLED=$([ "$P2P_ON" = 1 ] && echo true || echo false)
TRUST_PROXY=$([ "$TRUST_PROXY_ON" = 1 ] && echo true || echo false)
HTTP_PORT=$HTTP_PORT
P2P_PORT=$P2P_PORT
IMAGE_TAG=$IMAGE_TAG
ADMIN_INIT_PASSWORD=$ADMIN_INIT_PASSWORD
ADMIN_SESSION_SECRET=<生成/沿用>
EOF
  echo ""
  echo "  将要拉取/运行的镜像： $IMAGE:$IMAGE_TAG"
  echo "  将要监听的端口：     $HTTP_PORT (HTTP) / $P2P_PORT (P2P)"
  echo "  将要安装的 timer：   $([ "$AUTO_UPDATE" = 1 ] && echo "每天 $UPDATE_AT" || echo 不装)"
  echo ""
  echo "  ${C_Y}干跑结束，没有做任何改动。${C_RESET}去掉 --dry-run 即真正部署。"
  hr
  exit 0
fi

# ============================================================
# 5. 写配置
# ============================================================
step "5/7" "写配置文件"

mkdir -p "$DEPLOY_DIR" "$DATA_DIR/download" || die "创建目录失败"
chown -R 33:33 "$DATA_DIR" 2>/dev/null || true
info "目录就绪  $DEPLOY_DIR / $DATA_DIR"

# 5.1 下载 compose（若已有则备份）
if [ -f "$COMPOSE_FILE" ]; then
  cp "$COMPOSE_FILE" "${COMPOSE_FILE}.bak-$(date +%Y%m%d-%H%M%S)"
  info "旧 compose 已备份"
fi
git_raw_ok=0
if gh_raw "server/deploy/docker-compose.node.yml" "$COMPOSE_FILE.tmp" 2>/dev/null \
   && [ -s "$COMPOSE_FILE.tmp" ]; then
  mv "$COMPOSE_FILE.tmp" "$COMPOSE_FILE"; git_raw_ok=1
fi
if [ "$git_raw_ok" != "1" ]; then
  rm -f "$COMPOSE_FILE.tmp"
  warn "下载 compose 失败，改用内置模板"
  cat > "$COMPOSE_FILE" <<'YAML'
services:
  app:
    image: ghcr.io/openwtu/charging-crawler:latest
    container_name: charge-node
    restart: unless-stopped
    user: "33:33"
    ports:
      - "8791:8791"
      - "4001:4001"
    environment:
      NODE_ENV: production
      TZ: Asia/Shanghai
      HOST: 0.0.0.0
      PORT: "8791"
      DATABASE_PATH: /data/charge.db
      DATABASE_READONLY: "false"
      AUTO_WORKER: "true"
      TOKEN_KEY_FILE: /data/token_key
      VERSION_FILE: /data/version.json
      APK_DIR: /data/download
      WEB_DIST: /web
      P2P_ENABLED: ${P2P_ENABLED:-true}
      P2P_LISTEN_PORT: "4001"
      P2P_KEY_FILE: /data/p2p_key
      P2P_WHITELIST_CACHE: /data/p2p_peers.json
      P2P_MDNS: "false"
      NODE_NAME: ${NODE_NAME:-charge-node}
      NODE_URL: ${NODE_URL:-}
      NODE_P2P_ADDR: ${NODE_P2P_ADDR:-}
      TRUST_PROXY: ${TRUST_PROXY:-false}
      ADMIN_INIT_PASSWORD: ${ADMIN_INIT_PASSWORD:-}
      ADMIN_SESSION_SECRET: ${ADMIN_SESSION_SECRET:-}
    volumes:
      - /etc/localtime:/etc/localtime:ro
      - ${DATA_DIR:-/var/lib/charge-cloud}:/data
    mem_limit: 512m
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
YAML
fi
info "compose   $COMPOSE_FILE"

# 5.2 端口模板占位（compose 里写死了 8791/4001，这里按用户选择替换）
if [ "$HTTP_PORT" != "8791" ]; then
  sed -i "s|\"8791:8791\"|\"$HTTP_PORT:8791\"|g" "$COMPOSE_FILE"
  sed -i 's|PORT: "8791"|PORT: "8791"|g' "$COMPOSE_FILE"
fi
if [ "$P2P_PORT" != "4001" ]; then
  sed -i "s|\"4001:4001\"|\"$P2P_PORT:4001\"|g" "$COMPOSE_FILE"
fi

# 5.3 下载 update-node.sh
if gh_raw "server/deploy/update-node.sh" "$DEPLOY_DIR/update-node.sh" 2>/dev/null \
   && [ -s "$DEPLOY_DIR/update-node.sh" ]; then
  chmod +x "$DEPLOY_DIR/update-node.sh"
  bash -n "$DEPLOY_DIR/update-node.sh" || die "update-node.sh 语法检查失败"
  info "update-node.sh ✓"
else
  warn "下载 update-node.sh 失败 —— 自动更新将不可用（不影响本体运行）"
  AUTO_UPDATE=0
fi

# 5.4 写 .env（先备份已有的）
if [ -f "$ENV_FILE" ]; then
  cp "$ENV_FILE" "${ENV_FILE}.bak-$(date +%Y%m%d-%H%M%S)"
  info "旧 .env 已备份"
fi
SESSION_SECRET=$( [ -f "$ENV_FILE" ] && grep -E '^ADMIN_SESSION_SECRET=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- || true )
[ -z "${SESSION_SECRET:-}" ] && SESSION_SECRET="$(gen_pw 32)"

umask 077
cat > "$ENV_FILE" <<EOF
# charge-node 部署配置（install.sh 生成 $(date '+%Y-%m-%d %H:%M:%S')）
DATA_DIR=$DATA_DIR
NODE_NAME=$NODE_NAME
NODE_URL=$NODE_URL
NODE_P2P_ADDR=$NODE_P2P_ADDR
P2P_ENABLED=$([ "$P2P_ON" = 1 ] && echo true || echo false)
TRUST_PROXY=$([ "$TRUST_PROXY_ON" = 1 ] && echo true || echo false)
HTTP_PORT=$HTTP_PORT
P2P_PORT=$P2P_PORT
IMAGE_TAG=$IMAGE_TAG
ADMIN_INIT_PASSWORD=$ADMIN_INIT_PASSWORD
ADMIN_SESSION_SECRET=$SESSION_SECRET
EOF
chmod 600 "$ENV_FILE"
info ".env      $ENV_FILE（600）"

# ============================================================
# 6. 启动
# ============================================================
step "6/7" "拉镜像并启动"

cd "$DEPLOY_DIR" || die "进入 $DEPLOY_DIR 失败"

PULL_REF="$IMAGE:$IMAGE_TAG"
info "拉取 $PULL_REF …"
if ! docker pull "$PULL_REF" 2>&1 | tail -3; then
  warn "拉取 $PULL_REF 失败，回退到 latest"
  PULL_REF="$IMAGE:latest"
  docker pull "$PULL_REF" 2>&1 | tail -3 || die "镜像拉取失败：检查网络或 \`docker login ghcr.io\`"
fi

# 用指定 tag 覆盖 compose 里的 image
if [ "$IMAGE_TAG" != "latest" ]; then
  sed -i "s|image: $IMAGE:.*|image: $IMAGE:$IMAGE_TAG|" "$COMPOSE_FILE"
fi

info "启动容器…"
if [ "$OURS_RUNNING" = "1" ]; then
  docker compose down --remove-orphans >/dev/null 2>&1 || true
fi
docker compose up -d 2>&1 | tail -5 || die "容器启动失败：docker compose logs 查看原因"

# ============================================================
# 7. 健康检查
# ============================================================
step "7/7" "健康检查"

HEALTH_URL="http://127.0.0.1:${HTTP_PORT}"
OK=0
for i in $(seq 1 24); do
  sleep 5
  if curl -sf --max-time 3 "$HEALTH_URL/health" >/dev/null 2>&1; then OK=1; break; fi
  printf '    等待启动… %ds\r' "$((i*5))"
done
echo ""

if [ "$OK" != "1" ]; then
  err "健康检查超时（120 秒）"
  echo ""
  echo "  排查建议："
  echo "    docker compose -f $COMPOSE_FILE logs --tail 80"
  echo "    docker ps -a | grep charge-node"
  echo "    ss -ltnp | grep $HTTP_PORT"
  exit 1
fi

# 7.1 装自动更新 timer
if [ "$AUTO_UPDATE" = "1" ] && [ -x "$DEPLOY_DIR/update-node.sh" ]; then
  HH="${UPDATE_AT%%:*}"
  MM="${UPDATE_AT##*:}"
  HH=$((10#$HH)); MM=$((10#$MM))
  cat > /etc/systemd/system/charge-node-update.service <<EOF
[Unit]
Description=charge-node 每日静默更新（拉 GHCR 新镜像，失败自动回退）
After=docker.service
Wants=docker.service

[Service]
Type=oneshot
Environment=UPDATE_TAG=$IMAGE_TAG
Environment=DATA_DIR=$DATA_DIR
ExecStart=/bin/bash $DEPLOY_DIR/update-node.sh \${UPDATE_TAG}
EOF
  cat > /etc/systemd/system/charge-node-update.timer <<EOF
[Unit]
Description=charge-node 每日静默更新

[Timer]
OnCalendar=*-*-* $(printf '%02d:%02d' "$HH" "$MM"):00
Persistent=true
RandomizedDelaySec=300

[Install]
WantedBy=timers.target
EOF
  systemctl daemon-reload
  systemctl enable --now charge-node-update.timer >/dev/null 2>&1 || warn "timer 启用失败"
  info "自动更新  每天 $(printf '%02d:%02d' "$HH" "$MM") ✓"
else
  info "自动更新  未启用"
fi

# 7.2 结果
hr
echo "${C_G}✅ 部署完成${C_RESET}"
echo ""

VERSION=$(curl -s --max-time 8 "$HEALTH_URL/status" 2>/dev/null | (have python3 && python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(d['server']['version'])
except Exception:
    print('?')
" || sed -n 's/.*"version":"\([^"]*\)".*/\1/p' | head -1) || echo "?")

echo "  访问地址      http://<本机IP>:${HTTP_PORT}"
if [ -n "$NODE_URL" ]; then
  echo "                $NODE_URL"
fi
echo "  管理后台      http://<本机IP>:${HTTP_PORT}/admin"
echo "  初始账号      admin"
echo "  初始口令      ${C_B}${ADMIN_INIT_PASSWORD}${C_RESET}   ${C_D}(首次登录必须改密)${C_RESET}"
echo "  版本          ${VERSION:-?}"
echo "  数据目录      $DATA_DIR"
echo "  配置文件      $ENV_FILE"
echo ""
echo "  常用命令："
echo "    docker compose -f $COMPOSE_FILE logs -f --tail 100"
echo "    docker compose -f $COMPOSE_FILE restart"
echo "    docker compose -f $COMPOSE_FILE down"
if [ "$AUTO_UPDATE" = "1" ]; then
  echo "    systemctl list-timers charge-node-update.timer"
fi
echo ""
echo "  ${C_D}提示：容器只监听 0.0.0.0:$HTTP_PORT，建议前面挂 Nginx + HTTPS。${C_RESET}"
hr
