/**
 * 管理后台 P1 业务接口：概览 / 趋势 / 令牌池 / 实时数据 / 系统信息 / 告警（实时求值）。
 *
 * 由 `routes/admin.ts` 在**已挂会话守卫的 scope** 里调用，本文件不再重复鉴权。
 * 所有查询走现有索引；分页用游标（不用 OFFSET）。
 */
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import fs from 'node:fs';
import { DATABASE_PATH, NODE_ENV, P2P_ENABLED, REGISTER_TOKEN, SERVER_VERSION } from '../config.js';
import { getDb } from '../db/index.js';
import { tokenPoolStats } from '../domain/health.js';
import { getWorkerState } from '../domain/worker.js';
import { banlistStats } from '../domain/banlist.js';
import { p2pPeers, p2pSelfId, p2pSelfName, p2pWhitelistCount } from '../domain/p2p.js';
import { readSettings } from '../domain/adminsettings.js';
import { adminOf, readBody, requireRole } from './admin-util.js';
import { audit } from '../domain/adminaudit.js';

function nowLocal(): string {
  const d = new Date();
  const p = (x: number): string => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
    + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function todayStart(): string {
  const d = new Date();
  const p = (x: number): string => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} 00:00:00`;
}

function daysAgoStart(days: number): string {
  const d = new Date(Date.now() - days * 86400_000);
  const p = (x: number): string => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} 00:00:00`;
}

/** 本地时间字符串 → 秒级 epoch；解析失败返回 0 */
function parseLocal(ts: string | null | undefined): number {
  if (!ts) return 0;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(ts));
  if (!m) return 0;
  const [, y, mo, d, h, mi, s] = m;
  return Math.floor(
    new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)).getTime() / 1000,
  );
}

