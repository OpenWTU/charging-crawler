# server/deploy —— Node 版部署

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
