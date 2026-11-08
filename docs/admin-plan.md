# 管理后台设计（完整版）

> 使用者：你（owner）+ 协管（运维/只读）。
> 目标：**打开就知道好不好、点两下能处置、出问题查得到根因、长期能运维**。
> 本期确定：**多账号 + 口令**、**白名单 = 本地覆盖层 ∪ GitHub `nodes.json`（按 peerId 去重）**、**快照/采样硬删、区域/设备软删**。

---

## 〇、设计原则

```
第 1 层 健康态   —— 打开 3 秒判断"今天系统好不好"（概览 + 顶栏常驻新鲜度 + 告警中心）
第 2 层 下钻     —— 坏了，定位到哪一环（令牌 → worker → 上游 → 上传端 → 节点）
第 3 层 处置     —— 就地操作，不用跳来跳去（每个数据旁边就是动作）
第 4 层 可追溯   —— 谁改了什么、什么时候、改前改后（审计 + 日志 + 配置历史）
```

四条贯穿全局的硬约束：

1. **任何表格可搜索、可排序、可导出**（CSV）
2. **任何写操作有确认 + 影响预览 + 审计**（"将删除 12,345 行"）
3. **任何危险操作需要输入确认词**（`DELETE` / 账号口令）
4. **窄屏可用**（≤768px 侧边栏折叠成抽屉，表格横向滚动）

---

## 一、信息架构（15 页，四组）

```
┌──────────────────────────────────────────────────────────────────────┐
│ ◐ 充电桩后台 │ ● 数据新鲜 3 分钟前 │ ⚠ 2 │ 主节点 │ 主管理员 ▾        │
├──────────────┬───────────────────────────────────────────────────────┤
│ ▼ 监控        │                                                      │
│   概览        │                                                      │
│   告警中心 ②  │                                                      │
│   流量与限流  │                                                      │
│ ▼ 数据        │                    内容区                            │
│   实时数据    │                                                      │
│   历史分析    │                                                      │
│   数据质量 ③  │                                                      │
│   数据浏览器  │                                                      │
│ ▼ 运维        │                                                      │
│   令牌池 ②    │                                                      │
│   上传设备    │                                                      │
│   桩与区域    │                                                      │
│   节点网络    │                                                      │
│   任务与调度  │                                                      │
│   运行日志    │                                                      │
│ ▼ 系统        │                                                      │
│   配置中心    │                                                      │
│   版本发布    │                                                      │
│   备份恢复    │                                                      │
│   账号与权限  │                                                      │
│   审计        │                                                      │
│   我的        │                                                      │
└──────────────┴───────────────────────────────────────────────────────┘
```

**分组可折叠**（记忆状态）；每个菜单项右侧可挂**实时徽章**（未处理告警数、待办数、异常数）。

**顶栏 4 件全局常驻**：
| 元素 | 内容 | 点击 |
|---|---|---|
| 数据新鲜度 | 绿 `3 分钟前` / 黄 `18 分钟前` / 红 `2 小时前` | 打开「断链定位」弹层 |
| 告警铃 | 未处理告警数 | 告警中心 |
| 当前节点 | `主节点 · 在线` | 节点网络 |
| 账号菜单 | 我的 / 切换主题 / 退出 | — |

---

## 二、逐页详细设计

### 页 1 · 概览（Overview）

**目的**：3 秒内回答「今天系统好不好」，并给出下一步去处。

```
┌─ 指标卡 ×5（每张可点，带迷你火花线）──────────────────────────┐
│ 今日快照      在线设备      有效令牌      在线节点     数据延迟  │
│ 1,247 ↑12%   23/26         2/16 ⚠      1/2        3 分钟    │
│ ▁▂▃▅▆▇█      ▇▆▇▇▆▅       ▇▅▃▂▁      ▂▃▃▃▃        ▁▁▂▁▁   │
└──────────────────────────────────────────────────────────────┘
┌─ 近 24 小时（可切 7d/30d）──────┐┌─ 待处理告警（2）────────────┐
│ [面积图] 空闲率                 ││ 🔴 令牌池 14 条已过期        │
│ [柱状]   快照量（右轴）          ││ 🟡 设备 aa11… 26h 未上传     │
│ 悬停十字准星，显示该小时明细       ││ [查看全部 →]                │
└─────────────────────────────────┘└─────────────────────────────┘
┌─ 空位排行（最空/最满 TOP5）──────┐┌─ 实时事件流 ────────────────┐
│ 一食堂东侧  44% ████████        ││ ●08:12 App 上传 +39 区       │
│ 图书馆北     8% ██              ││ ●08:02 worker 抓取 +39 区    │
│ 点击进该区域                     ││ ●07:55 设备 tester 被拉黑    │
└─────────────────────────────────┘└─────────────────────────────┘
┌─ 系统组成健康（四格）──────────────────────────────────────┐
│ 数据库 ●正常 18.7MB    P2P ●1/2 在线    上游 ●可连       │
│ 磁盘 ●剩 42%          自动更新 ●下次 18h 后            │
└──────────────────────────────────────────────────────────┘
```

**接口**
```
GET /admin/api/overview
→ { cards, alerts, freshness, health: { db, p2p, upstream, disk, update } }

GET /admin/api/overview/trend?range=24h|7d|30d
GET /admin/api/overview/ranking?limit=5
GET /admin/api/overview/events?limit=10
```

---

### 页 2 · 告警中心（Alerts）

**目的**：所有历史告警 + 处理状态；规则可调。

