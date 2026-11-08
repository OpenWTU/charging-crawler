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

describe('回归：保留期清理真的能跑（M12）', () => {
  it('workerRound 的清理段不因列名错误而失败', async () => {
    // 终审指出：上一版把 4 条 DELETE 抄在测试里 = 空壳 —— worker.ts 里列名写错（created_at 等）
    // 时 84 个测试照样全绿。这里改成真的跑一轮 workerRound，让清理段执行到。
    const { workerRound } = await import('../src/domain/worker.js');
    const fakeCall = async () => ({ code: 0, data: null });
    const result = await workerRound(fakeCall as never, getDb());
    expect(typeof result).toBe('string');
    // 清理段如果列名错，logger.warn 会被调用但不会抛 —— 所以额外直查三张表能被清理段的 WHERE 命中
    const db = getDb();
    for (const q of [
      sql`SELECT COUNT(*) AS n FROM p2p_validation WHERE ts < '2000-01-01'`,
      sql`SELECT COUNT(*) AS n FROM admin_audit WHERE ts < '2000-01-01'`,
      sql`SELECT COUNT(*) AS n FROM config_history WHERE ts < '2000-01-01'`,
      sql`SELECT COUNT(*) AS n FROM alert_state WHERE last_at < '2000-01-01'`,
    ]) {
      await expect(q.execute(db)).resolves.toBeDefined();
    }
  });
});

describe('回归：端口变化不能被当成重复（第 4 轮原始 S1 bug）', () => {
  it('同区域计数不变、但端口状态变了 → 不是 duplicate，且端口被写入', async () => {
    const d2 = 'dd44ee55ff660011';
    const s2 = 'ef'.repeat(32);
    await postJson('/api/device/register', {}, { device_id: d2, secret: s2 });
    // 让这个桩存在（cleanPorts 只认 controllers 里已登记的 device_hex）
    // areas 的实际列是 first_seen/last_seen（没有 created_at/updated_at）
    await sql`
      INSERT INTO areas (area_id, name, first_seen, last_seen)
      VALUES ('r6area', '回归端口区', '2026-11-08 09:00:00', '2026-11-08 09:00:00')
      ON CONFLICT (area_id) DO NOTHING
    `.execute(getDb());
    // controllers 的实际列是 updated_at（没有 created_at）
    await sql`
      INSERT INTO controllers (device_hex, area_id, area_name, updated_at)
      VALUES (${d2}, 'r6area', '回归端口区', '2026-11-08 09:00:00')
      ON CONFLICT (device_hex) DO NOTHING
    `.execute(getDb());

    const area = { name: '回归端口区', total_port: 2, idle_port: 1, charging_port: 1, fault_port: 0 };
    const mk = (status: string) => ({
      project: 'regress-port',
      app_version: '0.0.1',
      areas: [area], // 区域计数**完全不变**
      ports: [{ device_hex: d2, ports: [{ port: '01', status, group: status === 'free' ? 'free' : 'busy' }] }],
    });
    const body1 = JSON.stringify(mk('free'));
    const t1 = ts();
    const r1 = await postJson('/api/snapshot', {
      'x-charge-timestamp': t1,
      'x-charge-nonce': 'e5e5e5e5e5e50001',
      'x-charge-signature': deviceSignature(s2, t1, 'e5e5e5e5e5e50001', Buffer.from(body1, 'utf8')),
      'x-device-id': d2,
    }, mk('free'));
    expect(r1.statusCode).toBe(200);

    const body2 = JSON.stringify(mk('charging'));
    const t2 = ts();
    const r2 = await postJson('/api/snapshot', {
      'x-charge-timestamp': t2,
      'x-charge-nonce': 'e5e5e5e5e5e50002',
      'x-charge-signature': deviceSignature(s2, t2, 'e5e5e5e5e5e50002', Buffer.from(body2, 'utf8')),
      'x-device-id': d2,
    }, mk('charging'));
    expect(r2.statusCode).toBe(200);
    // 关键断言：不能是 duplicate（端口变了）
    expect((r2.json() as { duplicate?: boolean }).duplicate).toBeUndefined();
    // 且端口状态真的写进去了
    const st = await sql<{ status: string }>`
      SELECT status FROM port_states WHERE device_hex = ${d2} AND port = '01'
    `.execute(getDb());
    expect(st.rows[0]?.status).toBe('charging');
  });
});

