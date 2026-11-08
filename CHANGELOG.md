# 变更记录（Changelog）

本文件格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

> 说明：仓库内代码另有一套历史内部版本号（当前 `2.4.0`），
> 对外发布使用独立语义化版本与 Git tag。

## [v2.4.6] - 2026-11-08

### 修复
- **ci 的 android job 改为「只做 Java 编译检查」**（不再打包 APK）。
  v2.4.0–v2.4.5 这个 job 反复失败全在 SDK 环境上，而 **release-apk.yml 一直能过**
  —— 说明打包流程本身没问题，是 ci 这个 job 在重复维护一套不需要的环境。
  现在：定位 runner 预装的 `android.jar` → `javac` 编译主源码与测试源码即可。
  APK 的实际构建由 release-apk（打 tag 时）负责。

## [v2.4.5] - 2026-11-08

### 修复（ci.yml 的 android job 最后两个坑，这次有 CI 日志佐证）
CI 日志显示：
```
+ echo ANDROID_HOME=
ANDROID_HOME=                       ← 空的！
FileNotFoundError: 'build-tools/34.0.0/aapt2'
```
1. **`ANDROID_HOME` 从未设置** —— `${{ env.ANDROID_HOME }}` 引用的是 workflow 顶层 env，
   不是 shell 变量。release-apk.yml 有自己的「设置 ANDROID_HOME」步骤，ci.yml 没有。
   → 抄 release-apk 的三步：设置 `ANDROID_HOME=$HOME/android-sdk` + 下载 cmdline-tools + 装
   `platforms;android-34` / `build-tools;34.0.0`
2. **build.py 硬编码 `build-tools/34.0.0` 与 `platforms/android-34`** —— runner 预装版本未必是 34。
   → 改成动态探测：优先 34.0.0/android-34，找不到就取目录里最新的并打印一行说明。

v2.4.4 的 release-apk 已经成功（它有完整的 SDK 设置），本轮只影响 ci。

## [v2.4.4] - 2026-11-08

### 修复（CI APK 构建失败的真正根因 —— v2.4.0~v2.4.3 连续四版都挂在这）
```
FileNotFoundError: [Errno 2] No such file or directory:
  '.../android/app/src/main/assets/www/index.html'
```
M9 把 `assets/www` 从 git 取消跟踪（改由构建时生成）后，CI checkout 出来的仓库**没有这个目录**，
而 `build.py` 在 `shutil.copy2` 之前没有创建它 —— 于是必然崩在「构建 APK」这一步。

修复：`www.mkdir(parents=True, exist_ok=True)` 放在拷贝之前。
本地已模拟 CI 状态（先 `rm -rf assets/www`）验证：构建成功、APK 461 KB、目录被自动创建。

> 前几版走过的弯路（记录下来避免重犯）：
> v2.4.0 猜是 freshness 检查 → v2.4.1 改成 CI 跳过；v2.4.2 猜是版本号断言 → 改成警告 + 补
> subprocess 输出捕获；v2.4.3 猜是 ci.yml 缺 env → 补 env。
> 这些都是真实存在的小问题（顺手修了），但**都不是这次的根因**。
> 真正的教训：CI 失败必须先把日志拿到手再改，否则一路猜。

## [v2.4.3] - 2026-11-08

### 修复（CI APK 构建的真正根因）
- **ci.yml 的 android job 缺 `env:`** —— `CHARGE_ANDROID_SDK` / `CHARGE_JAVA_HOME` 为空时，
  `build.py` 会回落到 Windows 默认路径 `C:\Android\sdk`，在 ubuntu 上必然不存在。
  （这个 job 是 v2.4.0 我新加的，加的时候漏了 env）
- **`run()` 回退到 v2.3.8 的行为**（`check=True`、不捕获输出）——
  v2.4.2 的 `capture_output=True` + 自己打印可能改变了子进程行为，而 v2.3.8 的 CI 是通过的。
  可观测性改由 workflow 的 `set -x` + 环境打印承担。
- 两个 workflow 的 APK 步骤都加了诊断（`set -x`、SDK/JDK 路径、python 版本、build-tools/platforms 列表）

