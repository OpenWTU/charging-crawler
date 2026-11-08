# 跨节点数据互校（P2P 一致性校验）详细设计

> 目标：**一个节点广播的快照，如果与本节点"同一时刻"的数据偏差过大，可以选择丢弃。**
> 本文是可实施的设计文档，含算法、阈值依据、边界情况、误判处理与测试策略。

---

## 一、问题定义

### 1.1 要防什么

P2P 拓扑里任何节点都能广播快照。白名单只回答「这个 peerId 是不是我认识的」，
不回答「它发来的数据对不对」。以下情况都会让远端数据出错：

| 类别 | 具体情形 | 后果 |
|---|---|---|
| **时钟问题** | 节点主机时间错 2 小时 / 时区配错 | `captured_at` 错 → 时序乱、趋势图异常 |
| **上游差异** | 不同节点访问上游拿到的区域集合/数值不同（灰度、缓存、地域） | 同一时刻两份不同数据 |
| **版本差异** | 节点跑旧代码，字段语义变了（如 idle 的定义改了） | 数值对不上 |
| **数据损坏** | DB 抖动、写入部分失败 | 快照残缺（区域少一半） |
| **恶意灌水** | 白名单泄露/内部人员/被入侵 | 大面积假数据污染历史与趋势 |

跨节点互校是**最便宜的一致性兜底**：不需要引入共识算法，只需要"两个独立观测者测同一件事，
差太多就有一个错了"。

### 1.2 不做什么（划清边界）

- ❌ 不做多数表决（2 个节点时没意义；且节点数少）
- ❌ 不做拜占庭容错
- ❌ 不自动拉黑节点（误判成本 > 收益）
- ❌ 不保证「采纳的就是对的」（只过滤明显离谱的）
- ❌ 不校验单条快照内部的自我一致性（那是 `splitValidAreas` 的守恒校验，已存在）

---

## 二、数据流与接入点

### 2.1 现状链路

```
节点 A（远端）                         节点 B（本节点）
   产生快照                                │
     │ broadcastSnapshot(payload)          │
     ├──────── gossipsub ─────────────────►│ onSnapshot 回调
                                            │ ① type==='signed' 校验
                                            │ ② whitelist.has(from) 校验
                                            │ ③ body_sha256 去重（30 分钟窗口）
                                            │ ④ storeSnapshot() 落库
```

### 2.2 插入校验闸（步骤 ③ 与 ④ 之间）

```
                                            │ ③ 摘要去重
                                            │ ★ ③.5 validateIncoming(msg)   ← 新增
                                            │      ├ accept  → ④ 落库
                                            │      ├ suspect → ④ 落库（payload 标 _suspect）
                                            │      └ drop    → 记录 + 告警，不落库
                                            │ ④ storeSnapshot()
```

**关键位置选择的理由**：放在去重**之后**（避免重复快照反复触发校验开销），
放在落库**之前**（丢弃就不写任何业务表）。

### 2.3 校验只作用于「P2P 收到的」

| 来源 | 是否校验 | 理由 |
|---|---|---|
| `POST /api/snapshot`（App 上传） | ❌ | 已验 HMAC + 时间是最近 10 分钟，是本节点自己的数据 |
| `worker`（服务端抓取） | ❌ | 本节点直接调上游，是基准的来源之一 |
| **`p2p`（其他节点广播）** | ✅ | 本文对象 |

---

## 三、算法

### 3.1 总览

```
validateIncoming(msg) -> {
    decision: 'accept' | 'suspect' | 'drop',
    reason:   'no_baseline' | 'insufficient_overlap' | 'within_threshold'
            | 'deviation_exceeded' | 'invalid_payload' | 'mode_off',
    deviation: number | null,
    base_snapshot_id: number | null,
    areas: [{ name, total, remote_idle, local_idle, deviation }]
}
```

四步：**取时间窗口 → 选基准快照 → 按区域对齐 → 算偏差并决策**。

### 3.2 第一步：确定远端快照的"时刻"

```ts
const t0 = msg.payload.captured_at   // 客户端采集时间（首选，数据本身的时刻）
        ?? msg.ts;                   // 广播时间（兜底）
if (!t0) return accept('no_baseline');   // 两边都没有时间 → 无法比对
```

**为什么优先 `captured_at`**：广播的 `ts` 含网络延迟与重传，且与数据实际采集时刻可能差几分钟；
`captured_at` 是"这组读数是什么时候的"，才是可比的量。

