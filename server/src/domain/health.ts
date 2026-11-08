/**
 * 令牌池统计与健康计数。
 *
 * ⚠️ 与 `cloud/tokens.py::token_pool_stats` 和 `cloud/health.py::health_stats` 逐字段一致。
 */
import { sql } from 'kysely';
import { HEALTH_STALE_SECONDS, TOKEN_LONG_LIVED_SECONDS } from '../config.js';
import { getDb } from '../db/index.js';
import { parseLocalTimestamp } from './ports.js';

export interface TokenPoolStats {
  count: number;
  valid: number;
  earliest_exp: number | null;
  cover_until: number | null;
  long_lived: number;
}

/** 池健康：总数 / 有效数 / 最早到期 / 覆盖到何时 / 长寿命数 */
export async function tokenPoolStats(): Promise<TokenPoolStats> {
  const db = getDb();
  // L12：原来把整表 expires_at 拉到 JS 里算 min/max（/status 与 /api/overview 每次调用）
  const res = await sql<{ n: number; valid: number; min_exp: number | null; max_exp: number | null }>`
    SELECT COUNT(*) AS n,
           SUM(CASE WHEN COALESCE(expires_at, 0) > ${Math.floor(Date.now() / 1000)} THEN 1 ELSE 0 END) AS valid,
           -- M4（复审实测）：原来取全表 MIN，池里只要留 1 条过期 token，
           -- earliest_exp 就恒为 null，「即将过期」提醒永久消失。这里直接排除过期行。
           MIN(CASE WHEN COALESCE(expires_at, 0) > ${Math.floor(Date.now() / 1000)} THEN expires_at END) AS min_exp,
           MAX(expires_at) AS max_exp
      FROM token_pool
  `.execute(db);
  const row = res.rows[0];
  const nowTs = Math.floor(Date.now() / 1000);
  const count = Number(row?.n ?? 0);
  const validCount = Number(row?.valid ?? 0);
  const minExp = row?.min_exp === null || row?.min_exp === undefined ? null : Number(row.min_exp);
  const maxExp = row?.max_exp === null || row?.max_exp === undefined ? null : Number(row.max_exp);
  // 最早到期只看还在有效期内的（min_exp 可能来自已过期的）
  const earliest = minExp !== null && minExp > nowTs ? minExp : null;
  // 覆盖到：最晚到期（只要还有一个有效 token 就能继续抓取）
  const latest = maxExp !== null && maxExp > nowTs ? maxExp : null;
  // 长效数：expires_at 距现在超过阈值的
  const longLivedRes = await sql<{ n: number }>`
    SELECT COUNT(*) AS n FROM token_pool
     WHERE COALESCE(expires_at, 0) - ${nowTs} > ${TOKEN_LONG_LIVED_SECONDS}
  `.execute(db);
  return {
    count,
    valid: validCount,
    earliest_exp: earliest,
    cover_until: latest,
    long_lived: Number(longLivedRes.rows[0]?.n ?? 0),
  };
}

export interface HealthStats {
  stale_devices: number;
  error_tokens: number;
  error_count: number;
}

/**
 * 健康计数（/api/overview.error_count 的唯一来源）。
 * error_count = stale_devices + error_tokens
 *  - stale_devices：controllers 里最近端口更新时间超过 HEALTH_STALE_SECONDS，或从未抓到端口的设备数
 *  - error_tokens：token_pool 中 last_error 非空且仍有效的条数
 */
export async function healthStats(): Promise<HealthStats> {
  const db = getDb();
  const nowTs = Date.now() / 1000;

  const rowsRes = await sql<{
    device_hex: string;
    updated_at: string | null;
    port_at: string | null;
  }>`
    SELECT c.device_hex, c.updated_at,
           (SELECT MAX(p.updated_at) FROM port_states p WHERE p.device_hex = c.device_hex) AS port_at
      FROM controllers c
  `.execute(db);

  const errRes = await sql<{ n: number }>`
    SELECT COUNT(*) AS n FROM token_pool
     WHERE last_error IS NOT NULL AND last_error <> '' AND expires_at > ${Math.floor(nowTs)}
  `.execute(db);
  const errorTokens = Number(errRes.rows[0]?.n ?? 0);

  let stale = 0;
  for (const r of rowsRes.rows) {
    const latest = r.port_at || r.updated_at || '';
    const ts = latest ? parseLocalTimestamp(latest) : null;
    const fresh = ts !== null && nowTs - ts <= HEALTH_STALE_SECONDS;
    if (!fresh) stale += 1;
  }

  return {
    stale_devices: stale,
    error_tokens: errorTokens,
    error_count: stale + errorTokens,
  };
}
