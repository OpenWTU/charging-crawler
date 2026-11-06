# ---------- 构建阶段 ----------
# 用 Node 24：node:sqlite 在 24 里已正式支持，无需 better-sqlite3 原生模块
# 因此镜像里不需要 python3 / make / g++，体积和构建时间都大幅下降
FROM node:24-alpine AS builder

WORKDIR /app

# 先只拷依赖清单，最大化利用缓存
COPY package.json pnpm-lock.yaml* .npmrc* ./
RUN corepack enable \
 && (pnpm install --frozen-lockfile=false --prod=false || npm install)

# 再拷源码并编译
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY migrations ./migrations
RUN (pnpm run build || npm run build)

# ---------- 运行阶段 ----------
FROM node:24-alpine

RUN apk add --no-cache tini

WORKDIR /app
ENV NODE_ENV=production

COPY package.json pnpm-lock.yaml* .npmrc* ./
RUN corepack enable \
 && (pnpm install --prod --frozen-lockfile=false || npm install --omit=dev) \
 && (pnpm store prune || true)

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/migrations ./migrations

# 非 root 运行
RUN mkdir -p /data /web \
 && addgroup -S app && adduser -S app -G app \
 && chown -R app:app /app /data /web
USER app

ENV HOST=0.0.0.0 \
    PORT=8791 \
    DATABASE_PATH=/data/charge.db \
    WEB_DIST=/web \
    P2P_ENABLED=false

EXPOSE 8791

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8791)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server.js"]
