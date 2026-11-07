# server/deploy —— Node 版部署

## 一条命令部署（推荐，含自动更新）

```bash
curl -fsSL -H "Accept: application/vnd.github.raw" \
  "https://api.github.com/repos/OpenWTU/charging-crawler/contents/server/deploy/install.sh" | bash
```

它自动完成：装 Docker → 拉镜像 → 起容器 → **装凌晨 3 点自动更新 timer（失败自动回退）**。

可选环境变量（不填就用默认）：

```bash
NODE_NAME=我的节点 NODE_URL=https://我的域名 NODE_P2P_ADDR=/ip4/1.2.3.4/tcp/4001 \
  bash install.sh
```

跑完后：
- 服务：`http://<ip>:8791`，状态页 `/status`
- 自动更新：`systemctl list-timers charge-node-update.timer`（每天 03:00）
- 更新日志：`/var/log/charge-update.log`

## 手动部署（分步）

镜像仓库：`ghcr.io/openwtu/charging-crawler`（CI 推 `v*` tag 自动构建）。

```bash
# 1. 装 Docker（Ubuntu/Debian）
curl -fsSL https://get.docker.com | sh

# 2. 拉部署文件
mkdir -p /opt/charge-node
curl -fsSL -H "Accept: application/vnd.github.raw" \
  "https://api.github.com/repos/OpenWTU/charging-crawler/contents/server/deploy/docker-compose.node.yml" \
  -o /opt/charge-node/docker-compose.yml
curl -fsSL -H "Accept: application/vnd.github.raw" \
  "https://api.github.com/repos/OpenWTU/charging-crawler/contents/server/deploy/update-node.sh" \
  -o /opt/charge-node/update-node.sh && chmod +x /opt/charge-node/update-node.sh

# 3. 起服务
DATA_DIR=/var/lib/charge-cloud NODE_NAME=我的节点 docker compose up -d

# 4. 装自动更新 timer（复制 install.sh 的 6/6 段即可）
```

## ⚠️ 时区（重要）

容器默认是 UTC，会把时间戳写慢 8 小时。**两个修复都已内置**，新部署不会踩坑：

1. `Dockerfile`：`apk add tzdata` + `ENV TZ=Asia/Shanghai`
2. `docker-compose.yml`：`TZ=Asia/Shanghai` + 挂载宿主 `/etc/localtime:/etc/localtime:ro`

部署后验证：

```bash
curl -s http://127.0.0.1:8791/status | python3 -c "import sys,json;print(json.load(sys.stdin)['server_time'])"
# 应与服务器 date '+%Y-%m-%d %H:%M:%S' 一致（北京时间）
```

如果宿主机的时区不是 Asia/Shanghai，`docker-compose.yml` 里的
`/etc/localtime` 挂载会把宿主的时区带进容器——此时以 Dockerfile 的
`TZ=Asia/Shanghai` 为准（Node 优先读 TZ 环境变量，需要镜像里的 tzdata）。

## 从 systemd 迁移到 Docker

1. `systemctl stop charge-node`（旧 systemd 版）
2. 按上面步骤起容器（DATA_DIR 指向 /var/lib/charge-cloud 复用数据）
3. 验证 /health + /api/overview + /status
4. 稳定后 `systemctl disable charge-node`

⚠️ **不要在服务器上 `docker compose build`**——构建 node_modules 会拉高负载
（ICPC 服务器已有教训）。服务器只 `pull` 现成镜像，构建在 CI 做。

## 凌晨静默更新（失败自动回退）

```bash
# 安装 timer（凌晨 3:00 拉最新镜像，失败回退旧镜像）
cp server/deploy/update-node.sh /opt/charge-node/
cp server/deploy/charge-node-update.{service,timer} /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now charge-node-update.timer
```

更新日志：`/var/log/charge-update.log`（成功/失败/回退都记录）。
回退原理：旧镜像仍在本地，回退 = 把旧镜像 ID 重新 tag 回目标标签再重建容器。

---

## 当前生产状态（2026-11-06 P8 完成后）

**Python 已下线**：charge-cloud 已 stop+disable。Node（charge-node）扛全部：

```
读：12 个 API + /api/pile + /status
写：/api/snapshot（HMAC 验签 + 自动拉黑）、/api/device/register（自动审批）
抓：worker 定时抓取（首轮 areas=ok:39|ports=ok:39/438）
静态：/（WEB_DIST=/opt/charge-cloud/cloud/web，注意无 dist 子目录）
```

