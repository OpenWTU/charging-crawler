# 变更记录（Changelog）

本文件格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

> 说明：仓库内代码另有一套历史内部版本号（当前 `2.2.3`），
> 对外发布使用独立语义化版本与 Git tag。

## [v2.3.x] - 2026-11-07

### P2P 多节点
- 节点目录 `nodes.json` 合并原 `peers.json`（peerId 白名单 + App 目录单一真相源）
- 白名单带 P2P 地址：节点启动自动尝试连接全部已知节点（NAT 后单向建连即通，无需人工配方向）
- 消息鉴权改用 libp2p `SignedMessage.from`（签名来源，防伪造 sender）
- 节点状态心跳（名称/版本/数据统计，60 秒），状态页节点卡片化
- 在线节点计数含本机（`online_total`）

### 修复
- 令牌池 `cover_until` 用最晚到期（原用最早到期，新上传的 token 体现不出来）
- Android 允许明文 HTTP（`usesCleartextTraffic`），修复切换到 http 备用节点失败
- 健康条令牌时间来源标注（服务器/本地），降级本地未过期不报警
- OverviewCache 合并服务器 overview 时服务器数据优先
- Android 系统状态栏跟随页面深浅色（含图标明暗），深色模式不再留浅色状态栏

### 部署
- `server/deploy/install.sh` 一条命令部署（装 Docker + 起容器 + 装凌晨自动更新 timer）
- `docker-compose.node.yml` 纯镜像部署模板

## [v2.2.x] - 2026-11-06

Node/TypeScript 全量重写稳定版。

### 后端
- Fastify 5 + Kysely + node:sqlite（Node 24），Python 版下线删除
- 设备 HMAC 验签上传（±10 分钟时间窗 + nonce 防重放）+ 自动审批 + 自动拉黑
- worker 定时抓取（token 池轮换，平台 MD5 签名对拍）
- /status 公开状态页（服务器/数据/令牌池/worker/节点/拉黑）
- P2P：libp2p + gossipsub 快照广播 + peerId 白名单（签名来源鉴权）+ 状态心跳
- Docker 部署（GHCR）+ 凌晨自动更新（失败回退）+ 时区修复

### App（2.2.3）
- 节点发现（GitHub 目录 + mDNS + 手动切换）+ 检查更新直读 GitHub
- 历史页收进实时页卡片 + 状态页节点卡片
- 公众号「蛮来电」抓取引导文案

## [未发布]

### 计划

- 上游 H5 接口基址改为可配置（当前硬编码在 `crawler/api.py` 与 Android `ApiClient.java`）
- 预测模型加入节假日特征（历史数据量不足，暂缓）
- 端口状态历史表（用于观察上游是否会返回「浮充/已充满」等细分状态）

## [v1.0.0] - 2026-11-06

首个公开版本（source-available，禁止商用）。

### 后端（Python 标准库 HTTP + SQLite）

- 模块化结构：`cloud/app.py` 门面（255 行）+ 12 个领域模块
  （`config` `db` `security` `geo` `store` `snapshots` `ports` `tokens`
  `prediction` `analytics` `health` `refresh`）+ 11 个 HTTP 模块
  （`http/base` `api` `api_upload` `api_ports` `api_state` `api_analytics`
  `admin` `admin_areas` `admin_account` `admin_ops` `static`）
- 设备级 HMAC 签名上传（时间窗 + nonce 防重放）、设备审批开关、
  区域白名单与总量守恒校验、单事务落库
- 登录令牌 AES-GCM 加密存储 + 令牌池轮换；管理员口令 scrypt；会话 HttpOnly + SameSite
- 端口级状态（数据契约 v2）：22 项状态白名单 + 四分组
  （`free`/`busy`/`unavailable`/`unknown`）+ 逐状态计数 `statuses`；
  未知状态保留原文；`status_group` 由 SQLite 触发器维护
- 到达预测：近 30 分钟趋势 + 同星期同小时历史空闲率 + 满区 ETA
- 热力图 / 15 分钟趋势 / 排行 / 同期参考（60s 缓存）
- worker 定时抓取（默认 10 分钟）、健康摘要 `/health`、CSV 导出（防公式注入）
- 幂等数据库迁移（补列 + 回填 + 建触发器）

### 抓取（crawler）

- 复刻上游 H5 的 MD5 签名头（`X-Timestamp` / `X-Signature` / `X-seq` / `X-AppID`）
- JWT 解析、跨进程抓取锁、原始数据保留与小时聚合策略

### 前端（Vue 3 + Vant 4 + ECharts 5）

- 组件化：`App.vue` 299 行、`Admin.vue` 19 行薄壳；`api.js` 拆为
  `api/{transport,areas,ports,analytics,admin,native,index}.js`；
  `views/` `components/` `composables/` `styles/` 分层
- 端口详情按细分状态上色并显示状态文案（空闲/充电中/已充满/浮充/未充占用/不可用/未知）
- 刷新进度：顶部卡片内侧细进度线 + 副标题分阶段文案
  （抓取充电区 x/y → 补全端口 x/y → 上传数据中），两阶段合并为连续进度
- 令牌保存 / 数据上传后立即失效并重读 overview 缓存，顶部健康状态即时更新
- 深色模式、响应式（320/360/390/1440）、桌面端 hover 反馈、自适应端口网格

### Android

- 无 AndroidX；`build.py` 离线构建（aapt2/javac/d8/apksigner）
- MainActivity 拆分为 394 行 + 16 个类（`bridge/` `web/` `net/` `capture/` `geo/` `state/`）
- 24 个 `@JavascriptInterface` 桥方法；WebView 关闭 file/content 访问
- VPN 抓包取令牌（仅目标域名）、设备密钥存 Keystore、更新包 sha256 校验

### 测试与 CI

- 134 项 unittest：服务端接口、签名、保留策略、调度、token 解析、
  端口状态分组与逐状态计数、迁移幂等
- GitHub Actions：Python 单测 + 前端构建

### 安全

- 限流覆盖全部读接口与后台接口；限流 IP 判定取转发头最可信一跳
- 后台写操作校验 Origin；后台错误不回栈；CSV 导出防公式注入
- WebView 禁用 file/content 访问，无忽略证书错误逻辑
