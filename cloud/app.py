"""充电桩数据云端门面：组装 Handler、启动服务；领域实现见同包其他模块。

启动：
    python -m cloud.app --host 127.0.0.1 --port 8788 \
        --db cloud/data/charge.db --secret-file cloud/data/upload_secret.txt \
        --version-file cloud/data/version.json --download-dir cloud/data/download

模块划分（单向依赖：http → 领域 → config/db）：
    config      常量/阈值/端口状态口径/缓存容器
    db          SCHEMA / init_db / migrate_schema
    security    token 加解密、口令 scrypt、后台会话、限流
    geo         区域 ID / 坐标解析 / 球面距离
    store       区域、设置、设备审批、逐区校验
    snapshots   上传 payload 校验与快照入库
    ports       端口清洗/落库/同步/健康分组
    tokens      JWT 解析与 token 池
    prediction  到达预测（趋势/风险率/ETA）
    refresh     抓取编排与 worker
    analytics   热力图/趋势/排行
    health      健康计数
    http/*      Handler 的 base / api / admin / static mixin

关键约定见各模块 docstring；本文件只做再导出、组合与进程启动。
"""

from __future__ import annotations

import argparse
import sys
import threading
import types
from datetime import datetime, timedelta  # 兼容：tests 里有 patch.object(cloud_app, "datetime")
from http.server import ThreadingHTTPServer
from pathlib import Path

from . import (
    analytics,
    config,
    db,
    geo,
    health,
    ports,
    prediction,
    refresh,
    security,
    snapshots,
    store,
    tokens,
)
from .http import admin as http_admin
from .http import admin_account as http_admin_account
from .http import admin_areas as http_admin_areas
from .http import admin_ops as http_admin_ops
from .http import api as http_api
from .http import api_analytics as http_api_analytics
from .http import api_ports as http_api_ports
from .http import api_state as http_api_state
from .http import api_upload as http_api_upload
from .http import base as http_base
from .http import static as http_static