Nginx 全部 proxy 到 8791。内存约 35 MB。

**回滚**：
```bash
systemctl enable --now charge-cloud
cp /root/nginx-charge-before-full-node-*.conf /etc/nginx/sites-available/charge.lizishuo.cn
nginx -t && systemctl reload nginx
```

### 两个关键踩坑（P8）

1. **WEB_DIST 路径**：生产的 web 目录是 `/opt/charge-cloud/cloud/web`（index.html 直接
   在这一层），**没有 dist 子目录**。误设成 `.../cloud/web/dist` 会导致前端 404。
2. **Wants 依赖**：charge-node.service 原来有 `Wants=charge-cloud.service`，
   重启 Node 会把已停的 Python 再拉起来。下线 Python 前必须先移除这个依赖。

---

## 服务器现状（2026-11-06 实测）

| 项 | 值 |
|---|---|
| Node | v22.23.3（`/usr/bin/node`，npm 10.9.9） |
| Docker | **未安装**（也不需要，用 systemd） |
| 内存 | 1613 MB 总 / 863 MB 可用 |
| 磁盘 | 40 GB，23 GB 可用 |
| 现有服务 | `charge-cloud`（Python，systemd，127.0.0.1:8788） |
| 数据库 | `/var/lib/charge-cloud/charge.db` |

**关键结论：不需要 Docker，也不需要升级 Node。**
Node 22.23.3 的 `node:sqlite` 实测不带 flag 就能用，`StatementSync.columns()` 也支持
（适配层依赖它判断读写语句），只有一个 ExperimentalWarning，用 `NODE_OPTIONS=--no-warnings` 抑制。

## 部署步骤

```bash
# 1. 本地构建并打包（不含 node_modules）
cd server
npm run build
tar -czf /tmp/charge-node-deploy.tgz dist migrations package.json

# 2. 上传并装依赖
scp /tmp/charge-node-deploy.tgz root@<host>:/tmp/
ssh root@<host> 'mkdir -p /opt/charge-node && \
  tar -xzf /tmp/charge-node-deploy.tgz -C /opt/charge-node && \
  cd /opt/charge-node && \
  npm install --omit=dev --registry=https://registry.npmmirror.com --no-audit --no-fund'
# 依赖约 45 MB、98 个包、26 秒

# 3. 安装 systemd 服务（只读连接生产库）
scp setup-service.sh root@<host>:/tmp/
ssh root@<host> 'bash /tmp/setup-service.sh'

# 或先看会做什么：
ssh root@<host> 'bash /tmp/setup-service.sh --dry-run'
```

## 对拍验证

把 `parity_server.py` 传上去，在服务器本地跑（Python 8788 vs Node 8791）：

```bash
scp parity_server.py root@<host>:/tmp/
ssh root@<host> 'python3 /tmp/parity_server.py'
```

**2026-11-06 实测结果：18/18 端点一致**，内存 RSS 88.6 MB。

## 已经踩过的坑

### 1. `pkill -f 'charge-node/dist/server.js'` 匹配不到进程
进程的 argv 只有 `node dist/server.js`（工作目录才是 `/opt/charge-node`），
所以 `pkill -f 'charge-node/...'` 永远匹配不到 → 旧进程继续占着 8791，新进程启动失败
（EADDRINUSE 被 nohup 吞掉），而 `curl` 打到的还是旧进程，看起来像"新代码没生效"。

**正确做法**：按端口杀 `fuser -k 8791/tcp`，或 `pkill -f 'node dist/server.js'`。

### 2. `node:sqlite` 在 Node 22 是实验特性
功能完整（我们实测 `prepare/all/get/run/iterate/columns` 全部可用），
但会打 ExperimentalWarning。生产用 `NODE_OPTIONS=--no-warnings` 抑制。

### 3. Python 版的 `validate_token_key()` 会阻止用脱敏副本启动
对拍用的库副本如果保留了 `devices.secret_enc` 或 `token_pool.token` 的密文，
但本机没有生产 `token_key`，Python 起来会 `InvalidTag` 崩掉。
脱敏时要把这两处的密文一起清空。

## 回滚

```bash
systemctl disable --now charge-node     # 停 Node 版
# Nginx 若配了分流，删掉对应 location 并 reload
```

Python 版 `charge-cloud` 全程不受影响（Node 只读打开同一个库）。