```
[全部 12] [未处理 2] [已忽略 3] [已恢复 7]
┌────────────────────────────────────────────────────────────┐
│ 级别 规则            首次      最后      状态      操作      │
│ 🔴 令牌池为空        08:40    现在    未处理   [去处理][忽略]│
│ 🟡 设备 24h 未上传   昨天     现在    未处理   [去看][忽略]  │
│ 🟡 磁盘 <15%         3 天前    2 天前  已恢复   —           │
└────────────────────────────────────────────────────────────┘
┌─ 规则配置 ──────────────────────────────────────────────────┐
│ 令牌池为空         [● 开]  级别 🔴                          │
│ 最近快照 > N 分钟  [● 开]  N = [60]                        │
│ worker 连续失败    [● 开]  N = [3]                         │
│ 设备 24h 未上传    [● 开]                                  │
│ P2P 降级            [● 开]                                  │
│ 磁盘 < N%          [● 开]  N = [15]                         │
│ 新镜像可用          [● 开]                                  │
└────────────────────────────────────────────────────────────┘
```

**行为**
- 告警**自动恢复**：触发条件消失时自动标「已恢复」（不是人工）
- 「忽略」= 静默到条件消失（不重复提醒）
- 可选通知渠道（P4）：Webhook（企业微信/飞书/Telegram）+ 邮件

**数据来源**：内存规则引擎（每次概览请求时求值）+ `alert_state` 表持久化状态

**新增表**
```sql
CREATE TABLE IF NOT EXISTS alert_state (
  code        TEXT PRIMARY KEY,   -- token_empty / stale_snapshot / worker_fail...
  level       TEXT NOT NULL,      -- red / yellow / blue
  first_at    TEXT NOT NULL,
  last_at     TEXT NOT NULL,
  resolved_at TEXT,
  ignored     INTEGER NOT NULL DEFAULT 0,
  detail      TEXT                -- JSON：触发时的数值快照
);
```

**接口**
```
GET  /admin/api/alerts?state=&page=
POST /admin/api/alerts/ignore   { code, ignored }
GET  /admin/api/alerts/rules
POST /admin/api/alerts/rules    { code, enabled, threshold }
```

---

### 页 3 · 流量与限流（Traffic）

**目的**：谁在刷、限流有没有生效、被封了谁。

```
┌─ 近 24h 请求量 ────────────────────────────────────────────┐
│ [堆叠柱] 按状态码：2xx(绿) / 4xx(黄) / 429(橙) / 5xx(红)   │
│ [折线] 独立 IP 数（右轴）                                   │
└───────────────────────────────────────────────────────────┘
┌─ 端点排行 ────────────────────┐┌─ 限流命中 ──────────────────┐
│ /api/now        8,421  2xx    ││ 上传 12/min  命中 34 次      │
│ /api/snapshot   1,012  2xx    ││ 注册 5/24h   命中 3 次       │
│ /api/snapshot     312  401    ││ 资产 300/min 命中 0 次       │
│ /admin/api/*       88  2xx    ││                             │
└───────────────────────────────┘└─────────────────────────────┘
┌─ 当前封禁 ─────────────────────────────────────────────────┐
│ 类型   目标              原因      剩余      操作            │
│ IP     198.51.100.7      bad_sig   47 分钟  [解封]          │
│ 设备   tester…0001       replay    59 分钟  [解封]          │
└────────────────────────────────────────────────────────────┘
```

**说明**：请求统计需要**轻量埋点**（每个请求一行内存聚合，每分钟落盘一次），不写每请求日志（太重）。

**新增表**
```sql
CREATE TABLE IF NOT EXISTS traffic_minute (
  minute     TEXT NOT NULL,   -- '2026-11-08 08:12'
  path       TEXT NOT NULL,
  status     TEXT NOT NULL,   -- '2xx' | '4xx' | '429' | '5xx'
  hits       INTEGER NOT NULL DEFAULT 0,
  uniq_ip    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (minute, path, status)
);
```

**接口**
```
GET  /admin/api/traffic/summary?range=24h
GET  /admin/api/traffic/endpoints?range=24h
GET  /admin/api/traffic/ratelimit
GET  /admin/api/banlist
POST /admin/api/banlist/unban   { kind: 'ip'|'device', target }
```

---

### 页 4 · 实时数据（Live）

**目的**：现在每个区域几个空位；哪里坏了一片。

```
工具条：🔍搜索区域 │ [只看有空位] [只看异常] │ 排序 空位↓ │ ⟳ 30s
数据来自 08:12 上传 · 3 分钟前
┌──────────────────────────────────────────────────────────┐
│ 区域名          总数  空  充  故障  空位率          状态  │
│ 一食堂东侧 ▸     48   21   26    1  ██████░░░░ 44%   ●   │
│ 图书馆北 ▸       24    2   22    0  ██░░░░░░░░  8%   ●   │
│ 三食堂 ▸         36    0   30    6  ░░░░░░░░░░  0%   ⚠   │
└──────────────────────────────────────────────────────────┘
   点击行 → 右侧抽屉（45% 宽）
┌────────────────────────────────────┐
│ 一食堂东侧                     [×] │
│ 48 端口 · 空 21 · 充 26 · 故障 1   │
│ ── 端口网格 ──────────────────────│
│ ▣▣▣▢▢▣▣▣▢▢▣▣▣▣▢▢▣▣▣▢▢▣▣▣▣      │
│ 绿=空闲 蓝=充电 灰=故障 深=离线    │
│ 悬停：桩号/端口/状态/更新           │
│ 点击：该桩详情                      │
│ ── 24h 趋势（该区域）──────────────│
│ [火花线图]                          │
│ [同步该区域所有桩]                  │
└────────────────────────────────────┘
```