export async function registerAdminDataRoutes(scope: FastifyInstance): Promise<void> {
  /* ================= 概览 ================= */
  scope.get('/admin/api/overview', async () => {
    const db = getDb();
    const pool = await tokenPoolStats();
    const peers = p2pPeers();
    const worker = getWorkerState();
    const settings = await readSettings();

    // 今日 / 昨日同时段快照数
    const snapRes = await sql<{
      today: number;
      yesterday_same: number;
      last_at: string | null;
    }>`
      SELECT
        (SELECT COUNT(*) FROM snapshots WHERE received_at >= ${todayStart()}) AS today,
        (SELECT COUNT(*) FROM snapshots
          WHERE received_at >= ${daysAgoStart(1)}
            AND received_at < ${todayStart()}) AS yesterday_same,
        (SELECT MAX(received_at) FROM snapshots) AS last_at
    `.execute(db);
    const snap = snapRes.rows[0] ?? { today: 0, yesterday_same: 0, last_at: null };

    // 设备在线（24h 有 last_seen）
    const devRes = await sql<{ online: number; total: number }>`
      SELECT
        (SELECT COUNT(*) FROM devices
          WHERE last_seen >= ${daysAgoStart(1)}) AS online,
        (SELECT COUNT(*) FROM devices
          WHERE COALESCE(deleted_at, '') = '') AS total
    `.execute(db);
    const dev = devRes.rows[0] ?? { online: 0, total: 0 };

    // 区域/控制器/端口
    const statRes = await sql<{
      areas: number;
      controllers: number;
      ports: number;
      free: number;
      busy: number;
      unavailable: number;
    }>`
      SELECT
        (SELECT COUNT(*) FROM areas WHERE COALESCE(deleted_at, '') = '') AS areas,
        (SELECT COUNT(*) FROM controllers) AS controllers,
        (SELECT COUNT(*) FROM port_states) AS ports,
        (SELECT COUNT(*) FROM port_states WHERE status_group = 'free') AS free,
        (SELECT COUNT(*) FROM port_states WHERE status_group = 'busy') AS busy,
        (SELECT COUNT(*) FROM port_states WHERE status_group = 'unavailable') AS unavailable
    `.execute(db);
    const counts = statRes.rows[0] ?? {
      areas: 0, controllers: 0, ports: 0, free: 0, busy: 0, unavailable: 0,
    };

    // 数据新鲜度
    const lastAt = snap.last_at;
    const lastSec = parseLocal(lastAt);
    const ageSec = lastSec ? Math.max(0, Math.floor(Date.now() / 1000) - lastSec) : null;

    const deltaPct = snap.yesterday_same > 0
      ? Math.round(((snap.today - snap.yesterday_same) / snap.yesterday_same) * 100)
      : null;

    /* ---- 告警（实时求值，P1 不落库） ---- */
    const alerts: Array<{ level: 'red' | 'yellow' | 'blue'; code: string; text: string; jump?: string }> = [];
    if (pool.valid === 0 && pool.count > 0) {
      alerts.push({
        level: 'red',
        code: 'token_empty',
        text: `令牌池 ${pool.count} 条全部过期，服务器无法抓取`,
        jump: 'tokens',
      });
    }
    if (ageSec !== null && ageSec > 3600) {
      alerts.push({
        level: 'red',
        code: 'stale_snapshot',
        text: `最近一条快照已 ${Math.floor(ageSec / 60)} 分钟前`,
        jump: 'live',
      });
    }
    if (worker.last_result && /no-token|error|fail/i.test(String(worker.last_result))) {
      alerts.push({
        level: 'yellow',
        code: 'worker_fail',
        text: `worker 最近一轮：${worker.last_result}`,
        jump: 'jobs',
      });
    }
    if (P2P_ENABLED && !p2pSelfId()) {
      alerts.push({ level: 'yellow', code: 'p2p_degraded', text: 'P2P 已启用但未启动成功（降级单节点）', jump: 'nodes' });
    }
    if (settings.p2p_validate_mode === 'warn') {
      alerts.push({ level: 'blue', code: 'validate_warn', text: '跨节点互校处于 warn 模式（只记录不丢弃）', jump: 'nodes' });
    }

    return {
      ok: true,
      cards: {
        snapshots_today: snap.today,
        snapshots_delta_pct: deltaPct,
        devices_online: dev.online,
        devices_total: dev.total,
        tokens_valid: pool.valid,
        tokens_total: pool.count,
        tokens_next_exp_sec: pool.earliest_exp
          ? Math.max(0, pool.earliest_exp - Math.floor(Date.now() / 1000))
          : null,
        nodes_online: peers.length,
        nodes_whitelist: p2pWhitelistCount(),
        freshness_sec: ageSec,
      },
      data: {
        areas: counts.areas,
        controllers: counts.controllers,
        ports: counts.ports,
        free: counts.free,
        busy: counts.busy,
        unavailable: counts.unavailable,
        last_upload_at: lastAt,
      },
      health: {
        db: 'ok',
        p2p: { enabled: P2P_ENABLED, running: !!p2pSelfId(), online: peers.length },
        worker: { last_result: worker.last_result ?? null, runs: worker.runs ?? 0 },
        banlist: banlistStats(),
      },
      alerts,
    };
  });

  /* ================= 趋势 ================= */
  scope.get('/admin/api/overview/trend', async (req) => {
    const range = String((req.query as { range?: string }).range ?? '24h');
    const hours = range === '7d' ? 168 : range === '30d' ? 720 : 24;
    const since = new Date(Date.now() - hours * 3600_000);
    const p = (x: number): string => String(x).padStart(2, '0');
    const sinceStr = `${since.getFullYear()}-${p(since.getMonth() + 1)}-${p(since.getDate())} `
      + `${p(since.getHours())}:00:00`;
    const db = getDb();
    // 快照量按小时
    const snapRes = await sql<{ bucket: string; n: number }>`
      SELECT substr(received_at, 1, 13) AS bucket, COUNT(*) AS n
        FROM snapshots WHERE received_at >= ${sinceStr}
       GROUP BY bucket ORDER BY bucket
    `.execute(db);
    // 平均空闲率按小时（area_samples 与 snapshots 同时刻聚合，直接用 received_at）
    const rateRes = await sql<{ bucket: string; rate: number | null }>`
      SELECT substr(received_at, 1, 13) AS bucket,
             AVG(CASE WHEN total > 0 THEN idle * 1.0 / total ELSE NULL END) AS rate
        FROM area_samples WHERE received_at >= ${sinceStr}
       GROUP BY bucket ORDER BY bucket
    `.execute(db);
    const rateMap = new Map(rateRes.rows.map((r) => [r.bucket, r.rate]));
    const points = snapRes.rows.map((r) => ({
      t: r.bucket,
      snapshots: Number(r.n),
      idle_rate: rateMap.get(r.bucket) ?? null,
    }));
    return { ok: true, range, points };
  });

  /* ================= 空位排行 ================= */
  scope.get('/admin/api/overview/ranking', async (req) => {
    const limit = Math.min(Math.max(Number((req.query as { limit?: string }).limit) || 5, 1), 20);
    const db = getDb();
    const res = await sql<{ area_name: string; idle: number; total: number }>`
      SELECT area_name, idle, total FROM area_samples
       WHERE snapshot_id = (SELECT MAX(id) FROM snapshots)
       ORDER BY CASE WHEN total > 0 THEN idle * 1.0 / total ELSE 0 END DESC
       LIMIT ${limit}
    `.execute(db);
    const res2 = await sql<{ area_name: string; idle: number; total: number }>`
      SELECT area_name, idle, total FROM area_samples
       WHERE snapshot_id = (SELECT MAX(id) FROM snapshots)
       ORDER BY CASE WHEN total > 0 THEN idle * 1.0 / total ELSE 1 END ASC
       LIMIT ${limit}
    `.execute(db);
    return {
      ok: true,
      emptiest: res.rows,
      fullest: res2.rows,
    };
  });

  /* ================= 实时事件流 ================= */
  scope.get('/admin/api/overview/events', async (req) => {
    const limit = Math.min(Number((req.query as { limit?: string }).limit) || 10, 50);
    const res = await sql<{
      id: number;
      received_at: string;
      device_id: string | null;
      app_version: string | null;
      areas: number;
    }>`
      SELECT s.id, s.received_at, s.device_id, s.app_version,
             (SELECT COUNT(*) FROM area_samples a WHERE a.snapshot_id = s.id) AS areas
        FROM snapshots s ORDER BY s.id DESC LIMIT ${limit}
    `.execute(getDb());
    return {
      ok: true,
      items: res.rows.map((r) => ({
        id: r.id,
        ts: r.received_at,
        source: r.device_id ? 'app' : 'worker',
        device_id: r.device_id,
        app_version: r.app_version,
        areas: Number(r.areas),
      })),
    };
  });

  /* ================= 令牌池 ================= */
  scope.get('/admin/api/tokens', async () => {
    const stats = await tokenPoolStats();
    const res = await sql<{
      id: number;
      user_id: string | null;
      expires_at: number | null;
      updated_at: string | null;
      source: string | null;
      last_error: string | null;
    }>`
      SELECT id, user_id, expires_at, updated_at, source, last_error
        FROM token_pool ORDER BY COALESCE(expires_at, 0) DESC
    `.execute(getDb());
    const nowSec = Math.floor(Date.now() / 1000);
    return {
      ok: true,
      stats,
      list: res.rows.map((r) => {
        const exp = Number(r.expires_at ?? 0);
        return {
          id: r.id,
          user_id: r.user_id,
          source: r.source,
          expires_at: exp,
          remain_sec: exp ? exp - nowSec : null,
          status: exp > nowSec ? 'valid' : 'expired',
          last_error: r.last_error,
          updated_at: r.updated_at,
        };
      }),
    };
  });

  scope.post('/admin/api/tokens/purge', async (req, reply) => {
    if (!requireRole(req, reply, 'ops')) return undefined;
    const admin = adminOf(req);
    const nowSec = Math.floor(Date.now() / 1000);
    const r = await sql`
      DELETE FROM token_pool WHERE COALESCE(expires_at, 0) <= ${nowSec}
    `.execute(getDb());
    const deleted = Number(r.numAffectedRows ?? 0);
    await audit({ username: admin.username, action: 'token_purge', ip: req.ip, detail: { deleted } });
    return { ok: true, deleted };
  });

  scope.post('/admin/api/tokens/delete', async (req, reply) => {
    if (!requireRole(req, reply, 'ops')) return undefined;
    const admin = adminOf(req);
    const body = readBody<{ ids?: unknown }>(req);
    const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(Number.isFinite) : [];
    if (!ids.length) return { ok: true, deleted: 0 };
    const r = await sql`DELETE FROM token_pool WHERE id IN (${sql.join(ids)})`.execute(getDb());
    const deleted = Number(r.numAffectedRows ?? 0);
    await audit({ username: admin.username, action: 'token_delete', target: ids.join(','), ip: req.ip, detail: { deleted } });
    return { ok: true, deleted };
  });

  /* ================= 实时数据 ================= */
  scope.get('/admin/api/live', async (req) => {
    const q = req.query as { q?: string; only_free?: string; sort?: string };
    const db = getDb();
    const snap = await sql<{ id: number; received_at: string }>`
      SELECT id, received_at FROM snapshots ORDER BY id DESC LIMIT 1
    `.execute(db);
    const latest = snap.rows[0];
    if (!latest) return { ok: true, snapshot: null, areas: [] };

    const rows = await sql<{
      area_name: string;
      idle: number;
      total: number;
      charging: number;
      fault: number;
      area_id: string | null;
    }>`
      SELECT a.area_name, SUM(a.idle) AS idle, SUM(a.total) AS total,
             SUM(a.charging) AS charging, SUM(a.fault) AS fault,
             MAX(a.area_id) AS area_id
        FROM area_samples a
       WHERE a.snapshot_id = ${latest.id}
       GROUP BY a.area_name
    `.execute(db);

    let areas = rows.rows.map((r) => {
      const total = Number(r.total) || 0;
      const idle = Number(r.idle) || 0;
      return {
        area_id: r.area_id,
        name: r.area_name,
        total,
        idle,
        charging: Number(r.charging) || 0,
        fault: Number(r.fault) || 0,
        idle_rate: total > 0 ? idle / total : 0,
      };
    });
    if (q.q) {
      const needle = String(q.q).trim();
      areas = areas.filter((a) => a.name.includes(needle));
    }
    if (q.only_free === '1') areas = areas.filter((a) => a.idle > 0);
    const sort = q.sort === 'rate' ? 'rate' : 'idle';
    areas.sort((a, b) => (sort === 'rate' ? b.idle_rate - a.idle_rate : b.idle - a.idle));

    return {
      ok: true,
      snapshot: { id: latest.id, received_at: latest.received_at },
      areas,
    };
  });

  scope.get('/admin/api/live/area', async (req, reply) => {
    const name = String((req.query as { name?: string }).name ?? '').trim();
    if (!name) return reply.code(400).send({ ok: false, error: '缺少 name' });
    const db = getDb();
    const ports = await sql<{
      device_hex: string;
      port: string;
      status: string | null;
      status_group: string;
      updated_at: string | null;
    }>`
      SELECT p.device_hex, p.port, p.status, p.status_group, p.updated_at
        FROM port_states p
        JOIN controllers c ON c.device_hex = p.device_hex
       WHERE c.area_name = ${name}
       ORDER BY p.device_hex, p.port
    `.execute(db);
    return { ok: true, area: name, ports: ports.rows };
  });

  /* ================= 系统信息 ================= */
  scope.get('/admin/api/system', async () => {
    const db = getDb();
    // 表行数
    const tables = ['snapshots', 'area_samples', 'areas', 'devices', 'controllers',
      'port_states', 'pile_samples', 'token_pool', 'worker_runs', 'admin_audit',
      'p2p_validation'];
    const rows: Array<{ name: string; rows: number }> = [];
    for (const t of tables) {
      try {
        // 表名来自白名单常量，不拼接外部输入
        const r = await sql<{ n: number }>`SELECT COUNT(*) AS n FROM ${sql.table(t)}`.execute(db);
        rows.push({ name: t, rows: Number(r.rows[0]?.n ?? 0) });
      } catch {
        /* 表可能还不存在（旧库） */
      }
    }
    // 体积（含 wal/shm）
    let dbSize = 0;
    for (const f of [DATABASE_PATH, `${DATABASE_PATH}-wal`, `${DATABASE_PATH}-shm`]) {
      try {
        dbSize += fs.statSync(f).size;
      } catch {
        /* 文件不存在 */
      }
    }
    const mem = process.memoryUsage();
    return {
      ok: true,
      runtime: {
        version: SERVER_VERSION,
        node_env: NODE_ENV,
        uptime_sec: Math.floor(process.uptime()),
        mem_rss: mem.rss,
        db_size: dbSize,
        p2p_enabled: P2P_ENABLED,
        p2p_self: p2pSelfId(),
        p2p_self_name: p2pSelfName(),
      },
      env: [
        { key: 'SERVER_VERSION', configured: !!SERVER_VERSION, value: SERVER_VERSION },
        { key: 'NODE_ENV', configured: true, value: NODE_ENV },
        { key: 'ADMIN_INIT_PASSWORD', configured: !!process.env.ADMIN_INIT_PASSWORD },
        { key: 'ADMIN_SESSION_SECRET', configured: !!process.env.ADMIN_SESSION_SECRET },
        { key: 'REGISTER_TOKEN', configured: !!REGISTER_TOKEN },
        { key: 'TRUST_PROXY', configured: !!process.env.TRUST_PROXY, value: process.env.TRUST_PROXY ?? null },
        { key: 'P2P_ENABLED', configured: true, value: String(P2P_ENABLED) },
      ],
      tables: rows,
      ts: nowLocal(),
    };
  });

  /* ================= 上传审计（upload_audit） ================= */
  scope.get('/admin/api/audit/upload', async (req) => {
    const q = req.query as { result?: string; limit?: string; before_id?: string };
    const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200);
    const db = getDb();
    let base = sql`
      SELECT id, ts, ip, ua, size, result, detail FROM upload_audit WHERE 1 = 1`;
    if (q.before_id) base = sql`${base} AND id < ${Number(q.before_id)}`;
    if (q.result === 'ok') base = sql`${base} AND result = 'ok'`;
    else if (q.result === 'fail') base = sql`${base} AND result <> 'ok'`;
    const res = await sql<{
      id: number; ts: string; ip: string | null; ua: string | null;
      size: number | null; result: string | null; detail: string | null;
    }>`${base} ORDER BY id DESC LIMIT ${limit}`.execute(db);
    return {
      ok: true,
      items: res.rows.map((r) => {
        let detail: unknown = null;
        try {
          detail = r.detail ? JSON.parse(r.detail) : null;
        } catch {
          detail = null;
        }
        return { ...r, detail };
      }),
      next_cursor: res.rows.at(-1)?.id ?? null,
    };
  });

  /* ================= 告警 ================= */
  scope.get('/admin/api/alerts', async () => {
    // P1 是实时求值（与概览同一套规则）；告警状态机（触发/恢复/忽略）在 P2 接 alert_state
    const pool = await tokenPoolStats();
    const worker = getWorkerState();
    const alerts: Array<{ level: string; code: string; text: string; jump?: string }> = [];
    const snapRes = await sql<{ last_at: string | null }>`
      SELECT MAX(received_at) AS last_at FROM snapshots
    `.execute(getDb());
    const lastSec = parseLocal(snapRes.rows[0]?.last_at ?? null);
    const ageSec = lastSec ? Math.max(0, Math.floor(Date.now() / 1000) - lastSec) : null;
    if (pool.valid === 0 && pool.count > 0) {
      alerts.push({
        level: 'red',
        code: 'token_empty',
        text: `令牌池 ${pool.count} 条全部过期`,
        jump: 'tokens',
      });
    }
    if (ageSec !== null && ageSec > 3600) {
      alerts.push({
        level: 'red',
        code: 'stale_snapshot',
        text: `最近一条快照已 ${Math.floor(ageSec / 60)} 分钟前`,
        jump: 'live',
      });
    }
    if (worker.last_result && /no-token|error|fail/i.test(String(worker.last_result))) {
      alerts.push({
        level: 'yellow',
        code: 'worker_fail',
        text: `worker 最近一轮：${worker.last_result}`,
        jump: 'jobs',
      });
    }
    if (P2P_ENABLED && !p2pSelfId()) {
      alerts.push({
        level: 'yellow',
        code: 'p2p_degraded',
        text: 'P2P 已启用但未启动成功（降级单节点）',
        jump: 'nodes',
      });
    }
    return { ok: true, alerts, persisted: false };
  });
}