**时钟偏差的兜底**：如果 `captured_at` 与本节点当前时间相差 > 24 小时，视为"这个节点的时钟可能错"
→ 走 `no_baseline` 采纳，但记一条 `clock_suspicious` 观测（不丢弃，因为可能是补传历史）。

### 3.3 第二步：选基准快照

在**本节点**库里找一条时间最接近 t0 的快照：

```sql
SELECT id, payload, captured_at, source
  FROM snapshots
 WHERE captured_at BETWEEN :t0_minus_W AND :t0_plus_W     -- W 默认 600 秒
 ORDER BY
   CASE source WHEN 'upload' THEN 0 ELSE 1 END,           -- 手机实测优先（更能反映真实）
   ABS(julianday(captured_at) - julianday(:t0)) ASC        -- 时间最接近
 LIMIT 1
```

**参数与理由**

| 参数 | 默认 | 理由 |
|---|---|---|
| `W`（窗口） | 600 秒 | 快照约 10 分钟一份；窗口比间隔略大才能命中"相邻那份"。太大（如 1 小时）会把状态变化误当偏差 |
| 来源优先级 | `upload` > `worker` | 手机端是用户在充电桩旁实测，最接近真实；worker 走服务端上游，可能被缓存 |
| 命中数量 | 取最近 1 条 | 多条会导致"用哪个基准"不确定；取最近最合直觉 |

**找不到基准** → `accept('no_baseline')`。

> 这条规则保证：**新节点、孤立节点、刚清库的节点不会被饿死**（没有基准就不校验，一律采纳）。

**索引需求**（新增）：
```sql
CREATE INDEX IF NOT EXISTS idx_snapshots_captured ON snapshots(captured_at);
```

### 3.4 第三步：按区域对齐

```ts
// 远端与本地都按 name 建映射
const remoteByName = new Map(remoteAreas.map(a => [a.name, a]));
const localByName  = new Map(localAreas.map(a => [a.name, a]));

const comparable = [];
for (const [name, r] of remoteByName) {
  const l = localByName.get(name);
  if (!l) continue;                       // 远端新增区域：跳过（不判错）
  if (Number(r.total) !== Number(l.total)) continue;   // 总端口不同 → 不是同一批硬件，不可比
  if (!Number(r.total)) continue;         // total=0 → 除零保护，跳过
  comparable.push({ name, r, l, total: Number(r.total) });
}
```

**为什么用 `name` 而不是 `area_id`**

`areas.area_id` 是**每个节点本地生成的 UUID**，同一物理区域在两个节点里的 `area_id` 不同。
`name`（如"一食堂东侧"）是唯一跨节点一致的标识。所以：

- 对齐键 = `name` 精确匹配
- 匹配不上（如"一食堂东侧" vs "一食堂东区"）→ 跳过该区域（**宁可不判，也不误判**）

**为什么要求 `total` 相同**

`total` 是区域总端口数（硬件属性，短期内不变）。
两边 `total` 不同说明：① 不是同一个物理区域；② 有一边数据残缺。两种都**不可比**，跳过。

**样本量门槛**：
```ts
if (comparable.length < MIN_AREAS) return accept('insufficient_overlap');  // 默认 3
```
理由：只有 1–2 个区域重合时噪声太大（单个区域空闲数抖动就触发），3 个以上才有统计意义。

### 3.5 第四步：算偏差

对每个可比区域，用**空闲率**作为主指标：

```ts
const rateRemote = Number(r.idle) / total;
const rateLocal  = Number(l.idle) / total;
const idleDev    = Math.abs(rateRemote - rateLocal);        // 0..1

// 故障数单独看（硬件问题两边应该一致，差异大说明有问题）
const faultGap   = Math.abs(Number(r.fault) - Number(l.fault));
const faultDev   = faultGap >= FAULT_ABS_MIN && faultGap / total >= FAULT_REL_MIN
                   ? FAULT_WEIGHT : 0;                       // 默认 >=3 且 >=20% → 记 0.5

const areaDev = Math.max(idleDev, faultDev);
```

整条快照的偏差取**最坏区域**：
```ts
const deviation = Math.max(...comparable.map(c => c.areaDev));
```

**为什么用"空闲率"而不是"空闲数绝对值"**

