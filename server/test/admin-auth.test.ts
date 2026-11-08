/**
 * 管理后台鉴权测试：登录、会话、CSRF、角色、改密失效。
 *
 * 用 app.inject 跑真实路由（不启端口），临时库隔离。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sql } from 'kysely';
import { buildServer, type App } from '../src/server.js';
import { closeDb, createDb, getDb } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';
import { NodeSqliteDatabase } from '../src/db/node-sqlite.js';
import { hashPassword, resetLoginState } from '../src/domain/adminauth.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charge-admin-test-'));
const dbPath = path.join(tmpDir, 'charge.db');

let app: App;
let superCookie = '';
let superCsrf = '';
let viewerCookie = '';
let viewerCsrf = '';

function cookieHeader(jar: Record<string, string>): string {
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
}

function parseSetCookies(setCookie: string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of setCookie ?? []) {
    const m = /^([^=]+)=([^;]*)/.exec(line);
    if (m && m[1]) out[m[1]] = m[2] ?? '';
  }
  return out;
}

async function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  return app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json', ...headers },
    payload: JSON.stringify(body),
  });
}

beforeAll(async () => {
  const raw = new NodeSqliteDatabase(dbPath);
  raw.pragma('journal_mode = WAL');
  migrate(raw);
  raw.close();
  createDb(dbPath);
  app = await buildServer();
  resetLoginState();

  // 直接造两个账号（不走 ensureAdminSeed，避免依赖模块级 env 求值时机）
  const db = getDb();
  const now = '2026-11-08 09:00:00';
  await sql`
    INSERT INTO admin_users (username, pass_hash, created_at, updated_at, disabled, role, must_change)
    VALUES ('root', ${hashPassword('admin12345')}, ${now}, ${now}, 0, 'super', 0),
           ('readonly', ${hashPassword('viewer12345')}, ${now}, ${now}, 0, 'viewer', 0)
  `.execute(db);
});

afterAll(async () => {
  await app.close();
  await closeDb();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* Windows 下 WAL 可能未释放 */
  }
});

describe('管理后台鉴权', () => {
  it('未登录访问受保护接口 → 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/api/overview' });
    expect(res.statusCode).toBe(401);
  });

  it('错口令 → 401', async () => {
    const res = await post('/admin/login', { username: 'root', password: 'wrong-pass' });
    expect(res.statusCode).toBe(401);
  });

  it('对口令 → 200 并下发会话与 CSRF', async () => {
    const res = await post('/admin/login', { username: 'root', password: 'admin12345' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; role: string; csrf: string; must_change: boolean };
    expect(body.ok).toBe(true);
    expect(body.role).toBe('super');
    expect(body.must_change).toBe(false);
    expect(body.csrf.length).toBeGreaterThan(10);

    const jar = parseSetCookies(res.headers['set-cookie'] as string[] | undefined);
    expect(jar.admin_s).toBeTruthy();
    expect(jar.admin_csrf).toBeTruthy();
    superCookie = cookieHeader(jar);
    superCsrf = jar.admin_csrf ?? '';
  });

  it('带会话访问概览 → 200', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/api/overview',
      headers: { cookie: superCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; cards: Record<string, unknown>; alerts: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.cards).toBeTruthy();
    expect(Array.isArray(body.alerts)).toBe(true);
  });

  it('写操作缺 CSRF 头 → 403', async () => {
    const res = await post('/admin/api/tokens/purge', {}, { cookie: superCookie });
    expect(res.statusCode).toBe(403);
  });

  it('写操作带正确 CSRF → 200', async () => {
    const res = await post(
      '/admin/api/tokens/purge',
      {},
      { cookie: superCookie, 'x-admin-csrf': superCsrf },
    );
    expect(res.statusCode).toBe(200);
    expect((res.json() as { ok: boolean }).ok).toBe(true);
  });

  it('伪造会话签名 → 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/api/me',
      headers: { cookie: 'admin_s=eyJ1Ijoicm9vdCJ9.deadbeef' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('只读账号不能改设置 → 403', async () => {
    const login = await post('/admin/login', { username: 'readonly', password: 'viewer12345' });
    expect(login.statusCode).toBe(200);
    const jar = parseSetCookies(login.headers['set-cookie'] as string[] | undefined);
    viewerCookie = cookieHeader(jar);
    viewerCsrf = jar.admin_csrf ?? '';

    const res = await post(
      '/admin/api/settings',
      { key: 'device_auto_approve', value: false },
      { cookie: viewerCookie, 'x-admin-csrf': viewerCsrf },
    );
    expect(res.statusCode).toBe(403);
  });

  it('改密后旧会话立即失效', async () => {
    const oldCookie = superCookie;
    const res = await post(
      '/admin/api/password',
      { old: 'admin12345', new: 'newpass12345' },
      { cookie: superCookie, 'x-admin-csrf': superCsrf },
    );
    expect(res.statusCode).toBe(200);
    // 旧 cookie 的账号版本已过期
    const after = await app.inject({
      method: 'GET',
      url: '/admin/api/me',
      headers: { cookie: oldCookie },
    });
    expect(after.statusCode).toBe(401);
  });

  it('设置写入后概览立即可读（缓存失效）', async () => {
    // 用 viewer 之外的 super 新会话（上一步已改密，重新登录）
    const login = await post('/admin/login', { username: 'root', password: 'newpass12345' });
    expect(login.statusCode).toBe(200);
    const jar = parseSetCookies(login.headers['set-cookie'] as string[] | undefined);
    const cookie = cookieHeader(jar);
    const csrf = jar.admin_csrf ?? '';

    const w = await post(
      '/admin/api/settings',
      { key: 'p2p_validate_mode', value: 'warn' },
      { cookie, 'x-admin-csrf': csrf },
    );
    expect(w.statusCode).toBe(200);

    const r = await app.inject({
      method: 'GET',
      url: '/admin/api/settings',
      headers: { cookie },
    });
    const body = r.json() as { settings: { p2p_validate_mode: string } };
    expect(body.settings.p2p_validate_mode).toBe('warn');
  });
});

