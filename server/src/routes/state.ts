/**
 * 实时状态族：/api/overview
 *
 * ⚠️ 与 `cloud/http/api_state.py::_route_overview` 逐字段一致（含键顺序）。
 * 注意 payload 里的 token_user 会被删掉（不向外暴露上传者身份）。
 */
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { WORKER_INTERVAL } from '../config.js';
import { getDb } from '../db/index.js';
import { healthStats, tokenPoolStats } from '../domain/health.js';

interface SnapshotArea {
  name?: string;
  lat?: number | null;
  lng?: number | null;
  [k: string]: unknown;
}

export async function overviewPayload(): Promise<Record<string, unknown>> {
  const db = getDb();

  const latestRes = await sql<{ received_at: string; payload: string }>`
    SELECT received_at, payload FROM snapshots ORDER BY id DESC LIMIT 1
  `.execute(db);
  const countRes = await sql<{ n: number }>`SELECT COUNT(*) AS n FROM snapshots`.execute(db);
  const coordsRes = await sql<{ name: string; lat: number | null; lng: number | null }>`
    SELECT name, lat, lng FROM areas
  `.execute(db);

  const latest = latestRes.rows[0];
  const count = Number(countRes.rows[0]?.n ?? 0);
  const coords = new Map<string, [number | null, number | null]>();
  for (const r of coordsRes.rows) {
    coords.set(String(r.name), [r.lat, r.lng]);
  }

  const nowTs = Math.floor(Date.now() / 1000);
  const pool = await tokenPoolStats();
  const health = await healthStats();

  // token_ready / token_valid / earliest_exp 保留原语义，以池为准
  const common = {
    token_ready: pool.valid > 0,
    token_valid: pool.valid,
    earliest_exp: pool.earliest_exp,
    token_pool: pool,
    interval: WORKER_INTERVAL,
    error_count: health.error_count,
  };

  if (!latest) {
    return { ok: true, uploads: 0, areas: [], ...common };
  }

  let snap: Record<string, unknown>;
  try {
    snap = JSON.parse(latest.payload) as Record<string, unknown>;
  } catch {
    throw new Error('快照数据损坏');
  }
  delete snap.token_user;

  const areas = snap.areas;
  if (Array.isArray(areas)) {
    for (const area of areas as SnapshotArea[]) {
      if (!area || typeof area !== 'object') continue;
      const point = coords.get(String(area.name)) ?? [null, null];
      area.lat = point[0];
      area.lng = point[1];
    }
  }

  return {
    ok: true,
    uploads: count,
    received_at: latest.received_at,
    generated_at: nowTs,
    last_scan_at: latest.received_at,
    adapter: 'haokuaichong',
    coord_system: 'gcj02',
    ...common,
    snapshot: snap,
  };
}

export async function registerStateRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/overview', async (_req, reply) => {
    try {
      return reply.send(await overviewPayload());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === '快照数据损坏') {
        return reply.code(500).send({ ok: false, error: '快照数据损坏' });
      }
      app.log.error({ err }, '/api/overview 失败');
      return reply.code(500).send({ ok: false, error: 'internal_error' });
    }
  });
}