- 区域大小差异大（24 口 vs 48 口），绝对值不可比
- 归一化后阈值（如 0.5 = 相差 50 个百分点）语义直观
- 空闲率正是这个产品对外表达的核心指标

**为什么故障数单独拎出来**

"空闲/充电"是**互相转化**的（有人来充，空闲就变充电），所以空闲率差 50 个百分点可能是真实变化；
但"故障"是硬件状态，两个观测者同时看同一片桩，故障数应该几乎一致。
故障差异是**更强的错误信号**，所以单独计权并给较低门槛（3 个口且 20%）。

### 3.6 决策

```ts
const mode = getSetting('p2p_validate_mode');    // off | warn | strict（默认 strict）
if (mode === 'off') return accept('mode_off');
if (deviation > threshold) {                     // threshold 默认 0.5
  if (mode === 'strict') return drop('deviation_exceeded', deviation);
  return suspect('deviation_exceeded', deviation);   // warn 模式
}
return accept('within_threshold', deviation);
```

**模式对照表**

| 模式 | 偏差超阈值 | 偏差正常 | 无基准 / 重叠不足 |
|---|---|---|---|
| **`strict`（默认）** | 丢弃（不落库） | 采纳 | 采纳 |
| `warn` | 采纳，payload 加 `_suspect: true` | 采纳 | 采纳 |
| `off` | 采纳 | 采纳 | 采纳 |

**⚠️ 校验代码自身异常**：整个函数包一层 `try/catch`，**任何异常都 `accept`** 并记 `error` 观测。
理由：校验是"额外保险"，不能因为保险丝烧了把数据流掐断。

---

## 四、误判分析（这是最重要的部分）

### 4.1 这个校验一定会误判

同一区域 10 分钟前后，空闲数从 20 掉到 3 是**完全真实**的（下课潮/饭点）。
所以设计目标不是"零误判"，而是**误判代价可控**：

| 保障 | 效果 |
|---|---|
| 只丢单条快照 | 其它节点/下一轮快照不受影响 |
| 不拉黑节点 | 不会因误判让人失联 |
| 记录全部判定 | 可事后核对是哪条被丢了、差在哪 |
| 可切 `warn` 观察 | 先用"只看不丢"跑一周，确认阈值合适再回 `strict` |
| 后台可看逐区域明细 | 「远端 40 vs 本地 2（差 79%）」一眼判断是误判还是真异常 |

### 4.2 阈值怎么定（给数据支撑的方法）

推荐**先 `warn` 跑 7 天**，然后看 `p2p_validation` 的分布：

```sql
SELECT
  CASE
    WHEN deviation < 0.2 THEN '0-20%'
    WHEN deviation < 0.4 THEN '20-40%'
    WHEN deviation < 0.6 THEN '40-60%'
    WHEN deviation < 0.8 THEN '60-80%'
    ELSE '80-100%'
  END AS bucket,
  COUNT(*) AS n
FROM p2p_validation
WHERE decision != 'no_baseline'
GROUP BY bucket;
```

- 如果 90% 的判定落在 `< 0.4` → 阈值 0.5 合适（只砍长尾）
- 如果大量落在 0.4–0.6 → 说明两边数据本来就差异大（可能是两个校区的部署），
  应该**提高阈值**或**只对共享区域校验**
- 如果几乎全是 0–0.2 → 可以收紧到 0.3 更安全

### 4.3 已知会误判的场景（要在文档里承认）

| 场景 | 为什么误判 | 缓解 |
|---|---|---|
| 饭点/下课潮 | 10 分钟内真实剧变 | 窗口别太大（600s），阈值别太低 |
| 远端区域名有细微差异 | `name` 不匹配 → 直接跳过（本就不会判错） | — |
| 远端刚经历上游改版（端口数变了） | `total` 不同 → 跳过（不判错） | — |
| 两个节点在不同校区部署 | 区域集合不同，重叠区域数值本就不同 | 提高阈值 / 只对白名单可信节点校验 |
| 节点时钟慢 5 分钟 | 窗口内匹配到"晚一份"的快照 | 窗口 600s 已覆盖；严重时钟错会走 `clock_suspicious` |

---

## 五、数据结构

### 5.1 判定记录表