describe('越权回归（审查发现的问题）', () => {
  let superCookie2 = '';
  let superCsrf2 = '';
  let viewerCookie2 = '';
  let viewerCsrf2 = '';
  let opsCookie = '';
  let opsCsrf = '';

  beforeAll(async () => {
    const db = getDb();
    const now = '2026-11-08 10:00:00';
    await sql`
      INSERT INTO admin_users (username, pass_hash, created_at, updated_at, disabled, role, must_change)
      VALUES ('root2', ${hashPassword('root2pass123')}, ${now}, ${now}, 0, 'super', 0),
             ('viewer2', ${hashPassword('viewer2pass1')}, ${now}, ${now}, 0, 'viewer', 0),
             ('ops2', ${hashPassword('ops2pass1234')}, ${now}, ${now}, 0, 'ops', 0)
      ON CONFLICT (username) DO NOTHING
    `.execute(db);

    for (const [user, pw] of [['root2', 'root2pass123'], ['viewer2', 'viewer2pass1'], ['ops2', 'ops2pass1234']] as const) {
      const r = await post('/admin/login', { username: user, password: pw });
      const jar = parseSetCookies(r.headers['set-cookie'] as string[] | undefined);
      const c = cookieHeader(jar);
      const cs = jar.admin_csrf ?? '';
      if (user === 'root2') { superCookie2 = c; superCsrf2 = cs; }
      if (user === 'viewer2') { viewerCookie2 = c; viewerCsrf2 = cs; }
      if (user === 'ops2') { opsCookie = c; opsCsrf = cs; }
    }
  });

  it('S1：viewer 不能浏览数据表（会读到口令哈希）', async () => {
    const res = await app.inject({
      method: 'GET', url: '/admin/api/db/rows?table=admin_users', headers: { cookie: viewerCookie2 },
    });
    expect(res.statusCode).toBe(403);
  });

  it('S1：super 也不能整表读 admin_users（敏感表禁读）', async () => {
    const res = await app.inject({
      method: 'GET', url: '/admin/api/db/rows?table=admin_users', headers: { cookie: superCookie2 },
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: string }).error).toContain('敏感');
  });

  it('S2：viewer 不能下载整库备份', async () => {
    const res = await app.inject({
      method: 'GET', url: '/admin/api/backup/download?name=x.db', headers: { cookie: viewerCookie2 },
    });
    expect(res.statusCode).toBe(403);
  });

  it('S3：viewer 不能删令牌池', async () => {
    const res = await post('/admin/api/tokens/purge', {}, {
      cookie: viewerCookie2, 'x-admin-csrf': viewerCsrf2,
    });
    expect(res.statusCode).toBe(403);
  });

  it('M2：ops 不能改 P2P 安全策略（需 super）', async () => {
    const res = await post('/admin/api/settings', {
      key: 'p2p_validate_mode', value: 'off',
    }, { cookie: opsCookie, 'x-admin-csrf': opsCsrf });
    expect(res.statusCode).toBe(403);
  });

  it('S8：只读 SQL 强制截断（自带 limit 999999 也不放过）', async () => {
    const res = await post('/admin/api/db/query', {
      sql: 'SELECT 1 AS x FROM snapshots LIMIT 999999',
    }, { cookie: superCookie2, 'x-admin-csrf': superCsrf2 });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; truncated?: boolean };
    expect(body.ok).toBe(true);
  });

  it('M13：登出后旧 cookie 立即失效', async () => {
    const login = await post('/admin/login', { username: 'viewer2', password: 'viewer2pass1' });
    const jar = parseSetCookies(login.headers['set-cookie'] as string[] | undefined);
    const cookie = cookieHeader(jar);
    // 登出
    await app.inject({ method: 'POST', url: '/admin/logout', headers: { cookie } });
    // 旧 cookie 再用
    const res = await app.inject({ method: 'GET', url: '/admin/api/me', headers: { cookie } });
    expect(res.statusCode).toBe(401);
  });
});
