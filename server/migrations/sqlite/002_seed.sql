-- 002_seed.sql —— 幂等的种子数据与兼容迁移
--
-- 与 `cloud/db.py` 的 `migrate_schema()` 尾部逻辑对应。
-- 注意：ALTER TABLE 补列、索引创建、触发器重建在 TypeScript 里做
-- （SQLite 的 ADD COLUMN 不支持 IF NOT EXISTS，必须先用 PRAGMA 判断），
-- 这里只放纯 SQL 能幂等执行的部分。

-- 设备审批开关默认开启（与 Python 版 DEVICE_APPROVAL_KEY 一致）
INSERT OR IGNORE INTO app_settings(key, value) VALUES ('device_approval', 'on');

-- 把历史 tokens 行搬进 token_pool（token 已加密，不再解包）
-- token_pool 没有 user_id 唯一约束，用 NOT EXISTS 保证不重复
INSERT OR IGNORE INTO token_pool(user_id, token, expires_at, updated_at, source)
SELECT t.user_id, t.token, t.expires_at, t.updated_at, 'migrate'
  FROM tokens t
 WHERE t.user_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM token_pool p WHERE p.user_id = t.user_id);