```sql
CREATE TABLE IF NOT EXISTS p2p_validation (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ts              TEXT    NOT NULL,        -- 判定发生时间（本地）
  peer_id         TEXT    NOT NULL,        -- 远端节点
  msg_ts          TEXT,                    -- 远端广播时间
  captured_at     TEXT,                    -- 远端数据时刻
  base_snapshot_id INTEGER,                -- 用作基准的本地快照（null = 无基准）
  decision        TEXT    NOT NULL,        -- accept | suspect | drop
  reason          TEXT    NOT NULL,        -- 见 3.1 的 reason 枚举
  deviation       REAL,                    -- 0..1，null = 未计算
  comparable      INTEGER,                 -- 可比区域数
  detail          TEXT,                    -- JSON：逐区域明细
  body_sha256     TEXT                     -- 远端快照摘要（可关联到 snapshots）
);
CREATE INDEX IF NOT EXISTS idx_p2pval_peer_ts ON p2p_validation(peer_id, ts);
CREATE INDEX IF NOT EXISTS idx_p2pval_ts ON p2p_validation(ts);
```

`detail` 示例：
```json
{
  "threshold": 0.5,
  "window_sec": 600,
  "min_areas": 3,
  "areas": [
    { "name": "一食堂东侧", "total": 48, "remote_idle": 40, "local_idle": 2, "deviation": 0.79 },
    { "name": "图书馆北",   "total": 24, "remote_idle": 3,  "local_idle": 4, "deviation": 0.04 }
  ],
  "skipped": [
    { "name": "三食堂", "why": "total_mismatch", "remote_total": 36, "local_total": 12 }
  ]
}
```

### 5.2 配置项（`app_settings`，后台可改，立即生效）

| 键 | 默认 | 范围 | 说明 |
|---|---|---|---|
| `p2p_validate_mode` | `strict` | off/warn/strict | 决策模式 |
| `p2p_validate_threshold` | `0.5` | 0.1–0.9 | 空闲率偏差阈值 |
| `p2p_validate_window_sec` | `600` | 60–3600 | 基准时间窗（±秒） |
| `p2p_validate_min_areas` | `3` | 1–20 | 最少可比区域数 |
| `p2p_validate_fault_min_abs` | `3` | 0–20 | 故障差绝对值门槛 |
| `p2p_validate_fault_min_rel` | `0.2` | 0–1 | 故障差相对门槛 |

后端启动时从 `app_settings` 读，**每次校验时重新读**（走内存缓存 + 写时失效），保证改完立即生效。

---

## 六、观测与告警

### 6.1 节点可信度

```
可信度 = 近 20 次「非 no_baseline」判定中 accept 的占比
```

| 展示 | 含义 |
|---|---|
| `✓ 12/12` | 最近 12 次全部通过 |
| `⚠ 3/12` | 明显不可信 |
| `— ` | 还没有可比基准 |

### 6.2 告警规则

| 级别 | 条件 | 文案 |
|---|---|---|
| 🟡 | 某节点近 20 次判定中 `drop` ≥ 10 次 | 「节点 X 数据可信度低（10/20 次偏差过大），建议切 warn 观察或移除白名单」 |
| 🔵 | 某节点出现 `clock_suspicious` | 「节点 X 时钟可能不准（captured_at 偏差 >24h）」 |
| 🔵 | 首次出现 `drop` | 「开始丢弃来自 X 的快照，可在节点网络页查看逐区域差异」 |

**告警不自动处置**：不拉黑、不改白名单，只提示。

### 6.3 实时可见性

- 节点网络页：可信度列 + 「校验详情」抽屉（最近 50 条，逐区域明细）
- 概览页：若当前有节点可信度 < 50%，概览告警区出现一条
- 日志：每次 `drop` 记 `warn` 级日志（含 sha 前 8 位与偏差值，便于 grep）

---

## 七、接口

### 7.1 后台（管理端）

```
GET /admin/api/nodes/{peer_id}/validation?limit=50&decision=
→ {
    stats: { pass: 12, fail: 3, unknown: 2, credibility: 0.8 },
    items: [{
      ts, decision, reason, deviation, comparable,
      base_snapshot_id, body_sha256,
      areas: [{ name, total, remote_idle, local_idle, deviation }],
      skipped: [{ name, why }]
    }]
  }

POST /admin/api/nodes/validation/mode
  { mode, threshold?, window_sec?, min_areas? }     // 写 app_settings

GET  /admin/api/nodes/{peer_id}/validation/simulate
  ?snapshot_id=...                                  // 用指定快照跑一次"如果当时校验会怎样"
```

