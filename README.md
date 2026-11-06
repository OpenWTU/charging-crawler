# 校园充电桩空位查询

武汉纺织大学阳光校区的充电桩空位实时查询与到达预测：**Android App + 网页 + Node 服务端 + P2P 共享**。

- 线上示例：`https://charge.lizishuo.cn/`
- 公开状态页：`/status`（令牌池 / 抓取 worker / 在线节点 / 拉黑统计，无登录）
- App 更新元数据：`/api/version`

> 本项目为个人用途的校园工具（武汉纺织大学阳光校区），**非官方产品**，与充电桩运营商无关。仅供学习与自用。

## 架构

```
App（Android WebView + Java）
  ├ 用自己的 token 直接抓平台数据 → 本地立即渲染（离线也能看）
  ├ 强制上传快照到服务器（token 上传另有开关，默认开）
  └ 节点发现：GitHub 目录 + mDNS → 直连任一可用节点

服务器节点（Node/TypeScript，Docker 部署）
  ├ 接收上传 + 设备注册（自动审批）+ 脏数据自动拉黑
  ├ worker 定时抓取（token 池轮换，10 分钟一轮）
  ├ 13 个只读 API + 静态页面
  └ P2P：libp2p + gossipsub 广播快照，节点间最终一致共享

存储：SQLite（WAL），各节点本地一份，P2P 同步
```

**关键设计**：

- **App 双抓取**：App 用自己的 token 抓数据（本地立即可用），服务器 worker 用 token 池兜底（token 上传开关打开时）。
- **服务端无中心**：任一节点可下线，新节点一条命令加入；App 通过 GitHub 目录自动切换可用节点。
- **token 永不进 P2P**：广播的只有快照数据，token 只在本地抓取用。

## 项目结构

```
server/                  Node/TypeScript 后端（核心，生产运行）
  src/                   Fastify 5 + Kysely + node:sqlite
    routes/              ports / analytics / state / misc / static / upload / status
    domain/              crypto / ports / analytics / prediction / store / tokens
                         worker / p2p / sign / crawler / ratelimit / banlist
    db/                  Kysely 实例 + 自研迁移器 + node:sqlite 适配
  migrations/sqlite/     001_init + 002_seed（与历史 Python 版 schema 逐字一致，对拍固化）
  scripts/               跨语言对拍（parity / crypto / sign）
  test/                  53 项（vitest）
  Dockerfile / deploy/   镜像构建 + 部署 + 更新脚本 + 对拍
  p2p/                   nodes.json（App 节点目录）+ peers.json（peerId 白名单）

webui/                   Vue 3 + Vant 4 + ECharts，Vite 多入口（index/admin/app）
android/                 WebView + JS 桥 App，build.py 离线构建（aapt2/javac/d8/apksigner）
docker-compose.yml       一键部署
.github/workflows/       ci（检查）+ release-image（镜像）+ release-apk（APK）
```

## 快速开始（Docker）

```bash
# 1. 装 Docker（Ubuntu）
curl -fsSL https://get.docker.com | sh

# 2. 拉部署文件
mkdir -p /opt/charge-node
# 放入仓库根 docker-compose.yml 和 server/deploy/update-node.sh

# 3. 起服务（数据目录指向 SQLite + token_key 所在处）
DATA_DIR=/var/lib/charge-cloud docker compose pull
DATA_DIR=/var/lib/charge-cloud docker compose up -d

# 4. 验证
curl http://127.0.0.1:8791/health
```

镜像：`ghcr.io/openwtu/charging-crawler:latest`（CI 推 `v*` tag 自动构建）。

## 功能

- **App**：实时列表、按楼栋推荐、分析页（热力图/趋势/排行/同期参考）、**历史页**（单区曲线/作息规律/采样明细）、令牌页（VPN 抓包/手动粘贴）、设置、刷新进度、**离线降级**（连不上服务器时隐藏分析/历史页签）、**节点发现**（GitHub 目录 + mDNS）。
- **网页**：同一套实时/分析/历史页面，公开只读。
- **服务端**：设备 HMAC 签名上传、设备注册**自动审批**、**脏数据自动拉黑**、区域白名单与总量守恒校验、单事务落库、worker 定时抓取、端口级状态同步、P2P 快照共享、公开状态页。

## 端口状态口径

上游接口返回**状态原文（中文）**，归一成四组用于快速判定，同时保留原文：

| 分组 | 含义 | 包含的状态原文 |
|---|---|---|
| `free` | 可充 | 空闲 |
| `busy` | 已占用 | 充电中、未充占用、已充满、充满占用、浮充、占用 |
| `unavailable` | 不可用 | 端口故障、故障、离线、维护、禁用、绑定、各类硬件故障 |
| `unknown` | 无法识别 | 其他（原文照旧保留） |

- `port_states.status_group` 由数据库触发器维护，直接改 `status` 也会自动重算。
- `/api/*-ports` 的 `summary` 同时给出四分组计数与 `statuses`（逐状态计数）。

