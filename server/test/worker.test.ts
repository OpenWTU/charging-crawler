/**
 * worker 编排测试：用 mock call 走完整抓取 + 端口同步链路。
 *
 * 绝不真实调用 ap3202（避免平台风控）——call 全部 mock。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDb, closeDb, sql } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';
import { NodeSqliteDatabase } from '../src/db/node-sqlite.js';
import { encryptToken } from '../src/domain/crypto.js';
import {
  serverRefreshOnce,
  syncPortsImpl,
  refreshRound,
  roundOk,
  stableStringify,
  type Call,
} from '../src/domain/worker.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charge-worker-test-'));
const dbPath = path.join(tmpDir, 'charge.db');

beforeAll(async () => {
  const raw = new NodeSqliteDatabase(dbPath);
  raw.pragma('journal_mode = WAL');
  migrate(raw);
  raw.close();
  const db = createDb(dbPath);

  // 种子：一个 token + 一个控制器
  const enc = encryptToken('eyJhbGciOiJIUzI1NiJ9.mock.payload');
  await db
    .insertInto('token_pool')
    .values({
      user_id: 'u1',
      token: enc,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      updated_at: '2026-11-06 00:00:00',
      source: 'test',
      last_error: null,
    })
    .execute();
  await db
    .insertInto('controllers')
    .values({ device_hex: 'AA11BB22', code: '15511320', area_name: '测试区1号' })
    .execute();
});

afterAll(async () => {
  await closeDb();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

/** mock 平台 API：按 path 返回固定数据 */
const mockCall: Call = async (path, params) => {
  if (path === 'user/userInfo') {
    return { data: { projectId: 'P1', projectName: '测试项目' } };
  }
  if (path === 'nearArea/list') {
    return { data: [{ id: 'A1', areaName: '测试区1号' }] };
  }
  if (path.startsWith('nearArea/')) {
    return {
      data: { totalPort: 10, idlePort: 3, chargingPort: 7, faultPort: 0, address: '阳光大道' },
    };
  }
  if (path === 'charge/ports') {
    return {
      data: {
        ports: [
          { port: '01', status: '空闲' },
          { port: '02', status: '充电中' },
          { port: '03', status: '端口故障' },
        ],
      },
    };
  }
  return {};
};

describe('roundOk', () => {
  it('任一段 fail 即失败；至少一段 ok', () => {
    expect(roundOk('ok:1')).toBe(true);
    expect(roundOk('fail:1')).toBe(false);
    expect(roundOk('areas=ok:1|ports=ok:1/3')).toBe(true);
    expect(roundOk('areas=no-token|ports=no-token')).toBe(false);
    expect(roundOk('areas=ok:1|ports=ok:1/3 fail:1')).toBe(false);
  });
});

describe('stableStringify（模拟 Python sort_keys）', () => {
  it('键排序', () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });
});

describe('serverRefreshOnce（mock）', () => {
  it('抓到 1 个区并落库', async () => {
    const db = createDb(dbPath);
    const result = await serverRefreshOnce(mockCall, db);
    expect(result).toBe('ok:1');

    const s = await sql<{ n: number }>`SELECT COUNT(*) AS n FROM snapshots`.execute(db);
    expect(Number(s.rows[0]?.n)).toBe(1);
    const a = await sql<{ n: number }>`SELECT COUNT(*) AS n FROM area_samples`.execute(db);
    expect(Number(a.rows[0]?.n)).toBe(1);
  });
});

describe('syncPortsImpl（mock）', () => {
  it('同步 3 个端口', async () => {
    const db = createDb(dbPath);
    const result = await syncPortsImpl(mockCall, undefined, db);
    expect(result).toBe('ok:1/3');

    const p = await sql<{ n: number }>`SELECT COUNT(*) AS n FROM port_states`.execute(db);
    expect(Number(p.rows[0]?.n)).toBe(3);
  });
});

describe('refreshRound（mock 全链）', () => {
  it('areas 与 ports 都 ok', async () => {
    const db = createDb(dbPath);
    const result = await refreshRound(mockCall, db);
    expect(result).toBe('areas=ok:1|ports=ok:1/3');
  });
});