**端口网格配色**（这是本页灵魂）：
| group | 色 | 说明 |
|---|---|---|
| `free` | 绿 `#22c55e` | 空闲 |
| `busy` | 蓝 `#3b82f6` | 充电中 |
| `unavailable` | 灰 `#9ca3af` + ✕ | 故障/禁用 |
| `unknown` / 无记录 | 深灰虚线 `#4b5563` | 未知 |

**异常判定**：整桩全 `unavailable` → 区域行标 ⚠；`updated_at` > 2h → 标黄点。

**接口**
```
GET  /admin/api/live?q=&only_free=&only_abnormal=&sort=
GET  /admin/api/live/area?area_id=
POST /admin/api/live/sync   { area_id }
```

---

### 页 5 · 历史分析（History）

三个子页签：

**5a 快照流**
```
[时间▾ 今天/7d/30d/自定义] [来源▾ App/Worker] [设备▾] [导出]
┌────────────────────────────────────────────────────────┐
│ 时间       来源  设备       版本   区域  摘要     操作   │
│ 08:12:33  App   3d2b…c9d  2.3.8  39   a1b2c3d4  [详情] │
│ 08:02:10  Wkr   —         2.3.8  39   e5f6a7b8  [详情] │
└────────────────────────────────────────────────────────┘
虚拟滚动 + 游标分页（不用 OFFSET）
点详情 → 抽屉显示该快照的区域级数值 + 端口摘要
```

**5b 区域趋势**
```
区域：[多选] 一食堂东侧 × 图书馆北 ×
范围：[6h][24h][7d][30d]  指标：[空位率▾/空位数/总端口]
[多线折线，十字准星]
下方数据表（与图联动，可导出）
```

**5c 单桩趋势**
```
桩：[搜索]  范围：[24h][7d]
[堆叠柱] 空闲/充电/不可用，按小时聚合
```

**接口**
```
GET /admin/api/history/snapshots?cursor=&size=&from=&to=&source=&device_id=
GET /admin/api/history/snapshot/{id}
GET /admin/api/history/area-trend?areas=&range=&metric=
GET /admin/api/history/pile-trend?device_hex=&range=
GET /admin/api/export.csv?table=&from=&to=
```

---

### 页 6 · 数据质量（Quality）★

**目的**：主动发现脏数据，不靠肉眼。

```
┌─ 检查结果（每次进入自动跑，可手动重跑）──────────────────┐
│ 🟡 守恒失败        12 条采样（idle+charging+fault ≠ total）│
│ 🟡 区域突变        一食堂东侧 上次 48 端口 → 本次 12 端口  │
│ 🔴 疑似重复区域    3 组（名称相似 / 坐标距离 <50m）        │
│ 🟡 无坐标区域      5 个区域 lat/lng 为空                  │
│ 🟡 幽灵端口        7 个端口 24h 未再出现（已由兜底清理覆盖）│
│ 🔵 快照过密        08:00-09:00 内 42 条（正常 ~6 条）      │
│ 🔵 长期未活跃设备  4 台 >30 天未上传                      │
└──────────────────────────────────────────────────────────┘
每条展开 → 明细表 + 处置动作
```

**处置动作**
| 问题 | 动作 |
|---|---|
| 守恒失败 | 查看原始 payload；[删除该采样] |
| 区域突变 | 标记「上游改版」并忽略一段时间；[通知我] |
| 重复区域 | [合并]（选主，把另一条采样改绑） |
| 无坐标 | [批量补坐标] → 地图点选 |
| 幽灵端口 | [立即清理] |
| 快照过密 | 查看是哪个设备在刷；[拉黑该设备] |
| 长期未活跃 | [清理设备] |

**接口**
```
GET  /admin/api/quality/scan            // 返回所有检查项
POST /admin/api/quality/fix   { kind, targets: [] }
```

---

### 页 7 · 数据浏览器（Data Browser）

**目的**：临时查数据（不用 ssh 进容器）。**只读 SQL**，限时限额。

```
表：[snapshots ▾]   [最近 100 行 ▾]
[只读 SQL 输入框（折叠）]
┌──────────────────────────────────────────────────┐
│ id │ received_at │ device_id │ areas │ sha…       │
│ …  │ …           │ …         │ …     │ …          │
└──────────────────────────────────────────────────┘
[导出当前结果 CSV]
```

**安全约束**
- 只允许 `SELECT`（关键字白名单校验，拒绝 `;` 多语句、`INSERT/UPDATE/DELETE/DROP/ATTACH/PRAGMA`）
- 强制 `LIMIT`（未写则自动加 `LIMIT 200`，最大 5000）
- 单次执行超时 5 秒（`busy_timeout` + `AbortSignal`）
- 只读连接（`DATABASE_READONLY` 的第二个 Kysely 实例）
- 所有执行进审计

**接口**
```
GET  /admin/api/db/tables
GET  /admin/api/db/rows?table=&limit=&offset=
POST /admin/api/db/query   { sql }
```

---

### 页 8 · 令牌池（Tokens）★ 最高频故障源