## [v2.4.2] - 2026-11-08

### 修复
- **CI APK 构建仍失败（v2.4.1）**：把 `build.py` 的「versionCode 与 name 不一致」从
  **硬失败改成警告** —— 用「构建失败」表达版本号不一致代价太大，而且当时根本看不到真实原因。
- **补可观测性**：`run()` 原来用 `subprocess.run(check=True)` 且不捕获输出，
  aapt2/d8/javac 的真实报错完全看不到（CI 日志里只有 CalledProcessError 堆栈）。
  现在捕获 stdout/stderr，失败时打印两边尾部 4KB，成功时也打印 javac 警告。
- 构建开始打印实际入参（`VERSION_NAME` / `CHARGE_VERSION_CODE`），便于对齐 CI 传参。

> 说明：v2.4.0 与 v2.4.1 的 tag 均已推送，其 release-apk 失败但 release-image 成功。
> 这三个 tag 指向的代码只差在这个构建脚本的诊断能力上，服务端镜像不受影响。

## [v2.4.1] - 2026-11-08

### 修复
- **CI 构建 APK 失败**（v2.4.0 的 release-apk 与 ci 的 android job 都挂在「构建 APK」）：
  上一轮给 `build.py` 加的「webui/src 比 dist 新就拒绝打包」启发式在 CI 里误判
  （checkout 的 mtime 与构建产物过于接近）。改为**只在本地生效**（检测 `CI`/`GITHUB_ACTIONS`
  环境变量），两个 workflow 同时显式加 `--allow-stale-web` 双保险。
  本地已模拟 CI 环境（含 `CHARGE_VERSION_NAME=2.4.0` / `CHARGE_VERSION_CODE=2004000`）验证通过。

## [v2.4.0] - 2026-11-08

### 新增：管理后台（17 个页面 + 多账号鉴权）
- **鉴权**：多账号 + 三角色（super/ops/viewer），scrypt 口令，HMAC 会话（带账号版本，
  改密/禁用/换角色即全端失效），CSRF 双提交，登录 5 次/10 分钟限流，初始口令强制改密
- **监控**：概览（5 指标卡 + 24h 趋势 + 告警 + 空位排行 + 事件流）、流量与限流（状态码分布/
  端点排行/封禁列表与解封）、审计（管理操作）
- **数据**：实时数据（区域表 + 端口网格着色）、历史分析（快照流/区域趋势/单桩趋势/CSV 导出）、
  数据质量（6 项体检 + 一键清理幽灵端口）、数据浏览器（只读 SQL：单条 SELECT + 关键字黑名单 +
  强制 LIMIT + 审计）
- **运维**：令牌池（健康卡 + 倒计时 + 清过期 + 空态引导）、上传设备（审批/拉黑/软删/详情时间线）、
  桩与区域（端口网格 + 改坐标 + 重复检测合并 + 单桩同步）、节点网络（拓扑数据 + 白名单增删热更新 +
  信任策略三态 + 互校可信度）、任务调度、运行日志（pino 环形缓冲 2000 条）、配置中心（运行时设置 +
  脱敏 env + 变更历史）
- **系统**：系统信息、版本发布（写触发文件，后台不持 docker 权限）、备份恢复（VACUUM INTO 在线快照，
  保 10 份，恢复需输 RESTORE + 先自动备份）、账号权限
- **设备审批开关**：`device_auto_approve`（默认开）；关闭后新设备注册为 pending，上传 403，
  需管理员在后台审批
- **白名单本地覆盖层**：生效 = dedupe(GitHub nodes.json ∪ app_settings.p2p_extra_peers)，
  按 peerId 去重、本地字段优先；改完热更新不重启

### 新增：跨节点数据互校（P2P 防污染）
- 收到其他节点快照时与本节点「同时段」数据比对：空闲率差 + 故障差加权，超阈值按模式丢弃/标记/放行
- 三档：`strict`（默认，丢弃）/ `warn`（落库标 `_suspect`）/ `off`
- 无基准、可比区域不足、时钟差 >24h、校验自身异常 → 一律采纳（不让新节点断粮、不掐断数据流）
- 判定记录进 `p2p_validation`，后台可看每个节点的可信度

