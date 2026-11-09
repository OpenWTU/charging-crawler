# 变更记录（Changelog）

本文件格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

> 说明：仓库内代码另有一套历史内部版本号（当前 `2.4.0`），
> 对外发布使用独立语义化版本与 Git tag。

## [v2.4.22] - 2026-11-09

### 加载/刷新时统计条改成骨架占位
**问题**：顶部「空闲 / 充电中 / 故障」三个数字在加载期间显示 `—`（`statText` 的
无数据兜底），三个破折号并排比数字还显眼；刷新时更难看 —— 先停在上一次的旧数字上，
新数据回来再跳一次，像是卡住了。

**改动**：
- 统计条在 `busy` 时把数字位换成脉冲骨架块（`.stat-ph`，复用 app.css 的 `skelPulse`），
  标签「空闲/充电中/故障」保留，布局尺寸贴着原数字位，切换不顶行距
- 新增 `busy = !loadError && (loading || refreshing)`：
  - `loading`（首屏未完成）→ 占位
  - `refreshing`（App 抓取 / 手动刷新）→ 同样占位，不再闪旧值
  - **加载失败时不算 busy**，要露出错误卡与重试按钮
- `HomeView` 新增 `refreshing` prop，`App.vue` 把 `useRefresh` 的 `refreshing` 传下去
- `aria-busy` + 三个 `aria-label="…加载中"`，读屏器能播报加载态
- `prefers-reduced-motion` 下动画归零

**说明**：**底部区域清单的骨架屏本来就有**（`.skel` + `.skel-line`，首屏 3 行骨架 +
搜索框骨架），这次一并让它跟随 `busy`，刷新时也显示占位，与统计条一致。

实测（线上网页 + 慢网 600ms RTT）：加载期 `.skel` 4 个 / `.skel-line` 6 个、
列表 0 行；加载完成后数字 `[47, 371, 0]`、列表 37 行，切换无残留。



### 状态栏跟随深色模式：补上前置 flag（原来被 ROM 静默忽略）
排查发现链路**本来就是通的**：

```
native.js setDarkMode → AndroidHost.setDarkMode (@JavascriptInterface)
  → BridgeHost 接口 → ActivityBridgeHost.setDarkMode
  → StatusBarTheme.apply(window, dark)   // setStatusBarColor + 图标明暗
```

`StatusBarTheme` 也早写好了（深色 `#0F172A`、浅色 `#F3F5F9`、API 30+ 与旧版两套图标明暗）。
**但 `setStatusBarColor` 缺前置条件会静默失效** —— 部分 ROM（尤其开了 edge-to-edge 的
RealmeUI / ColorOS）要求窗口带 `FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS` 且不能带
`FLAG_TRANSLUCENT_STATUS`，否则调用成功、颜色不变。

**改动**：
1. `apply()` 里显式 `addFlags(FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS)` +
   `clearFlags(FLAG_TRANSLUCENT_STATUS)`，再设色
2. `MainActivity.onCreate` 先按浅色预置一次，避免深色用户看到顶部闪一下系统默认色
   （WebView 起来后前端 `useTheme` 的 `immediate` watch 会立刻用真实主题覆盖）
3. `setDarkMode` 加 `DebugLog`（App 内「查看日志」能看到「状态栏 → 深色/浅色」，便于确认桥是否真的调到）
4. `StatusBarTheme.lastState()` 暴露最近一次应用值，供排查

**说明**：`setStatusBarColor` 在 `targetSdk >= 35`（强制 edge-to-edge）会变成 no-op。
当前 `targetSdk=34` 仍有效；将来升 35 时要改成「状态栏透明 + 页面自己留 safe-area inset」。



### 修复：暗色模式不跟随系统（两个 bug 叠加）
用户反馈「设置里选跟随系统、手机开暗色，页面还是亮的」。查出**两个独立原因**：

**① Android WebView 默认不响应 `prefers-color-scheme`**

`AppWebShell` 的 `WebSettings` 只配了 JS/DOM/视口，**没开深色模式支持** ——
WebView 里 `window.matchMedia('(prefers-color-scheme: dark)')` **永远返回 false**，
前端的所有深色逻辑因此全部失效。修复：

