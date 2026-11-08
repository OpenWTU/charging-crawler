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
  p2p/                   nodes.json（节点目录 + peerId 白名单，App 与服务器共用）

webui/                   Vue 3 + Vant 4 + ECharts，Vite 多入口（index/admin/app）
android/                 WebView + JS 桥 App，build.py 离线构建（aapt2/javac/d8/apksigner）
docker-compose.yml       一键部署
.github/workflows/       ci（检查）+ release-image（镜像）+ release-apk（APK）
```

## 快速开始（一条命令）

```bash
# 装 Docker + 拉镜像 + 起容器 + 装凌晨自动更新 timer，全自动
curl -fsSL -H "Accept: application/vnd.github.raw" \
  "https://api.github.com/repos/OpenWTU/charging-crawler/contents/server/deploy/install.sh" | bash
```

可选参数（不填用默认）：

```bash
NODE_NAME=我的节点 NODE_URL=https://我的域名 NODE_P2P_ADDR=/ip4/1.2.3.4/tcp/4001 \
  bash install.sh
```

镜像：`ghcr.io/openwtu/charging-crawler:latest`（CI 推 `v*` tag 自动构建）。
自动更新：每天 03:00 拉最新镜像，`/health` 检查失败自动回退旧镜像（日志 `/var/log/charge-update.log`）。

可选环境变量：

| 变量 | 说明 |
|---|---|
| `TRUST_PROXY` | 前面有 Nginx 时设 `true`（只信任本机/docker 网段转发的 `X-Forwarded-For`，防伪造绕过限流）|
| `REGISTER_TOKEN` | 设备注册令牌。**留空 = 不校验**；配置后 `POST /api/device/register` 必须带同名 `x-register-token` 头（新版 App 已内置），用于阻止任意注册 |
| `NODE_NAME` / `NODE_URL` / `NODE_P2P_ADDR` | 节点名称 / HTTP 地址 / 公网 P2P 地址（状态页卡片与节点互连用）|
| `ADMIN_INIT_PASSWORD` | 初始管理员口令（仅在 `admin_users` 为空时用来创建 `admin`，**首次登录强制改密**；不配则不创建账号）|
| `ADMIN_SESSION_SECRET` | 会话签名密钥（建议 ≥16 位随机串；缺失时进程内随机，重启后所有会话失效）|
| `ADMIN_COOKIE_SECURE` | 会话 cookie 是否 Secure（默认 `true`；本地 http 调试设 `false`）|
| `P2P_TRUST_NON_WHITELIST` | 是否采纳**非白名单节点**的数据。默认 `false`（丢弃，只信 `nodes.json` 里的节点）；设 `true` 则任何能连上来的节点数据都接受。**不影响连接本身**——非白名单节点照样能加入网络、状态页可见、App 可手动切过去 |

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
| — | `/admin` | **管理后台**（17 页：概览/实时/历史/质量/数据浏览器/令牌/设备/桩区域/节点/任务/日志/流量/系统/配置/发布/备份/账号/审计）|
| — | `/admin/login` | 管理员登录（多账号 + 三角色）|
| GET | `/api/latest` | 最新原始快照 |
| GET | `/status` | 公开状态页（无登录） |
| GET | `/health` | 健康摘要 |

## 安全

- 上传：设备级 HMAC 签名 + 时间戳窗口（±300s）+ nonce 防重放；坏请求自动计数拉黑（验签失败 5 次/10 分、重放 1 次、时间戳过期 10 次/10 分 → 拉黑 1 小时）。
- token：AES-256-GCM 加密存储，仅用于 worker 代为抓取；App「上传令牌」开关默认开，关闭后不上传。
- 设备注册：自动审批（无人工审核），secret 用 AES-GCM 加密落库。
- 只读接口：IP 限流。
- **管理后台**：`/admin`（17 页）。首次部署配 `ADMIN_INIT_PASSWORD` 创建 `admin` 账号，登录后**必须先改密**。
  三角色：`super`（全部）/`ops`（数据处理，不能改配置/白名单/恢复/账号）/`viewer`（只读）。
  写操作需 CSRF 头，全部进 `admin_audit`。方案见 [`docs/admin-plan.md`](docs/admin-plan.md)，
  跨节点互校见 [`docs/p2p-validation.md`](docs/p2p-validation.md)。
- **P2P**：节点身份用 peerId 白名单（权威源 `server/p2p/nodes.json`，App 节点目录与白名单合并成一份，走 PR 审计）；节点私钥留在服务器本地，绝不进仓库。
  - **连接层完全开放**：任何 libp2p 节点都能连上来（不拦 dial），非白名单节点也会出现在状态页
  - **消息层默认只信白名单**：不在 `nodes.json` 的节点，其快照/心跳默认丢弃；
    设 `P2P_TRUST_NON_WHITELIST=true` 可改为全部采纳
  - **App 自动切换只走白名单目录**（GitHub `nodes.json`）；mDNS 发现的局域网节点只记日志、
    不自动切换，但可以在状态页手动点过去

## P2P 去中心化共享

节点之间通过 libp2p + gossipsub 广播快照，最终一致：

```
App 上传 → 节点 A 落库 → gossipsub 广播（topic "charge-snapshots"）
        → 节点 B/C 收到 → body_sha256 去重 → 落库
