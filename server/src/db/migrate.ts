/**
 * 自研迁移器。
 *
 * 为什么不用 ORM 的迁移（Prisma/Drizzle Kit）：现有生产库的 schema 是「既成事实」，
 * 让 ORM 反向生成迁移会改写表结构（丢触发器、改列类型）。这里坚持**手写 SQL +
 * 版本表**，保证与 Python 版 schema 逐字一致。
 *
 * 三层职责：
 *  1. `.sql` 文件：纯 DDL/DML（幂等），按文件名顺序执行一次，记进 schema_migrations
 *  2. `applySchemaPatches()`：SQLite 做不到幂等 DDL 的部分（ALTER ADD COLUMN、
 *     触发器重建），每次启动都跑，靠 PRAGMA / DROP IF EXISTS 保证幂等
 *  3. 迁 PG 时：在 migrations/pg/ 放同名文件，dialect 层选目录，其余不动
 */
import fs from 'node:fs';
import path from 'node:path';
import { SERVER_ROOT } from '../config.js';
import { logger } from '../logger.js';
import { PORT_STATUS_GROUPS, type PortGroup } from '../domain/port-status.js';
import { nowStr } from '../domain/store.js';

const MIGRATION_DIR = path.join(SERVER_ROOT, 'migrations', 'sqlite');

/**
 * 迁移器只依赖这些能力（node:sqlite 与 better-sqlite3 都有），
 * 故意不绑定具体实现，便于将来换驱动或换方言。
 */
export interface MigrateConn {
  prepare(sql: string): {
    all(params?: readonly unknown[]): unknown[];
    run(params?: readonly unknown[]): { changes: number; lastInsertRowid: number | bigint };
    get(params?: readonly unknown[]): unknown;
  };
  exec(sql: string): unknown;
}

function spread(params?: readonly unknown[]): unknown[] {
  if (params === undefined) return [];
  return Array.isArray(params) ? [...params] : [params];
}

/** 手工事务（node:sqlite 没有 better-sqlite3 的 .transaction() 辅助） */
function inTransaction<T>(conn: MigrateConn, fn: () => T): T {
  conn.exec('BEGIN');
  try {
    const out = fn();
    conn.exec('COMMIT');
    return out;
  } catch (err) {
    try {
      conn.exec('ROLLBACK');
    } catch {
      /* 回滚失败时保留原始错误 */
    }
    throw err;
  }
}

/** 生产库可能缺失的可选表（只在某些历史库里存在） */
export const OPTIONAL_TABLES = new Set(['area_status']);

/** 需要补的列：与 Python 的 migrate_schema 一致 */
const COLUMN_PATCHES: Record<string, ReadonlyArray<readonly [string, string]>> = {
  snapshots: [
    ['device_id', 'TEXT'],
    ['real_ip', 'TEXT'],
  ],
  area_samples: [['area_id', 'TEXT']],
  devices: [['status', "TEXT NOT NULL DEFAULT 'approved'"]],
  areas: [
    ['lat', 'REAL'],
    ['lng', 'REAL'],
  ],
  area_status: [['raw_json', 'TEXT']],
  port_states: [['status_group', "TEXT NOT NULL DEFAULT 'unknown'"]],
  pile_samples: [['unavailable', 'INTEGER DEFAULT 0']],
};

/** controllers 的列补丁（Python 的 CONTROLLER_COLUMNS） */
const CONTROLLER_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ['device_hex', 'TEXT'],
  ['code', 'TEXT'],
  ['area_id', 'TEXT'],
  ['area_name', 'TEXT'],
  ['updated_at', 'TEXT'],
  ['qr_device_no', 'TEXT'],
];

function tableNames(conn: MigrateConn): Set<string> {
  const rows = conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
    name: string;
  }>;
  return new Set(rows.map((r) => r.name));
}