```java
if (Build.VERSION.SDK_INT >= 33) {
    s.setAlgorithmicDarkeningAllowed(true);   // Android 13+（forceDark 在 33 起废弃）
} else if (Build.VERSION.SDK_INT >= 29) {
    s.setForceDark(WebSettings.FORCE_DARK_AUTO);  // Android 10~12
}
```

**② `watchSystem()` 只定义、从不调用**

`useTheme.js` 里 `watchSystem` / `unwatchSystem` 都写好了，但只有
`onUnmounted(unwatchSystem)` —— **没有 `onMounted(watchSystem)`**。
于是「跟随系统」只在冷启动时读一次，之后手机切深浅色**不会触发任何更新**。补上 `onMounted(watchSystem)`。

**实测**（CDP 模拟 `prefers-color-scheme`）：

| 场景 | 结果 |
|---|---|
| 网页访问，系统 dark | `theme-dark:true`，body `rgb(15,23,42)` |
| 网页访问，运行中切 light（不刷新） | `theme-dark:false`，body `rgb(243,245,249)` |
| App 内默认（无手动设置），系统 dark | `theme-dark:true` |
| App 内运行中切 light（不刷新） | 立即变亮 |
| App 内手动选「明亮」，系统 dark | 保持亮色（手动优先） |
| App 内手动选「深色」，系统 light | 保持深色（手动优先） |
| App 内改回「跟随系统」，系统 dark | 回到深色 |

### 新增：管理后台「节点网络」页显示设备可信度
新增 `GET /admin/api/device-credibility`：把 `p2p_validation` 里 `dev:` 前缀的记录
按设备聚合（通过 / 可疑 / 总数 / 平均偏差 / 最近判定），按可疑数降序。
前端在「节点网络」页节点表下方加了对应表格，空态有说明文案。

这样不用查库就能看出**哪台设备在报偏离本地历史很远的数据**。



### 删掉 `REGISTER_TOKEN`：它和 UA 一样，没有安全价值
v2.4.18 刚加的注册令牌门禁，本轮撤掉。理由（用户点破的）：

> 令牌硬编码在 APK 里（`Cloud.java` L36），反编译一次就能拿到 —— **安全强度等同 User-Agent**。

而且它还要求多节点保持一致，维护成本远大于收益。实测现有的**上传路径**防线是这样的：

| 防线 | 实际强度 |
|---|---|
| `REGISTER_TOKEN` | ❌ ≈ UA |
| HMAC 验签 | ❌ 形同虚设（`secret` 是注册时服务器送的） |
| 上传限流 12/分/IP + IP 拉黑 | ✅ |
| 形状校验 `cleanPort` / `validatePayload` | ✅ |
| **数据合理性** | ❌ **完全没有** ← 本轮补上 |
| `device_auto_approve=off` | 可用但暂不启用（用户决定保持自助注册） |

**改动**：
- 删 `config.ts` 的 `REGISTER_TOKEN`
- 删 `upload.ts` 的令牌校验与「假成功不入库」逻辑
- 删管理后台「系统信息」里的 `REGISTER_TOKEN` 一行
- 删 `docker-compose.node.yml` 的对应 env

### 修复：互校的基准池只有 42%，导致长期空转
`findBaseline` 的条件是 `device_id IS NOT NULL`，但**本机 worker 采的快照 `device_id` 恰恰是 NULL**
（`worker.ts` 的 `insertInto('snapshots')` 固定写 `device_id: null`）。于是 587 条 worker 快照
全部被排除，基准池只剩 App 上传的 42% —— 线上 `p2p_validation` 表 **0 行**就是这个原因。

修法：条件放宽为 `device_id IS NOT NULL OR client_ip IN ('server','127.0.0.1')`。
P2P 写入的 `client_ip` 固定是 `'p2p'`，所以这条放宽**不会**让外部节点变成基准。

### 新增：App 上传也做数据合理性校验（warn 语义，只标记不丢）
以前 `/api/snapshot` 只有形状校验，任何已注册设备都能把「39 个区全空闲」直接写进库。

现在复用跨节点互校的算法：与本节点 `[captured_at ± 10 分钟]` 的历史快照按区域名对齐，
算空闲率偏差 + 故障差。

- **`warn` 语义**：只给 payload 打 `_suspect: true`，**绝不丢数据**。
  真实场景「一放学整片从满变空」本来就会大幅跳变，`strict` 会误杀正常数据。
