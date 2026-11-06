"""运行时配置：路径/阈值/端口状态口径/缓存容器与锁。

不变量：
* 本模块只放「模块级常量 + 可变缓存容器 + 小工具」，不依赖 cloud 包内其他模块；
* 缓存容器（dict / Lock）是**同一对象**被各模块 import 使用，因此清缓存必须在
  此模块上操作（cloud.app 门面再导出的是同一对象）；
* ``now_str()`` 是全仓统一的时间戳格式（"%Y-%m-%d %H:%M:%S"，本地时区），
  放在这里是为了让 db/store/security/ports 等模块都能单向依赖它而不产生环。
"""

from __future__ import annotations

import os
import re
import threading
import time


def now_str() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")


MAX_BODY = 1000 * 1024
MAX_SKEW = 300
APK_NAME = re.compile(r"^[A-Za-z0-9._-]+\.apk$")
NONCE_RE = re.compile(r"^[A-Fa-f0-9]{16,64}$")
# 上传端口校验：端口名 1-8 位字母数字/下划线/连字符；单设备 32 个、整包 64 个设备项。
PORT_RE = re.compile(r"^[0-9A-Za-z_-]{1,8}$")
PORT_STATUS_MAX = 16
# 端口状态分组（数据契约 v2 / A1）：平台真实状态 -> 分组，统计一律按分组聚合。
#   free        空闲
#   busy        有人在充/占用（充电中、未充占用、已充满、充满占用、浮充、占用）
#   unavailable 设备侧不可用（端口故障、故障、离线、维护、禁用、绑定、各类硬件故障）
#   unknown     空/无法识别（**原文保留**，不再改写成「其他」）
PORT_GROUP_FREE = "free"
PORT_GROUP_BUSY = "busy"
PORT_GROUP_UNAVAILABLE = "unavailable"
PORT_GROUP_UNKNOWN = "unknown"
PORT_STATUS_GROUPS: dict[str, str] = {
    "空闲": PORT_GROUP_FREE,
    "充电中": PORT_GROUP_BUSY,
    "未充占用": PORT_GROUP_BUSY,
    "已充满": PORT_GROUP_BUSY,
    "充满占用": PORT_GROUP_BUSY,
    "浮充": PORT_GROUP_BUSY,
    "占用": PORT_GROUP_BUSY,
    "端口故障": PORT_GROUP_UNAVAILABLE,
    "故障": PORT_GROUP_UNAVAILABLE,
    "离线": PORT_GROUP_UNAVAILABLE,
    "维护": PORT_GROUP_UNAVAILABLE,
    "禁用": PORT_GROUP_UNAVAILABLE,
    "绑定": PORT_GROUP_UNAVAILABLE,
    "绑定端口": PORT_GROUP_UNAVAILABLE,
    "禁用端口": PORT_GROUP_UNAVAILABLE,
    "存储器损坏": PORT_GROUP_UNAVAILABLE,
    "安全门卡住": PORT_GROUP_UNAVAILABLE,
    "保险丝烧断": PORT_GROUP_UNAVAILABLE,
    "继电器粘连": PORT_GROUP_UNAVAILABLE,
    "门磁芯片损坏": PORT_GROUP_UNAVAILABLE,
    "预检-负载短路": PORT_GROUP_UNAVAILABLE,
    "刷卡芯片损坏故障": PORT_GROUP_UNAVAILABLE,
}
# 平台数字状态码 -> 分组（0 空闲；1/2/3/5 占用；4/6/7/8/9/10/13/15/88/99 不可用）。
PORT_CODE_GROUPS: dict[int, str] = {
    0: PORT_GROUP_FREE,
    1: PORT_GROUP_BUSY,
    2: PORT_GROUP_BUSY,
    3: PORT_GROUP_BUSY,
    5: PORT_GROUP_BUSY,
    4: PORT_GROUP_UNAVAILABLE,
    6: PORT_GROUP_UNAVAILABLE,
    7: PORT_GROUP_UNAVAILABLE,
    8: PORT_GROUP_UNAVAILABLE,
    9: PORT_GROUP_UNAVAILABLE,
    10: PORT_GROUP_UNAVAILABLE,
    13: PORT_GROUP_UNAVAILABLE,
    15: PORT_GROUP_UNAVAILABLE,
    88: PORT_GROUP_UNAVAILABLE,
    99: PORT_GROUP_UNAVAILABLE,
}
# 可识别的状态全集（白名单只用于「哪些能分组」，不再用于改写原文）。
PORT_STATUSES = tuple(PORT_STATUS_GROUPS)
# 兼容保留：v1 曾把无法识别的状态改写成「其他」；v2 起原文保留 + group="unknown"，
# 这个常量只为旧脚本 import 不炸而保留，不再是落库值。
PORT_STATUS_UNKNOWN = "其他"
MAX_PORTS_PER_DEVICE = 32
MAX_PORT_ITEMS = 500
CONTROLLERS_LIMIT = 500
CONTROLLERS_CACHE_TTL = 30
CONTROLLERS_CACHE: dict = {}
CONTROLLERS_CACHE_LOCK = threading.Lock()
# /api/areas-ports：单条 JOIN 查询 + 30 秒缓存 + 设备上限，避免 N+1 放大。
AREAS_PORTS_LIMIT = 500
AREAS_PORTS_CACHE_TTL = 30
AREAS_PORTS_CACHE: dict = {}
AREAS_PORTS_CACHE_LOCK = threading.Lock()


