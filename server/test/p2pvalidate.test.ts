/**
 * 跨节点数据互校单测（算法层）。
 *
 * 覆盖 docs/p2p-validation.md 第 11.1 节的用例：正常 / 偏差 / 无基准 / 重叠不足 /
 * total 不一致 / 零端口 / 无效 payload / 故障差 / 模式差异。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sql } from 'kysely';
import { closeDb, createDb, getDb } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';
import { NodeSqliteDatabase } from '../src/db/node-sqlite.js';
import { invalidateSettingsCache, writeSetting } from '../src/domain/adminsettings.js';
import { validateIncoming } from '../src/domain/p2pvalidate.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charge-p2pval-test-'));
const dbPath = path.join(tmpDir, 'charge.db');

/** 构造一份快照 payload（6 个区域，48 口） */
function makeSnapshot(overrides: Record<string, { idle: number; charging?: number; fault?: number }> = {}) {
  const names = ['A 区', 'B 区', 'C 区', 'D 区', 'E 区', 'F 区'];
  const areas = names.map((name) => {
    const o = overrides[name];
    const idle = o ? o.idle : 20;
    const charging = o ? (o.charging ?? 27) : 27;
    const fault = o ? (o.fault ?? 1) : 1;
    return {
      name,
      total_port: 48,
      idle_port: idle,
      charging_port: charging,
      fault_port: fault,
    };
  });
  return { project: 'test', app_version: '2.3.8', captured_at: '2026-11-08 09:00:00', areas };
}

/** 往本地库插一条快照（作为基准） */
async function insertSnapshot(payload: unknown, capturedAt: string, deviceId: string | null) {
  const db = getDb();
  const res = await sql<{ id: number }>`
    INSERT INTO snapshots (received_at, captured_at, project, app_version, token_user,
                           client_ip, device_id, real_ip, body_sha256, payload)
    VALUES (${capturedAt}, ${capturedAt}, 'test', '2.3.8', '', '', ${deviceId}, '',
            ${'sha-' + Math.random().toString(16).slice(2)}, ${JSON.stringify(payload)})
    RETURNING id
  `.execute(db);
  return Number(res.rows[0]?.id ?? 0);
}

beforeAll(async () => {
  const raw = new NodeSqliteDatabase(dbPath);
  raw.pragma('journal_mode = WAL');
  migrate(raw);
  raw.close();
  createDb(dbPath);
});

afterAll(async () => {
  await closeDb();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* Windows WAL */
  }
});

beforeEach(async () => {
  // 每个用例前清空快照与设置缓存
  await sql`DELETE FROM snapshots`.execute(getDb());
  await sql`DELETE FROM app_settings`.execute(getDb());
  invalidateSettingsCache();
  await writeSetting('p2p_validate_mode', 'strict', null);
  invalidateSettingsCache();
});