`s simulate`（模拟）很有用：**切 strict 之前先拿历史数据试跑**，看会丢掉多少条。

### 7.2 内部（domain 层）

```ts
// server/src/domain/p2pvalidate.ts
export interface ValidateResult { decision, reason, deviation, baseSnapshotId, detail }
export async function validateIncoming(
  payload: Record<string, unknown>,
  msgTs: string | undefined,
  db: Db,
): Promise<ValidateResult>;

export function readValidateConfig(): ValidateConfig;   // 从 app_settings 读（带缓存）
export function invalidateConfigCache(): void;          // 配置写入后调用
```

---

## 八、时序（收到一条广播）

```
远端                 本节点
 │  gossipsub msg
 ├──────────────────►│
                     │ ① SignedMessage.from 在 whitelist？──否──► 静默丢弃
                     │ ② body_sha256 在 30 分钟内出现过？──是──► 丢弃（重复）
                     │ ③ validateIncoming()
                     │     ├ t0 = captured_at ?? msg.ts
                     │     ├ 查基准快照（窗口 ±600s，upload 优先）
                     │     ├ 无基准 ──► accept(no_baseline)
                     │     ├ 按 name 对齐 + total 校验 → 可比区域
                     │     ├ 可比 < 3 ──► accept(insufficient_overlap)
                     │     ├ 算 deviation（空闲率差 + 故障差）
                     │     └ deviation > 0.5 ?
                     │           ├ 否 ──► accept
                     │           ├ strict ──► drop
                     │           └ warn  ──► suspect
                     │ ④ 写 p2p_validation（除 off 模式）
                     │ ⑤ accept/suspect ──► storeSnapshot()
                     │    drop ──► 记 warn 日志 + 可选告警，return
                     ▼
```

---

## 九、边界情况完整清单

| # | 情况 | 处理 | 理由 |
|---|---|---|---|
| 1 | `captured_at` 与 `msg.ts` 都缺失 | accept(`no_baseline`) | 无法定位时刻 |
| 2 | `captured_at` 与本机时间差 > 24h | accept(`no_baseline`) + 记 `clock_suspicious` | 可能是补传历史，也可能时钟错；不轻易丢 |
| 3 | `payload.areas` 缺失/非数组 | **drop**(`invalid_payload`) | 这属于"数据无效"，不是"偏差大"，任何模式都拒 |
| 4 | 窗口内无本地快照 | accept(`no_baseline`) | 新节点不能被饿死 |
| 5 | 基准快照自身 areas 为空 | accept(`no_baseline`) | 基准不可用 |
| 6 | 可比区域 < `min_areas` | accept(`insufficient_overlap`) | 样本太小 |
| 7 | 某区域 `total = 0` | 跳过该区域 | 除零 |
| 8 | 某区域 `total` 两边不同 | 跳过该区域 | 不是同一批硬件 |
| 9 | 远端区域本地没有 | 跳过 | 可能是新增区域 |
| 10 | 本地区域远端没有 | 跳过 | 可能是远端不完整（仍会被其他区域判定） |
| 11 | 所有可比区域 deviation ≤ 阈值 | accept(`within_threshold`) | 正常 |
| 12 | 校验函数内部抛异常 | accept + 记 error | 保险丝不能掐断数据流 |
| 13 | `mode = off` | accept(`mode_off`)，**不写** validation 表 | 关闭时不产生任何开销 |
| 14 | 自己广播回来的（`from === selfId`） | 在 ① 之前就已被白名单/去重挡掉 | 现状已有 |
| 15 | `p2p_validate_mode` 值非法 | 按 `strict` 处理 + 启动时告警 | 失败安全 |
| 16 | 同一远端 1 秒内连发 10 条 | 摘要去重会挡；校验本身也幂等 | — |
| 17 | validation 表增长过快 | 保留 30 天（随 `worker_runs` 一起清理） | — |

---

## 十、性能

| 项 | 评估 |
|---|---|
| 触发频率 | = P2P 快照广播频率 ≈ 每节点每 10 分钟 1 条。双节点约 144 次/天 |
| 单次开销 | 1 次 `snapshots` 区间查询（走新索引）+ 内存比对（≤ 50 个区域）≈ **< 2ms** |
| 写入 | 1 行 `p2p_validation`（~500B）。144 行/天 ≈ 70KB/天，30 天 2MB |
| 索引 | 新增 `idx_snapshots_captured`（`captured_at`），查询 O(log n) |
| 对主流程影响 | 在 P2P 消息回调里同步执行，但耗时 < 2ms，可忽略；若将来节点多，可改为"先落库、异步判定、事后标记/删除" |

