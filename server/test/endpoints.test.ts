/**
 * 端点行为测试：在「空库」上验证 12 个只读接口的响应形状与边界分支。
 *
 * 与 smoke.test.ts 互补：
 *  - smoke 覆盖迁移器 + 触发器 + 服务骨架
 *  - 本文件覆盖业务端点的空态 / 缺参 / 404 分支
 *
 * 这些是 CI 可自动跑的服务端质量保障（跨语言对拍脚本 parity_server.py
 * 需要 Python 服务，CI 里不方便起，本地与服务器上用）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDb, closeDb } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';
import { NodeSqliteDatabase } from '../src/db/node-sqlite.js';
import { buildServer } from '../src/server.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charge-ep-test-'));
const dbPath = path.join(tmpDir, 'charge.db');

let app: Awaited<ReturnType<typeof buildServer>>;

beforeAll(async () => {
  // 建空库（有 schema，无数据）
  const raw = new NodeSqliteDatabase(dbPath);
  raw.pragma('journal_mode = WAL');
  migrate(raw);
  raw.close();
  createDb(dbPath, true);
  app = await buildServer();
});

afterAll(async () => {
  await app.close();
  await closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function get(path: string): Promise<{ status: number; body: any }> {
  const res = await app.inject({ method: 'GET', url: path });
  let body: unknown = res.body;
  try {
    body = JSON.parse(res.body);
  } catch {
    /* 保持原文 */
  }
  return { status: res.statusCode, body };
}

describe('空库端点行为', () => {
  it('/api/overview 空库：uploads=0，areas=[]', async () => {
    const { status, body } = await get('/api/overview');
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.uploads).toBe(0);
    expect(body.areas).toEqual([]);
    expect(body.interval).toBe(600);
  });

  it('/api/areas-ports 空库：total=0，truncated=false', async () => {
    const { status, body } = await get('/api/areas-ports');
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.total).toBe(0);
    expect(body.truncated).toBe(false);
    expect(body.areas).toEqual([]);
  });

  it('/api/now 空库：areas=[]', async () => {
    const { status, body } = await get('/api/now');
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.areas).toEqual([]);
  });

  it('/api/analytics 空库：samples=0，heatmap 7x24，trend 96/7', async () => {
    const { status, body } = await get('/api/analytics');
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.samples).toBe(0);
    expect(body.heatmap).toHaveLength(7);
    expect(body.heatmap[0]).toHaveLength(24);
    expect(body.trend_24h).toHaveLength(96);
    expect(body.trend_7d).toHaveLength(7);
    expect(body.ranking).toEqual([]);
  });

  it('/api/free-rate 空库：24 个点，free_rate 全 null', async () => {
    const { status, body } = await get('/api/free-rate');
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.points).toHaveLength(24);
    expect(body.total_samples).toBe(0);
    for (const p of body.points) expect(p.free_rate).toBeNull();
  });

  it('/api/area-coords 空库：areas=[]', async () => {
    const { status, body } = await get('/api/area-coords');
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.areas).toEqual([]);
  });

  it('/api/controllers 空库：count=0', async () => {
    const { status, body } = await get('/api/controllers');
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.count).toBe(0);
    expect(body.controllers).toEqual([]);
  });

  it('/api/latest 空库：404 还没有数据', async () => {
    const { status, body } = await get('/api/latest');
    expect(status).toBe(404);
    expect(body.error).toBe('还没有数据');
  });

  it('/api/history 缺 area：400', async () => {
    const { status, body } = await get('/api/history');
    expect(status).toBe(400);
    expect(body.error).toBe('缺少 area');
  });

  it('/api/area-ports 缺 area：400', async () => {
    const { status, body } = await get('/api/area-ports');
    expect(status).toBe(400);
    expect(body.error).toBe('缺少 area');
  });

  it('/api/analytics 未知区域：400', async () => {
    const { status, body } = await get('/api/analytics?area=不存在的区');
    expect(status).toBe(400);
    expect(body.error).toBe('未知区域');
  });

  it('/api/pile 不存在：404 设备不存在', async () => {
    const { status, body } = await get('/api/pile/NOSUCHDEV');
    expect(status).toBe(404);
    expect(body.error).toBe('设备不存在');
  });

  it('未知路由：404 JSON', async () => {
    const { status, body } = await get('/no-such-endpoint');
    expect(status).toBe(404);
    expect(body.error).toBe('not_found');
  });

  it('/assets 路径穿越被拒：404', async () => {
    const { status } = await get('/assets/..%2F..%2Fetc%2Fpasswd');
    expect(status).toBe(404);
  });

  it('/download 非法 APK 名：404', async () => {
    const { status } = await get('/download/not-an-apk.txt');
    expect(status).toBe(404);
  });
});
