# 校园充电桩空位查询

武汉纺织大学阳光校区的充电桩空位实时查询与到达预测：Android App + 网页 + 管理后台 + 服务端抓取。

- 线上示例：`https://charge.example.com/`（部署时替换为你自己的域名）
- 管理后台：`/admin`
- App 更新元数据：`/api/version`

> 本项目为个人用途的校园工具（武汉纺织大学阳光校区），**非官方产品**，与充电桩运营商无关。仅供学习与自用。

## 项目结构

```
cloud/                  服务端（Python 标准库 HTTP + SQLite）
  app.py                门面：显式再导出 + Handler 组合 + create_server/main
  config.py             常量、端口状态分组表、缓存容器与锁
  db.py                 建表与幂等迁移（含触发器）
  security.py           token 密钥、口令 scrypt、后台会话、限流
  geo.py  store.py  snapshots.py  tokens.py
  ports.py              端口状态清洗/分组/健康判定/同步
  prediction.py         到达预测（趋势、历史空闲率、ETA）
  analytics.py          热力图/趋势/排行
  health.py  refresh.py 健康摘要与 worker 编排
  http/                 base.py（分发）api.py（GET 路由）api_upload.py
                        api_ports.py  api_state.py  api_analytics.py
                        admin.py  admin_areas.py  admin_account.py
                        admin_ops.py  static.py
crawler/                上游 H5 抓取：签名客户端、token 解析、抓取锁、保留策略
webui/                  Vue 3 + Vant 4 + ECharts 5，Vite 多入口（index/admin/app）
android/                WebView + JS 桥 App 源码，build.py 离线构建（不含 APK）
tests/                  unittest 全量用例
tools/                  少量可复用脚本（二维码导入、控制器枚举、回测、冒烟）
cloud/deploy/           systemd unit、nginx 样例、备份脚本
```

## 架构

```
微信/快充 H5 ──(token)──> 服务端 worker（每 10 分钟）
                              │  /api/snapshot 设备签名上传
Android App（WebView + JS 桥）──┤  SQLite（WAL）
网页 Vue（Vant + ECharts）──────┤  /api/overview|now|analytics|area-ports
管理后台 Vue（Cookie 会话）─────┘  /admin/api/*
```

- 服务端：`python -m cloud.app`，systemd 服务 `charge-cloud`（样例见 `cloud/deploy/charge-cloud.service`）。
- 前端：`webui/` 构建到 `cloud/web/dist`；App 把同一份产物打包进 `assets/www`，经虚拟域名
  `appassets.androidplatform.net` 加载。
- Android：无 AndroidX 依赖，`android/build.py` 用 aapt2/javac/d8/apksigner 离线出包。

## 功能

- **App**：实时列表、按楼栋推荐（`/api/now`）、分析页（热力图/趋势/排行/同期参考）、
  令牌页（VPN 抓包 / 手动粘贴）、设置（上传令牌、深色、检查更新、诊断）、
  刷新进度（顶部细进度线 + 分阶段文案）、进入即检查更新、令牌失效提示。
- **网页**：同一套实时/分析页面，公开只读。
- **后台**：概览、上传审计、服务器抓取、设备（审批/撤销）、令牌池、账户、
  区域管理、系统、CSV 导出、异常提示。
- **服务端**：设备级 HMAC 签名上传、设备审批开关、区域白名单与总量守恒校验、
  单事务落库、worker 定时抓取、端口级状态同步、每日备份。

## 端口状态口径

上游接口返回的是**状态原文（中文）**，本项目把它归一成四个分组用于快速判定，同时保留原文：

| 分组 | 含义 | 包含的状态原文 |
|---|---|---|
| `free` | 可充 | 空闲 |
| `busy` | 已占用 | 充电中、未充占用、已充满、充满占用、浮充、占用 |
| `unavailable` | 不可用 | 端口故障、故障、离线、维护、禁用、绑定、各类硬件故障 |
| `unknown` | 无法识别 | 其他（原文照旧保留，不丢弃） |

- `/api/*-ports` 的 `summary` 同时给出四分组计数与 `statuses`（逐状态计数），
  便于前端把「充电中 / 已充满 / 浮充」分别展示，而不是并成一个"占用"。
- `port_states.status_group` 由数据库触发器维护，直接改 `status` 也会自动重算。

> 说明：上游**用户端**接口实际只返回 `空闲` / `充电中` 等少数状态；`浮充`、`已充满`
> 等在运营商后台才有。本项目已按全量状态做了映射，上游返回时即可正确显示。

## 安全与数据