```

- 默认 `P2P_ENABLED=true`（单节点也启动，白名单空时拒绝所有外部消息，安全）。
- 加节点：部署新节点 → 在 `server/p2p/nodes.json` 里加一条（peerId / name / url / p2p 地址）→ PR 合入 main → 发版。所有节点与 App 自动生效（服务器据此鉴权+互连，App 据此发现+切换）。
- App 端节点发现：启动时从 GitHub contents API 拉 `nodes.json`，逐个 `/health` 探测选第一个通的；mDNS 发现局域网节点；全失败回退内置 `charge.lizishuo.cn`。
- 状态页节点卡片：显示节点名称（NODE_NAME）/版本/数据统计，可点击手动切换连接节点。
- 自动互连：节点启动时尝试连接目录里所有节点的 `p2p` 地址，任一方向连通即可（TCP 全双工），NAT 后无需人工配方向。
- **数据同步范围**：只广播新产生的快照（`body_sha256` 去重）；节点加入前的历史不回填。
- 在线节点计数 `online` 为其他节点数，`online_total` 含本机；状态页显示「在线节点（含本机）」。

## 构建与发布

```bash
# 前端
cd webui && pnpm install && pnpm run build   # 输出到 webui/dist

# APK（本机，需 Android SDK/JDK + release keystore）
CHARGE_VERSION_CODE=2004021 CHARGE_VERSION_NAME=2.4.21 python android/build.py

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

- App：`2.4.21`（versionCode 2004021）
- Node 后端测试：`cd server && pnpm test`（53 项，含密码学对拍、端点边界、P2P 两节点互传、worker mock）
- 只读接口曾与 Python 版 24/24 对拍一致（Python 版已删除，见 git 历史）
- 签名：release keystore 保持仓库外，SHA256 见 `/api/version`

## 数据来源与使用边界

- 数据来自**公开的用户端 H5 接口**，使用**本人账号**的登录令牌，频率受限（每请求 ≥200ms）。
- 仅采集"哪个端口空着"这类面向用户的公开信息，**不采集**其他用户数据、不调用运营商后台接口、不做设备控制。
- 请勿用于商业用途；部署到公网前请自行确认上游服务条款与学校/运营商要求。

## 许可证

PolyForm Noncommercial License 1.0.0（SPDX：`PolyForm-Noncommercial-1.0.0`），**非 OSI 开源许可，禁止商业使用**。详见 `LICENSE` 与 `NOTICE`。