```
┌─ 健康卡 ────────────────────────────────────────────────────┐
│ 有效 2 / 16   覆盖到 13:52   最快到期 22min                │
│ ▓▓▓░░░░░░░░░  ⏱ 环形     [清空已过期] [刷新]               │
└────────────────────────────────────────────────────────────┘
┌─ 表格 ─────────────────────────────────────────────────────┐
│ 用户ID     来源   过期      剩余    状态   最后错误   操作   │
│ 66108368  App   13:52     22min   ●有效  —        [删][试] │
│ 64789362  App   07:15     -       ○过期  —        [删]     │
└────────────────────────────────────────────────────────────┘
┌─ 上传者排行（谁在供令牌）──────────────────────────────────┐
│ 66108368  ████████ 8 条（1 有效）                          │
└────────────────────────────────────────────────────────────┘
```

**空态引导**（`有效 0` 时健康卡替换为）：
```
⚠ 令牌池已全部过期，服务器无法抓取

 1. 打开手机 App
 2. 「令牌」页 → 重新获取
 3. 抓完自动上传，这里 30 秒内刷新

 [我已重新获取，立即刷新]
```

**「试一次」**：用该 token 调上游 `user/userInfo`，行内显示 `✓ 可用` / `✗ 401` / `✗ 网络超时`。判断「是 token 死了还是上游变了」。

**接口**
```
GET  /admin/api/tokens
POST /admin/api/tokens/purge
POST /admin/api/tokens/delete   { ids }
POST /admin/api/tokens/probe    { id }
```

---

### 页 9 · 上传设备（Devices）

```
[全部 26][在线 23][24h 未传 3][待审批 0][已拉黑 1]      自动审批 [● 开]
┌──────────────────────────────────────────────────────────┐
│ ☐ 设备ID       型号      版本   状态    上传  IP          最后活跃 │
│ ☐ 3d2b…c9d    RMX5010  2.3.8  ●正常   842  203.0.113.9  3min  │
│ ☐ aa11…dd44   MI 14    2.3.7  ●正常    17  198.51.100 2h     │
│ ☐ tester…001  —        —      ⛔拉黑    99  —          1d     │
└──────────────────────────────────────────────────────────┘
批量：[拉黑][恢复][删除]        行操作：[审批][拉黑][删除][详情]
```

**详情抽屉**：该设备的上传时间线（来自 `snapshots`）+ 请求审计（`upload_audit`）+ 已上传区域列表。

#### 自动审批开关（服务端行为变更，不只是后台配置）

```
app_settings.device_auto_approve = 1（默认开）
  → POST /api/device/register 直接 status='approved'，立即可上传（现状行为）

app_settings.device_auto_approve = 0（关）
  → POST /api/device/register 写入 status='pending'，注册接口返回 { ok: true, pending: true }
  → 该设备后续所有 /api/snapshot 一律 403 { error: '设备待审批' }
  → 后台「上传设备」页出现待审批条数徽章，管理员点「审批」后立即生效（无需 App 重装/重注册）
```

- 开关写入 `app_settings`，**每请求读取**，改完立即对下一次注册生效（不重启）
- 关闭期间已在册的 approved 设备**不受影响**（只有新注册进 pending）
- 审批动作写 `admin_audit`；被拒（拉黑）的设备在 register 时返回 403 且不重复建行
- 后台顶栏 + 侧边栏「上传设备」挂待审批徽章

**接口补充**
```
POST /admin/api/devices/approve  { ids }   // pending → approved
POST /admin/api/devices/reject   { ids }   // pending → revoked
```

**接口**
```
GET  /admin/api/devices?status=&q=&cursor=
GET  /admin/api/devices/{id}
POST /admin/api/devices/approve { ids }
POST /admin/api/devices/revoke  { ids, revoked }
POST /admin/api/devices/delete  { ids }
```

---

### 页 10 · 桩与区域（Units）

```
┌─ 左：区域 ──────────┐┌─ 右：区域详情 ─────────────────────┐
│ 🔍 搜索             ││ 一食堂东侧  4 桩 48 端口            │
│ 一食堂东侧  4桩     ││ [地图打点] [改坐标] [合并] [删除]   │
│ 图书馆北    2桩     ││ ── 桩列表 ────────────────────────  │
│ 三食堂      6桩     ││ 00AFEC05 码牌8612 ●12口 正常 [同步] │
│ [+ 新建区域]        ││ [端口网格]                          │
│ [重复检测]          ││ 00AFEC06 码牌8613 ⚠3口故障 [同步]   │
└─────────────────────┘└────────────────────────────────────┘
```

**地图视图**（右上切换）：区域按坐标打点，气泡显示空位率；可拖拽修正坐标。

**重复检测**：名称相似度模型（去停用词后 Levenshtein）+ 坐标距离，成对列出 → [合并]。

**接口**
```
GET    /admin/api/units/areas?q=
GET    /admin/api/units/area/{area_id}
POST   /admin/api/units/area          // 改名称/坐标
POST   /admin/api/units/area/merge    { from, to }
DELETE /admin/api/units/area/{area_id}   // 软删
POST   /admin/api/units/device/sync   { device_hex }
POST   /admin/api/units/device/bind   { device_hex, area_id }
GET    /admin/api/units/duplicates
```

---

### 页 11 · 节点网络（Nodes）