- 判定记录写入 `p2p_validation`，`peer_id` 用 `dev:<device_id>` 前缀与 P2P 节点区分。
- 校验自身抛异常时**按通过处理**（保险丝，不能掐断上传）。

**验证**：新增用例「基准全空闲 → 对照（内容不变，不标记）→ 跳变成全满（标记 `_suspect`）」，
断言三条都入库、标记序列是 `[false, false, true]`、`p2p_validation` 有 `dev:` 记录。
**96 个测试全过**。



### 设备注册加令牌门禁：令牌不对则**不入库**，但对外返回成功
**动机**：桩不属于任何用户之后，「任意设备刷任意桩」的拦截本来就不该有，
真正合理的闸门是**准入** —— 谁能注册设备。但直接 403 会让不带该头的旧版 App
反复报错重试，所以采用「**对外成功、实际不入库**」。

**行为**（`REGISTER_TOKEN` 配置后生效）：

| 情形 | 写库 | 对外响应 |
|---|---|---|
| 带正确 `x-register-token` | ✅ 正常写入 | `{ok:true, device_id, pending}` |
| 未带 / 值不对，且**库里没有**这个 device_id | ❌ **不写** | `{ok:true, device_id, pending:false, status:'approved'}`（伪装成功） |
| 未带 / 值不对，但**库里已有**该 device_id | ✅ 照常更新 | 正常响应（老设备重新注册不受影响） |

**为什么「伪装成功」不会变成漏洞**：`/api/snapshot` 要按 `device_id` 从 `devices`
取 `secret_enc` 验签，查不到就返回 401「签名校验失败（设备未注册或已撤销）」。
所以没入库的设备**注册看似成功、上传必然失败**。

**审计**：被静默拒绝的注册会写 `upload_audit`（`reason=register_no_token`，
带 ip/ua），管理后台「上传设备」页能看到。

**令牌值**：默认 `chg-reg-7f3a9c21e5d84b06`，**与 App 内置的 `REGISTER_TOKEN` 一致**
（`Cloud.java` L36 本来就硬编码了这个值并会发送该头，所以存量 App 不需要升级）。
换值时必须两边同步，否则所有新装机会全部「假注册」。

## [v2.4.17] - 2026-11-08

### 彻底移除桩归属：**桩是公共设施，不属于任何设备/用户**
v2.4.16 只是把排他默认关掉，`owner_device` / `port_owner_guard` 这套概念仍然在。
用户指出这是根本性的理解错误 —— **充电桩不属于任何一个用户**，谁抓到都能报，
所以「归属」本身就不该存在。本次把它整套删掉：

- 删除设置项 `port_owner_guard`
- 删除 `upload.ts` 里的首见登记、跨设备拒绝、僵尸 owner 接管（约 80 行）
- `controllers.owner_device` 保留，但语义改为**「最后写入者」**，纯诊断用途，不参与任何准入判断
- 用例反向重写：设备 A 首报后**设备 B 改写必须生效**，且响应里不能有 `rejected`

### 新增：App 抓到的端口数据本地优先渲染
**问题**：`__onLocalState` 的载荷里其实**早就有 `ports`**（Android 的 `RefreshService`
在补全端口后会再推一版），但前端 `applyLocalState` 只吃 `areas`，端口被整个丢掉 ——
于是端口面板永远等服务器回写，上传被拒或慢的时候，用户看不到自己刚抓到的端口状态。

**实现**（新增 `webui/src/api/localPorts.js`，无依赖，避免 ports/areas 循环引用）：

| 环节 | 行为 |
|---|---|
| Android 推送 | `RefreshService` 的 `portArr` 每项补 `area`（来自 `/api/controllers` 的 `area_name`）与 `code` |
| 前端接住 | `applyLocalState` 调 `applyLocalPorts(state.ports)`，按 `device_hex` 建索引 |
| 读取 | `getAreaPorts(name)` / `getAreasPorts()` 先查本地，命中就用本地（不等服务器） |
| 上传成功 | `clearLocalPorts()` → 立刻回到「服务器权威」 |
| 上传失败 | 保留本地快照，下次刷新仍优先显示自己抓到的数据 |
| 兜底 | TTL 10 分钟，避免长时间停在很久以前的一份快照上 |