describe('跨节点数据互校', () => {
  it('两份完全一致 → accept(within_threshold)，deviation=0', async () => {
    const local = makeSnapshot();
    await insertSnapshot(local, '2026-11-08 09:00:00', 'dev-local');
    const remote = makeSnapshot();
    const r = await validateIncoming(remote, '2026-11-08 09:00:05');
    expect(r.decision).toBe('accept');
    expect(r.reason).toBe('within_threshold');
    expect(r.deviation).toBeCloseTo(0, 5);
    expect(r.comparable).toBeGreaterThanOrEqual(3);
  });

  it('只差 1 个空闲口 → accept', async () => {
    await insertSnapshot(makeSnapshot(), '2026-11-08 09:00:00', 'dev-local');
    const remote = makeSnapshot({ 'A 区': { idle: 21, charging: 26 } });
    const r = await validateIncoming(remote, '2026-11-08 09:00:05');
    expect(r.decision).toBe('accept');
    expect(r.deviation).toBeLessThan(0.5);
  });

  it('空闲率差 0.79（远端 40/48 vs 本地 2/48）→ strict 模式 drop', async () => {
    const local = makeSnapshot({
      'A 区': { idle: 2, charging: 45 },
      'B 区': { idle: 2, charging: 45 },
      'C 区': { idle: 2, charging: 45 },
    });
    await insertSnapshot(local, '2026-11-08 09:00:00', 'dev-local');
    const remote = makeSnapshot({
      'A 区': { idle: 40, charging: 7 },
      'B 区': { idle: 40, charging: 7 },
      'C 区': { idle: 40, charging: 7 },
    });
    const r = await validateIncoming(remote, '2026-11-08 09:00:05');
    expect(r.decision).toBe('drop');
    expect(r.reason).toBe('deviation_exceeded');
    expect(r.deviation).toBeGreaterThan(0.5);
  });

  it('同上但 warn 模式 → suspect', async () => {
    await writeSetting('p2p_validate_mode', 'warn', null);
    invalidateSettingsCache();
    const local = makeSnapshot({
      'A 区': { idle: 2, charging: 45 },
      'B 区': { idle: 2, charging: 45 },
      'C 区': { idle: 2, charging: 45 },
    });
    await insertSnapshot(local, '2026-11-08 09:00:00', 'dev-local');
    const remote = makeSnapshot({
      'A 区': { idle: 40, charging: 7 },
      'B 区': { idle: 40, charging: 7 },
      'C 区': { idle: 40, charging: 7 },
    });
    const r = await validateIncoming(remote, '2026-11-08 09:00:05');
    expect(r.decision).toBe('suspect');
    expect(r.reason).toBe('deviation_exceeded');
  });

  it('off 模式 → accept(mode_off) 且不做比对', async () => {
    await writeSetting('p2p_validate_mode', 'off', null);
    invalidateSettingsCache();
    const r = await validateIncoming(makeSnapshot(), '2026-11-08 09:00:00');
    expect(r.decision).toBe('accept');
    expect(r.reason).toBe('mode_off');
    expect(r.comparable).toBe(0);
  });

  it('本节点无快照 → accept(no_baseline)', async () => {
    const r = await validateIncoming(makeSnapshot(), '2026-11-08 09:00:00');
    expect(r.decision).toBe('accept');
    expect(r.reason).toBe('no_baseline');
    expect(r.baseSnapshotId).toBeNull();
  });

  it('基准在窗口外（±601 秒）→ accept(no_baseline)', async () => {
    await insertSnapshot(makeSnapshot(), '2026-11-08 08:49:00', 'dev-local');
    // 远端 09:00:00，差 11 分钟 > 默认 600 秒窗口
    const r = await validateIncoming(makeSnapshot(), '2026-11-08 09:00:00');
    expect(r.decision).toBe('accept');
    expect(r.reason).toBe('no_baseline');
  });

  it('可比区域不足（只 2 个同名）→ accept(insufficient_overlap)', async () => {
    const local = makeSnapshot();
    await insertSnapshot(local, '2026-11-08 09:00:00', 'dev-local');
    const remote = {
      captured_at: '2026-11-08 09:00:00',
      areas: [
        { name: 'A 区', total_port: 48, idle_port: 40, charging_port: 7, fault_port: 1 },
        { name: 'B 区', total_port: 48, idle_port: 40, charging_port: 7, fault_port: 1 },
      ],
    };
    const r = await validateIncoming(remote, '2026-11-08 09:00:05');
    expect(r.decision).toBe('accept');
    expect(r.reason).toBe('insufficient_overlap');
  });

  it('区域 total 不一致 → 该区域进 skipped，不参与判定', async () => {
    await insertSnapshot(makeSnapshot(), '2026-11-08 09:00:00', 'dev-local');
    const remote = {
      captured_at: '2026-11-08 09:00:00',
      areas: [
        { name: 'A 区', total_port: 24, idle_port: 2, charging_port: 21, fault_port: 1 },
        { name: 'B 区', total_port: 48, idle_port: 20, charging_port: 27, fault_port: 1 },
        { name: 'C 区', total_port: 48, idle_port: 20, charging_port: 27, fault_port: 1 },
        { name: 'D 区', total_port: 48, idle_port: 20, charging_port: 27, fault_port: 1 },
      ],
    };
    const r = await validateIncoming(remote, '2026-11-08 09:00:05');
    expect(r.detail.skipped.some((s) => s.why === 'total_mismatch')).toBe(true);
    expect(r.decision).toBe('accept');
  });

  it('total=0 → 跳过不崩', async () => {
    await insertSnapshot(makeSnapshot(), '2026-11-08 09:00:00', 'dev-local');
    const remote = {
      captured_at: '2026-11-08 09:00:00',
      areas: [
        { name: 'A 区', total_port: 0, idle_port: 0, charging_port: 0, fault_port: 0 },
        { name: 'B 区', total_port: 48, idle_port: 20, charging_port: 27, fault_port: 1 },
      ],
    };
    const r = await validateIncoming(remote, '2026-11-08 09:00:05');
    expect(r.detail.skipped.some((s) => s.why === 'zero_total')).toBe(true);
  });

  it('远端 areas 缺失 → drop(invalid_payload)', async () => {
    await insertSnapshot(makeSnapshot(), '2026-11-08 09:00:00', 'dev-local');
    const r = await validateIncoming({ captured_at: '2026-11-08 09:00:00' }, '2026-11-08 09:00:05');
    expect(r.decision).toBe('drop');
    expect(r.reason).toBe('invalid_payload');
  });

  it('故障数差异大（远端 6 / 本地 0）→ 触发故障路径', async () => {
    const local = makeSnapshot({
      'A 区': { idle: 20, charging: 28, fault: 0 },
      'B 区': { idle: 20, charging: 28, fault: 0 },
      'C 区': { idle: 20, charging: 28, fault: 0 },
    });
    await insertSnapshot(local, '2026-11-08 09:00:00', 'dev-local');
    const remote = makeSnapshot({
      'A 区': { idle: 20, charging: 22, fault: 6 },
      'B 区': { idle: 20, charging: 22, fault: 6 },
      'C 区': { idle: 20, charging: 22, fault: 6 },
    });
    const r = await validateIncoming(remote, '2026-11-08 09:00:05');
    expect(r.decision).toBe('drop');
    expect(r.deviation).toBeGreaterThanOrEqual(0.5);
  });

  it('时钟与本地相差 >24h → 视为补传历史，accept(no_baseline)', async () => {
    await insertSnapshot(makeSnapshot(), '2026-11-08 09:00:00', 'dev-local');
    const remote = { ...makeSnapshot(), captured_at: '2026-11-01 09:00:00' };
    const r = await validateIncoming(remote, '2026-11-01 09:00:00');
    expect(r.decision).toBe('accept');
    expect(r.reason).toBe('no_baseline');
  });
});