### 修复
- **logger 环形缓冲存 req 对象导致 `/admin/api/logs` 循环引用 500**（实测），改 sanitize 压浅层值
- 概览趋势柱色过浅、侧边栏版本号未取

### 数据库
- 新表：`admin_audit` / `alert_state` / `config_history` / `p2p_validation` / `traffic_minute`
- 补列：`admin_users.role/must_change/last_login_*`、`areas.deleted_at`、`devices.deleted_at`
- 新索引：`idx_snapshots_captured`

### 修复（三轮全仓库审查，共 120+ 项）

**后端（8 严重 + 20 中等 + 12 轻微）**
- **S1** 公开 `/api/now` 每次 0.19–0.49s 全程阻塞事件循环、无缓存无限流（实测 5ms 定时器
  216ms 内 0 次触发）→ 60s 缓存 + 按 IP 限流
- **S2** `/api/snapshot` 无「设备↔桩」归属校验 → 任意自注册设备可把别人的满桩刷成「空闲」
  （实测 free=16）→ 加 `controllers.owner_device`，跨设备改写被拒
- **S3** viewer 能读 `admin_users.pass_hash` / 下载整库备份 / 删令牌池且无审计 → 改 super/ops + 审计
- **S4** 未验签的 `X-Device-Id` 能把任意设备打黑（持久 DoS）→ `bad_sig`/`bad_ts` 只按 IP 计数
- **S5** 软删设备可无损复活且后台看不见 → 重新注册清 `deleted_at`
- **S6** 错误处理器注册晚于路由 → 异常吐 SQLite 表名 → 移到第一个 register 之前
- **S7** `duplicates` 同步 O(n²) 可打挂整站（2000 区域实测 6.8s）→ 超 300 区域拒绝
- **S8** `db/query` 无行数上限（实测 200k 行 / 453MB RSS）→ 强制截断 5000 + 敏感表拦截
- M1 上传路径无摘要去重（App 重试会落重复快照）→ 加 `snapshotDigest` 30 分钟窗口
- M2 软删区域对公开接口无效 → 查询加 `deleted_at` 过滤
- M3 webui 的 `POST /api/refresh` 在 Node 版不存在（404）→ 补路由
- M4 后台「锁版本/回滚到 tag」写的 `update.request` 没人读 → update-node.sh 消费它
- M5/M10/M11/M12/M14 同步查询、无界增长、全站共享限流桶、已成功区域被塞回失败集
- M6/M7/M8/M9 P2P：ingest 校验形状 + 本地重算摘要、白名单降级链、越权不一致
- L1 删 12 个死配置常量；L2 worker 间隔接线；L10 端口上限 32→64；L11 peerMeta 清扫；
  L12 tokenPoolStats 改 SQL 聚合；L5 登录 Origin 精确比较

**管理后台前端（5 严重 + 13 中等 + 4 轻微）**
- **S1** 实时数据页整页文字对比度 1.1:1（`.live` 被 legacy CSS 污染成浅绿）→ 根类改名 + 显式补色
- **S2** 401 永不换屏，会话过期后外壳卡死 → 全局 `admin-auth-expired` 事件回登录页
- **S3** 设备拉黑零确认 → confirm
- **S4** 角色门控只做了 3 个菜单，写按钮对 viewer 全开 → `useRole()` + 全页面门控
- **S5** 令牌池清空无确认、失败无提示 → confirm + catch + 页头错误
- M1/M2 概览首屏 3 接口各请求两次、图表永不刷新
- M3/M4 实时页搜索每键一发、抽屉竞态
- M5/M6/M7 加载更多丢筛选、无忙锁、末页仍可点
- M10 上传审计 tab 硬编码文案不渲染数据 → 真表格
- M18 坐标非法静默写 (0,0) → Number.isFinite + 范围校验
- M29 无 keep-alive（切 tab 状态全丢）→ 动态组件 + KeepAlive（CDP 实测状态保留）
- M30/M31 可访问性（dialog 语义/aria-current/符号区分）+ ≤600px 响应式
- 删 18 个死代码文件（git 历史可回滚）+ 清理 admin.css 污染规则