```
┌─ 拓扑图（力导向）──────────────────────────────────────────┐
│              ● 备用节点 v2.3.8                            │
│                   │ 实线                                  │
│              ● 主节点（本机）                             │
│                   ┆ 虚线（未受信）                         │
│              ○ test-node v2.3.7                           │
└──────────────────────────────────────────────────────────┘
┌─ 节点表 ───────────────────────────────────────────────────┐
│ 名称        版本   白名单  在线  可信度   地址              快照 │
│ 主节点(我)  2.3.8  —      —     —       8.148.70.133:4001  —  │
│ 备用节点    2.3.8  ✓      ●     ✓12/12  141.11.148.175…   22 │
│ test-node   2.3.7  ✗      ●     ⚠3/12   1.2.3.4:4001       0  │
│ 行操作：[加入白名单][断开][复制 peerId][校验详情]              │
└──────────────────────────────────────────────────────────┘
┌─ 策略 ─────────────────────────────────────────────────────┐
│ P2P 启用              ● 开（env P2P_ENABLED）              │
│ 采纳非白名单数据       ○ 关  ← 可切（写 app_settings，优先 env）│
│ 白名单 2 条  [管理]                                        │
│ 来源：GitHub nodes.json(2) ∪ 本地覆盖层(0)  = 去重后 2       │
└────────────────────────────────────────────────────────────┘
```

**白名单合并规则（确定）**

```
生效白名单 = dedupe( GitHub nodes.json ∪ 本地覆盖层 app_settings.p2p_extra_peers )
去重键：peerId
字段合并优先级：本地覆盖层 > GitHub（同 peerId 时，本地的 addr/url/name 覆盖远程）
删除：从本地覆盖层删 = 只影响本节点；不影响 GitHub 那份
```

- **新增**：填 peerId + addr + url + name → 写 `app_settings.p2p_extra_peers`
- **删除**：只能删本地覆盖层里的；GitHub 里的只能通过在 GitHub 改（界面上标灰 + 提示"来自 nodes.json，需改仓库"）
- **热更新**：写入后立即重建 whitelist `Set` 并对新增 addr `dial()`，**不重启**

**接口**
```
GET    /admin/api/nodes
→ { policy: { enabled, trust_non_whitelist, source },
    self, peers, whitelist: { github: [], local: [], merged_count } }

POST   /admin/api/nodes/whitelist            { peer_id, addr?, url?, name? }
DELETE /admin/api/nodes/whitelist/{peer_id}  // 仅本地层
PATCH  /admin/api/nodes/policy               { trust_non_whitelist }
POST   /admin/api/nodes/dial                 { addr }
POST   /admin/api/nodes/disconnect           { peer_id }
```

---

### 页 11.5 · 跨节点数据一致性校验（P2P 防污染）★

> **完整设计见 [`docs/p2p-validation.md`](./p2p-validation.md)**（算法、阈值依据、误判分析、
> 边界情况、测试策略都在那份）。这里只保留后台视角的摘要。

**一句话**：收到其他节点的快照时，与本节点"同一时刻"的数据比对，偏差过大按配置丢弃。

**后台能看到什么**
- 节点表加「可信度」列：`✓ 12/12`（近 12 次全部通过）/ `⚠ 3/12` / `—`（无基准）
- 「校验详情」抽屉：每次判定的时间、基准快照、逐区域 `远端 vs 本地 vs 偏差`、决策
- 「模拟」按钮：用历史快照试跑「如果当时 strict 会丢多少条」——**切 strict 前必看**

**后台能改什么（配置中心）**

| 键 | 默认 | 说明 |
|---|---|---|
| `p2p_validate_mode` | `strict` | off / warn / **strict**；建议先 warn 跑 7 天 |
| `p2p_validate_threshold` | `0.5` | 空闲率偏差阈值（0–1） |
| `p2p_validate_window_sec` | `600` | 基准时间窗 |
| `p2p_validate_min_areas` | `3` | 最少可比区域数 |

**告警**：某节点近 20 次判定里 `drop` ≥ 10 次 → 🟡「节点 X 数据可信度低，建议切 warn 观察或移除白名单」（**不自动拉黑**）。

**接口**
```
GET  /admin/api/nodes/{peer_id}/validation?limit=50
POST /admin/api/nodes/validation/mode   { mode, threshold?, window_sec?, min_areas? }
GET  /admin/api/nodes/{peer_id}/validation/simulate?snapshot_id=...
```

---

### 页 12 · 任务与调度（Jobs）

**目的**：worker 抓取 + 自动更新的"运行记录"，以及手动触发。

```
┌─ 定时任务 ─────────────────────────────────────────────────┐
│ 抓取 worker      每 10 分钟   上次 08:02 成功   下次 08:12  │
│ 镜像自动更新      每天 03:00   上次 11-08 成功   下次 11-09  │
│ 数据保留清理      每天 04:00   上次 11-08 删除 12 行        │
│ 备份（若启用）    每天 05:00   未启用                       │
└───────────────────────────────────────────────────────────┘
┌─ 抓取轮次历史 ─────────────────────────────────────────────┐
│ 时间     结果                          耗时   操作          │
│ 08:02   areas=ok:39                    14s   [重跑]        │
│ 07:52   areas=no-token                 1s    [重跑]        │
│ 07:42   areas=ok:39 ports=ok:39        21s   [重跑]        │
└───────────────────────────────────────────────────────────┘
批量：[再跑一轮]  [清理 30 天前记录]
```

**接口**
```
GET  /admin/api/jobs
GET  /admin/api/jobs/worker-runs?cursor=
POST /admin/api/jobs/worker/run        // 立即抓一轮
POST /admin/api/jobs/worker-runs/purge { before_days }
GET  /admin/api/jobs/update-status
```

