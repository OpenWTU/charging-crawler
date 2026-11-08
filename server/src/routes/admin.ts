/**
 * 管理后台路由：登录 / 会话守卫 / CSRF / 角色 / 账号 / 设置 / P2P 策略。
 *
 * 设计见 docs/admin-plan.md。要点：
 *  - `/admin/api/*` 全部要求会话；写方法额外要求 CSRF 头与 cookie 一致
 *  - 会话里带账号版本号，改密/禁用/换角色后旧会话立即失效
 *  - `must_change=1` 时除改密外一律 403
 *  - 所有写操作进 `admin_audit`
 *  - 角色：super > ops > viewer（后端强制，前端隐藏只是体验）
 */
import fs from 'node:fs';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { stat as statAsync } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import { ADMIN_INIT_PASSWORD, ADMIN_INIT_USERNAME, WEB_DIST, P2P_ENABLED } from '../config.js';
import {
  accountVersion,
  checkPasswordPolicy,
  csrfOk,
  hashPassword,
  loginAllowed,
  newCsrfToken,
  noteLoginFailure,
  noteLoginSuccess,
  roleAtLeast,
  SESSION_TTL_SEC,
  signSession,
  verifyPassword,
  verifyPasswordConstantTime,
  verifySession,
  revokeSession,
  isSessionRevoked,
  type AdminRole,
} from '../domain/adminauth.js';
import {
  readSettings,
  SETTING_SCHEMA,
  SETTINGS_DEFAULTS,
  writeSetting,
  type SettingKey,
} from '../domain/adminsettings.js';
import { audit, listAudit } from '../domain/adminaudit.js';
import { registerAdminDataRoutes } from './admin-data.js';
import { registerAdminUnitRoutes } from './admin-units.js';
import { registerAdminHistoryRoutes } from './admin-history.js';
import { registerAdminOpsRoutes } from './admin-ops.js';
import { registerAdminSystemRoutes } from './admin-system2.js';
import { getDb } from '../db/index.js';
import { logger } from '../logger.js';

const COOKIE_SESSION = 'admin_s';
const COOKIE_CSRF = 'admin_csrf';
/** 生产走 HTTPS 反代，cookie 必须 Secure；本地 http 开发可设 ADMIN_COOKIE_SECURE=false */
const COOKIE_SECURE = process.env.ADMIN_COOKIE_SECURE !== 'false';

interface AdminCtx {
  username: string;
  role: AdminRole;
  mustChange: boolean;
}
declare module 'fastify' {
  interface FastifyRequest {
    admin?: AdminCtx;
  }
}