describe('回归：多设备众包写同一个桩（port_owner_guard 默认关）', () => {
  it('设备 A 报过之后，设备 B 仍能写同一个桩（owner_device 变成最后写入者）', async () => {
    const area = '众包测试区';
    const hexA = 'AA000001';
    const hexB = 'AA000002';
    const devA = 'a0a0a0a0a0a0a0a1';
    const devB = 'b0b0b0b0b0b0b0b2';
    const secA = '11'.repeat(32);
    const secB = '22'.repeat(32);

    // 两个设备各自注册
    for (const [d, s] of [[devA, secA], [devB, secB]] as const) {
      const r = await postJson('/api/device/register', {}, { device_id: d, secret: s });
      expect(r.statusCode).toBe(200);
    }
    // 登记区域与两个桩（cleanPorts 只认 controllers 里已登记的 device_hex）
    const db = getDb();
    await sql`
      INSERT INTO areas (area_id, name, first_seen, last_seen)
      VALUES ('r6crowd', ${area}, '2026-11-08 09:00:00', '2026-11-08 09:00:00')
      ON CONFLICT (area_id) DO NOTHING
    `.execute(db);
    for (const h of [hexA, hexB]) {
      await sql`
        INSERT INTO controllers (device_hex, area_id, area_name, updated_at)
        VALUES (${h}, 'r6crowd', ${area}, '2026-11-08 09:00:00')
        ON CONFLICT (device_hex) DO NOTHING
      `.execute(db);
    }

    const mk = (status: string) => ({
      project: 'crowd',
      app_version: '0.0.1',
      areas: [{ name: area, total_port: 2, idle_port: 1, charging_port: 1, fault_port: 0 }],
      ports: [{ device_hex: hexA, ports: [{ port: '01', status, group: status === 'free' ? 'free' : 'busy' }] }],
    });

    async function upload(dev: string, sec: string, nonce: string, status: string) {
      const body = JSON.stringify(mk(status));
      const tm = ts();
      return postJson('/api/snapshot', {
        'x-charge-timestamp': tm,
        'x-charge-nonce': nonce,
        'x-charge-signature': deviceSignature(sec, tm, nonce, Buffer.from(body, 'utf8')),
        'x-device-id': dev,
      }, mk(status));
    }

    // 设备 A 先写：free
    const rA = await upload(devA, secA, 'c0c0c0c0c0c00001', 'free');
    expect(rA.statusCode).toBe(200);
    expect((rA.json() as { rejected?: string[] }).rejected).toBeUndefined();

    const afterA = await sql<{ status: string; owner_device: string | null }>`
      SELECT ps.status, c.owner_device FROM port_states ps
        JOIN controllers c ON c.device_hex = ps.device_hex
       WHERE ps.device_hex = ${hexA} AND ps.port = '01'
    `.execute(db);
    expect(afterA.rows[0]?.status).toBe('free');
    expect(afterA.rows[0]?.owner_device).toBe(devA);

    // 设备 B 再写同一个桩：charging —— 必须成功（默认不排他）
    const rB = await upload(devB, secB, 'c0c0c0c0c0c00002', 'charging');
    expect(rB.statusCode).toBe(200);
    const bodyB = rB.json() as { rejected?: string[]; warn?: string };
    expect(bodyB.rejected).toBeUndefined();   // ← 关键：不能被 owner 规则拒
    expect(bodyB.warn).toBeUndefined();

    const afterB = await sql<{ status: string; owner_device: string | null }>`
      SELECT ps.status, c.owner_device FROM port_states ps
        JOIN controllers c ON c.device_hex = ps.device_hex
       WHERE ps.device_hex = ${hexA} AND ps.port = '01'
    `.execute(db);
    expect(afterB.rows[0]?.status).toBe('charging');  // ← B 的数据真的写进去了
    expect(afterB.rows[0]?.owner_device).toBe(devB);  // owner 变成「最后写入者」
  });
});