**Android（4 严重 + 13 中等 + 10 轻微）**
- **S1** versionCode 双轨制：本地 215 / CI 1011039（相差 5000 倍）→ 统一公式 + 漂移断言
- **S2** 刷新失败重复发 `__onRefreshDone`，假原因覆盖真原因
- **S3** APK 下载白名单挂在使用可被改写的 `base()` → 改常量（官方域名 + GitHub Release）
- **S4** `usesCleartextTraffic="true"` 全局放行（JWT/device_secret 明文上路）→ networkSecurityConfig
- M1 桥超时 8-20s 短于原生最坏 20-23s → 统一到 +3s 余量
- M2 历史失败被吞成空数组 → ok:false 抛错
- M4 corrupt 不清；M5 Keystore 解密失败可辨识；M6 mDNS 不可达 + 无 stop；
  M7 OverviewCache 原子；M8 Updater 线程池拒绝；M9 assets/www 取消跟踪；
  M10 CI 补 Android job；M11 app.js 全局错误兜底；M12 桥回调清理；M13/M14 view 层修复

## [v2.3.8] - 2026-11-08

按「轻微级问题也要修、攒批而不反复发版」的约定，本版累积了四轮审查修复 + 一个新开关。

### 新增：非白名单节点信任开关 + 后台管理预留

- 新增 `P2P_TRUST_NON_WHITELIST`（默认 `false`）：控制**是否采纳非白名单节点的数据**。
  默认丢弃（只信 `nodes.json` 里的节点）；设 `true` 后任何能连上来的节点数据都接受。
  连接层本来就不拦——非白名单节点在任何配置下都能加入 P2P、能被状态页看到。
- `/status` 的 `peers.nodes[]` 新增 `whitelisted` 字段，并暴露当前 `trust_non_whitelist` 策略；
  状态页给非白名单节点打「未受信」标签，仍可手动切换
- App 的 **mDNS 发现的局域网节点不再自动切换**（自动切换只走 GitHub 目录 = 白名单），
  只记日志；用户仍可在状态页手动点过去
- 预留节点后台管理：`GET /admin/api/p2p`（只读，P2P 策略 + 节点概览）；
  `PATCH /admin/api/p2p/policy` 在管理员登录落地前固定返回 503，不会误开权限

### 修复（第三轮复审发现）

批量修复后又做了一轮「只审修复本身」的复审，抓到并修掉：

- `bodyLimit` 若正好等于 `MAX_BODY`，Fastify 会在进 handler 前拦掉超限请求并回
  `{"error":"internal_error"}`，反而破坏契约 → 改为 `MAX_BODY + 1024`，
  让 upload 分支自己返回规范的 `{ok:false,error:'请求体大小非法'}`
- `startWorker` 的停止函数原来只跟踪「第一轮」，`stop()` 等不到后续轮次
  （实测在途时 0ms 返回、之后仍在写库）；改为跟踪当前轮 + 最多等 5 秒
  （避免一轮几百个桩时关不掉容器）
- 端口清理改成「本次端口数 ≥ 库里已有数才清」后，若上游长期只返回部分端口，
  真下线的端口会永久残留（公开页空位数偏大）→ 补一条按 `updated_at`
  的 24 小时兜底清理
- `tokenCoverText` 双重时间转换（`tsText(fmtExp(at))`）导致「覆盖到 …」恒为空
  ——这是批量修复时我自己引入的回归，已改为 `tsText(at)`
- `corrupt` 标记原来只在 `StateBuilder` 里写、前端无人读、且文案数据源是
  `SecureState.settingsJson()`，属于死字段 → 在 `SecureState` 也写入并在
  `loadTokenState()` 里消费（令牌解析失败显示「已失效」而不是「从未设置」）
- `mergeInto` 改用 `isOnline()`（与 `server_online` 同判据）：原来 40s 的独立
  TTL 会让「挂后台再回前台」时健康条闪一次「本地令牌 / 最后更新 —」