function columnNames(conn: MigrateConn, table: string): Set<string> {
  const rows = conn.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

/** 渲染 status → status_group 的 CASE 表达式（与 Python 的 _port_group_case 同构） */
export function portGroupCase(expr = 'NEW.status'): string {
  const whens = Object.entries(PORT_STATUS_GROUPS)
    .filter(([, group]) => (group as string) !== 'unknown')
    .map(([status, group]) => `WHEN '${status.replace(/'/g, "''")}' THEN '${group}'`)
    .join(' ');
  return `CASE ${expr} ${whens} ELSE 'unknown' END`;
}

/** 回填 status_group（只补还没分组的行，幂等） */
function backfillStatusGroup(conn: MigrateConn): void {
  const stmt = conn.prepare(
    "UPDATE port_states SET status_group = ? WHERE status = ? "
      + "AND (status_group IS NULL OR status_group = '' OR status_group = 'unknown')",
  );
  inTransaction(conn, () => {
    for (const [status, group] of Object.entries(PORT_STATUS_GROUPS)) {
      if ((group as string) === 'unknown') continue;
      stmt.run([group as PortGroup, status]);
    }
    conn
      .prepare(
        "UPDATE port_states SET status_group = 'unknown' "
          + "WHERE status_group IS NULL OR status_group = ''",
      )
      .run([]);
  });
}

/** 重建 port_states 的触发器（DROP + CREATE，幂等） */
function ensurePortGroupTriggers(conn: MigrateConn): void {
  const cases = portGroupCase();
  conn.exec('DROP TRIGGER IF EXISTS trg_port_states_group_ins');
  conn.exec('DROP TRIGGER IF EXISTS trg_port_states_group_upd');
  conn.exec(
    `CREATE TRIGGER trg_port_states_group_ins AFTER INSERT ON port_states
     BEGIN
       UPDATE port_states SET status_group = ${cases}
        WHERE device_hex = NEW.device_hex AND port = NEW.port;
     END;`,
  );
  conn.exec(
    `CREATE TRIGGER trg_port_states_group_upd AFTER UPDATE OF status ON port_states
     BEGIN
       UPDATE port_states SET status_group = ${cases}
        WHERE device_hex = NEW.device_hex AND port = NEW.port;
     END;`,
  );
}

/**
 * 应用 schema 补丁（幂等，每次启动都跑）。
 * 对应 Python 的 `migrate_schema()`：补列、补索引、回填、重建触发器。
 */
export function applySchemaPatches(conn: MigrateConn): void {
  const tables = tableNames(conn);

  // 1) 补列
  for (const [table, cols] of Object.entries(COLUMN_PATCHES)) {
    if (!tables.has(table)) continue;
    const have = columnNames(conn, table);
    for (const [col, decl] of cols) {
      if (!have.has(col)) {
        conn.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
        logger.info({ table, column: col }, '[migrate] 补列');
      }
    }
  }

  // 2) controllers 的列（历史库可能缺 qr_device_no 等）
  if (tables.has('controllers')) {
    const have = columnNames(conn, 'controllers');
    for (const [col, decl] of CONTROLLER_COLUMNS) {
      if (!have.has(col)) {
        conn.exec(`ALTER TABLE controllers ADD COLUMN ${col} ${decl}`);
        logger.info({ table: 'controllers', column: col }, '[migrate] 补列');
      }
    }
  }

  // 3) 索引
  conn.exec(
    'CREATE INDEX IF NOT EXISTS idx_samples_area_id ON area_samples(area_id, snapshot_id)',
  );
  // /api/now、/api/history、prediction 都按 snapshot_id 过滤/排序；
  // 已有复合索引前缀是 area_name/area_id，snapshot_id 单列查询会全表扫描
  conn.exec(
    'CREATE INDEX IF NOT EXISTS idx_samples_snapshot ON area_samples(snapshot_id)',
  );
  if (tables.has('port_states')) {
    conn.exec(
      'CREATE INDEX IF NOT EXISTS idx_port_states_group '
        + 'ON port_states(device_hex, status_group)',
    );
    backfillStatusGroup(conn);
    ensurePortGroupTriggers(conn);
  }

  logger.debug({ tables: tables.size }, '[migrate] schema 补丁完成');
}

function listMigrations(): string[] {
  if (!fs.existsSync(MIGRATION_DIR)) return [];
  return fs
    .readdirSync(MIGRATION_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

function ensureMigrationsTable(conn: MigrateConn): void {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);
}

function appliedMigrations(conn: MigrateConn): Set<string> {
  const rows = conn.prepare('SELECT name FROM schema_migrations').all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

export interface MigrateResult {
  applied: string[];
  skipped: string[];
  dryRun: boolean;
}

/** 执行全部迁移。幂等：已执行的跳过。 */
export function migrate(conn: MigrateConn, opts: { dryRun?: boolean } = {}): MigrateResult {
  const dryRun = opts.dryRun ?? false;
  ensureMigrationsTable(conn);
  const done = appliedMigrations(conn);
  const files = listMigrations();
  const applied: string[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    if (done.has(file)) {
      skipped.push(file);
      continue;
    }
    const sqlText = fs.readFileSync(path.join(MIGRATION_DIR, file), 'utf8');
    if (dryRun) {
      logger.info({ file }, '[migrate] (dry-run) 将执行');
      applied.push(file);
      continue;
    }
    inTransaction(conn, () => {
      conn.exec(sqlText);
      conn
        .prepare('INSERT INTO schema_migrations(name, applied_at) VALUES (?, ?)')
        .run([file, nowStr()]);
    });
    logger.info({ file }, '[migrate] 已执行');
    applied.push(file);
  }

  if (!dryRun) applySchemaPatches(conn);

  return { applied, skipped, dryRun };
}

export { spread };
