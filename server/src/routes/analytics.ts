/**
 * 历史与分析族：/api/history、/api/analytics
 *
 * ⚠️ 与 `cloud/http/api_analytics.py` 逐字段对齐：
 *   _route_history   → {ok, area, rows:[{idle,total,charging,fault,t}]}（时间升序）
 *   _route_analytics → 直接返回 build_analytics() 的结构
 */
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { getDb } from '../db/index.js';
import { buildAnalytics } from '../domain/analytics.js';

export async function historyPayload(area: string, limitRaw: string | undefined): Promise<
  | { ok: false; status: number; error: string }
  | {
      ok: true;
      area: string;
      rows: Array<{ idle: number; total: number; charging: number; fault: number; t: string }>;
    }
> {
  if (!area) return { ok: false, status: 400, error: '缺少 area' };

  // 与 Python 一致：max(1, min(int(limit), 1000))，解析失败回落 200
  let limit = 200;
  if (limitRaw !== undefined && limitRaw !== '') {
    const n = Number.parseInt(limitRaw, 10);
    if (Number.isFinite(n)) limit = Math.max(1, Math.min(n, 1000));
  }

  const db = getDb();
  const res = await sql<{
    received_at: string;
    idle: number;
    total: number;
    charging: number;
    fault: number;
  }>`
    SELECT s.received_at, a.idle, a.total, a.charging, a.fault
      FROM area_samples a
      JOIN snapshots s ON s.id = a.snapshot_id
     WHERE a.area_name = ${area}
     ORDER BY a.snapshot_id DESC LIMIT ${limit}
  `.execute(db);

  // Python 用 reversed(rows) → 时间升序
  return {
    ok: true,
    area,
    rows: [...res.rows].reverse().map((r) => ({
      idle: Number(r.idle),
      total: Number(r.total),
      charging: Number(r.charging),
      fault: Number(r.fault),
      t: r.received_at,
    })),
  };
}

export async function registerAnalyticsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/history', async (req, reply) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const payload = await historyPayload(String(q.area ?? ''), q.limit);
    if (payload.ok === false) {
      return reply.code(payload.status).send({ ok: false, error: payload.error });
    }
    return reply.send(payload);
  });

  app.get('/api/analytics', async (req, reply) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;

    // area 必须是 areas 表登记过的（与 Python 的反滥用校验一致）
    let area: string | null = null;
    const rawArea = (q.area ?? '').trim();
    if (rawArea) {
      const candidate = rawArea.slice(0, 80);
      const db = getDb();
      const known = await sql<{ one: number }>`
        SELECT 1 AS one FROM areas WHERE name = ${candidate}
      `.execute(db);
      if (!known.rows.length) {
        return reply.code(400).send({ ok: false, error: '未知区域' });
      }
      area = candidate;
    }

    // weeks: max(1, min(int, 52))，默认 8
    let weeks = 8;
    if (q.weeks !== undefined && q.weeks !== '') {
      const n = Number.parseInt(q.weeks, 10);
      if (Number.isFinite(n)) weeks = Math.max(1, Math.min(n, 52));
    }

    try {
      const payload = await buildAnalytics(area, weeks);
      return reply.send(payload);
    } catch (err) {
      app.log.error({ err }, '分析数据构建失败');
      return reply.code(500).send({ ok: false, error: '分析数据暂不可用' });
    }
  });
}
