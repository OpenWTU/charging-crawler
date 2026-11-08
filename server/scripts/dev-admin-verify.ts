/**
 * 本地验证服务：临时库 + 造样例数据 + 起 buildServer（供 CDP 打开 /admin 验证）。
 * 用法：node --import tsx server/scripts/dev-admin-verify.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charge-admin-dev-'));
const dbPath = path.join(tmpDir, 'charge.db');

process.env.DATABASE_PATH = dbPath;
process.env.DATABASE_READONLY = 'false';
process.env.ADMIN_INIT_PASSWORD = 'devpass12345';
process.env.ADMIN_COOKIE_SECURE = 'false'; // 本地 http
process.env.P2P_ENABLED = 'false';
process.env.AUTO_WORKER = 'false';
process.env.NODE_ENV = 'development';
process.env.VITEST = '1'; // 防止提前跑 main()

const { migrate } = await import('../src/db/migrate.js');
const { NodeSqliteDatabase } = await import('../src/db/node-sqlite.js');
const { createDb } = await import('../src/db/index.js');
const { sql } = await import('kysely');
const { buildServer } = await import('../src/server.js');
const { ensureAdminSeed } = await import('../src/routes/admin.js');
const { hashPassword } = await import('../src/domain/adminauth.js');

const raw = new NodeSqliteDatabase(dbPath);
raw.pragma('journal_mode = WAL');
migrate(raw);
raw.close();
createDb(dbPath);
const db = createDb(dbPath);

/* ---- 造样例数据 ---- */
const areas = [
  { name: '一食堂东侧', total: 48, idle: 21, charging: 26, fault: 1 },
  { name: '图书馆北', total: 24, idle: 2, charging: 22, fault: 0 },
  { name: '三食堂', total: 36, idle: 0, charging: 30, fault: 6 },
  { name: '宿舍楼下', total: 24, idle: 12, charging: 12, fault: 0 },
  { name: '体育馆', total: 12, idle: 8, charging: 4, fault: 0 },
];
const nowStr = (d: Date): string => {
  const p = (x: number): string => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
    + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

// 14 条历史快照（每 10 分钟一条）
for (let i = 14; i >= 0; i -= 1) {
  const t = new Date(Date.now() - i * 600_000);
  const ts = nowStr(t);
  const payload = {
    captured_at: ts,
    project: 'demo',
    app_version: '2.3.8',
    token_user: '66108368',
    areas: areas.map((a) => ({
      name: a.name,
      total_port: a.total,
      idle_port: Math.max(0, a.idle + ((i % 3) - 1)),
      charging_port: a.charging,
      fault_port: a.fault,
    })),
  };
  const res = await sql<{ id: number }>`
    INSERT INTO snapshots (received_at, captured_at, project, app_version, token_user,
                           client_ip, device_id, real_ip, body_sha256, payload)
    VALUES (${ts}, ${ts}, 'demo', '2.3.8', '66108368', '127.0.0.1',
            ${i % 2 === 0 ? 'dev-sample-0001' : null}, '127.0.0.1',
            ${'sha-' + i}, ${JSON.stringify(payload)})
    RETURNING id
  `.execute(db);
  const sid = Number(res.rows[0]?.id ?? 0);
  for (const a of payload.areas) {
    await sql`
      INSERT INTO area_samples (snapshot_id, area_id, area_name, idle, total, charging, fault, received_at)
      VALUES (${sid}, ${'aid-' + a.name}, ${a.name}, ${a.idle_port}, ${a.total_port},
              ${a.charging_port}, ${a.fault_port}, ${ts})
    `.execute(db);
  }
}

// 端口状态
for (const a of areas) {
  for (let k = 0; k < a.total; k += 1) {
    const group = k < a.idle ? 'free' : k < a.idle + a.charging ? 'busy' : 'unavailable';
    const devHex = 'DEV' + a.name.slice(0, 2);
    await sql`
      INSERT INTO port_states (device_hex, port, status, status_group, updated_at)
      VALUES (${devHex}, ${String(k + 1).padStart(2, '0')}, ${group}, ${group}, ${nowStr(new Date())})
      ON CONFLICT (device_hex, port) DO NOTHING
    `.execute(db);
  }
  await sql`
    INSERT INTO controllers (device_hex, code, area_id, area_name, updated_at, qr_device_no)
    VALUES (${'DEV' + a.name.slice(0, 2)}, ${'C' + a.total}, ${'aid-' + a.name}, ${a.name},
            ${nowStr(new Date())}, ${'QR' + a.total})
    ON CONFLICT (device_hex) DO NOTHING
  `.execute(db);
  await sql`
    INSERT INTO areas (area_id, name, first_seen, last_seen)
    VALUES (${'aid-' + a.name}, ${a.name}, ${nowStr(new Date())}, ${nowStr(new Date())})
    ON CONFLICT (area_id) DO NOTHING
  `.execute(db);
}

// 令牌池：2 个有效 + 2 个过期
const nowSec = Math.floor(Date.now() / 1000);
const tokens = [
  { uid: '66108368', exp: nowSec + 1800, src: 'upload' },
  { uid: '64789362', exp: nowSec + 2400, src: 'upload' },
  { uid: '63984941', exp: nowSec - 600, src: 'upload' },
  { uid: '66104240', exp: nowSec - 7200, src: 'migrate' },
];
for (const t of tokens) {
  await sql`
    INSERT INTO token_pool (user_id, token, expires_at, updated_at, source, last_error)
    VALUES (${t.uid}, ${'enc'}, ${t.exp}, ${nowStr(new Date())}, ${t.src}, ${null})
  `.execute(db);
}

// 设备
for (const d of [
  { id: 'dev-sample-0001', model: 'RMX5010', ver: '2.3.8', status: 'approved', up: 42 },
  { id: 'dev-sample-0002', model: 'MI 14', ver: '2.3.7', status: 'approved', up: 17 },
  { id: 'dev-blocked-001', model: '—', ver: '—', status: 'revoked', up: 3 },
]) {
  await sql`
    INSERT INTO devices (device_id, secret_enc, model, app_version, created_at, last_seen,
                         uploads, revoked, status)
    VALUES (${d.id}, ${hashPassword('x')}, ${d.model}, ${d.ver}, ${nowStr(new Date())},
            ${nowStr(new Date())}, ${d.up}, ${d.status === 'revoked' ? 1 : 0}, ${d.status})
    ON CONFLICT (device_id) DO NOTHING
  `.execute(db);
}

await sql`
  INSERT INTO worker_runs (ts, result) VALUES (${nowStr(new Date())}, 'areas=ok:39')
`.execute(db);

/* ---- 管理员 ---- */
await ensureAdminSeed();

/* ---- 起服务 ---- */
const app = await buildServer();
await app.listen({ host: '127.0.0.1', port: 8899 });
console.log('READY http://127.0.0.1:8899/admin  (admin / devpass12345)');
console.log('DB:', dbPath);
