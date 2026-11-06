-- 001_init.sql —— 基础表结构
--
-- ⚠️ 与 `cloud/db.py` 的 SCHEMA 常量逐字对应。
-- 修改任何一边都要同步另一边，否则双跑期两边 schema 会漂移。
-- 幂等：全部使用 IF NOT EXISTS，可重复执行。
--
-- 字段类型保持 SQLite 现状（迁 PG 时另写 migrations/pg/001_init.sql，
-- 业务代码通过 Kysely 抽象，不受影响）。

CREATE TABLE IF NOT EXISTS snapshots (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    received_at  TEXT NOT NULL,
    captured_at  TEXT,
    project      TEXT,
    app_version  TEXT,
    token_user   TEXT,
    client_ip    TEXT,
    device_id    TEXT,
    real_ip      TEXT,
    body_sha256  TEXT NOT NULL,
    payload      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snapshots_received ON snapshots(received_at);
CREATE INDEX IF NOT EXISTS idx_snapshots_sha ON snapshots(body_sha256);

CREATE TABLE IF NOT EXISTS nonces (
    nonce    TEXT PRIMARY KEY,
    seen_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS area_samples (
    snapshot_id  INTEGER NOT NULL,
    area_id      TEXT,
    area_name    TEXT NOT NULL,
    idle         INTEGER NOT NULL,
    total        INTEGER NOT NULL,
    charging     INTEGER NOT NULL,
    fault        INTEGER NOT NULL,
    received_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_samples_area ON area_samples(area_name, snapshot_id);
CREATE INDEX IF NOT EXISTS idx_samples_received ON area_samples(received_at);

CREATE TABLE IF NOT EXISTS areas (
    area_id    TEXT PRIMARY KEY,
    name       TEXT UNIQUE,
    first_seen TEXT,
    last_seen  TEXT,
    lat        REAL,
    lng        REAL
);

CREATE TABLE IF NOT EXISTS app_settings (
    key   TEXT PRIMARY KEY,
    value TEXT
);

CREATE TABLE IF NOT EXISTS worker_runs (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    ts     TEXT NOT NULL,
    result TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS upload_audit (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    ts       TEXT NOT NULL,
    ip       TEXT,
    ua       TEXT,
    size     INTEGER,
    result   TEXT,
    detail   TEXT
);

CREATE TABLE IF NOT EXISTS admin_users (
    username   TEXT PRIMARY KEY,
    pass_hash  TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    disabled   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tokens (
    user_id     TEXT PRIMARY KEY,
    token       TEXT NOT NULL,
    expires_at  INTEGER NOT NULL,
    updated_at  TEXT NOT NULL
);

-- token 池：多 token 轮换来源（tokens 只做兼容写入），token 已加密。
CREATE TABLE IF NOT EXISTS token_pool (
    id         INTEGER PRIMARY KEY,
    user_id    TEXT,
    token      TEXT,
    expires_at INTEGER,
    updated_at TEXT,
    source     TEXT,
    last_error TEXT
);

CREATE TABLE IF NOT EXISTS devices (
    device_id   TEXT PRIMARY KEY,
    secret_enc  TEXT NOT NULL,
    model       TEXT,
    app_version TEXT,
    created_at  TEXT NOT NULL,
    last_seen   TEXT,
    uploads     INTEGER NOT NULL DEFAULT 0,
    revoked     INTEGER NOT NULL DEFAULT 0,
    status      TEXT NOT NULL DEFAULT 'approved'
);

-- 控制器：device_hex 形如 00AFEC05，code 为平台十进制桩号，qr_device_no 为码牌
CREATE TABLE IF NOT EXISTS controllers (
    device_hex TEXT PRIMARY KEY,
    code       TEXT,
    area_id    TEXT,
    area_name  TEXT,
    updated_at TEXT,
    qr_device_no TEXT
);

-- 端口实时状态：每个控制器每个端口一行，由 sync_ports 维护
-- status_group：free/busy/unavailable/unknown（数据契约 v2），与原文 status 并存
CREATE TABLE IF NOT EXISTS port_states (
    device_hex TEXT NOT NULL,
    port       TEXT NOT NULL,
    status     TEXT,
    status_group TEXT NOT NULL DEFAULT 'unknown',
    updated_at TEXT,
    PRIMARY KEY (device_hex, port)
);
CREATE INDEX IF NOT EXISTS idx_port_states_device ON port_states(device_hex);

-- 单桩采样：每设备每次抓取一条（同一秒 REPLACE），供单桩详情趋势使用
CREATE TABLE IF NOT EXISTS pile_samples (
    device_hex TEXT NOT NULL,
    ts         TEXT NOT NULL,
    free       INTEGER,
    total      INTEGER,
    busy       INTEGER,
    online     INTEGER,
    unavailable INTEGER DEFAULT 0,
    PRIMARY KEY (device_hex, ts)
);
CREATE INDEX IF NOT EXISTS idx_pile_samples_ts ON pile_samples(ts);