from .analytics import (
    build_analytics,
)
from .config import (
    ADMIN_COOKIE, ADMIN_LOGIN_MAX_FAILS, ADMIN_LOGIN_WINDOW, ADMIN_PASS,
    ADMIN_PASS_HASH, ADMIN_SESSION_MAX, ADMIN_SESSION_TTL, ADMIN_USER,
    ANALYTICS_CACHE, ANALYTICS_MISS_LIMIT, ANALYTICS_SLOT_MINUTES,
    ANALYTICS_TREND_DAYS, ANALYTICS_TREND_SLOTS, ANALYTICS_TZ,
    ANOMALY_SNAPSHOT_SECONDS, APK_NAME, AREA_LOCK, AREA_PORTS_CACHE,
    AREA_PORTS_CACHE_LOCK, AREA_PORTS_CACHE_TTL,
    AREA_PORTS_DEVICE_LIMIT, AREA_PORT_LOCK, AREA_PORT_LAST, AREA_SYNC,
    AREA_SYNC_LAST, AREAS_PORTS_CACHE, AREAS_PORTS_CACHE_LOCK,
    AREAS_PORTS_CACHE_TTL, AREAS_PORTS_LIMIT, CONTROLLERS_CACHE,
    CONTROLLERS_CACHE_LOCK, CONTROLLERS_CACHE_TTL, CONTROLLERS_LIMIT,
    HEALTH_CACHE, HEALTH_CACHE_LOCK, HEALTH_CACHE_TTL,
    HEALTH_STALE_SECONDS, MAX_BODY, MAX_PORTS_PER_DEVICE,
    MAX_PORT_ITEMS, MAX_SKEW, NONCE_RE, NOW_ETA_MAX_MINUTES,
    NOW_ETA_MEDIAN_SCALE, NOW_FREE_KEEP_10M, NOW_HIST_DAYS,
    NOW_TREND_MINUTES, NOW_TREND_MIN_SPAN_MIN, NOW_TREND_SHRINK_K,
    NOW_WALK_M_PER_MIN, NOW_ZERO_AREA_PRIOR_MIN,
    NOW_ZERO_GLOBAL_PRIOR_EVENTS, NOW_ZERO_GLOBAL_PRIOR_MIN,
    NOW_ZERO_HOUR_PRIOR_MIN, PILE_HISTORY_LIMIT, PORT_CODE_GROUPS,
    PORT_GROUP_BUSY, PORT_GROUP_FREE, PORT_GROUP_UNAVAILABLE,
    PORT_GROUP_UNKNOWN, PORT_RE, PORT_REFRESH_COOLDOWN,
    PORT_STALE_SECONDS, PORT_STATUS_GROUPS, PORT_STATUSES,
    PORT_STATUS_MAX, PORT_STATUS_UNKNOWN, PORT_SYNC_INTERVAL,
    PORT_SYNC_LOCK, PREDICTION_CACHE, PREDICTION_CACHE_BUILDING,
    PREDICTION_CACHE_COND, PREDICTION_CACHE_GEN, PREDICTION_CACHE_LOCK,
    PREDICTION_CACHE_TTL, QR_DEVICE_RE, RATE, RATE_LOCK, REFRESH_LAST,
    REFRESH_LOCK, SESSIONS, SESSION_LOCK, SYNC_LOCK, TOKEN_KEY_FILE,
    TOKEN_LONG_LIVED_SECONDS, TOKEN_TRY_LIMIT, WORKER_INTERVAL,
    WORKER_STATE, invalidate_areas_ports_cache, now_str,
)
from .db import (
    CONTROLLER_COLUMNS, SCHEMA, ensure_controller_tables, init_db,
    migrate_schema, table_columns,
)
from .geo import (
    EARTH_RADIUS_M, area_id_for_name, haversine_m, parse_coord,
)
from .health import (
    health_stats, health_stats_cached, worker_log_info,
)
from .ports import (
    _clean_port_entries, _clean_ports, _extract_ports, _pile_counts,
    _ports_health, _sync_ports_impl, area_port_state, ports_summary,
    record_pile_sample, status_group, sync_ports,
)
from .prediction import (
    _prediction_confidence, _trend_10m, invalidate_prediction_cache,
    prediction_fields, prediction_stats, prediction_stats_cached,
)
from .refresh import (
    _round_ok, refresh_locked, refresh_round, server_refresh_once,
    start_worker, worker_round,
)
from .security import (
    WEAK_PASSWORDS, _token_key, admin_configured, admin_credentials_ok,
    decrypt_token, encrypt_token, ensure_default_admin, hash_password,
    login_allowed, login_clear_failures, login_record_failure,
    password_weak, rate_ok, read_secret, session_drop, session_login,
    session_touch, session_user, validate_token_key, verify_password,
)
from .snapshots import (
    store_snapshot, validate_payload,
)
from .store import (
    DEVICE_APPROVAL_KEY, DEVICE_STATUSES, check_areas,
    device_approval_enabled, get_setting, seed_areas, set_setting,
    split_valid_areas, upsert_area,
)
from .tokens import (
    _active_tokens, _expire_token, _is_auth_error, _mark_pool_error,
    _pick_token, _pool_upsert, parse_token, token_pool_stats,
)
from .http.base import (
    BaseHandler,
)
from .http.api import (
    ApiMixin,
)
from .http.admin import (
    AdminMixin,
)


class Handler(http_api.ApiMixin, http_admin.AdminMixin, http_static.StaticMixin,
              http_base.BaseHandler):
    """HTTP 入口：api / admin / static 三个 mixin + 基类（分发与通用能力）。"""


_MODULES = (
    config, db, geo, security, tokens, store, snapshots, ports, analytics,
    health, prediction, refresh,
    http_base, http_api, http_api_upload, http_api_ports,
    http_api_state, http_api_analytics,
    http_admin, http_admin_areas, http_admin_account, http_admin_ops,
    http_static,
)

