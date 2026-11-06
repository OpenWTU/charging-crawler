/**
 * 令牌解析与令牌池写入（cloud/tokens.py 的写路径）。
 *
 * ⚠️ parse_token 必须与 Python 一致：JWT payload 的 aud 必须等于 "quick_user_api"，
 * encryId 是标准 base64 编码的 user_id，exp 有效区间 (now, now+7200]。
 */
import { sql } from 'kysely';
import { getDb, type Db } from '../db/index.js';
import { nowStr } from './store.js';

/** base64url → 标准 base64（JWT payload 段） */
function b64urlToStd(s: string): string {
  return s.replace(/-/g, '+').replace(/_/g, '/');
}

function b64decodeUtf8(s: string, urlsafe: boolean): string {
  const std = urlsafe ? b64urlToStd(s) : s;
  const pad = '='.repeat((4 - (std.length % 4)) % 4);
  return Buffer.from(std + pad, 'base64').toString('utf8');
}

export interface ParsedToken {
  uid: string;
  exp: number;
}

/** 解析 App 上传的 JWT，返回 {uid, exp} 或 null（与 Python parse_token 一致） */
export function parseToken(token: string): ParsedToken | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(b64decodeUtf8(parts[1]!, true));
    if (payload.aud !== 'quick_user_api') return null;
    const exp = Number(payload.exp || 0);
    const uid = Buffer.from(String(payload.encryId || ''), 'base64').toString('utf8');
    const now = Date.now() / 1000;
    if (!uid || exp <= now || exp > now + 7200) return null;
    return { uid, exp };
  } catch {
    return null;
  }
}

/**
 * 写入令牌池：同 user_id 覆盖更新（expires_at 最新那条），否则新增；
 * 新写入清空 last_error（与 Python _pool_upsert 一致）。返回行 id。
 */
export async function poolUpsert(
  userId: string,
  enc: string,
  exp: number,
  source = 'upload',
  db: Db = getDb(),
): Promise<number> {
  const stamp = nowStr();
  const row = await sql<{ id: number }>`
    SELECT id FROM token_pool WHERE user_id = ${userId}
    ORDER BY expires_at DESC LIMIT 1
  `.execute(db);
  const id = row.rows[0]?.id;
  if (id !== undefined) {
    await sql`
      UPDATE token_pool SET token = ${enc}, expires_at = ${Math.trunc(exp)},
        updated_at = ${stamp}, source = ${source}, last_error = NULL
      WHERE id = ${id}
    `.execute(db);
    return Number(id);
  }
  const ins = await db
    .insertInto('token_pool')
    .values({
      user_id: userId,
      token: enc,
      expires_at: Math.trunc(exp),
      updated_at: stamp,
      source,
      last_error: null,
    })
    .executeTakeFirst();
  return Number(ins?.insertId ?? 0);
}