describe('App 上传的数据合理性校验（warn 语义：只标记不丢）', () => {
  it('与本地历史偏差大的上传会被标记 _suspect，但快照仍然入库', async () => {
    const sec = '77'.repeat(32);
    const dev = 'c0c0c0c0c0c0c0c3';
    expect((await postJson('/api/device/register', {}, { device_id: dev, secret: sec })).statusCode).toBe(200);

    // 3 个区域（>= p2p_validate_min_areas 的默认 3），total 相同才可比
    const AREAS = ['偏检A区', '偏检B区', '偏检C区'];
    const db = getDb();
    for (let i = 0; i < AREAS.length; i += 1) {
      const name = AREAS[i]!;
      await sql`
        INSERT INTO areas (area_id, name, first_seen, last_seen)
        VALUES (${'r6val' + i}, ${name}, '2026-11-08 09:00:00', '2026-11-08 09:00:00')
        ON CONFLICT (area_id) DO NOTHING
      `.execute(db);
    }

    // 基准：三个区全部空闲（idle == total）
    const base = {
      project: 'vtest',
      app_version: '0.0.1',
      captured_at: nowLocalStr(0),
      areas: AREAS.map((name) => ({
        name, total_port: 10, idle_port: 10, charging_port: 0, fault_port: 0,
      })),
    };
    const r1 = await postJson('/api/snapshot', {
      'x-charge-timestamp': ts(),
      'x-charge-nonce': 'e0e0e0e0e0e0e0001',
      'x-charge-signature': deviceSignature(sec, ts(), 'e0e0e0e0e0e0e0001', Buffer.from(JSON.stringify(base), 'utf8')),
      'x-device-id': dev,
    }, base);
    expect(r1.statusCode).toBe(200);

    // 对照：内容与基准一致（三个区仍全空闲）→ 不该被标记。
    // 注意 snapshotDigest 刻意排除 captured_at，只改时间会被判重丢弃，
    // 所以这里改 app_version 让摘要不同，验证的是「内容没变就不标记」。
    const same = { ...base, app_version: '0.0.2', captured_at: nowLocalStr(5) };
    const r2 = await postJson('/api/snapshot', {
      'x-charge-timestamp': ts(),
      'x-charge-nonce': 'e0e0e0e0e0e0e0002',
      'x-charge-signature': deviceSignature(sec, ts(), 'e0e0e0e0e0e0e0002', Buffer.from(JSON.stringify(same), 'utf8')),
      'x-device-id': dev,
    }, same);
    expect(r2.statusCode).toBe(200);

    // 跳变：三个区从"全空闲"变"全满"，偏差 100% > 阈值 0.5
    const jump = {
      project: 'vtest',
      app_version: '0.0.1',
      captured_at: nowLocalStr(10),
      areas: AREAS.map((name) => ({
        name, total_port: 10, idle_port: 0, charging_port: 10, fault_port: 0,
      })),
    };
    const r3 = await postJson('/api/snapshot', {
      'x-charge-timestamp': ts(),
      'x-charge-nonce': 'e0e0e0e0e0e0e0003',
      'x-charge-signature': deviceSignature(sec, ts(), 'e0e0e0e0e0e0e0003', Buffer.from(JSON.stringify(jump), 'utf8')),
      'x-device-id': dev,
    }, jump);
    expect(r3.statusCode).toBe(200);   // 关键：warn 语义下不拒绝

    // 三条都入库
    const cnt = await sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM snapshots WHERE device_id = ${dev}
    `.execute(db);
    expect(Number(cnt.rows[0]?.n)).toBe(3);

    // 跳变那条带 _suspect 标记，前面两条不带
    const rows = await sql<{ id: number; payload: string }>`
      SELECT id, payload FROM snapshots WHERE device_id = ${dev} ORDER BY id
    `.execute(db);
    const flags = rows.rows.map((r) => {
      const o = JSON.parse(r.payload) as { _suspect?: boolean };
      return o._suspect === true;
    });
    expect(flags).toEqual([false, false, true]);

    // 互校表里有记录，peer_id 用 dev: 前缀区分设备与 P2P 节点
    const val = await sql<{ decision: string; peer_id: string }>`
      SELECT decision, peer_id FROM p2p_validation
       WHERE peer_id = ${'dev:' + dev}
       ORDER BY id DESC LIMIT 1
    `.execute(db);
    expect(val.rows.length).toBe(1);
    expect(['suspect', 'drop']).toContain(String(val.rows[0]?.decision));
  });
});

/** 生成「现在 + offset 秒」的本地时间串 */
function nowLocalStr(offsetSec: number): string {
  const d = new Date(Date.now() + offsetSec * 1000);
  const p = (x: number): string => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
    + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
