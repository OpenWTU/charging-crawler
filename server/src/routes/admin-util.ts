/**
 * 管理端路由的共享工具：读 body、角色校验、审计包装。
 *
 * 注意：`upload.ts` 把全局 `application/json` parser 改成了 buffer（供 HMAC 验签），
 * 所以所有管理端读 body 都必须走 `readBody()`，不能直接用 `req.body`。
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { roleAtLeast, type AdminRole } from '../domain/adminauth.js';

export interface AdminCtx {
  username: string;
  role: AdminRole;
  mustChange: boolean;
}

/** 读 JSON body（兼容 Buffer / string / object） */
export function readBody<T extends Record<string, unknown>>(req: FastifyRequest): T {
  const raw = req.body as unknown;
  if (Buffer.isBuffer(raw)) {
    try {
      return JSON.parse(raw.toString('utf8')) as T;
    } catch {
      return {} as T;
    }
  }
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as T;
    } catch {
      return {} as T;
    }
  }
  if (raw && typeof raw === 'object') return raw as T;
  return {} as T;
}

/** 当前会话（守卫已保证存在） */
export function adminOf(req: FastifyRequest): AdminCtx {
  return (req as FastifyRequest & { admin: AdminCtx }).admin;
}

/**
 * 角色校验：不满足时已经 send 403，调用方 `return undefined` 即可。
 * 返回 true 表示通过。
 */
export function requireRole(req: FastifyRequest, reply: FastifyReply, min: AdminRole): boolean {
  const admin = adminOf(req);
  if (!roleAtLeast(admin.role, min)) {
    void reply.code(403).send({ ok: false, error: `需要${min === 'ops' ? '运维' : '超级管理员'}及以上权限` });
    return false;
  }
  return true;
}

/** 把 ids 参数规范化成正整数数组 */
export function idList(v: unknown, max = 200): number[] {
  if (!Array.isArray(v)) return [];
  const out: number[] = [];
  for (const x of v) {
    const n = Number(x);
    if (Number.isInteger(n) && n > 0) out.push(n);
    if (out.length >= max) break;
  }
  return out;
}

/** 字符串数组规范化（去空、截断、去重） */
export function strList(v: unknown, max = 200, maxLen = 120): string[] {
  if (!Array.isArray(v)) return [];
  const set = new Set<string>();
  for (const x of v) {
    const s = String(x ?? '').trim().slice(0, maxLen);
    if (s) set.add(s);
    if (set.size >= max) break;
  }
  return [...set];
}

/** 本地时间字符串（与 nowStr 同格式） */
export function nowLocal(): string {
  const d = new Date();
  const p = (x: number): string => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
    + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** N 天前的同一时刻（本地格式） */
export function daysAgo(days: number): string {
  return nowLocal2(new Date(Date.now() - days * 86400_000));
}

export function nowLocal2(d: Date): string {
  const p = (x: number): string => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
    + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 本地时间字符串 → 秒级 epoch（失败返回 0） */
export function parseLocal(ts: string | null | undefined): number {
  if (!ts) return 0;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(ts));
  if (!m) return 0;
  return Math.floor(
    new Date(
      Number(m[1]), Number(m[2]) - 1, Number(m[3]),
      Number(m[4]), Number(m[5]), Number(m[6]),
    ).getTime() / 1000,
  );
}
