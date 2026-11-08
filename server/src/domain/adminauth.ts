/**
 * 管理后台鉴权：口令哈希、会话签名、CSRF、登录限流、角色判定。
 *
 * 设计要点（详见 docs/admin-plan.md 5.1）：
 *  - 口令用 scrypt（慢哈希），存储格式 `scrypt$N$r$p$<salt-hex>$<hash-hex>`
 *  - 会话用 HMAC-SHA256 签名的 cookie，payload 里带 `v`（账号版本）：改密/禁用/换角色
 *    会让所有旧会话立即失效
 *  - 登录失败按 IP 限流（5 次 / 10 分钟），失败也进审计
 *  - 本模块不直接依赖 Fastify，方便单测
 */
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { logger } from '../logger.js';

/* ---------------- 角色 ---------------- */

export type AdminRole = 'super' | 'ops' | 'viewer';

const ROLE_RANK: Record<AdminRole, number> = { viewer: 1, ops: 2, super: 3 };

export function isRole(v: unknown): v is AdminRole {
  return v === 'super' || v === 'ops' || v === 'viewer';
}

/** 会话角色是否达到所需等级 */
export function roleAtLeast(role: AdminRole, min: AdminRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

/* ---------------- 口令 ---------------- */

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const SALT_BYTES = 32;

/** 口令策略：≥10 位且同时含字母与数字。返回错误文案，通过返回 null */
export function checkPasswordPolicy(pw: string): string | null {
  if (typeof pw !== 'string' || pw.length < 10) return '口令至少 10 位';
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return '口令必须同时包含字母和数字';
  return null;
}

/** 生成口令哈希（scrypt） */
export function hashPassword(pw: string): string {
  const salt = randomBytes(SALT_BYTES);
  const hash = scryptSync(pw, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  }) as Buffer;
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

/** 校验口令（常量时间比对）；格式非法一律 false，绝不抛错 */
export function verifyPassword(pw: string, stored: string): boolean {
  try {
    const parts = String(stored ?? '').split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const N = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    const salt = Buffer.from(parts[4] ?? '', 'hex');
    const expect = Buffer.from(parts[5] ?? '', 'hex');
    if (!N || !r || !p || !salt.length || !expect.length) return false;
    const got = scryptSync(pw, salt, expect.length, { N, r, p }) as Buffer;
    return got.length === expect.length && timingSafeEqual(got, expect);
  } catch {
    return false;
  }
}

/** 用户不存在时也要跑一次 scrypt，否则耗时差 40 倍可枚举用户名（审查 M12） */
const DUMMY_HASH = hashPassword('dummy-password-for-timing');

/** 恒定耗时的口令校验：用户不存在/被禁用时也走同样开销 */
export function verifyPasswordConstantTime(pw: string, stored: string | null | undefined): boolean {
  const ok = stored ? verifyPassword(pw, stored) : false;
  if (!stored) verifyPassword(pw, DUMMY_HASH); // 等时
  return ok;
}

/* ---------------- 会话 ---------------- */

export interface SessionPayload {
  /** username */
  u: string;
  /** role */
  r: AdminRole;
  /** 账号版本：admin_users.updated_at 的短哈希；不匹配即失效 */
  v: string;
  /** 过期时间（秒级 epoch） */
  exp: number;
}

/** 会话密钥：优先 env，缺失则进程内随机（重启失效，并告警） */
const SESSION_SECRET: Buffer = (() => {
  const raw = process.env.ADMIN_SESSION_SECRET;
  if (raw && raw.trim().length >= 16) return Buffer.from(raw.trim(), 'utf8');
  logger.warn(
    '[admin] 未配置 ADMIN_SESSION_SECRET（建议 ≥16 位随机串），本次使用临时密钥，重启后所有会话失效',
  );
  return randomBytes(32);
})();

export const SESSION_TTL_SEC = 8 * 3600;

/** 账号版本号：用于让旧会话失效（改密/禁用/换角色后 updated_at 会变） */
export function accountVersion(updatedAt: string | null | undefined): string {
  const h = createHmac('sha256', SESSION_SECRET).update(String(updatedAt ?? '')).digest('hex');
  return h.slice(0, 8);
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s: string): Buffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

/** 签发会话 token（不含 cookie 属性，属性由路由层设置） */
export function signSession(p: Omit<SessionPayload, 'exp'> & { exp?: number }): string {
  const payload: SessionPayload = {
    u: p.u,
    r: p.r,
    v: p.v,
    exp: p.exp ?? Math.floor(Date.now() / 1000) + SESSION_TTL_SEC,
  };
  const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const sig = b64url(createHmac('sha256', SESSION_SECRET).update(body).digest());
  return `${body}.${sig}`;
}

/** 验签 + 校验过期；任何异常返回 null */
export function verifySession(token: string | undefined | null): SessionPayload | null {
  try {
    if (!token) return null;
    const [body, sig] = String(token).split('.');
    if (!body || !sig) return null;
    const expect = b64url(createHmac('sha256', SESSION_SECRET).update(body).digest());
    const a = Buffer.from(sig);
    const b = Buffer.from(expect);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const payload = JSON.parse(fromB64url(body).toString('utf8')) as SessionPayload;
    if (!payload || typeof payload.u !== 'string' || !isRole(payload.r)) return null;
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

/* ---------------- CSRF ---------------- */

export function newCsrfToken(): string {
  return randomBytes(32).toString('hex');
}

/** 双提交校验：header 与 cookie 相等且非空 */
export function csrfOk(headerVal: string | undefined, cookieVal: string | undefined): boolean {
  if (!headerVal || !cookieVal) return false;
  const a = Buffer.from(String(headerVal));
  const b = Buffer.from(String(cookieVal));
  return a.length === b.length && timingSafeEqual(a, b);
}

/* ---------------- 登录限流（内存） ---------------- */

const LOGIN_MAX_FAILS = 5;
const LOGIN_WINDOW_SEC = 10 * 60;
const LOGIN_LOCK_SEC = 10 * 60;

interface LoginState {
  fails: number;
  windowStart: number;
  lockedUntil: number;
}

const loginState = new Map<string, LoginState>();

export type LoginVerdict = { ok: true } | { ok: false; retryAfterSec: number };

/** 限流键：IP 与 IP+用户名 各计一份（只看 IP 时全站共享一个桶，任何人 5 次就能锁死所有管理员） */
function keysOf(ip: string, username?: string): string[] {
  const out = [`ip:${ip}`];
  const u = String(username ?? '').trim().toLowerCase();
  if (u) out.push(`ipu:${ip}|${u}`);
  return out;
}

/** 是否允许尝试登录（被锁则给出剩余秒数） */
export function loginAllowed(ip: string, username?: string): LoginVerdict {
  const now = Math.floor(Date.now() / 1000);
  for (const key of keysOf(ip, username)) {
    const s = loginState.get(key);
    if (!s) continue;
    if (s.lockedUntil > now) return { ok: false, retryAfterSec: s.lockedUntil - now };
    if (now - s.windowStart > LOGIN_WINDOW_SEC) loginState.delete(key);
  }
  return { ok: true };
}

/** 记一次失败；返回是否触发锁定 */
export function noteLoginFailure(ip: string, username?: string): boolean {
  const now = Math.floor(Date.now() / 1000);
  let locked = false;
  for (const key of keysOf(ip, username)) {
    let s = loginState.get(key);
    if (!s || now - s.windowStart > LOGIN_WINDOW_SEC) {
      s = { fails: 0, windowStart: now, lockedUntil: 0 };
      loginState.set(key, s);
    }
    s.fails += 1;
    if (s.fails >= LOGIN_MAX_FAILS) {
      s.lockedUntil = now + LOGIN_LOCK_SEC;
      locked = true;
    }
  }
  return locked;
}

export function noteLoginSuccess(ip: string, username?: string): void {
  for (const key of keysOf(ip, username)) loginState.delete(key);
}

/* ---------------- 会话黑名单（M13：登出立即失效） ---------------- */

const revoked = new Map<string, number>();

/** 登出时把会话 token 的签名摘要拉黑到过期为止 */
export function revokeSession(token: string | undefined | null): void {
  if (!token) return;
  const exp = verifySession(token)?.exp;
  if (!exp) return;
  const now = Math.floor(Date.now() / 1000);
  if (exp <= now) return;
  const sig = String(token).split('.')[1] ?? token;
  revoked.set(sig, exp);
  // 顺手清已过期的
  for (const [k, e] of revoked) if (e <= now) revoked.delete(k);
}

export function isSessionRevoked(token: string | undefined | null): boolean {
  if (!token) return false;
  const sig = String(token).split('.')[1] ?? token;
  const exp = revoked.get(sig);
  if (!exp) return false;
  if (exp <= Math.floor(Date.now() / 1000)) {
    revoked.delete(sig);
    return false;
  }
  return true;
}

/** 测试用：清空限流状态 */
export function resetLoginState(): void {
  loginState.clear();
}