def invalidate_areas_ports_cache() -> None:
    """端口/码牌写入后清缓存，保证 30 秒缓存不会压住刚上传的数据。"""
    with AREAS_PORTS_CACHE_LOCK:
        AREAS_PORTS_CACHE.clear()
    with AREA_PORTS_CACHE_LOCK:
        AREA_PORTS_CACHE.clear()
# 二维码设备号：8 位十六进制（如 acfc1a00），由管理员/POS 小票导入。
QR_DEVICE_RE = re.compile(r"^[0-9A-Fa-f]{8}$")
# 单桩采样历史：接口最多返回最近 120 条。
PILE_HISTORY_LIMIT = 120
# 一次刷新最多尝试的 token 数（池内轮换）。
TOKEN_TRY_LIMIT = 3
# 剩余有效期 > 30 分钟的 token 记为“长寿命”，用于池覆盖评估。
TOKEN_LONG_LIVED_SECONDS = 1800
# 区域快照 + 端口状态统一刷新周期（秒）：单一 worker 循环，先区域后端口。
WORKER_INTERVAL = 600
HEALTH_STALE_SECONDS = WORKER_INTERVAL + 300  # 健康告警留出 worker 周期+余量
# /api/now 到达预测：历史窗口 / 趋势窗口 / 趋势最小跨度 / ETA 上限（分钟）。
NOW_HIST_DAYS = 14
NOW_TREND_MINUTES = 30
NOW_TREND_MIN_SPAN_MIN = 5
NOW_ETA_MAX_MINUTES = 120
# 趋势收缩：t 统计量平方/(t 统计量平方+K)。回测（451 个历史时刻、39 区、3.4 天）
# 显示 30 分钟 OLS 斜率在 10/15/30 分钟尺度上噪声远大于信号，收缩后可把客户端
# 外推误差压掉约 10%~15%，同时保留真实单调变化（t 很大时几乎不收缩）。
NOW_TREND_SHRINK_K = 9.0
# 到达概率：单个空闲端口在未来 10 分钟仍空闲的概率（P(idle=1 时仍 >0) ≈ 0.76）。
NOW_FREE_KEEP_10M = 0.76
# 到达 ETA：前端与后端统一按 80 米/分钟步行速度估算；无坐标时为 null。
NOW_WALK_M_PER_MIN = 80
# analytics 15 分钟固定槽：24 小时 = 96 槽；时区口径由部署环境 TZ 固定为 Asia/Shanghai。
ANALYTICS_SLOT_MINUTES = 15
ANALYTICS_TREND_SLOTS = 96
ANALYTICS_TREND_DAYS = 7
ANALYTICS_TZ = "Asia/Shanghai"
# 满区（idle=0）释放风险率的分层收缩强度，单位“分钟暴露量”：
# 小时层向全局收缩 30 分钟、区域层向小时层收缩 240 分钟（区域样本少、噪声大）。
NOW_ZERO_HOUR_PRIOR_MIN = 30.0
NOW_ZERO_AREA_PRIOR_MIN = 240.0
NOW_ZERO_GLOBAL_PRIOR_EVENTS = 0.5
NOW_ZERO_GLOBAL_PRIOR_MIN = 60.0
# 满区 ETA：用中位等待 ln2/h 再乘经验校准系数（0.6 在训练段把覆盖率校准到 ~0.48）。
NOW_ETA_MEDIAN_SCALE = 0.6
# 反滥用/缓存阈值
ANALYTICS_MISS_LIMIT = 30          # /api/analytics 缓存未命中：每 IP / 60 秒
ANOMALY_SNAPSHOT_SECONDS = 1800    # 与 store_snapshot 的 30 分钟去重窗口对齐
PREDICTION_CACHE_TTL = 60          # /api/now 预测聚合缓存（秒）
PREDICTION_CACHE: dict = {}
PREDICTION_CACHE_LOCK = threading.Lock()
PREDICTION_CACHE_COND = threading.Condition(PREDICTION_CACHE_LOCK)
PREDICTION_CACHE_BUILDING = False
PREDICTION_CACHE_GEN = 0
AREA_PORTS_CACHE_TTL = 30          # /api/area-ports 单 area 缓存
AREA_PORTS_CACHE: dict = {}
AREA_PORTS_CACHE_LOCK = threading.Lock()
AREA_PORTS_DEVICE_LIMIT = 500
HEALTH_CACHE_TTL = 30              # /api/health 只读摘要缓存
HEALTH_CACHE: dict = {}
HEALTH_CACHE_LOCK = threading.Lock()
ADMIN_USER = os.environ.get("ADMIN_USER", "")
ADMIN_PASS = os.environ.get("ADMIN_PASS", "")
ADMIN_PASS_HASH = os.environ.get("ADMIN_PASS_HASH", "")  # scrypt:<salt_hex>:<hash_hex>
RATE: dict = {}
RATE_LOCK = threading.Lock()
REFRESH_LOCK = threading.Lock()
REFRESH_LAST = 0.0
ANALYTICS_CACHE: dict = {}

