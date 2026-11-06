/**
 * P0 冒烟测试：确认骨架能起来、迁移器能建表、触发器正确。
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrate, applySchemaPatches, portGroupCase } from '../src/db/migrate.js';
import { NodeSqliteDatabase } from '../src/db/node-sqlite.js';
import { createDb, closeDb } from '../src/db/index.js';
import { buildServer } from '../src/server.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charge-node-test-'));
const dbPath = path.join(tmpDir, 'charge.db');

// 让全局单例指向临时库，避免 buildServer() 的 /health 落到项目 data/ 目录
beforeAll(() => {
  createDb(dbPath);
});

afterAll(async () => {
  await closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('迁移器', () => {
  it('能建出全部基础表并记录版本', () => {
    const conn = new NodeSqliteDatabase(dbPath);
    conn.pragma('journal_mode = WAL');
    const res = migrate(conn);

    expect(res.applied.length).toBeGreaterThan(0);

    const tables = (
      conn.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);

    for (const t of [
      'snapshots', 'nonces', 'area_samples', 'areas', 'app_settings', 'worker_runs',
      'upload_audit', 'admin_users', 'tokens', 'token_pool', 'devices', 'controllers',
      'port_states', 'pile_samples', 'schema_migrations',
    ]) {
      expect(tables, `缺少表 ${t}`).toContain(t);
    }
    conn.close();
  });

  it('迁移幂等：再跑一次不会重复执行', () => {
    const conn = new NodeSqliteDatabase(dbPath);
    const res = migrate(conn);
    expect(res.applied.length).toBe(0);
    expect(res.skipped.length).toBeGreaterThan(0);
    conn.close();
  });

  it('status_group 触发器会把分组算对', () => {
    const conn = new NodeSqliteDatabase(dbPath);
    applySchemaPatches(conn);

    conn
      .prepare(
        'INSERT INTO port_states(device_hex, port, status, updated_at) VALUES (?,?,?,?)',
      )
      .run(['00AFEC05', '01', '浮充', new Date().toISOString()]);

    const row = conn
      .prepare('SELECT status, status_group FROM port_states WHERE device_hex=? AND port=?')
      .get(['00AFEC05', '01']) as { status: string; status_group: string };

    expect(row.status).toBe('浮充');
    expect(row.status_group).toBe('busy');

    // 直接改 status，触发器应自动重算分组
    conn
      .prepare('UPDATE port_states SET status=? WHERE device_hex=? AND port=?')
      .run(['端口故障', '00AFEC05', '01']);
    const row2 = conn
      .prepare('SELECT status_group FROM port_states WHERE device_hex=? AND port=?')
      .get(['00AFEC05', '01']) as { status_group: string };
    expect(row2.status_group).toBe('unavailable');

    // 未知状态保留原文，分组为 unknown
    conn
      .prepare('UPDATE port_states SET status=? WHERE device_hex=? AND port=?')
      .run(['某个新状态', '00AFEC05', '01']);
    const row3 = conn
      .prepare('SELECT status, status_group FROM port_states WHERE device_hex=? AND port=?')
      .get(['00AFEC05', '01']) as { status: string; status_group: string };
    expect(row3.status).toBe('某个新状态');
    expect(row3.status_group).toBe('unknown');

    conn.close();
  });

  it('portGroupCase 与 Python 的 CASE 表达式同构', () => {
    const c = portGroupCase();
    expect(c.startsWith('CASE NEW.status ')).toBe(true);
    expect(c.endsWith("ELSE 'unknown' END")).toBe(true);
    expect(c).toContain("WHEN '空闲' THEN 'free'");
    expect(c).toContain("WHEN '浮充' THEN 'busy'");
    // unknown 分组的状态不应被显式映射
    expect(c).not.toContain("THEN 'unknown'");
  });
});

describe('服务骨架', () => {
  it('/health 返回 200 且带 tables 计数', async () => {
    const app = await buildServer();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect([200, 503]).toContain(res.statusCode);
    const body = res.json() as { ok: boolean; tables: number };
    expect(typeof body.tables).toBe('number');
    await app.close();
  });

  it('未知路由返回 404 JSON', async () => {
    const app = await buildServer();
    const res = await app.inject({ method: 'GET', url: '/no-such-endpoint' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'not_found' });
    await app.close();
  });
});
