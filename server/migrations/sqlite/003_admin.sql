-- 003_admin.sql —— 管理后台所需的新表（P1）
--
-- 幂等：全部 CREATE ... IF NOT EXISTS。
-- 给已有表补列（admin_users.role 等）不在这里做——ALTER TABLE 不幂等，
-- 统一走 migrate.ts 的 COLUMN_PATCHES（它先 PRAGMA table_info 再决定是否 ADD）。

-- 管理操作审计：谁在什么时候改了什么
CREATE TABLE IF NOT EXISTS admin_audit (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    ts       TEXT NOT NULL,
    username TEXT,
    action   TEXT NOT NULL,
    target   TEXT,
    detail   TEXT,
    ip       TEXT,
    ok       INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_ts ON admin_audit(ts);
CREATE INDEX IF NOT EXISTS idx_admin_audit_user ON admin_audit(username, ts);

-- 告警状态：同一规则的触发/恢复/忽略状态机
CREATE TABLE IF NOT EXISTS alert_state (
    code        TEXT PRIMARY KEY,
    level       TEXT NOT NULL,
    first_at    TEXT NOT NULL,
    last_at     TEXT NOT NULL,
    resolved_at TEXT,
    ignored     INTEGER NOT NULL DEFAULT 0,
    detail      TEXT
);

-- 配置变更历史（app_settings 的审计面）
CREATE TABLE IF NOT EXISTS config_history (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    ts        TEXT NOT NULL,
    username  TEXT,
    key       TEXT NOT NULL,
    old_value TEXT,
    new_value TEXT
);
CREATE INDEX IF NOT EXISTS idx_config_history_ts ON config_history(ts);

-- 跨节点数据互校的判定记录（详见 docs/p2p-validation.md）
CREATE TABLE IF NOT EXISTS p2p_validation (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    ts               TEXT NOT NULL,
    peer_id          TEXT NOT NULL,
    msg_ts           TEXT,
    captured_at      TEXT,
    base_snapshot_id INTEGER,
    decision         TEXT NOT NULL,
    reason           TEXT NOT NULL,
    deviation        REAL,
    comparable       INTEGER,
    detail           TEXT,
    body_sha256      TEXT
);
CREATE INDEX IF NOT EXISTS idx_p2pval_peer_ts ON p2p_validation(peer_id, ts);
CREATE INDEX IF NOT EXISTS idx_p2pval_ts ON p2p_validation(ts);

-- 流量分钟聚合（概览/流量页用；内存聚合后每分钟落盘一次）
CREATE TABLE IF NOT EXISTS traffic_minute (
    minute  TEXT NOT NULL,
    path    TEXT NOT NULL,
    status  TEXT NOT NULL,
    hits    INTEGER NOT NULL DEFAULT 0,
    uniq_ip INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (minute, path, status)
);
CREATE INDEX IF NOT EXISTS idx_traffic_minute ON traffic_minute(minute);