# 允许从门面广播到实现模块的名字白名单（= tests/tools 实际 monkeypatch 的集合）。
# 见 _FacadeModule 的 docstring：非白名单名字只在门面自身生效，不再外溢。
_FACADE_BROADCAST = frozenset({
    # 常量 / 路径（config、security）
    "ADMIN_PASS", "ADMIN_PASS_HASH", "ADMIN_USER",
    "ANALYTICS_MISS_LIMIT", "AREAS_PORTS_LIMIT",
    "REFRESH_LAST", "TOKEN_KEY_FILE",
    # 时钟替身（app / analytics / prediction / http.admin，同为 datetime 类）
    "datetime",
    # 被替换的函数
    "encrypt_token", "health_stats", "prediction_stats",
    "refresh_round", "server_refresh_once", "sync_ports",
})


class _FacadeModule(types.ModuleType):
    """门面模块类型：把**白名单内**的属性赋值广播到持有该名字的实现模块。

    tests/tools 里有 ``cloud_app.TOKEN_KEY_FILE = ...``、
    ``cloud_app.prediction_stats = slow``、``patch.object(cloud_app, "sync_ports")``
    这类「通过门面 monkeypatch」的用法。拆分后实现分散在子模块里，门面因此把赋值
    单向广播给 cloud 包内持有该名字的模块，保证打过补丁的名字在实现模块里同样生效
    （只影响 cloud 包内模块）。

    为什么是白名单而不是「凡有同名就广播」：后者会把**语义不同的同名符号**一起改写。
    典型例子是 ``datetime``——``app`` / ``analytics`` / ``prediction`` / ``http.admin``
    四个模块都有它，现在是同一个类（``from datetime import datetime``），所以广播无害；
    但只要将来有人写成 ``import datetime``（模块对象），广播就会把模块换成类、把类换成
    模块，产生按测试执行顺序才复现的诡异失败。白名单把「魔法」限制在已知集合内，
    新增 monkeypatch 目标时显式加进 ``_FACADE_BROADCAST`` 即可。
    """

    def __setattr__(self, name: str, value: object) -> None:
        super().__setattr__(name, value)
        if name not in _FACADE_BROADCAST:
            return
        for mod in _MODULES:
            if name in vars(mod):
                setattr(mod, name, value)


sys.modules[__name__].__class__ = _FacadeModule


def create_server(db_path: Path, secret_file: Path, version_file: Path,
                  download_dir: Path, host: str = "127.0.0.1",
                  port: int = 8788, web_dir: Path | None = None,
                  workers: bool = True) -> ThreadingHTTPServer:
    conn = init_db(db_path)
    try:
        validate_token_key(conn)
    except Exception:
        conn.close()
        raise
    handler = type("BoundHandler", (Handler,), {
        "db": conn,
        "secret": read_secret(secret_file),
        "version_file": version_file,
        "download_dir": download_dir,
        "web_dir": web_dir or Path(__file__).parent / "web",
    })
    httpd = ThreadingHTTPServer((host, port), handler)
    httpd.db_lock = threading.RLock()
    httpd.db_path = db_path
    if workers:
        start_worker(httpd)
    return httpd


def main() -> int:
    parser = argparse.ArgumentParser(description="充电桩数据云端服务")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8788)
    parser.add_argument("--db", default="cloud/data/charge.db")
    parser.add_argument("--secret-file", default="cloud/data/upload_secret.txt")
    parser.add_argument("--version-file", default="cloud/data/version.json")
    parser.add_argument("--download-dir", default="cloud/data/download")
    parser.add_argument("--web-dir", default="cloud/web")
    args = parser.parse_args()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    httpd = create_server(Path(args.db), Path(args.secret_file),
                          Path(args.version_file), Path(args.download_dir),
                          args.host, args.port, web_dir=Path(args.web_dir))
    print(f"服务已启动: http://{args.host}:{args.port}", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