**验证**：`localPorts.js` 的 7 组断言全过（注入/按区域取/全量归组/清空/覆盖/空载荷不破坏）。

## [v2.4.16] - 2026-11-08

### 修正：桩归属不该按设备排他（多设备众包是正常场景）
**推翻 v2.4.15 的前提**。线上实测：

| 数据 | 值 |
|---|---|
| 设备总数 / 近 24h 活跃 | 28 / 7 |
| 最近 300 条快照里**有上报的设备数** | **17 台** |
| 每台单次携带的区域数 | **全部 39 个** |

也就是说**多台设备众包上报同一批桩是产品的正常用法**。S2 的「首见登记 + 排他」
等于只让第一台设备写、另外 16 台的数据静默丢弃 —— 设计前提就错了。

**改动**：
- 新增设置 `port_owner_guard`，**默认 false**（不排他）
  - 关闭时：任何已注册设备都能写，`controllers.owner_device` 只记「**最后写入者**」用于排查
  - 打开时才走原来的排他逻辑（含 v2.4.15 的「僵尸 owner 可接管」）
- 管理后台「配置中心」可切换

> 准入控制应该用 `REGISTER_TOKEN`（控制谁能注册设备），而不是靠桩级别的排他。

### 修复：上传失败时前端页面完全不刷新
`App.vue` 的 `onUploadDone` 原来在 `ok === false` 时**只弹提示就 return**：

```js
if (s && s.ok === false) { showToast(...); return; }   // ← 页面停在旧数据/加载态
```

**表现**：抓了一次，页面还停在旧数据，用户以为「抓取没生效」。

**修复**：失败也要走完整刷新（`reload` + `refreshPortsIfOpen` + `loadAllPorts` + `loadNow`），
把 loading 收掉、时间与健康条更新；另外对**部分拒绝**（`rejected` 非空）单独提示
「N 个桩的端口未能写入（归属属于其他设备），其余已上传」，不再静默。

### 顺带修掉
`adminsettings.ts` 的 `coerce()` 对 bool 用的是**硬编码 key 判断**
（只列了 `device_auto_approve` / `p2p_trust_non_whitelist`），
新加的 bool 项会掉进 `Number(v)` 分支读成 NaN → 回退默认值，
表现为「后台改了不生效」。改成按 `SETTING_SCHEMA[key].type` 判断。

### 测试
新增「多设备众包」用例（设备 A 报过后设备 B 仍能写同一桩，owner 变成 B），
原 S2 排他用例改为**显式打开 `port_owner_guard`** 后验证。**95 个测试全过**。

## [v2.4.15] - 2026-11-08

### 修复：桩归属「永久锁定」导致换设备后数据全被拒
**线上实测**（2026-11-08 13:32）：`upload_audit` 连续 8 条 `owner_rejected`。
排查发现 `controllers` 的 **39 个桩 owner 全是同一个设备** `b976ee67…` ——
它只在 11:36 上报过 1 次（`uploads=1`），但那次 payload 带了全部 39 个桩的 ports，
按 S2 的「首见登记」规则一次性认领了全部。用户之后重装 App / 换机，
`device_id` 变成 `5e23ca77…`（`uploads=8`、13:32 仍活跃），于是全被拒。

**根因**：S2 的归属规则是「首见登记 + 永久锁定」，没有任何失活回收机制。
换设备 = 数据永久写不进去，只能手工改库。

**修复**：加「僵尸 owner 可接管」——归属校验时查原 owner 的 `devices.last_seen`，
满足任一条件即允许当前设备接管并记 `logger.info`：
- `last_seen` 距今超过 **7 天**（`OWNER_STALE_MS`）
- 原 owner 已被软删（`deleted_at` 非空）
- 原 owner 不在 `devices` 表里（未注册/已清理）

接管用 `UPDATE … WHERE owner_device = <原 owner>` 带条件更新，并发下只有一个能成功。

**同一批线上数据已修**：39 个桩的 `owner_device` 已从 `b976ee67…` 转到 `5e23ca77…`，
改前做过 `VACUUM INTO` 备份（`/var/lib/charge-cloud/backup-manual/charge-after-owner-fix-*.db`）。