- 上传使用设备级 HMAC（时间窗 + nonce 防重放）；旧全局密钥已移除。
- 登录令牌由服务端 AES-GCM 加密存储，仅用于 worker 代为刷新；关闭 App 的「上传令牌」后
  不再上传，同时 App 隐藏分析页、不能主动刷新。
- 管理员口令 scrypt 哈希；会话 HttpOnly + SameSite=Lax + 24 小时绝对上限；登录限速。
- 区域白名单：上传/抓取只接受 `areas` 表登记过的名称。
- 无鉴权只读接口带 IP 限流；后台写操作校验 Origin。

## 数据来源与使用边界

- 数据来自**公开的用户端 H5 接口**，使用**本人账号**的登录令牌，频率受限（每请求 ≥200ms）。
- 仅采集"哪个端口空着"这类面向用户的公开信息，**不采集**其他用户数据、不调用运营商后台接口、
  不做设备控制。
- 请勿用于商业用途；部署到公网前请自行确认上游服务条款与学校/运营商要求。

## 构建

```powershell
# 前端
cd webui
pnpm install
pnpm run build          # 输出到 ../cloud/web/dist

# Android（需自备 Android SDK/JDK，并在 android/build.py 配置路径；
#           release 签名需自备 keystore，见文件顶部说明）
python android/build.py
```

## 部署

一键部署脚本 `deploy.ps1` 需要本机配置（**不入仓库**）：

```powershell
# 1) 复制样例并填写自己的服务器与工具路径
copy deploy.local.ps1.example deploy.local.ps1
#    $cfgHost = 'root@<your-server>'
#    $cfgSshKey = "$env:USERPROFILE\.ssh\<your-key>"
#    $cfgNode/$cfgPnpm/$cfgPy/$cfgPublicUrl 可选

# 2) 执行（构建前端 -> 测试 -> 构建 APK -> 打包上传 -> 远端备份/同步/重启/自检）
pwsh -File deploy.ps1
pwsh -File deploy.ps1 -SkipApk      # 只发服务端
```

也可手工部署（**必须同步整个 `cloud/`，不是单个 app.py**）：

```bash
rsync -a cloud/  <host>:/opt/charge-cloud/cloud/
rsync -a crawler/ <host>:/opt/charge-cloud/crawler/
rsync -a --delete cloud/web/dist/ <host>:/opt/charge-cloud/cloud/web/
ssh <host> 'chown -R www-data:www-data /opt/charge-cloud/cloud /opt/charge-cloud/crawler; systemctl restart charge-cloud'
```

## 运维

- 备份：`cloud/deploy/charge-db-backup.sh` / `charge-backup-bundle.sh`（cron 样例同目录），
  数据库 + 配置 + `token_key` + `version.json`，manifest/sha256 校验，保留 90 天；
  详见 `cloud/deploy/BACKUP.md`。
- 巡检：`curl -s localhost:8788/health`（含 worker 状态、令牌池、错误计数）。
- 数据库迁移：服务启动时自动执行（幂等），升级前建议先跑一次备份。

## 主要接口

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/snapshot` | 设备签名上传（需已审批且未撤销） |
| POST | `/api/device/register` | 设备注册（受审批开关影响） |
| GET | `/api/overview` | 最新快照 + 健康/令牌池字段 |
| GET | `/api/now` | 当前空闲 + 增量 + 到达预测（p_free_10m / p_free_at_arrival / eta_min） |
| GET | `/api/areas-ports` | 全区端口级状态（含分组与逐状态计数） |
| GET | `/api/area-ports?area=` | 单区端口明细 |
| GET | `/api/pile/<device>` | 单桩详情与最近采样 |
| GET | `/api/analytics` | 热力图 / 15 分钟趋势 / 排行 / 同期参考（60s 缓存） |
| GET | `/api/free-rate` | 分时段空闲率 |
| GET | `/api/history?area=` | 单区历史 |
| GET | `/api/area-coords` | 区域坐标 |
| GET | `/health` | 健康摘要 |
| POST | `/api/refresh` | 手动触发抓取（需管理员会话，带冷却） |
| GET | `/api/version` | APK 版本与 sha256 |
| * | `/admin/api/*` | 管理接口（Cookie 会话） |

## 版本与测试

- App：`1.11.39`（versionCode 215）
- 测试：`python -m unittest discover -s tests`（134 项）
- 签名：release keystore 保持在仓库外，SHA256 见 `/api/version`

## 许可证

PolyForm Noncommercial License 1.0.0（SPDX：`PolyForm-Noncommercial-1.0.0`），
**非 OSI 开源许可，禁止商业使用**。详见 `LICENSE` 与 `NOTICE`。