---

### 页 13 · 运行日志（Logs）

**目的**：不进容器看日志。

```
[级别▾ 全部/error/warn/info] [搜索关键词] [自动刷新 ⟳ 5s]
┌──────────────────────────────────────────────────────────┐
│ 08:12:33 INFO  [upload] 快照已落库 id=1012 areas=39      │
│ 08:12:30 WARN  [p2p] 回调异常 …                          │
│ 08:02:10 INFO  [worker] 轮次完成 ok:39                   │
└──────────────────────────────────────────────────────────┘
```

**实现**：pino 加一个**环形缓冲 transport**（内存保留最近 2000 条），通过 SSE 或 3 秒轮询推给前端。**不读 docker logs**（要挂 docker.sock，风险大）。

**接口**
```
GET /admin/api/logs?level=&q=&since_id=    // 增量拉取
```

---

### 页 14 · 配置中心（Config）

**目的**：所有可调项一屏可见，标明来源与是否可运行时改。

```
┌─ 可运行时修改（存 app_settings，立即或下次重启生效）────────┐
│ 自动审批新设备        [● 开]                    立即       │
│ 采纳非白名单数据      [○ 关]                    立即       │
│ worker 间隔(秒)       [600]                     下次重启   │
│ 数据保留(天)          [90]                      立即       │
│ 告警阈值…             [展开规则]                立即       │
└───────────────────────────────────────────────────────────┘
┌─ 环境变量（只读，脱敏）────────────────────────────────────┐
│ NODE_NAME            主节点                               │
│ P2P_ENABLED          true                                 │
│ REGISTER_TOKEN       ●已配置（值不可见）                    │
│ TRUST_PROXY          true                                 │
│ ADMIN_SESSION_SECRET ●已配置                              │
└───────────────────────────────────────────────────────────┘
┌─ 变更历史（app_settings 的改动）──────────────────────────┐
│ 08:40  主管理员  数据保留 90→60 天                         │
└───────────────────────────────────────────────────────────┘
```

**接口**
```
GET  /admin/api/config
POST /admin/api/config              { key, value }
GET  /admin/api/config/history?cursor=
```

---

### 页 15 · 版本发布（Release）

```
┌─ 当前 ────────────────────────────────────────────────────┐
│ 服务 v2.3.8   镜像 sha256:abc123…   构建 11-08 07:20      │
│ App  2.3.8 (2003008)  APK 441KB  sha256:def456…           │
│ 后端启动 4 天 7 小时                                      │
└───────────────────────────────────────────────────────────┘
┌─ 可用版本（GHCR / GitHub Releases）────────────────────────┐
│ v2.3.8  当前      v2.3.7  ✓     v2.3.6  ✓                 │
│ [立即更新到最新]  [回滚到上一版]                           │
└───────────────────────────────────────────────────────────┘
┌─ 更新历史（/var/log/charge-update.log 摘要）───────────────┐
│ 11-08 03:04  镜像无变化，无需更新                          │
│ 11-07 22:05  更新成功 v2.2.7 → 容器已重建                  │
└───────────────────────────────────────────────────────────┘
```

**安全性**：更新/回滚**不在后台直接执行** docker 命令，而是**写一个触发文件**（`/data/update.request`），由宿主上的 systemd timer 检测并执行 `update-node.sh` ——后台不获得宿主机权限。

**接口**
```
GET  /admin/api/release
GET  /admin/api/release/history
POST /admin/api/release/update   { tag }   // 写触发文件，非直接执行
```

---

### 页 16 · 备份恢复（Backup）

```
┌─ 备份 ────────────────────────────────────────────────────┐
│ 最近备份  11-08 05:00  18.7MB  /data/backups/charge-*.db  │
│ 保留 7 份   总占 131MB                                    │
│ [立即备份] [下载最新备份] [上传恢复]                       │
└───────────────────────────────────────────────────────────┘
┌─ 恢复 ────────────────────────────────────────────────────┐
│ ⚠ 恢复会覆盖当前数据库                                   │
│ 选择：从备份列表 / 上传文件                               │
│ 恢复前自动先备份当前库                                    │
│ [输入 RESTORE 确认] [执行恢复]                            │
└───────────────────────────────────────────────────────────┘
```

**实现**：用 SQLite 的 `VACUUM INTO`（在线的、原子的一致性快照），不用停服。

**接口**
```
GET  /admin/api/backup
POST /admin/api/backup/create
GET  /admin/api/backup/download?name=
POST /admin/api/backup/restore   { name }   // 需确认词
```

---

### 页 17 · 账号与权限（Accounts & Roles）

**多账号 + 三个角色**（你要求的"多账号"，加最小必要分工）：

| 角色 | 说明 | 权限 |
|---|---|---|
| `super` | 超管 | 全部（含账号、危险操作、配置） |
| `ops` | 运维 | 数据处理（清令牌、封设备、同步桩、看日志、跑任务）；**不能**改配置/白名单/恢复/账号 |
| `viewer` | 只读 | 全部页面只读 |

```
[账号 3] [角色说明]
┌──────────────────────────────────────────────────────────┐
│ 用户名   角色    状态    最后登录         操作            │
│ admin    super   ●启用   08:40 今天      [改密][禁用]     │
│ ops1     ops     ●启用   昨天            [改密][禁用][删]  │
│ guest    viewer  ○禁用   —              [启用][删]        │
└──────────────────────────────────────────────────────────┘
[+ 新增账号]
┌─ 会话管理 ────────────────────────────────────────────────┐
│ admin   2 个活跃会话   [全部下线]                           │
└──────────────────────────────────────────────────────────┘
```