# 端口状态同步：平台接口每次间隔 0.25s；区域端口超过 5 分钟未更新则按需刷新，
# 同一区域 60 秒内最多触发一次，避免把平台打爆。
PORT_SYNC_INTERVAL = 0.25
PORT_STALE_SECONDS = 900
PORT_REFRESH_COOLDOWN = 60
PORT_SYNC_LOCK = threading.Lock()
AREA_PORT_LAST: dict = {}
AREA_PORT_LOCK = threading.Lock()
AREA_SYNC_LAST = 0.0
SYNC_LOCK = threading.Lock()
AREA_SYNC = {}
AREA_LOCK = threading.Lock()

# ---------------------------------------------------------------------------
# 管理后台网页登录：内存会话 + HttpOnly Cookie（不再使用 HTTP Basic）
# ---------------------------------------------------------------------------
ADMIN_COOKIE = "charge_admin"
ADMIN_SESSION_TTL = 12 * 3600        # 12 小时，访问时滑动续期
ADMIN_SESSION_MAX = 24 * 3600        # 绝对上限 24 小时
ADMIN_LOGIN_WINDOW = 300             # 登录失败计数窗口（秒）
ADMIN_LOGIN_MAX_FAILS = 5            # 窗口内允许的登录失败次数
SESSIONS: dict = {}                  # token -> {"user", "created", "expires"}
SESSION_LOCK = threading.RLock()
WORKER_STATE: dict = {"last_run": None, "last_result": None, "runs": 0,
                      "started_at": None}


TOKEN_KEY_FILE = os.environ.get("TOKEN_KEY_FILE", "/var/lib/charge-cloud/token_key")
