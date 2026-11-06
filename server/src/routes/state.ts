/**
 * 实时状态族：/api/overview
 *
 * ⚠️ 与 `cloud/http/api_state.py::_route_overview` 逐字段一致（含键顺序）。
 * 注意 payload 里的 token_user 会被删掉（不向外暴露上传者身份）。
 */
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { NOW_WALK_M_PER_MIN, WORKER_INTERVAL } from '../config.js';
import { getDb } from '../db/index.js';
import { pyRound } from '../domain/analytics.js';
import { haversineM, parseCoord } from '../domain/geo.js';
import { healthStats, tokenPoolStats } from '../domain/health.js';
import { areaPortGroupCounts, areaPortState } from '../domain/ports.js';
import { fmtDateTime, predictionFields, predictionStats } from '../domain/prediction.js';

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

export interface NowItem {
  name: string;
  idle: number;
  total: number;
  delta: number;
  distance_m: number | null;
  score: number;
  unavailable_ports: number;
  port_state: string;
  hist_free_rate: number | null;
  hist_samples: number | null;
  trend_10m: number | null;
  predicted_idle: number | null;
  eta_min: number | null;
  confidence: 'high' | 'medium' | 'low' | null;
  p_free_10m: number | null;
  p_free_at_arrival: number | null;
}

/**
 * /api/now：当前空闲 + 增量 + 距离/评分 + 到达预测。
 * 与 cloud/http/api_state.py::_route_now 逐字段一致。
 */
export async function nowPayload(
  latRaw: unknown,
  lngRaw: unknown,
): Promise<{ ok: true; areas: NowItem[] }> {
  const userLat = parseCoord(latRaw, -90.0, 90.0);
  const userLng = parseCoord(lngRaw, -180.0, 180.0);
  const useCoords = userLat !== null && userLng !== null;

  const db = getDb();

  const curRes = await sql<{ m: number | null }>`SELECT MAX(id) AS m FROM snapshots`.execute(db);
  const curId = curRes.rows[0]?.m ?? null;

  let rows: Array<{
    area_name: string;
    idle: number;
    total: number;
    charging: number;
    fault: number;
  }> = [];
  if (curId !== null) {
    const r = await sql<{
      area_name: string;
      idle: number;
      total: number;
      charging: number;
      fault: number;
    }>`
      SELECT area_name, idle, total, charging, fault
        FROM area_samples WHERE snapshot_id = ${curId}
    `.execute(db);
    rows = r.rows;
  }

  // 30 分钟前的快照（用于算 delta）
  const cutoff = fmtDateTime(new Date(Date.now() - 1800 * 1000));
  const oldRes = await sql<{ m: number | null }>`
    SELECT MAX(id) AS m FROM snapshots WHERE received_at < ${cutoff}
  `.execute(db);
  const oldId = oldRes.rows[0]?.m ?? null;
  const old = new Map<string, number>();
  if (oldId !== null) {
    const o = await sql<{ area_name: string; idle: number }>`
      SELECT area_name, idle FROM area_samples WHERE snapshot_id = ${oldId}
    `.execute(db);
    for (const r of o.rows) old.set(String(r.area_name), Number(r.idle));
  }

  const coordsRes = await sql<{ name: string; lat: number | null; lng: number | null }>`
    SELECT name, lat, lng FROM areas
  `.execute(db);
  const coords = new Map<string, [number | null, number | null]>();
  for (const r of coordsRes.rows) coords.set(String(r.name), [r.lat, r.lng]);

  // 端口级明细优先（含禁用/绑定/维护/硬件故障），无明细时回退平台 faultPort
  let portCounts: Map<string, [number, number]>;
  try {
    portCounts = await areaPortGroupCounts();
  } catch {
    portCounts = new Map();
  }

  let prediction: Awaited<ReturnType<typeof predictionStats>>;
  try {
    prediction = await predictionStats();
  } catch {
    prediction = {};
  }

  const maxIdle = rows.reduce((acc, r) => Math.max(acc, Number(r.idle) || 0), 0);
  const items: NowItem[] = [];

  for (const r of rows) {
    const name = String(r.area_name);
    const idle = Number(r.idle);
    const total = Number(r.total);
    const fault = Number(r.fault ?? 0);

    const [detailTotal, detailBad] = portCounts.get(name) ?? [0, 0];
    const unavailablePorts = detailTotal > 0 ? detailBad : fault;
    const delta = idle - (old.get(name) ?? idle);

    let distanceM: number | null = null;
    let score = idle; // 无坐标/未传经纬度：回退为纯空闲
    const point = coords.get(name);
    if (useCoords && point && point[0] !== null && point[1] !== null) {
      const dist = haversineM(userLat, userLng, Number(point[0]), Number(point[1]));
      distanceM = Math.trunc(pyRound(dist, 0));
      score = pyRound(
        0.65 * (idle / Math.max(1, maxIdle)) +
          0.35 * (1 - Math.min(distanceM, 3000) / 3000),
        3,
      );
    } else if (useCoords) {
      score = pyRound(0.65 * (idle / Math.max(1, maxIdle)), 3);
    }

    const walkMin =
      distanceM !== null ? Math.max(1, Math.ceil(distanceM / NOW_WALK_M_PER_MIN)) : null;

    items.push({
      name,
      idle,
      total,
      delta,
      distance_m: distanceM,
      score,
      unavailable_ports: unavailablePorts,
      port_state: areaPortState(idle, total, unavailablePorts),
      ...predictionFields(name, idle, prediction, total, walkMin),
    });
  }

  items.sort((a, b) => b.score - a.score);
  return { ok: true, areas: items };
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

  app.get('/api/now', async (req, reply) => {
    const q = (req.query ?? {}) as Record<string, unknown>;
    try {
      return reply.send(await nowPayload(q.lat, q.lng));
    } catch (err) {
      app.log.error({ err }, '/api/now 失败');
      return reply.code(500).send({ ok: false, error: 'internal_error' });
    }
  });
}