**口令策略**：最短 10 位、必须含字母+数字；`scrypt` 存储；连续 5 次错锁定 10 分钟。

**接口**
```
GET  /admin/api/accounts
POST /admin/api/accounts              { username, password, role }
POST /admin/api/accounts/disable      { username, disabled }
DELETE /admin/api/accounts/{username}
POST /admin/api/accounts/password     { username, password }   // super 重置他人
POST /admin/api/accounts/sessions/kill { username | 'self' }
```

---

### 页 18 · 审计（Audit）

两个子页签：

**18a 管理操作**（新表 `admin_audit`）
```
[时间] [账号▾] [动作▾ 登录/删数据/改配置/白名单/恢复]
┌──────────────────────────────────────────────────────────┐
│ 08:40  admin  登录 203.0.113.5 成功                      │
│ 08:12  ops1   清空过期令牌 删 14 条 成功                 │
│ 07:55  admin  拉黑设备 aa11… 成功                        │
│ 07:50  admin  改配置 数据保留 90→60                      │
└──────────────────────────────────────────────────────────┘
```

**18b 上传记录**（`upload_audit`，需补埋点）
```
[结果▾] [时间]
┌──────────────────────────────────────────────────────────┐
│ 08:12  3d2b…c9d  203.0.113.9  成功  39区 12.4KB          │
│ 08:11  tester…    198.51.100.7  401  签名错误            │
└──────────────────────────────────────────────────────────┘
```

---

### 页 19 · 我的（Profile）

```
├ 账号信息：用户名 / 角色 / 最后登录 IP
├ 改密码：[旧密码] [新密码] [确认]
├ 我的会话：1 个活跃（当前）  [其他全部下线]
├ 登录历史：08:40 203.0.113.5 成功 / 昨天 失败×2
└ 主题：跟随系统 / 浅色 / 深色
```

---

## 三、权限矩阵（后端强制，非仅前端隐藏）

| 能力 | super | ops | viewer |
|---|:--:|:--:|:--:|
| 查看所有页面/导出 | ✅ | ✅ | ✅ |
| 清空过期令牌 / 删令牌 | ✅ | ✅ | ❌ |
| 设备审批/拉黑/删除 | ✅ | ✅ | ❌ |
| 同步桩 / 改绑区域 | ✅ | ✅ | ❌ |
| 合并/删除区域 | ✅ | ✅ | ❌ |
| 触发 worker | ✅ | ✅ | ❌ |
| 解封 IP/设备 | ✅ | ✅ | ❌ |
| 改配置（app_settings） | ✅ | ❌ | ❌ |
| 白名单增删 / 信任策略 | ✅ | ❌ | ❌ |
| 备份 / 恢复 | ✅ | ❌ | ❌ |
| 触发更新 / 回滚 | ✅ | ❌ | ❌ |
| 账号管理 / 重置他人口令 | ✅ | ❌ | ❌ |
| 只读 SQL | ✅ | ❌ | ❌ |

后端用统一的 `requireRole('ops')` 装饰器，**前端隐藏只是体验，服务端才是边界**。

---

## 四、数据模型变更

**已有（复用）**：`admin_users`（加 `role` 列）、`app_settings`、`upload_audit`、`worker_runs`

**新增**

```sql
-- 账号加角色
ALTER TABLE admin_users ADD COLUMN role TEXT NOT NULL DEFAULT 'viewer';
ALTER TABLE admin_users ADD COLUMN must_change INTEGER NOT NULL DEFAULT 0;
ALTER TABLE admin_users ADD COLUMN last_login_at TEXT;
ALTER TABLE admin_users ADD COLUMN last_login_ip TEXT;

-- 管理审计
CREATE TABLE IF NOT EXISTS admin_audit (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  ts       TEXT NOT NULL,
  username TEXT,
  action   TEXT NOT NULL,
  target   TEXT,
  detail   TEXT,          -- JSON：变更前后/影响行数
  ip       TEXT,
  ok       INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_ts ON admin_audit(ts);

-- 告警状态
CREATE TABLE IF NOT EXISTS alert_state (
  code TEXT PRIMARY KEY, level TEXT NOT NULL,
  first_at TEXT NOT NULL, last_at TEXT NOT NULL,
  resolved_at TEXT, ignored INTEGER NOT NULL DEFAULT 0, detail TEXT
);

-- 流量分钟聚合
CREATE TABLE IF NOT EXISTS traffic_minute (
  minute TEXT NOT NULL, path TEXT NOT NULL, status TEXT NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0, uniq_ip INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (minute, path, status)
);
CREATE INDEX IF NOT EXISTS idx_traffic_minute ON traffic_minute(minute);

-- 配置变更历史（app_settings 的审计面）
CREATE TABLE IF NOT EXISTS config_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL, username TEXT, key TEXT NOT NULL,
  old_value TEXT, new_value TEXT
);

-- 软删除
ALTER TABLE areas ADD COLUMN deleted_at TEXT;
ALTER TABLE devices ADD COLUMN deleted_at TEXT;
```

---

## 五、技术设计

### 5.1 鉴权（多账号 + 角色）