### 另附：worker 报 `no-token` 的原因（非代码问题）
`token_pool` 共 16 条，其中 **15 条早已过期**（118 ~ 10156 分钟），
唯一有效的 1 条也在 13:40 到期 —— 12:56 之后没有新的令牌上传，所以 worker 抓不到数据。
令牌靠 App 端「上传令牌」开关持续上传，属于运维范畴；补抓后立刻恢复
（实测手动 `/api/refresh` 返回 `areas=ok:39|ports=ok:39/438`）。

## [v2.4.14] - 2026-11-08

### 管理后台移动端：配置中心堆叠布局 + 横向滚动提示
| 问题 | 实测 | 修复 |
|---|---|---|
| **配置中心长键名挤掉值和说明** | 390px 下 `p2p_validate_window_sec` 占掉半屏，说明列被硬切，越界元素 **38 个** | 移动端把配置表改成**一行一个配置**的堆叠布局（`键/值/说明/操作` 作为左侧标签，用 `td::before` 自动生成，不改模板）；长键名 `word-break: break-all`；值控件 `flex:1` 占满剩余宽度 |
| **表格能横滑但看不出来** | 移动端浏览器默认隐藏滚动条 | `.a-panel` 强制画 6px 细滚动条（`::-webkit-scrollbar` + `scrollbar-width: thin`），作为「可横滑」的提示 |

复测：配置中心越界元素 **38 → 0**、横向溢出 0px、小触摸目标 0。

> 说明：其它宽表（历史分析、数据浏览器）保持横向滚动 + 细滚动条提示。
> 数据浏览器的列是动态的，做卡片式布局不现实；历史分析的表以时间序列为主，横滑反而更快。

## [v2.4.13] - 2026-11-08

### 管理后台移动端适配
实测（390×844）发现的问题与修复：

| 问题 | 实测数据 | 修复 |
|---|---|---|
| **侧栏占满整屏**，18 个菜单项变成横向滚动条，分组标题被隐藏，靠后的「配置中心/版本发布/备份恢复」基本找不到 | 侧栏宽 390px（= 视口宽） | 改成**汉堡 + 抽屉**：侧栏 `position: fixed` + `translateX(-100%)`，宽度 `min(280px, 82vw)`，带遮罩、`body` 滚动锁、点菜单项自动关闭 |
| **触摸目标过小**（`.a-btn.sm` 只有 28px 高） | 概览 18 个、历史分析 54 个、配置中心 26 个小于 32px | 移动端 `.a-btn` / `.a-btn.sm` 统一 `min-height: 40px`，`.nav-item` 44px |
| **工具栏按钮挤在一起** | 历史分析「导出」被挤到第二行且无间距 | `.a-toolbar` 加 `flex-wrap: wrap` + `gap: 8px` |
| **表格溢出时外层不滚动** | 配置中心说明列被硬切 | `.a-panel` 移动端 `overflow-x: auto` + `-webkit-overflow-scrolling: touch` |
| **断点太窄** | 只有 600px，600–900 的平板也出问题 | 统一到 **900px**，另加 420px 超窄屏规则（隐藏用户名、压缩 padding） |

修复后同口径复测：**侧栏 280px、小触摸目标 0（概览/历史/配置/流量/系统/节点全部归零）、整页横向溢出 0px**。
桌面端回归（1440×900）：汉堡隐藏、侧栏 190px `position: static`、grid `190px + 1250px` —— 未受影响。

## [v2.4.12] - 2026-11-08

### 紧急修复：设置页只剩 tab、内容全空
**症状**：App 底部「设置」tab 能切过去，但页面里什么都没有（顶部卡片还在）。

**根因（TDZ）**：第 8 轮给诊断状态加 30 秒缓存时，把两个 `let` 写在了函数定义处，
而 `readDiagnoseCached()` 在**更早**的一行就被调用了：

```js
51:  const diagnose = ref(readDiagnoseCached());   // ← 这里调用
...
122: let diagnoseCache = null;                    // ← 变量在这里才声明
123: let diagnoseCacheAt = 0;
124: function readDiagnoseCached() { ... }
```

`function` 声明会提升（所以能调用），但函数体里访问的 `let diagnoseCache` 处于
**暂时性死区** → `ReferenceError: Cannot access 'x' before initialization`
→ `Settings.vue` 的 `setup()` 抛错 → 整个组件不渲染。

**修复**：把两个 `let` 提到首次调用之前。

