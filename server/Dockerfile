# ---------- 构建阶段 ----------
# 构建上下文 = 仓库根（见 docker-compose.yml 的 build.context）
# Node 24：node:sqlite 已正式（无 experimental warning），无需原生模块编译
FROM node:24-alpine AS builder

WORKDIR /app

# 先只拷依赖清单，最大化利用层缓存
# 注意：node:24 已弃用 corepack，直接 npm 装固定版本 pnpm（lockfile 是 9.0）
COPY server/package.json server/pnpm-lock.yaml ./
RUN npm install -g pnpm@9 && pnpm install --frozen-lockfile=false

# 拷源码并编译
COPY server/tsconfig.json server/tsconfig.build.json ./
COPY server/src ./src
COPY server/migrations ./migrations
RUN pnpm run build

# ---------- 运行阶段 ----------
FROM node:24-alpine

RUN apk add --no-cache tini curl tzdata

WORKDIR /app
# SERVER_VERSION 由 CI 构建时注入（ARG VERSION=tag），本地构建默认 dev
ARG VERSION=dev
ENV NODE_ENV=production \
    TZ=Asia/Shanghai \
    SERVER_VERSION=$VERSION

# 生产依赖（libp2p 等全是纯 JS，无需编译工具）
COPY server/package.json server/pnpm-lock.yaml ./
RUN npm install -g pnpm@9 && pnpm install --prod --frozen-lockfile=false && pnpm store prune || true

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/migrations ./migrations

# 前端产物打进镜像（webui/dist 即 vite 输出：index.html + app.html + assets/），
# 与后端同 tag 发布，节点间不会前端版本不一致。
COPY webui/dist /web

# P2P 白名单默认值随镜像发布（GitHub raw 在国内服务器常被 TLS 阻断，不能运行时依赖拉取）
COPY server/p2p/peers.json /app/default-peers.json

# 非 root 运行
RUN mkdir -p /data /apk \
 && addgroup -S app && adduser -S app -G app \
 && chown -R app:app /app /data /web /apk
USER app

ENV HOST=0.0.0.0 \
    PORT=8791 \
    DATABASE_PATH=/data/charge.db \
    WEB_DIST=/web \
    APK_DIR=/apk \
    TOKEN_KEY_FILE=/data/token_key \
    P2P_ENABLED=false

EXPOSE 8791
EXPOSE 4001

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -sf http://127.0.0.1:8791/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server.js"]