**备用方案（若将来开销变大）**：先落库（`payload` 加 `_pending_validate`），由后台任务批量校验，
`drop` 的软删除（加 `deleted_at`）。当前不需要。

---

## 十一、测试策略

### 11.1 纯函数单测（`p2pvalidate.test.ts`）

| 用例 | 期望 |
|---|---|
| 完全一致的两份快照 | `accept(within_threshold)`，deviation=0 |
| 只差 1 个空闲口 | accept |
| 空闲率差 0.79（远端 40/48 vs 本地 2/48） | `drop`（strict 模式） |
| 同上但 `warn` 模式 | `suspect` |
| 同上但 `off` 模式 | `accept(mode_off)`，不写表 |
| 无本地快照 | `accept(no_baseline)` |
| 本地快照在窗口外（±601s） | `accept(no_baseline)` |
| 只有 2 个可比区域（min=3） | `accept(insufficient_overlap)` |
| 区域 `total` 不一致 | 该区域进 `skipped`，不影响其它 |
| 区域 `total=0` | 跳过，不崩 |
| 远端 areas 缺失 | `drop(invalid_payload)` |
| 故障数远端 6 / 本地 0（total=48） | `drop`（fault 路径触发） |
| 内部抛异常（mock db 失败） | `accept` + 记 error |

### 11.2 集成测试（两节点）

用现有 `p2p.test.ts` 的两节点脚手架：
1. 启动 A、B 两个节点（都启用 P2P，互在 whitelist）
2. A 广播一条与 B 同时段明显冲突的快照（如 idle=40 vs B 的 2）
3. 断言：B 的 `snapshots` 表**没有**这条；`p2p_validation` 有 1 条 `decision='drop'`
4. 切 `warn` 再发一次 → 断言落库且 `payload._suspect === true`

### 11.3 手工验证（生产前）

```
1. 部署到备用节点，mode=warn
2. 观察 7 天，导出 deviation 分布（见 4.2 的 SQL）
3. 若分布合理 → 切 strict
4. 切之前先用 simulate 接口对最近 100 条历史跑一遍，确认会丢的比例 < 5%
```

---

## 十二、实施步骤

| 步 | 内容 | 产出 |
|---|---|---|
| 1 | `migrations/sqlite/003_p2p_validation.sql`：建表 + `idx_snapshots_captured` | 表结构 |
| 2 | `domain/p2pvalidate.ts`：`validateIncoming` + `readValidateConfig`（纯逻辑，先写单测） | 算法可测 |
| 3 | `domain/p2p.ts :: ingestSnapshot` 插入校验闸（含 try/catch 兜底） | 生效 |
| 4 | `app_settings` 默认值 + 配置读取缓存 | 可配 |
| 5 | 后台节点网络页：可信度列 + 校验详情抽屉 + 模拟接口 | 可见 |
| 6 | 告警规则接入（可信度 < 50%） | 可观测 |
| 7 | 集成测试（两节点冲突场景） | 回归保护 |

> 建议：**上线先 `warn` 跑一周**，用真实 deviation 分布校准阈值，再切 `strict`。
> 直接 `strict` 上线有把正常波动误杀的风险。

---

## 十三、与「白名单 / 信任开关」的关系（避免概念混淆）

三个机制各管一件事，**互不替代**：

```
P2P_TRUST_NON_WHITELIST   管「不认识的节点，我要不要听」        → 粗粒度开关
白名单 (nodes.json)       管「具体哪些 peerId 我认识」          → 身份
跨节点数据互校（本文）     管「认识的节点这次说的对不对」        → 数据质量
```

典型组合：

| 场景 | 配置 |
|---|---|
| 只信任自己的节点 | 白名单 = 自己+备用；`trust_non_whitelist=false`；`validate_mode=strict` |
| 开放接入但防脏数据 | `trust_non_whitelist=true`；`validate_mode=strict` |
| 观察期 | `validate_mode=warn`（全采纳，只记录） |
| 单节点部署 | 无 P2P 广播，校验不触发 |
