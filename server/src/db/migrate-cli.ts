#!/usr/bin/env node
/**
 * 迁移命令行。
 *
 * 用法：
 *   npm run migrate                    # 对默认 DATABASE_PATH 执行
 *   DATABASE_PATH=/tmp/x.db npm run migrate
 *   npm run migrate:dry                # 只打印将要执行的迁移
 */
import { DATABASE_PATH } from '../config.js';
import { logger } from '../logger.js';
import { migrate } from './migrate.js';
import { NodeSqliteDatabase } from './node-sqlite.js';

const dryRun = process.argv.includes('--dry-run');
const dbPath = process.env.DATABASE_PATH || DATABASE_PATH;

logger.info({ dbPath, dryRun }, '开始迁移');
const db = new NodeSqliteDatabase(dbPath);

try {
  db.pragma('busy_timeout = 20000');
  if (!dryRun) {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
  }
  const res = migrate(db, { dryRun });
  logger.info(res, '迁移完成');
  process.exitCode = 0;
} catch (err) {
  logger.error({ err }, '迁移失败');
  process.exitCode = 1;
} finally {
  db.close();
}