---

## Nginx 灰度分流（2026-11-06 已上线）

### 为什么不能全量切

Python 版有 **17 个 API 路径**，Node 版目前只实现 **7 个只读查询**：

| 类别 | 路径 | Node |
|---|---|---|
| 只读查询 | overview / now / areas-ports / area-ports / analytics / history | ✅ |
| 只读查询 | pile/:device | ✅ |
| 只读查询 | area-coords / controllers / free-rate / latest / **version** | ❌ |
| **写入** | **snapshot（App 上传）/ device/register / refresh** | ❌ |
| 管理 | `/admin/*` | ❌ |
| 静态 | `/`（前端 web/dist） | ❌ |

**全量转 8791 会让 App 上传失败、前端打不开、管理页进不去。**
所以采用「按路径精确分流」：只切已验证的 7 个端点，其余一律留在 Python。

⚠️ 特别注意 `/api/version`：Node 版目前返回的是**占位假数据**（versionCode 0），
绝不能切过去，否则 App 的更新检查会失效。

### 已应用的配置

在 `/etc/nginx/sites-available/charge.lizishuo.cn` 的 `location /` **之前**插入：

```nginx
location ~ ^/api/(overview|now|areas-ports|area-ports|analytics|history|version|latest|area-coords|controllers|free-rate)$ {
    proxy_pass http://127.0.0.1:8791;
    # ... 标准 proxy_set_header
}

location ^~ /api/pile/ {
    proxy_pass http://127.0.0.1:8791;
    # ... 标准 proxy_set_header
}
```

当前已切到 Node 的端点（**12 个**）：overview / now / areas-ports / area-ports /
analytics / history / pile/ / version / latest / area-coords / controllers / free-rate。

**仍走 Python 的**：/api/snapshot（上传）、/api/device/register、/api/refresh、
/admin/*、/（前端静态资源与 APK 下载）。

⚠️ `/` 与 `/assets/` 暂不切：虽然 Node 已实现静态资源托管（流式发送），但前端页面是
最后一道防线，Node 挂了不至于整站打不开；等 Node 稳定跑一段时间再切。

Nginx 的 location 优先级：`^~` 前缀 > `~` 正则 > 普通前缀 `/`，
所以这两个块会先于 `location /` 命中，其余路径自然落回 Python。

备份在 `/root/nginx-charge-before-node-<时间戳>.conf` 和
`/root/nginx-charge-before-vlatest-<时间戳>.conf`。

### 上线后验证（实测全部通过）

```bash
# 读路径确实走 Node：直连 8791 与经 Nginx 的响应逐字段一致
curl -s https://charge.lizishuo.cn/api/overview

# 写路径仍走 Python：应返回业务校验错误，而不是 404
curl -s -X POST https://charge.lizishuo.cn/api/snapshot -d '{}'
#   -> 401 {"ok":false,"error":"时间戳非法"}
curl -s -X POST https://charge.lizishuo.cn/api/refresh -d '{}'
#   -> 401 {"ok":false,"error":"需要管理员登录后才能刷新"}

# Node 上这些路径确实是 404（证明没被误分）
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:8791/api/snapshot
#   -> 404

# /api/version 仍由 Python 提供真实版本号
curl -s https://charge.lizishuo.cn/api/version
#   -> versionCode 215 / versionName 1.11.39
```

### 节点标识与手动切换（v2.2+）

- `NODE_NAME`：节点名称（状态页卡片显示，默认 peerId 前 8 位）
- `NODE_URL`：节点 HTTP 地址（状态页卡片「切换」时 App 直连这个 URL）

docker-compose.yml 里可配：
```yaml
environment:
  NODE_NAME: 主节点
  NODE_URL: https://charge.lizishuo.cn
```

### 运维观察点

- `docker logs charge-node -f` 看 Node 日志
- `docker stats charge-node` 看内存（实测约 50-110 MB）
- 健康检查：`curl http://127.0.0.1:8791/health`
- 更新日志：`/var/log/charge-update.log`

---

## 当前生产状态

```
生产：charge-node 容器（GHCR latest），Docker 部署
镜像：CI 推 v* tag 自动构建，凌晨 3 点自动更新（失败回退）
数据：SQLite 在 /var/lib/charge-cloud（数据卷挂载 /data）
P2P：默认启用，白名单鉴权（签名来源 peerId）
```

