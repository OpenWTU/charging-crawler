/**
 * 管理操作审计：写 `admin_audit`。
 *
 * 约定：所有会改变状态的 admin 接口都必须调用 `audit()`（成功与失败都记）。
 * 审计失败绝不影响主流程（try/catch 吞掉并 warn）。
 */
import { sql } from 'kysely';
import { getDb } from '../db/index.js';
import { logger } from '../logger.js';

export interface AuditEntry {
  username: string | null;
  /** 动作码，约定见 docs/admin-plan.md：login/logout/password/purge/revoke/settings/peers/... */
  action: string;
  /** 作用对象（id / 名称 / 键名） */
  target?: string | null;
  /** 结构化细节（变更前后、影响行数等） */
  detail?: unknown;
  ip?: string | null;
  ok?: boolean;
}

function nowLocal(): string {
  const d = new Date();
  const p = (x: number): string => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
    + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 写一条审计（不抛错） */
export async function audit(entry: AuditEntry): Promise<void> {
  try {
    const detail = entry.detail === undefined ? null : JSON.stringify(entry.detail);
    await sql`
      INSERT INTO admin_audit (ts, username, action, target, detail, ip, ok)
      VALUES (${nowLocal()}, ${entry.username}, ${entry.action},
              ${entry.target ?? null}, ${detail}, ${entry.ip ?? null},
              ${entry.ok === false ? 0 : 1})
    `.execute(getDb());
  } catch (e) {
    logger.warn({ err: e, action: entry.action }, '[audit] 写入失败（不影响主流程）');
  }
}

export interface AuditRow {
  id: number;
  ts: string;
  username: string | null;
  action: string;
  target: string | null;
  detail: string | null;
  ip: string | null;
  ok: number;
}

/** 分页查询（管理端「审计」页用） */
export async function listAudit(opts: {
  limit?: number;
  beforeId?: number;
  username?: string;
  action?: string;
}): Promise<AuditRow[]> {
  const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), 200);
  const db = getDb();
  let q = sql<AuditRow>`SELECT id, ts, username, action, target, detail, ip, ok FROM admin_audit WHERE 1 = 1`;
  if (opts.beforeId) q = sql`${q} AND id < ${opts.beforeId}`;
  if (opts.username) q = sql`${q} AND username = ${opts.username}`;
  if (opts.action) q = sql`${q} AND action = ${opts.action}`;
  q = sql`${q} ORDER BY id DESC LIMIT ${limit}`;
  const res = await q.execute(db);
  return res.rows;
}
