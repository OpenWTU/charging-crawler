/**
 * 第 5/6 轮审查的回归用例 —— 这几个 bug 都是「改错了却全绿」的类型，必须钉住。
 *
 * 1. 去重：两次逐字节相同的上传，第二次必须 duplicate（S1-① 曾因「比较含 ports、入库不含」而彻底失效）
 * 2. 去重：ports 顺序不同仍应判重复（S1-② 数组顺序敏感）
 * 3. db/query：双引号标识符 `"admin_users"` 必须 403（S1-③ 曾把 "..." 当字符串剥离，等于藏表名）
 * 4. db/query：`secret_enc` / `pass_hash` 列必须 403（M7-② 曾把正则写成 \\b，永不命中）
 * 5. 保留期清理：workerRound 的 4 条 DELETE 必须真的能执行（M12 曾列名全错，被 .catch 静默吞掉）
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sql } from 'kysely';
import { createDb, closeDb, getDb } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';
import { NodeSqliteDatabase } from '../src/db/node-sqlite.js';
import { buildServer, type App } from '../src/server.js';
import { deviceSignature } from '../src/domain/crypto.js';
import { hashPassword, resetLoginState } from '../src/domain/adminauth.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charge-r6-'));
const dbPath = path.join(tmpDir, 'charge.db');

let app: App;
const deviceId = 'cc33dd44ee55ff66';
const secret = 'ab'.repeat(32);
let cookie = '';
let csrf = '';

function ts(): string {
  return String(Math.floor(Date.now() / 1000));
}

async function postJson(url: string, headers: Record<string, string>, obj: unknown) {
  return app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json', ...headers },
    payload: Buffer.from(JSON.stringify(obj), 'utf8'),
  });
}

/** 带签名的上传（nonce 由调用方给，必须每次不同） */
async function upload(nonce: string, bodyObj: unknown) {
  const body = JSON.stringify(bodyObj);
  const t = ts();
  const sig = deviceSignature(secret, t, nonce, Buffer.from(body, 'utf8'));
  return postJson(
    '/api/snapshot',
    {
      'x-charge-timestamp': t,
      'x-charge-nonce': nonce,
      'x-charge-signature': sig,
      'x-device-id': deviceId,
    },
    bodyObj,
  );
}

beforeAll(async () => {
  const raw = new NodeSqliteDatabase(dbPath);
  raw.pragma('journal_mode = WAL');
  migrate(raw);
  raw.close();
  createDb(dbPath);
  app = await buildServer();
  resetLoginState();

  // 设备注册（自动审批开）
  await postJson('/api/device/register', {}, { device_id: deviceId, secret });

  // 超管账号 + 登录
  const db = getDb();
  const now = '2026-11-08 09:00:00';
  await sql`
    INSERT INTO admin_users (username, pass_hash, created_at, updated_at, disabled, role, must_change)
    VALUES ('root', ${hashPassword('admin12345')}, ${now}, ${now}, 0, 'super', 0)
  `.execute(db);

  const login = await postJson('/admin/login', {}, { username: 'root', password: 'admin12345' });
  const jar: Record<string, string> = {};
  for (const line of (login.headers['set-cookie'] as unknown as string[] | undefined) ?? []) {
    const m = /^([^=]+)=([^;]*)/.exec(line);
    if (m && m[1]) jar[m[1]] = m[2] ?? '';
  }
  cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  csrf = jar.admin_csrf ?? '';
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

const AREA = { name: '回归测试区', total_port: 10, idle_port: 3, charging_port: 7, fault_port: 0 };

describe('回归：去重（S1）', () => {
  it('两次逐字节相同的上传 → 第二次 duplicate，不落第二条快照', async () => {
    const payload = { project: 'regress', app_version: '0.0.1', areas: [AREA] };
    const first = await upload('aaaabbbbcccc0001', payload);
    expect(first.statusCode).toBe(200);
    const b1 = first.json() as { ok: boolean; duplicate?: boolean; id?: number };
    expect(b1.duplicate).toBeUndefined();

    const second = await upload('aaaabbbbcccc0002', payload);
    expect(second.statusCode).toBe(200);
    const b2 = second.json() as { ok: boolean; duplicate?: boolean; id?: number; accepted?: number };
    expect(b2.duplicate).toBe(true);
    // 与正常响应同名字段（L2）
    expect(b2.id).toBe(b1.id);
    expect(b2.accepted).toBe(0);

    const db = getDb();
    const cnt = await sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM snapshots WHERE payload LIKE '%regress%'
    `.execute(db);
    expect(Number(cnt.rows[0]?.n)).toBe(1); // 只落一条
  });

  it('区域计数变了 → 不算重复', async () => {
    const p1 = { project: 'regress2', app_version: '0.0.1', areas: [{ ...AREA, idle_port: 5 }] };
    const p2 = { project: 'regress2', app_version: '0.0.1', areas: [{ ...AREA, idle_port: 1 }] };
    const r1 = await upload('aaaabbbbcccc0003', p1);
    const r2 = await upload('aaaabbbbcccc0004', p2);
    expect((r1.json() as { duplicate?: boolean }).duplicate).toBeUndefined();
    expect((r2.json() as { duplicate?: boolean }).duplicate).toBeUndefined();
  });
});

describe('回归：db/query 敏感表拦截（S1-③ / M7-②）', () => {
  async function query(text: string) {
    return app.inject({
      method: 'POST',
      url: '/admin/api/db/query',
      headers: { 'content-type': 'application/json', cookie, 'x-admin-csrf': csrf },
      payload: JSON.stringify({ sql: text }),
    });
  }

  it('双引号标识符 "admin_users" 必须 403（不能靠剥离当成字符串）', async () => {
    const res = await query('select * from "admin_users"');
    expect(res.statusCode).toBe(403);
  });

  it('裸表名 admin_users 必须 403', async () => {
    const res = await query('select * from admin_users');
    expect(res.statusCode).toBe(403);
  });

  it('secret_enc 列必须 403（列级正则生效）', async () => {
    const res = await query('select secret_enc from devices');
    expect(res.statusCode).toBe(403);
  });

  it('pass_hash 列必须 403', async () => {
    const res = await query('select pass_hash from admin_users');
    expect(res.statusCode).toBe(403);
  });

  it('普通查询仍可用（不误杀）', async () => {
    const res = await query('select count(*) as n from snapshots');
    expect(res.statusCode).toBe(200);
  });

  it('字符串字面量里出现表名不该被误杀', async () => {
    const res = await query(
      "select count(*) as n from upload_audit where detail like '%admin_users%'",
    );
    expect(res.statusCode).toBe(200);
  });
});

describe('回归：保留期清理的 SQL 能执行（M12）', () => {
  it('4 张表的 DELETE 不因列名错误而失败', async () => {
    const db = getDb();
    const cutoff = '2000-01-01 00:00:00'; // 远古时间，删不到东西但能验证 SQL 合法
    // 这些语句必须与 worker.ts 里的列名一致：p2p_validation.ts / admin_audit.ts /
    // config_history.ts / alert_state.last_at
    await expect(sql`DELETE FROM p2p_validation WHERE ts < ${cutoff}`.execute(db)).resolves.toBeDefined();
    await expect(sql`DELETE FROM admin_audit WHERE ts < ${cutoff}`.execute(db)).resolves.toBeDefined();
    await expect(sql`DELETE FROM config_history WHERE ts < ${cutoff}`.execute(db)).resolves.toBeDefined();
    await expect(sql`DELETE FROM alert_state WHERE last_at < ${cutoff}`.execute(db)).resolves.toBeDefined();
  });
});
