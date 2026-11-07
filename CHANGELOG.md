# 变更记录（Changelog）

本文件格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

> 说明：仓库内代码另有一套历史内部版本号（当前 `2.3.7`），
> 对外发布使用独立语义化版本与 Git tag。

## [v2.3.7] - 2026-11-08

第二轮复审（只审上一轮修复本身）后的收尾版本。

### 修复（复审发现）
- `createDb` 换库时 Kysely 的 `destroy()` 是空操作（`#db` 要到首次查询才赋值）→
  先 `rawDb.close()` 再 destroy，并补 `.catch()`（否则 reject 成未处理 rejection 会让进程退出）；
  单例键同时比较路径与 readonly 模式
- `storeSnapshot` 改为复用 `snapshotDigest`（原来自拼摘要只排除 captured_at，
  遇到带 received_at/client_ip 的 payload 会与广播摘要分叉）
- `ingestSnapshot` 去重补 30 分钟时间窗（原无窗口，夜间 idle==total 这类
  内容相同但时间不同的正常快照会被永久判重丢弃）
- 白名单重试定时器纳入 `stopP2p` 清理（原来停机后仍每 5 分钟拉 GitHub），
  重试成功时补一次 `dial` 让已有节点主动连上新节点
- `/health` 的 `p2p` 改为运行态（`!!p2pSelfId()`），并单列 `p2p_enabled`——
  原来 P2P 降级后仍报 `p2p:true`，监控看不出降级
- `REGISTER_TOKEN` 读取时 `.trim()`（配置带空格会导致全员 403）；
  注册限流前移到令牌校验之前（原错误 token 不受限流，可无限爆破）；
  403 文案改为同时提示「App 版本过旧或服务端配置不一致」
- `banlist` 补惰性内存清扫（条目 > 5000 时清过期项，防伪造 IP 撑爆内存）
- `StateBuilder` 注释修正（`mergeInto` 是服务器值**覆盖**本地，不是只补缺失键）
- 状态页轮询不再因错误态停止（切节点失败会自动回滚，页面要能自愈）
- `Updater.check()` 捕获 `RejectedExecutionException`（Activity 销毁后前端 `upChecking`
  会永久卡住）
- `useUpdate` 失败分支补 `onAfterCheck()`（原跳过刷新判定）；`autoCheck` 加防重入
  （原会把正在进行的手动检查的 silent 改成 true，导致「点了没反应」）
- 404/403 时客户端解析 `error` 字段，不再把原始 JSON 抛给用户
- 测试：重放拉黑用例改用独立设备自造完整流程（原来依赖前序用例状态，单独跑必失败）

## [v2.3.6] - 2026-11-08

全面代码审查（server / webui / android 逐文件）后的修复版本。

### 安全
- 设备注册令牌 `REGISTER_TOKEN`（可选）：配置后 `/api/device/register` 必须带
  `x-register-token` 头，防止任意注册后污染公共数据；**留空则不校验**（兼容旧版 App）
- P2P 初始化失败不再拖死 HTTP 服务（原会把已 listen 的服务一起 exit，compose 无限重启）
- `trustProxy` 只信任 Nginx 所在网段（原 `true` 允许客户端伪造 `X-Forwarded-For`
  绕过全部 IP 限流与自动拉黑）

### 修复（审查发现）
- 拉黑计数改为按事件类型分开（原三类共用一个计数器，阈值却不同 → 会提前误拉黑合法设备）
- 快照摘要统一为 `snapshotDigest`（上传用 sha256(原始 body)、P2P 用 sha256(stableStringify)，
  同一份数据两个摘要 → P2P 去重与窗口去重全部失效、重复落库）
- 补 `idx_samples_snapshot` 索引（`/api/now` 等按 snapshot_id 查询原是全表扫描，
  90 天约 65 万行且在同步 SQLite 上阻塞事件循环）
- `createDb` 同路径复用连接、换路径销毁旧连接（原反复初始化泄漏连接）
- 服务端抓取的快照 `token_user` 恒为空（`uid` 变量从未赋值）
- P2P 事件回调未捕获的 rejection 会让 Node 24 直接退出进程
- 白名单拉取失败后每 5 分钟重试（原永久拒绝所有外部消息，需人工重启）
- `NODE_ENV` 默认改为 production（原 development 会在 --prod 镜像里找 pino-pretty 而启动崩溃）
- 心跳广播 `NODE_P2P_ADDR`（原为死配置）
- 端口数据被拒时记日志并返回具体原因（原静默 400）

### App
- 自动检查更新抛 `ReferenceError`（`SEEN_KEY` 被误删）→ 更新弹窗永不出现
- 「同一版本只提醒一次」改为 12 小时过期 + 手动检查始终弹窗
- App 桥路径透传 `server_online`（原离线降级会在 60 秒轮询后被反写成在线）
- 手动切换节点加 http(s) 校验 + 切换后 `/health` 探测，不通自动回滚（原切到坏节点无法自救）
- GitHub 检查更新超时缩短到 4 秒，快速回退服务器

## [v2.3.3] - 2026-11-07

### P2P 多节点

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