| 项 | 方案 |
|---|---|
| 口令 | `scrypt`（N=16384,r=8,p=1；salt 32B；out 64B），格式 `scrypt$N$r$p$salt$hash`；`timingSafeEqual` 比对 |
| 口令策略 | ≥10 位，含字母+数字；连续 5 次错锁 10 分钟（按 username + IP 双维度） |
| 会话 | 签名 cookie `admin_s`：payload `{u, r, v, exp}`（`v` = `admin_users.updated_at` 哈希前 8 位，改密/禁用/换角色即全端失效），HMAC-SHA256，8h 滑动续期 |
| Cookie | `HttpOnly; Secure; SameSite=Strict; Path=/admin` |
| CSRF | cookie `admin_csrf` + 写操作要求头 `X-Admin-CSRF` 相等 |
| 初始账号 | `ADMIN_INIT_PASSWORD`（env）仅在表空时建 `admin`/`super` + `must_change=1` |
| 强制改密 | `must_change=1` 时除改密接口外一律 403 |
| 会话管理 | `sessions` 表（username / jti / ip / ua / last_seen），可"踢掉其他会话" |

### 5.2 前端

- **布局**：左侧分组导航（可折叠 + 徽章）+ 顶栏 + 内容区；`≤768px` 侧栏变抽屉
- **路由**：hash 路由（`/admin#/live`），30 行手写（不引 vue-router）
- **图表**：echarts（已有依赖），封装 `<AdminChart>`（自动 resize + 主题跟随）
- **表格**：扩展现有 `useAdminList`（加排序 / 多选 / 游标分页）
- **抽屉**：Vant `van-popup position="right"`
- **配色**：复用 `design.css` 变量；端口网格另定 4 色
- **统一组件**：`<AdminEmpty>`（空态）、`<AdminConfirm>`（危险操作确认词）、`<AdminBadge>`（状态徽章）

### 5.3 后端结构

```
server/src/routes/admin.ts            注册 + 会话守卫钩子 + CSRF + 角色
server/src/routes/admin/
  overview.ts alerts.ts traffic.ts live.ts history.ts quality.ts
  db.ts tokens.ts devices.ts units.ts nodes.ts jobs.ts logs.ts
  config.ts release.ts backup.ts accounts.ts audit.ts
server/src/domain/
  adminauth.ts      口令/会话/限流/角色
  adminsettings.ts  app_settings（schema + 默认值 + 热更新事件）
  adminaudit.ts     审计写入
  alertengine.ts    告警求值
  traffic.ts        流量聚合（内存 → 每分钟落盘）
  logbuffer.ts      pino 环形缓冲（最近 2000 条）
  backup.ts         VACUUM INTO 备份/恢复
```

### 5.4 性能与安全

| 关注点 | 做法 |
|---|---|
| 大表分页 | 游标（`WHERE id < ?`），不用 OFFSET |
| 趋势聚合 | 按小时 `substr(received_at,1,13)`；已有 `idx_samples_snapshot`/`idx_samples_received` |
| 导出 | 流式（`reply.raw` + 分批 SELECT），上限 20 万行 |
| 只读 SQL | 关键字白名单 + 强制 LIMIT + 5s 超时 + 只读连接 + 审计 |
| 更新/恢复 | **不直接执行宿主机命令**，写触发文件由 systemd 执行（后台不获得宿主权限） |
| 日志 | 环形缓冲，不读 docker logs（不挂 docker.sock） |
| 密码 | 任何接口都不返回 hash；日志脱敏 |

---

## 六、实施分期（四期）

| 期 | 内容 | 交付后能做 |
|---|---|---|
| **P1** | 鉴权（多账号+角色+CSRF+限流+强制改密）、登录页、侧边栏骨架、hash 路由、顶栏、**概览**、**告警中心（读取+忽略）**、**令牌池**、**实时数据**、系统只读信息 | 每天早上巡检、断链自查、就地清令牌/看端口 |
| **P2** | **数据质量**、**上传设备**、**桩与区域**（含地图、重复合并）、**历史分析**+导出、`upload_audit` 埋点 | 治理脏数据、封人、导出分析 |
| **P3** | **节点网络**（白名单合并+热更新+拓扑）、**任务与调度**、**运行日志**、**配置中心**、**流量与限流** | 全链路运维 |
| **P4** | **版本发布**（触发文件）、**备份恢复**、**数据浏览器**、**账号与权限**完整版、**审计**全量、趋势图打磨 | 长期可运维 |

每期收尾都跑 `typecheck` + 53 单测 + `webui lint/build` + APK 构建，**攒批发版**。

---

## 七、确定的白名单规则（你已拍板）

```
生效白名单 = dedupe( GitHub nodes.json ∪ 本地覆盖层 app_settings.p2p_extra_peers )

去重键   ：peerId
字段优先 ：本地覆盖层 > GitHub（同 peerId 时本地的 addr/url/name 生效）
新增     ：写本地覆盖层 → 立即重建 Set → 对新 addr dial()（不重启）
删除     ：只能删本地层；GitHub 那份在界面标灰并提示"来自 nodes.json，需改仓库"
展示     ：节点表分别标明来源（nodes.json / 本地）
```

---

## 八、明确不做

- ❌ 实时 WebSocket（30s 轮询够）
- ❌ 多租户 / 多校区
- ❌ 细粒度按资源授权（三角色已够）
- ❌ 移动端专门适配（窄屏滚动可用即可）
- ❌ 通用报表设计器
- ❌ 后台直接执行 docker/systemctl（一律走触发文件）