- 私钥长度下限 60 → 100（Ed25519 protobuf 实际 136 hex，60 会放过 30 字节的无效值）
- `NODE_P2P_ADDR` 拼接地址时补 `/p2p/` 与尾斜杠保护（与白名单解析规则一致）
- 心跳的 `p2p` 地址保留上一次已知值（对方某次不广播时不清空）
- nonce 格式非法时只按 IP 计数（`device_id` 来自未验签的头，
  按 device 记会让人用垃圾 nonce 打掉别人的设备）
- 坏 JSON / payload 校验失败的日志由 warn 降为 debug（限流可被绕过，warn 会被刷爆）
- 首次上传区域数上限 200 → 500（与 `validatePayload` 对齐，避免真实区数 >200
  的全新节点永远无法引导）

### 修复（37 项轻微级）

**server**
- `/status` 的 `db_size` 计入 `-wal`/`-shm`（WAL 下原来严重低估）
- 上传：nonce 格式非法也计入 `bad_sig`（原来不计数，可无限试探）
- 上传：JSON / payload 校验失败记日志并返回具体原因（原来静默 400）
- `/api/version` 去掉 UTF-8 BOM（App 侧 `new JSONObject` 遇 BOM 会一直失败，
  表现是「检查更新永远失败」而服务器看着正常）
- `crypto.tokenKey`：错误信息给出期望长度；密钥目录改用 `path.dirname`
  （文件名不含分隔符时原实现会把目录算错）
- `p2p.loadOrCreateKey` 校验 hex 格式（截断/空文件原来直接抛错 → 触发整站 P2P 降级）
- `p2p`：`addresses` 优先用 `NODE_P2P_ADDR`；心跳里的 `p2p` 地址存入 `peerMeta`，
  `/status` 的 `nodes[].addr` 不再恒为 null
- worker 端口清理只在「本次端口数 ≥ 库里已有数」时执行
  （上游偶尔只返回部分端口，无条件 `NOT IN` 会把有效端口删掉）
- `startWorker` 的停止函数改为返回 Promise，等正在跑的一轮结束再关库
- `/api/pile/*` 去掉二次 `decodeURIComponent`（Fastify 已解码）
- `schema_migrations.applied_at` 改用本地时间（原来混用 UTC 与其他表的本地时间）
- `bodyLimit` 对齐 `MAX_BODY`（原来 8MB，超限时返回 Fastify 默认错误体，破坏契约）
- 首次上传（areas 表为空）限制单次最多 200 个区名（防一次请求灌入大量伪造数据）

**webui**
- 状态页：长效令牌兼容布尔/数字；节点无地址时给出提示；切换节点后等 4 秒再刷新
  （覆盖最长 6 秒的健康探测）
- 统计条 idle/charging/fault 加 `Number()` 兜底（概览缺字段时不再显示 NaN）
- 健康条「覆盖到」显示完整时间（跨天时不再看不出是哪天）
- 分析页：请求序号过期时返回 null 且不覆盖已有数据（原来会闪成「暂无数据」）
- `transport.callBridgeJSON` 结束时清理 `window[cbKey]`（并发场景只删自己那个）
- 删掉 App.vue 的 `uploadTokenOn` 死状态
- `index.html` 补 `theme-color`（网页端工具栏跟随深浅色）

**android**
- `RefreshService.postProgress` 用 `JSONObject.quote` 转义（文案含引号会让整条 JS 语法错误）
- `StateBuilder`：token 解析失败时标 `corrupt`（原来误显示「尚未设置令牌」）
- `OverviewCache` 改用不可变 `Snapshot`（json 与时间戳原子读写），
  `MERGE_TTL_MS` 120s → 40s（服务器掉线后健康条少显示 80 秒旧状态）
- `navAmap` / `Updater.download` 补 `isGone()` 判断
- `StatusBarTheme` / `MainActivity` 补前瞻注释（targetSdk 35、新增 requestCode）

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

## 计划（未排期）

> 与顶部「## [未发布]」不同：这里放方向性的长期想法，不是待发版内容。

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