function nowLocal(): string {
  const d = new Date();
  const p = (x: number): string => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
    + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/* ---------------- 初始账号 ---------------- */

/**
 * 首次启动（admin_users 为空且配置了 ADMIN_INIT_PASSWORD）创建初始 super 账号。
 * 未配置口令则**不创建**（不留默认口令）。
 */
export async function ensureAdminSeed(): Promise<void> {
  try {
    const db = getDb();
    const res = await sql<{ n: number }>`SELECT COUNT(*) AS n FROM admin_users`.execute(db);
    if (Number(res.rows[0]?.n ?? 0) > 0) return;
    if (!ADMIN_INIT_PASSWORD) {
      logger.warn('[admin] admin_users 为空且未配置 ADMIN_INIT_PASSWORD，未创建管理员（后台无法登录）');
      return;
    }
    const policyErr = checkPasswordPolicy(ADMIN_INIT_PASSWORD);
    if (policyErr) {
      logger.error({ err: policyErr }, '[admin] ADMIN_INIT_PASSWORD 不满足策略，未创建管理员');
      return;
    }
    const ts = nowLocal();
    await sql`
      INSERT INTO admin_users (username, pass_hash, created_at, updated_at, disabled, role, must_change)
      VALUES (${ADMIN_INIT_USERNAME}, ${hashPassword(ADMIN_INIT_PASSWORD)}, ${ts}, ${ts}, 0, 'super', 1)
    `.execute(db);
    logger.info(
      { username: ADMIN_INIT_USERNAME },
      '[admin] 已创建初始管理员（首次登录必须改密）',
    );
  } catch (e) {
    logger.error({ err: e }, '[admin] 初始化管理员失败');
  }
}

/* ---------------- 页面 ---------------- */

async function sendPage(reply: FastifyReply, file: string): Promise<unknown> {
  const full = path.join(WEB_DIST, file);
  try {
    const st = await statAsync(full);
    return reply
      .type('text/html; charset=utf-8')
      .header('Cache-Control', 'no-store')
      .header('Content-Length', st.size)
      .send(createReadStream(full));
  } catch {
    return reply.code(500).send({ ok: false, error: '页面缺失' });
  }
}

/* ---------------- 会话守卫 ---------------- */

async function loadAdmin(req: FastifyRequest): Promise<AdminCtx | null> {
  const token = (req.cookies as Record<string, string> | undefined)?.[COOKIE_SESSION];
  // M13：登出后立即失效（原来只清 cookie，旧 token 8 小时内仍可用）
  if (isSessionRevoked(token)) return null;
  const session = verifySession(token);
  if (!session) return null;
  const res = await sql<{
    username: string;
    role: AdminRole;
    disabled: number;
    updated_at: string | null;
    must_change: number;
  }>`
    SELECT username, role, disabled, updated_at, must_change
      FROM admin_users WHERE username = ${session.u}
  `.execute(getDb());
  const u = res.rows[0];
  if (!u || Number(u.disabled) === 1) return null;
  // 账号版本不匹配 = 改过密/换过角色/被禁用过 → 旧会话失效
  if (accountVersion(u.updated_at) !== session.v) return null;
  return { username: u.username, role: u.role, mustChange: Number(u.must_change) === 1 };
}

function isWrite(method: string): boolean {
  return !['GET', 'HEAD', 'OPTIONS'].includes(method);
}

/**
 * 读取 JSON 请求体。
 *
 * 注意：`upload.ts` 把全局 `application/json` parser 改成了 buffer（供 HMAC 验签用），
 * 所以这里拿到的可能是 Buffer，需要自己 JSON.parse。
 */
function readBody<T extends Record<string, unknown>>(req: FastifyRequest): T {
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

/* ---------------- 路由注册 ---------------- */

export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
  /* ===== 页面 ===== */
  // 页面路径要同时认带尾斜杠的形式：用户手动输入 /admin/ 或分享出去的链接常带斜杠，
  // Fastify 默认不做尾斜杠归一化 → 会落到 notFoundHandler 返回一段 JSON（看起来像挂了）。
  app.get('/admin', async (_req, reply) => sendPage(reply, 'admin.html'));
  app.get('/admin/', async (_req, reply) => sendPage(reply, 'admin.html'));

  const sendLoginPage = async (_req: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    // 优先独立登录页；没有则回退主页面（前端会按未登录态渲染登录表单）
    const file = fs.existsSync(path.join(WEB_DIST, 'admin-login.html'))
      ? 'admin-login.html'
      : 'admin.html';
    return sendPage(reply, file);
  };
  app.get('/admin/login', sendLoginPage);
  app.get('/admin/login/', sendLoginPage);

  /* ===== 公开：登录 / 登出 ===== */
  app.post('/admin/login', async (req, reply) => {
    // L18：登录也要挡一下跨站表单（login-CSRF 能把受害者登到攻击者账号）
    // M9（复审实测）：两处漏洞/误杀
    //   ① 用 x-forwarded-host 做安全判断 → 客户端自带 `X-Forwarded-Host: evil.com` 即可绕过；
    //   ② 用 o.host 精确比较 → 非默认端口部署（host 无端口、Origin 有端口）时管理员登不上。
    // 修法：只信任 req.headers.host，比较时归一化默认端口。
    const origin = req.headers.origin;
    if (origin) {
      try {
        const o = new URL(origin);
        const hostRaw = String(req.headers.host ?? '').split(',')[0]?.trim().toLowerCase();
        // 归一化：去掉默认端口
        const norm = (h: string): string => h
          .replace(/^([^:]+):80$/, '$1')
          .replace(/^([^:]+):443$/, '$1');
        // L-e（复审）：缺 Host 时原来 fail-open（跳过校验）—— 直接拒绝更安全
        if (!hostRaw || norm(o.host.toLowerCase()) !== norm(hostRaw)) {
          return reply.code(403).send({ ok: false, error: '跨站请求被拒绝' });
        }
      } catch {
        return reply.code(403).send({ ok: false, error: 'Origin 非法' });
      }
    }
    const ip = req.ip;
    const body = readBody<{ username?: unknown; password?: unknown }>(req);
    const uname = String(body.username ?? '').trim();
    const verdict = loginAllowed(ip, uname);
    if (!verdict.ok) {
      return reply.code(429).send({
        ok: false,
        error: `尝试过于频繁，请 ${Math.ceil(verdict.retryAfterSec / 60)} 分钟后再试`,
      });
    }
    const username = uname;
    const password = String(body.password ?? '');
    if (!username || !password) {
      return reply.code(400).send({ ok: false, error: '请输入用户名和口令' });
    }
    const res = await sql<{
      username: string;
      pass_hash: string;
      role: AdminRole;
      disabled: number;
      updated_at: string | null;
      must_change: number;
    }>`
      SELECT username, pass_hash, role, disabled, updated_at, must_change
        FROM admin_users WHERE username = ${username}
    `.execute(getDb());
    const u = res.rows[0];
    // M12：用户不存在也跑一次 scrypt，消除 40 倍耗时差（防用户名枚举）
    const passOk = verifyPasswordConstantTime(password, u?.pass_hash);
    if (!u || Number(u.disabled) === 1 || !passOk) {
      const locked = noteLoginFailure(ip, username, Boolean(u));
      await audit({
        username: username || null,
        action: 'login',
        ip,
        ok: false,
        detail: { reason: locked ? 'locked' : 'bad_credentials' },
      });
      return reply.code(401).send({ ok: false, error: '用户名或口令错误' });
    }
    noteLoginSuccess(ip, username);
    const ts = nowLocal();
    await sql`
      UPDATE admin_users SET last_login_at = ${ts}, last_login_ip = ${ip}
       WHERE username = ${u.username}
    `.execute(getDb());
    const token = signSession({
      u: u.username,
      r: u.role,
      v: accountVersion(u.updated_at),
    });
    const csrf = newCsrfToken();
    reply.setCookie(COOKIE_SESSION, token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: COOKIE_SECURE,
      path: '/admin',
      maxAge: SESSION_TTL_SEC,
    });
    reply.setCookie(COOKIE_CSRF, csrf, {
      httpOnly: false, // 前端要读出来放请求头
      sameSite: 'strict',
      secure: COOKIE_SECURE,
      path: '/admin',
      maxAge: SESSION_TTL_SEC,
    });
    await audit({ username: u.username, action: 'login', ip });
    return {
      ok: true,
      username: u.username,
      role: u.role,
      must_change: Number(u.must_change) === 1,
      csrf,
    };
  });

  app.post('/admin/logout', async (req, reply) => {
    const admin = await loadAdmin(req).catch(() => null);
    // M13：把当前 token 拉黑，立即失效
    const tok = (req.cookies as Record<string, string> | undefined)?.[COOKIE_SESSION];
    revokeSession(tok);
    reply.clearCookie(COOKIE_SESSION, { path: '/admin' });
    reply.clearCookie(COOKIE_CSRF, { path: '/admin' });
    if (admin) await audit({ username: admin.username, action: 'logout', ip: req.ip });
    return { ok: true };
  });

  /* ===== 受保护：/admin/api/* ===== */
  await app.register(async (scope) => {
    scope.addHook('preHandler', async (req, reply) => {
      const admin = await loadAdmin(req);
      if (!admin) {
        return reply.code(401).send({ ok: false, error: '未登录或会话已过期' });
      }
      // 未改初始口令前，只允许改密与读会话
      // 用 pathname 比较：req.url 带 query 会把「首次改密」流程锁死（审查 M14）
      const pathname = (req.url.split('?')[0] ?? '');
      if (admin.mustChange && pathname !== '/admin/api/password' && pathname !== '/admin/api/me') {
        return reply.code(403).send({ ok: false, error: '请先修改初始口令' });
      }
      if (isWrite(req.method)) {
        const cookies = (req.cookies as Record<string, string> | undefined) ?? {};
        const header = req.headers['x-admin-csrf'];
        if (!csrfOk(typeof header === 'string' ? header : undefined, cookies[COOKIE_CSRF])) {
          return reply.code(403).send({ ok: false, error: 'CSRF 校验失败，请刷新页面重试' });
        }
      }
      req.admin = admin;
      return undefined;
    });

    /** 当前会话信息（前端启动时调） */
    scope.get('/admin/api/me', async (req) => ({
      ok: true,
      username: req.admin?.username,
      role: req.admin?.role,
      must_change: req.admin?.mustChange ?? false,
      settings_schema: SETTING_SCHEMA,
      settings_defaults: SETTINGS_DEFAULTS,
    }));

    /* ----- 改密（自己） ----- */
    scope.post('/admin/api/password', async (req, reply) => {
      const admin = req.admin as AdminCtx;
      const body = readBody<{ old?: unknown; new?: unknown }>(req);
      const oldPw = String(body.old ?? '');
      const newPw = String(body.new ?? '');
      const policyErr = checkPasswordPolicy(newPw);
      if (policyErr) return reply.code(400).send({ ok: false, error: policyErr });
      const db = getDb();
      const res = await sql<{ pass_hash: string }>`
        SELECT pass_hash FROM admin_users WHERE username = ${admin.username}
      `.execute(db);
      const row = res.rows[0];
      if (!row || !verifyPassword(oldPw, row.pass_hash)) {
        await audit({
          username: admin.username,
          action: 'password',
          ip: req.ip,
          ok: false,
          detail: { reason: 'old_mismatch' },
        });
        return reply.code(400).send({ ok: false, error: '原口令不正确' });
      }
      const ts = nowLocal();
      await sql`
        UPDATE admin_users
           SET pass_hash = ${hashPassword(newPw)}, must_change = 0, updated_at = ${ts}
         WHERE username = ${admin.username}
      `.execute(db);
      await audit({ username: admin.username, action: 'password', ip: req.ip });
      // 改密后旧会话全部失效：重新签发一个
      const token = signSession({ u: admin.username, r: admin.role, v: accountVersion(ts) });
      reply.setCookie(COOKIE_SESSION, token, {
        httpOnly: true,
        sameSite: 'strict',
        secure: COOKIE_SECURE,
        path: '/admin',
        maxAge: SESSION_TTL_SEC,
      });
      return { ok: true };
    });

    /* ----- 账号管理（仅 super） ----- */
    const requireSuper = (req: FastifyRequest, reply: FastifyReply): boolean => {
      const admin = req.admin as AdminCtx;
      if (!roleAtLeast(admin.role, 'super')) {
        void reply.code(403).send({ ok: false, error: '需要超级管理员权限' });
        return false;
      }
      return true;
    };

    scope.get('/admin/api/accounts', async (req, reply) => {
      if (!requireSuper(req, reply)) return undefined;
      const res = await sql<{
        username: string;
        role: AdminRole;
        disabled: number;
        must_change: number;
        created_at: string;
        updated_at: string;
        last_login_at: string | null;
        last_login_ip: string | null;
      }>`
        SELECT username, role, disabled, must_change, created_at, updated_at,
               last_login_at, last_login_ip
          FROM admin_users ORDER BY username
      `.execute(getDb());
      return { ok: true, accounts: res.rows };
    });

    scope.post('/admin/api/accounts', async (req, reply) => {
      if (!requireSuper(req, reply)) return undefined;
      const admin = req.admin as AdminCtx;
      const body = readBody<{ username?: unknown; password?: unknown; role?: unknown }>(req);
      const username = String(body.username ?? '').trim();
      const password = String(body.password ?? '');
      const role = String(body.role ?? 'viewer');
      if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) {
        return reply.code(400).send({ ok: false, error: '用户名需 3–32 位字母数字或 _.-' });
      }
      if (!['super', 'ops', 'viewer'].includes(role)) {
        return reply.code(400).send({ ok: false, error: '角色非法' });
      }
      const policyErr = checkPasswordPolicy(password);
      if (policyErr) return reply.code(400).send({ ok: false, error: policyErr });
      const db = getDb();
      const ts = nowLocal();
      // L16：直接 INSERT，靠主键冲突判重（原来 SELECT 再 INSERT 非原子，并发会 500）
      try {
        await sql`
          INSERT INTO admin_users (username, pass_hash, created_at, updated_at, disabled, role, must_change)
          VALUES (${username}, ${hashPassword(password)}, ${ts}, ${ts}, 0, ${role as AdminRole}, 0)
        `.execute(db);
      } catch (e) {
        if (/UNIQUE constraint failed/i.test(String((e as Error).message ?? ''))) {
          return reply.code(409).send({ ok: false, error: '用户名已存在' });
        }
        throw e;
      }
      await audit({ username: admin.username, action: 'account_add', target: username, ip: req.ip, detail: { role } });
      return { ok: true };
    });

    scope.post('/admin/api/accounts/disable', async (req, reply) => {
      if (!requireSuper(req, reply)) return undefined;
      const admin = req.admin as AdminCtx;
      const body = readBody<{ username?: unknown; disabled?: unknown }>(req);
      const username = String(body.username ?? '').trim();
      const disabled = body.disabled === true;
      if (username === admin.username) {
        return reply.code(400).send({ ok: false, error: '不能禁用自己的账号' });
      }
      const db = getDb();
      const ts = nowLocal();
      const r = await sql`
        UPDATE admin_users SET disabled = ${disabled ? 1 : 0}, updated_at = ${ts}
         WHERE username = ${username}
      `.execute(db);
      if (!r.numAffectedRows) return reply.code(404).send({ ok: false, error: '账号不存在' });
      await audit({ username: admin.username, action: 'account_disable', target: username, ip: req.ip, detail: { disabled } });
      return { ok: true };
    });

    scope.post('/admin/api/accounts/password', async (req, reply) => {
      if (!requireSuper(req, reply)) return undefined;
      const admin = req.admin as AdminCtx;
      const body = readBody<{ username?: unknown; password?: unknown }>(req);
      const username = String(body.username ?? '').trim();
      const password = String(body.password ?? '');
      const policyErr = checkPasswordPolicy(password);
      if (policyErr) return reply.code(400).send({ ok: false, error: policyErr });
      const db = getDb();
      const ts = nowLocal();
      const r = await sql`
        UPDATE admin_users SET pass_hash = ${hashPassword(password)}, must_change = 1, updated_at = ${ts}
         WHERE username = ${username}
      `.execute(db);
      if (!r.numAffectedRows) return reply.code(404).send({ ok: false, error: '账号不存在' });
      await audit({ username: admin.username, action: 'account_password', target: username, ip: req.ip });
      return { ok: true, must_change: true };
    });

    scope.post('/admin/api/accounts/role', async (req, reply) => {
      if (!requireSuper(req, reply)) return undefined;
      const admin = req.admin as AdminCtx;
      const body = readBody<{ username?: unknown; role?: unknown }>(req);
      const target = String(body.username ?? '').trim();
      const role = String(body.role ?? '');
      if (!['super', 'ops', 'viewer'].includes(role)) {
        return reply.code(400).send({ ok: false, error: '角色非法' });
      }
      if (target === admin.username) {
        return reply.code(400).send({ ok: false, error: '不能改自己的角色（避免把自己锁死）' });
      }
      const ts = nowLocal();
      const r = await sql`
        UPDATE admin_users SET role = ${role as AdminRole}, updated_at = ${ts}
         WHERE username = ${target}
      `.execute(getDb());
      if (!r.numAffectedRows) return reply.code(404).send({ ok: false, error: '账号不存在' });
      await audit({ username: admin.username, action: 'account_role', target, ip: req.ip, detail: { role } });
      return { ok: true, role };
    });

    scope.delete('/admin/api/accounts/:username', async (req, reply) => {
      if (!requireSuper(req, reply)) return undefined;
      const admin = req.admin as AdminCtx;
      const target = String((req.params as { username?: string }).username ?? '');
      if (target === admin.username) {
        return reply.code(400).send({ ok: false, error: '不能删除自己的账号' });
      }
      const r = await sql`DELETE FROM admin_users WHERE username = ${target}`.execute(getDb());
      if (!r.numAffectedRows) return reply.code(404).send({ ok: false, error: '账号不存在' });
      await audit({ username: admin.username, action: 'account_delete', target, ip: req.ip });
      return { ok: true };
    });

    /* ----- 设置（读：任意登录；写：ops 及以上） ----- */
    scope.get('/admin/api/settings', async () => {
      const settings = await readSettings();
      return { ok: true, settings, schema: SETTING_SCHEMA, defaults: SETTINGS_DEFAULTS };
    });

    scope.post('/admin/api/settings', async (req, reply) => {
      const admin = req.admin as AdminCtx;
      if (!roleAtLeast(admin.role, 'ops')) {
        return reply.code(403).send({ ok: false, error: '需要运维及以上权限' });
      }
      const body = readBody<{ key?: unknown; value?: unknown }>(req);
      const key = String(body.key ?? '') as SettingKey;
      if (!Object.hasOwn(SETTINGS_DEFAULTS, key)) {
        return reply.code(400).send({ ok: false, error: '未知设置项' });
      }
      // P2P 信任/互校/白名单属于安全策略，运维只能看不能改（审查 M2）
      const SUPER_ONLY: Set<string> = new Set([
        'p2p_trust_non_whitelist', 'p2p_validate_mode', 'p2p_validate_threshold',
        'p2p_validate_window_sec', 'p2p_validate_min_areas', 'p2p_extra_peers',
      ]);
      if (SUPER_ONLY.has(key) && !roleAtLeast(admin.role, 'super')) {
        return reply.code(403).send({ ok: false, error: 'P2P 安全策略需要超级管理员权限' });
      }
      try {
        const r = await writeSetting(key, body.value, admin.username);
        await audit({
          username: admin.username,
          action: 'settings',
          target: key,
          ip: req.ip,
          detail: { old: r.oldValue, new: r.newValue },
        });
        return { ok: true, key, value: r.newValue };
      } catch (e) {
        return reply.code(400).send({
          ok: false,
          error: e instanceof Error ? e.message : '设置写入失败',
        });
      }
    });

    /* ----- 配置变更历史 ----- */
    scope.get('/admin/api/settings/history', async (req) => {
      const limit = Math.min(Number((req.query as { limit?: string }).limit) || 50, 200);
      const res = await sql<{
        id: number;
        ts: string;
        username: string | null;
        key: string;
        old_value: string | null;
        new_value: string | null;
      }>`
        SELECT id, ts, username, key, old_value, new_value
          FROM config_history ORDER BY id DESC LIMIT ${limit}
      `.execute(getDb());
      return { ok: true, items: res.rows };
    });

    /* ----- 审计 ----- */
    scope.get('/admin/api/audit', async (req) => {
      const q = req.query as { limit?: string; before_id?: string; username?: string; action?: string };
      const items = await listAudit({
        limit: Number(q.limit) || 50,
        beforeId: Number(q.before_id) || undefined,
        username: q.username,
        action: q.action,
      });
      return { ok: true, items };
    });

    /* ----- P2P 策略与节点（从旧版只读端点迁移，纳入鉴权） ----- */
    scope.get('/admin/api/p2p', async () => {
      const settings = await readSettings();
      return {
        ok: true,
        readonly: false,
        policy: {
          p2p_enabled: P2P_ENABLED,
          // 设置优先于 env：null = 跟随 env
          trust_non_whitelist: settings.p2p_trust_non_whitelist,
          validate_mode: settings.p2p_validate_mode,
          extra_peers: settings.p2p_extra_peers,
        },
      };
    });

    /* ----- 业务数据：概览 / 趋势 / 令牌池 / 实时 / 系统 / 告警 ----- */
    await registerAdminDataRoutes(scope);
    /* ----- 上传设备 / 桩 / 区域 ----- */
    await registerAdminUnitRoutes(scope);
    /* ----- 历史分析 / CSV 导出 / 数据质量 ----- */
    await registerAdminHistoryRoutes(scope);
    /* ----- 节点网络 / 任务 / 日志 / 配置 / 流量 ----- */
    await registerAdminOpsRoutes(scope);
    /* ----- 版本发布 / 备份恢复 / 数据浏览器 ----- */
    await registerAdminSystemRoutes(scope);
  }, { prefix: '' });

  logger.info('[admin] 管理后台路由已注册');
}

/** 供测试/工具读取页面目录（避免重复拼接） */
export const adminPageDir = WEB_DIST;
export const __dirnameOfAdminModule = path.dirname(fileURLToPath(import.meta.url));
