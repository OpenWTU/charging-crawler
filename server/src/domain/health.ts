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
  const res = await sql<{ expires_at: number | null }>`SELECT expires_at FROM token_pool`.execute(db);
  const nowTs = Math.floor(Date.now() / 1000);
  const exps = res.rows.map((r) => Number(r.expires_at ?? 0));
  const valid = exps.filter((e) => e > nowTs);
  const earliest = valid.length ? Math.min(...valid) : null;
  const latest = valid.length ? Math.max(...valid) : null;
  return {
    count: exps.length,
    valid: valid.length,
    // 最早到期：最小 expires_at（用于「快过期」提醒）
    earliest_exp: earliest,
    // 覆盖到：最晚到期（只要还有一个有效 token 就能继续抓取，数据覆盖到最后一个过期）
    cover_until: latest,
    long_lived: valid.filter((e) => e - nowTs > TOKEN_LONG_LIVED_SECONDS).length,
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