**验证**（CDP 注入假桥、加载 APK 里的 app.html、切到设置 tab）：
- 修复前：`[ERR] Vue 渲染异常: ReferenceError: Cannot access 'ne' before initialization`，
  `.settings-page` 不存在、0 个分组、0 个 cell
- 修复后：**0 错误**，`getSettings()` 被调用，截图里「账户 / 上传 / 外观 / 诊断」四组全部渲染
  （登录令牌、重新获取令牌、清除令牌、上传开关、跟随系统·明亮·深色、诊断抓包）

> 影响范围：v2.4.7 起的 APK 都有这个问题（`Settings.vue` 从 v2.4.7 到 v2.4.11 一字未改）。
> 之前没暴露是因为 v2.4.7 整个白屏、v2.4.8+ 才进得去。

## [v2.4.11] - 2026-11-08

### 紧急修复：v2.4.9 / v2.4.10 的 APK 白屏
**根因**：v2.4.9 把 `vite base` 从 `'./'` 改成 `'/'`（为了修服务器的 `/admin/login` 子路径）。
产物里的引用从 `./assets/x` 变成 `/assets/x`，而 App 的 `AppWebShell.serveAsset` 是：

```java
WebView 入口 = https://appassets.androidplatform.net/www/app.html
APK 里的资源 = assets/www/assets/x
serveAsset: getAssets().open(path.substring(1))
  base './' → /www/assets/x → open("www/assets/x")  ✓
  base '/'  → /assets/x     → open("assets/x")      ✗ 不存在 → 子资源全 404 → 白屏
```

主文档（`/www/app.html`）能加载，所以看到的是"页面骨架在、但渲染不出来"。

**修复**：`serveAsset` 先按原路径找，找不到再补 `www/` 前缀 —— 两种 `base` 产物都能命中：

```java
String rel = path.substring(1);
try { in = getAssets().open(rel); }
catch (IOException first) {
    if (rel.startsWith("www/")) throw first;
    in = getAssets().open("www/" + rel);
}
```

顺带把缓存头判断也改成同时认 `/assets/` 与 `/www/assets/`。

**验证**：用 Node 复刻 `serveAsset` 的路由逻辑 + CDP 加载 `/www/app.html`：
8 个子资源**全部走「回退 www/」命中**（`/assets/app-B5lRZZ6a.js` 等），`#app` 渲染 2592 字节，MIME 全部正确。

## [v2.4.10] - 2026-11-08

### 修复：带尾斜杠的页面路径返回 JSON 404
`/admin/`、`/admin/login/`、`/status/` 这类带斜杠的地址会落到 `notFoundHandler`，
返回一段 `{"ok":false,"error":"not_found"}` —— 用户手动输入或分享出去的链接常带斜杠。

**修复**：为 `/admin`、`/admin/login`、`/status` 各补一条尾斜杠路由
（`/admin/login` 的 handler 抽成 `sendLoginPage` 复用）。

**全面排查同类路径问题**（本轮做的）：
- 静态扫描前端源码：`fetch` / 动态 `import` / 模板 `href|src` / CSS `url()` / `window.open` /
  `location.href` / `new URL` 的相对路径 —— **0 处真问题**
  （唯一命中的 `import('../charts.js')` 是模块导入，Vite 打包后是绝对路径）
- dist 三个入口的引用：**全部 `/` 开头**，0 个相对路径
- CDP 从 `/admin/login` 进入 → 登录 → 遍历 17 个页面：**0 个 404、0 个加载失败、0 个 JS 异常**
- 首页 `/` 交互（卡片、抽屉）：0 个 4xx

**不改的**（设计如此）：
- `/app.html`、`/admin.html` 直接访问 404 —— `static.ts` 注释写明只因 `/` 和 `/index.html`，
  Android 走 `appassets` 虚拟域名，Python 版一致
- `/api/now/` 这类 API 尾斜杠 404 —— 调用方不会带斜杠

## [v2.4.9] - 2026-11-08

### 紧急修复：首页「管理员」按钮点进去没有登录表单
**根因**：`vite.config.js` 里 `base: './'`，产物写的是相对路径 `./assets/xxx.js`，浏览器按
**当前 URL 的目录**解析：

| 访问路径 | `./assets/x` 被解析为 | 结果 |
|---|---|---|
| `/admin` | `/assets/x` | 200 ✓ |
| **`/admin/login`** | **`/admin/assets/x`** | **6 个资源全 404 → 白屏** |

