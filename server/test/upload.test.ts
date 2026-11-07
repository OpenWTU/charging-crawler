/**
 * 上传链路测试：设备注册（自动审批）+ 快照上传 + nonce 重放。
 *
 * 用临时读写库（迁移器建表）走真实 HTTP 注入，验证：
 *  1. register 自动审批（直接 approved，无 pending）
 *  2. snapshot 验签 + 落库（快照/区域样本）
 *  3. 同 nonce 重放 → 409
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDb, closeDb, sql } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';
import { NodeSqliteDatabase } from '../src/db/node-sqlite.js';
import { buildServer } from '../src/server.js';
import { deviceSignature } from '../src/domain/crypto.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charge-upload-test-'));
const dbPath = path.join(tmpDir, 'charge.db');

let app: Awaited<ReturnType<typeof buildServer>>;
const deviceId = 'aa11bb22cc33dd44';
const secret = 'ab'.repeat(32); // 64 hex

beforeAll(async () => {
  const raw = new NodeSqliteDatabase(dbPath);
  raw.pragma('journal_mode = WAL');
  migrate(raw);
  raw.close();
  createDb(dbPath); // 读写
  app = await buildServer();
});

afterAll(async () => {
  await app.close();
  await closeDb();
  // Windows 下 WAL 文件可能尚未完全释放，删除失败无害（临时目录）
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function postJson(url: string, headers: Record<string, string>, obj: unknown) {
  const buf = Buffer.from(JSON.stringify(obj), 'utf8');
  return app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json', ...headers },
    payload: buf,
  });
}

describe('设备注册（自动审批）', () => {
  it('新设备直接 approved', async () => {
    const res = await postJson('/api/device/register', {}, { device_id: deviceId, secret });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; device_id?: string; pending?: boolean };
    expect(body.ok).toBe(true);
    expect(body.device_id).toBe(deviceId);
    expect(body.pending).toBeUndefined(); // 自动审批：无 pending

    const db = createDb(dbPath);
    const row = await sql<{ status: string }>`
      SELECT status FROM devices WHERE device_id = ${deviceId}
    `.execute(db);
    expect(row.rows[0]?.status).toBe('approved');
  });

  it('secret 不一致返回 409 secret_mismatch', async () => {
    const res = await postJson('/api/device/register', {}, { device_id: deviceId, secret: 'cd'.repeat(32) });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'secret_mismatch' });
  });
});

describe('快照上传', () => {
  const area = {
    name: '测试充电区1号',
    total_port: 10,
    idle_port: 3,
    charging_port: 7,
    fault_port: 0,
  };
  const ts = () => String(Math.floor(Date.now() / 1000));
  const nonce = 'deadbeefcafe1234';

  it('验签通过并落库', async () => {
    const bodyObj = { project: 'test', app_version: '0.0.0', areas: [area] };
    const body = JSON.stringify(bodyObj);
    const sig = deviceSignature(secret, ts(), nonce, Buffer.from(body, 'utf8'));

    const res = await postJson(
      '/api/snapshot',
      {
        'x-charge-timestamp': ts(),
        'x-charge-nonce': nonce,
        'x-charge-signature': sig,
        'x-device-id': deviceId,
      },
      bodyObj,
    );
    expect(res.statusCode).toBe(200);
    const r = res.json() as { ok: boolean; id: number; accepted: number };
    expect(r.ok).toBe(true);
    expect(r.accepted).toBe(1);

    const db = createDb(dbPath);
    const s = await sql<{ n: number }>`SELECT COUNT(*) AS n FROM snapshots`.execute(db);
    expect(Number(s.rows[0]?.n)).toBe(1);
    const a = await sql<{ n: number }>`SELECT COUNT(*) AS n FROM area_samples`.execute(db);
    expect(Number(a.rows[0]?.n)).toBe(1);
  });

  it('错误签名 → 401（bad_sig 计数，未达拉黑阈值）', async () => {
    const bodyObj = { project: 'test', app_version: '0.0.0', areas: [area] };
    const res = await postJson(
      '/api/snapshot',
      {
        'x-charge-timestamp': ts(),
        'x-charge-nonce': 'beefdeadbeef1234',
        'x-charge-signature': '00'.repeat(32), // 错误签名
        'x-device-id': deviceId,
      },
      bodyObj,
    );
    expect(res.statusCode).toBe(401);
  });

  it('同 nonce 重放 → 409（并触发拉黑）', async () => {
    const bodyObj = { project: 'test', app_version: '0.0.0', areas: [area] };
    const body = JSON.stringify(bodyObj);
    const sig = deviceSignature(secret, ts(), nonce, Buffer.from(body, 'utf8'));
    const res = await postJson(
      '/api/snapshot',
      {
        'x-charge-timestamp': ts(),
        'x-charge-nonce': nonce, // 同一个 nonce
        'x-charge-signature': sig,
        'x-device-id': deviceId,
      },
      bodyObj,
    );
    expect(res.statusCode).toBe(409);
  });

  it('重放达阈值后拉黑，后续请求 → 403', async () => {
    // 用独立设备自造完整流程，不依赖前序用例的注册/nonce 状态（单跑 -t 也能过）
    const d2 = 'ff00ff00ff00ff00';
    const s2 = 'cd'.repeat(32);
    const reg = await postJson('/api/device/register', {}, { device_id: d2, secret: s2 });
    expect(reg.statusCode).toBe(200);

    const bodyObj = { project: 'test', app_version: '0.0.0', areas: [area] };
    const body = JSON.stringify(bodyObj);
    const nonce2 = 'beefbeefbeefbeef';
    const sig = deviceSignature(s2, ts(), nonce2, Buffer.from(body, 'utf8'));
    const headers = {
      'x-charge-timestamp': ts(),
      'x-charge-nonce': nonce2,
      'x-charge-signature': sig,
      'x-device-id': d2,
    };

    // 首次使用该 nonce：正常落库
    const first = await postJson('/api/snapshot', headers, bodyObj);
    expect(first.statusCode).toBe(200);

    // replay 阈值是 3（nonce 为全局主键，1 次就拉黑会误伤合法设备）：重放 3 次都应是 409
    for (let i = 0; i < 3; i += 1) {
      const sigR = deviceSignature(s2, ts(), nonce2, Buffer.from(body, 'utf8'));
      const r = await postJson(
        '/api/snapshot',
        { ...headers, 'x-charge-timestamp': ts(), 'x-charge-signature': sigR },
        bodyObj,
      );
      expect(r.statusCode).toBe(409);
    }

    // 达到阈值后，该设备后续请求全部 403
    const nonce3 = 'deadbeefdeadbeef';
    const sig3 = deviceSignature(s2, ts(), nonce3, Buffer.from(body, 'utf8'));
    const res = await postJson(
      '/api/snapshot',
      {
        'x-charge-timestamp': ts(),
        'x-charge-nonce': nonce3,
        'x-charge-signature': sig3,
        'x-device-id': d2,
      },
      bodyObj,
    );
    expect(res.statusCode).toBe(403); // 重放达阈值后拉黑，全部拒绝
  });
});
