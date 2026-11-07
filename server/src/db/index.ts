/**
 * 数据库连接层。
 *
 * 设计要点：
 * 1. **dialect 可切换**：现在用 SqliteDialect + node:sqlite 适配层；迁 PostgreSQL 时
 *    只换这一个函数（换成 PostgresDialect + pg.Pool），上层 Kysely 查询完全不动。
 * 2. **PRAGMA 与 Python 版逐项一致**：WAL + busy_timeout=20000 + synchronous=NORMAL，
 *    保证双跑期两端行为相同。
 * 3. **只读模式**：双跑期 Node 只读生产库，避免与 Python 抢写锁。
 *
 * 为什么不依赖 better-sqlite3：见 ./node-sqlite.ts 顶部说明（原生模块 vs Node 内置）。
 */
import { Kysely, SqliteDialect, sql } from 'kysely';
import fs from 'node:fs';
import path from 'node:path';
import { DATABASE_PATH, DATABASE_READONLY } from '../config.js';
import { logger } from '../logger.js';
import { NodeSqliteDatabase } from './node-sqlite.js';
import type { Database } from './types.js';

export type Db = Kysely<Database>;

let instance: Db | null = null;
let rawDb: NodeSqliteDatabase | null = null;
let instancePath: string | null = null;

/**
 * 创建一个 Kysely 实例。
 *
 * 迁 PostgreSQL 时把这里的 SqliteDialect 换成 PostgresDialect（配合 pg 的 Pool），
 * 其余代码（含所有 query）无需改动 —— 这就是选 Kysely 的原因。
 *
 * 同路径复用已有连接（避免反复初始化泄漏）；换路径时先销毁旧连接。
 */
export function createDb(filePath = DATABASE_PATH, readonly = DATABASE_READONLY): Db {
  if (instance && instancePath === filePath) return instance;
  if (instance) {
    try {
      void instance.destroy();
    } catch {
      /* 旧连接销毁失败不影响新连接 */
    }
    instance = null;
    rawDb = null;
  }
  if (!readonly) fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const db = new NodeSqliteDatabase(filePath, { readonly });

  if (readonly) {
    // 只读连接不能改 journal_mode/synchronous
    db.pragma('busy_timeout = 20000');
  } else {
    // 与 Python 版 init_db() 完全一致
    const wal = db.pragma('journal_mode = WAL');
    const mode = Array.isArray(wal) && wal.length ? String((wal[0] as { journal_mode?: string }).journal_mode ?? wal[0]) : String(wal);
    if (mode.toLowerCase() !== 'wal') {
      logger.warn({ journalMode: mode }, '[db] WAL 未启用');
    }
    db.pragma('busy_timeout = 20000');
    db.pragma('synchronous = NORMAL');
  }

  rawDb = db;
  instance = new Kysely<Database>({
    // 适配层提供了 Kysely SqliteDriver 所需的 prepare/reader/all/run/iterate/close
    dialect: new SqliteDialect({ database: db as never }),
  });
  instancePath = filePath;
  logger.info({ file: filePath, readonly }, '[db] 已连接');
  return instance;
}

export function getDb(): Db {
  if (!instance) return createDb();
  return instance;
}

/** 原生适配层（迁移脚本、PRAGMA 检查用） */
export function getRaw(): NodeSqliteDatabase {
  if (!rawDb) throw new Error('数据库未初始化，请先调用 createDb()');
  return rawDb;
}

export async function closeDb(): Promise<void> {
  if (instance) {
    await instance.destroy();
    instance = null;
  }
  if (rawDb) {
    try {
      rawDb.close();
    } catch {
      /* 已关闭 */
    }
    rawDb = null;
  }
}

/** 健康检查：能跑通一条最简查询即视为可用 */
export async function ping(db: Db = getDb()): Promise<{ ok: boolean; tables: number }> {
  const r = await sql<{ n: number }>`
    SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'
  `.execute(db);
  const tables = Number(r.rows[0]?.n ?? 0);
  return { ok: tables > 0, tables };
}

/** 列出所有表名（迁移器与对拍脚本用） */
export async function listTables(db: Db = getDb()): Promise<string[]> {
  const r = await sql<{ name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `.execute(db);
  return r.rows.map((x) => x.name);
}

/**
 * 业务代码禁止直接拼 SQL：方言差异（ON CONFLICT、LIMIT/OFFSET、RETURNING 等）
 * 由 Kysely 统一处理，迁 PG 时才可能只换 dialect 而不改业务。
 */
export { sql };