## 主要接口

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/snapshot` | 设备签名上传（HMAC + 时间窗 + nonce 防重放） |
| POST | `/api/device/register` | 设备注册（自动审批） |
| GET | `/api/overview` | 最新快照 + 健康/令牌池字段 |
| GET | `/api/now` | 当前空闲 + 增量 + 到达预测 |
| GET | `/api/areas-ports` | 全区端口级状态 |
| GET | `/api/area-ports?area=` | 单区端口明细 |
| GET | `/api/pile/<device>` | 单桩详情与最近采样 |
| GET | `/api/analytics` | 热力图 / 趋势 / 排行 / 同期参考 |
| GET | `/api/free-rate` | 分时段空闲率 |
| GET | `/api/history?area=` | 单区历史 |
| GET | `/api/area-coords` | 区域坐标 |
| GET | `/api/controllers` | 控制器清单 |
| GET | `/api/version` | APK 版本与 sha256 |
| GET | `/api/latest` | 最新原始快照 |
| GET | `/status` | 公开状态页（无登录） |
| GET | `/health` | 健康摘要 |

## 安全

- 上传：设备级 HMAC 签名 + 时间戳窗口（±300s）+ nonce 防重放；坏请求自动计数拉黑（验签失败 5 次/10 分、重放 1 次、时间戳过期 10 次/10 分 → 拉黑 1 小时）。
- token：AES-256-GCM 加密存储，仅用于 worker 代为抓取；App「上传令牌」开关默认开，关闭后不上传。
- 设备注册：自动审批（无人工审核），secret 用 AES-GCM 加密落库。
- 只读接口：IP 限流。
- **P2P**：节点身份用 peerId 白名单（权威源 `server/p2p/peers.json`，走 PR 审计）；节点私钥留在服务器本地，绝不进仓库。

## P2P 去中心化共享

节点之间通过 libp2p + gossipsub 广播快照，最终一致：

```
App 上传 → 节点 A 落库 → gossipsub 广播（topic "charge-snapshots"）
        → 节点 B/C 收到 → body_sha256 去重 → 落库
```

- 默认 `P2P_ENABLED=true`（单节点也启动，白名单空时拒绝所有外部消息，安全）。
- 加节点：部署新节点 → 把它的 HTTP 地址写进 `server/p2p/nodes.json`（App 目录）、peerId 写进 `server/p2p/peers.json`（白名单）→ PR 合入 main → 发版（镜像带新白名单）。
- App 端节点发现：启动时从 GitHub contents API 拉 `nodes.json`，逐个 `/health` 探测选第一个通的；mDNS 发现局域网节点；全失败回退内置 `charge.lizishuo.cn`。
- 状态页节点卡片：显示节点名称（NODE_NAME）/版本/数据统计，可点击手动切换连接节点。

## 构建与发布

```bash
# 前端
cd webui && pnpm install && pnpm run build   # 输出到 webui/dist

# APK（本机，需 Android SDK/JDK + release keystore）
CHARGE_VERSION_CODE=2000000 CHARGE_VERSION_NAME=2.2.3 python android/build.py

# Docker 镜像（本地验证）
docker compose build
```

**CI 自动发布**（推 `v*` tag）：

- `release-image.yml`：构建前端 + Docker 镜像 → 推 GHCR。
- `release-apk.yml`：装 JDK17 + Android SDK → 从 Secrets 读签名密钥 → 构建 APK → 发布 Release asset（需配置 3 个 Secrets：`ANDROID_KEYSTORE_B64` / `ANDROID_KEYSTORE_PASSWORD` / `ANDROID_KEY_ALIAS`）。

## 部署与运维

详见 `server/deploy/README.md`。要点：

- **从 systemd 迁移到 Docker**：停 systemd charge-node → `docker compose up -d`（`user: "33:33"` 复用 www-data 数据）→ 验证。
- **凌晨静默更新**：`charge-node-update.timer` 每天 03:00 拉最新镜像重建，`/health` 检查失败自动回退旧镜像；日志 `/var/log/charge-update.log`。
- **回滚**：`docker compose` 切回旧镜像 tag；或 `systemctl start charge-node` 回 systemd 版。
- **跨语言对拍**：`server/scripts/`（对拍脚本）+ `server/deploy/parity_server.py`（生产对拍）。

## 版本与测试

- App：`2.2.3`（versionCode 2002003）
- Node 后端测试：`cd server && pnpm test`（53 项，含密码学对拍、端点边界、P2P 两节点互传、worker mock）
- 只读接口曾与 Python 版 24/24 对拍一致（Python 版已删除，见 git 历史）
- 签名：release keystore 保持仓库外，SHA256 见 `/api/version`

## 数据来源与使用边界

- 数据来自**公开的用户端 H5 接口**，使用**本人账号**的登录令牌，频率受限（每请求 ≥200ms）。
- 仅采集"哪个端口空着"这类面向用户的公开信息，**不采集**其他用户数据、不调用运营商后台接口、不做设备控制。
- 请勿用于商业用途；部署到公网前请自行确认上游服务条款与学校/运营商要求。

## 许可证

PolyForm Noncommercial License 1.0.0（SPDX：`PolyForm-Noncommercial-1.0.0`），**非 OSI 开源许可，禁止商业使用**。详见 `LICENSE` 与 `NOTICE`。