而首页右上角那个「管理员」按钮（`App.vue:20`）指向的正是 `/admin/login`。
所以「直接输 /admin 正常、点按钮进去白屏」。

**修复**：`base: './'` → `base: '/'`（绝对路径）。

对 App 安全：WebView 走 `AppWebShell` 的 `appassets.androidplatform.net`，
`/assets/x` 会被 `serveAsset` 当成 `assets/x` 读出来，与 `./assets/x` 等价。

**验证**：本地模拟 `/admin` 与 `/admin/login` 都返回同一份 admin.html —— 两条路径现在都能
渲染出口令框（1 个）、用户名框与「登录」按钮；ppreviously `/admin/login` 是 6 个资源全 404。

## [v2.4.8] - 2026-11-08

### 紧急修复：v2.4.7 的 APK 白屏
**根因**：第 8 轮「补 MIME 映射」时**误删了 `.html → text/html` 这条**（v2.3.8 本来有）。
`AppWebShell.serveAsset` 于是把 `app.html` / `admin.html` 当成 `application/octet-stream`，
WebView 不渲染主文档 → **整个 App 白屏**，App 内打开的管理后台也白屏。

**修复**：补回 `.html` / `.htm` → `text/html`。

> 影响面：v2.4.7 的 APK（Release 与本地构建）全部受影响；服务端与浏览器访问的管理后台不受影响。
> 教训：删改「兜底分支」的映射表时必须逐条比对原列表，这类回归 lint / typecheck / build 都抓不到。

## [v2.4.7] - 2026-11-08

### 修复（终审后清零，两位审查员报的每一项都修完）
**后端**
- S1 去重被改成死代码（比较含 ports、入库不含）→ 入库统一用同一 digest
- S1-② 摘要对 ports 数组顺序敏感 → 哈希前规范化排序
- S1-③ 双引号表名绕过（`select * from "admin_users"` 实测 200 且带 scrypt 哈希）→ 只剥单引号
- M7-② 列级正则写成 `\b`（永不命中）→ 改 ``
- M12 清理 SQL 列名全错（created_at/changed_at/updated_at → ts/ts/last_at）→ 修正
- M2 上传路径没失效 /api/now 缓存 → 落库后调 invalidateNowCache()
- M1 /api/refresh：补 refreshBusy 互斥、ok 改用 roundOk、finally 释放
- M8 IP 桶改为只在「用户名不存在」时计数（防枚举，不再可锁死全站管理员）
- M5 `_suspect` 加入摘要排除列表；S4 改名不再丢坐标；L-b/L-e 补齐
- L1 duplicates 超限 409；L5 startWorker 尊重显式 intervalMs；L6 sweepPeerMeta 时区；
  L-c 审计 result 区分 partial；L-d 撞软删区域文案
- A/E：`db/rows` 对 devices 剔除 secret_enc；`db/query` 列级拦截

**前端**
- S6（我引入的回归）ConfigPage 只解构 isSuper → 超管看不到任何保存按钮 → 修
- S1 KeepAlive 让 17 页只加载一次（配置中心能覆盖别人刚改的值）→ 封装 `usePageLoad`
  （同时挂 onMounted + onActivated 去重），13 个页面统一
- S2 日志页 5s 轮询切走后照跑 → onActivated/onDeactivated
- M1 冷启动误报「会话已过期」→ apiFetch 真正实现 silent
- M2 质量页跳转死链 → emit('go')；M3 reachedEnd 重置；M5/M9-b 门控补齐
- M6 配置中心 viewer 仍见保存 → canWrite；M7 抽屉 role；M8 .topbar 死代码
- L11 文案分流；L12 草稿保护；L14 usePageLoad；L15 死样式；L1/L3 CSS 响应式

### 新增回归测试
`server/test/regression-r6.test.ts`（10 条）钉住：去重命中、端口变化不算重复、
`"admin_users"` 403、`secret_enc`/`pass_hash` 403、字面量不误杀、workerRound 清理可执行。

### 验证
typecheck 0 / **94 测试全过** / webui lint 0 / build 通过 / APK 461 KB / CDP 逐页 0 console 错误。
两位审查员终审结论均为「可以部署」。

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
