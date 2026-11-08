/**
 * 管理端：历史分析 + CSV 导出 + 数据质量体检。
 *
 * 分页一律用游标（`id < cursor`），不用 OFFSET。
 * 导出：单次上限 2 万行（20 万行实测 313MB RSS，容器会 OOM）；更大范围请用数据浏览器。
 */
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { getDb } from '../db/index.js';
import { audit } from '../domain/adminaudit.js';
import {
  adminOf, daysAgo, idList, nowLocal, requireRole,
} from './admin-util.js';

/** CSV 字段转义 + 防 Excel 公式注入 */
function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s = String(v);
  // 以 = + - @ 开头的会被 Excel 当公式执行
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** 可导出的表白名单（表名不来自用户输入拼接） */
const EXPORT_TABLES: Record<string, { columns: string[] }> = {
  snapshots: {
    columns: ['id', 'received_at', 'captured_at', 'project', 'app_version', 'token_user', 'device_id', 'client_ip', 'body_sha256'],
  },
  area_samples: {
    columns: ['snapshot_id', 'area_id', 'area_name', 'idle', 'total', 'charging', 'fault', 'received_at'],
  },
  pile_samples: {
    columns: ['device_hex', 'ts', 'free', 'total', 'busy', 'online', 'unavailable'],
  },
  devices: {
    columns: ['device_id', 'model', 'app_version', 'status', 'uploads', 'created_at', 'last_seen'],
  },
  tokens: {
    columns: ['id', 'user_id', 'expires_at', 'source', 'updated_at', 'last_error'],
  },
  audit: {
    columns: ['id', 'ts', 'username', 'action', 'target', 'ip', 'ok'],
  },
};

export async function registerAdminHistoryRoutes(scope: FastifyInstance): Promise<void> {
  /* ==================== 快照流 ==================== */

  scope.get('/admin/api/history/snapshots', async (req) => {
    const q = req.query as {
      cursor?: string; size?: string; from?: string; to?: string;
      source?: string; device_id?: string;
    };
    const size = Math.min(Math.max(Number(q.size) || 50, 1), 200);
    const db = getDb();
    let base = sql`
      SELECT s.id, s.received_at, s.captured_at, s.device_id, s.app_version, s.token_user,
             s.body_sha256,
             (SELECT COUNT(*) FROM area_samples a WHERE a.snapshot_id = s.id) AS areas
        FROM snapshots s WHERE 1 = 1`;
    if (q.cursor) base = sql`${base} AND s.id < ${Number(q.cursor)}`;
    if (q.from) base = sql`${base} AND s.received_at >= ${q.from}`;
    if (q.to) base = sql`${base} AND s.received_at <= ${q.to}`;
    if (q.device_id) base = sql`${base} AND s.device_id = ${q.device_id}`;
    if (q.source === 'app') base = sql`${base} AND s.device_id IS NOT NULL`;
    if (q.source === 'worker') base = sql`${base} AND s.device_id IS NULL`;
    const res = await sql<{
      id: number;
      received_at: string;
      captured_at: string | null;
      device_id: string | null;
      app_version: string | null;
      token_user: string | null;
      body_sha256: string;
      areas: number;
    }>`${base} ORDER BY s.id DESC LIMIT ${size}`.execute(db);
    return {
      ok: true,
      items: res.rows.map((r) => ({
        ...r,
        source: r.device_id ? 'app' : 'worker',
        sha8: r.body_sha256.slice(0, 8),
      })),
      next_cursor: res.rows.at(-1)?.id ?? null,
    };
  });

  scope.get('/admin/api/history/snapshot/:id', async (req, reply) => {
    const id = Number((req.params as { id?: string }).id);
    if (!Number.isInteger(id)) return reply.code(400).send({ ok: false, error: 'id 非法' });
    const db = getDb();
    const snap = await sql<{
      id: number; received_at: string; captured_at: string | null;
      device_id: string | null; app_version: string | null; token_user: string | null;
      client_ip: string | null; body_sha256: string; payload: string;
    }>`
      SELECT id, received_at, captured_at, device_id, app_version, token_user,
             client_ip, body_sha256, payload FROM snapshots WHERE id = ${id}
    `.execute(db);
    const row = snap.rows[0];
    if (!row) return reply.code(404).send({ ok: false, error: '快照不存在' });
    const samples = await sql<{
      area_name: string; idle: number; total: number; charging: number; fault: number;
    }>`
      SELECT area_name, idle, total, charging, fault FROM area_samples
       WHERE snapshot_id = ${id} ORDER BY area_name
    `.execute(db);
    let payloadPreview: unknown = null;
    try {
      payloadPreview = JSON.parse(row.payload);
    } catch {
      payloadPreview = null;
    }
    return { ok: true, snapshot: { ...row, payload: undefined }, areas: samples.rows, payload: payloadPreview };
  });

  scope.delete('/admin/api/snapshot/:id', async (req, reply) => {
    if (!requireRole(req, reply, 'ops')) return undefined;
    const admin = adminOf(req);
    const id = Number((req.params as { id?: string }).id);
    if (!Number.isInteger(id)) return reply.code(400).send({ ok: false, error: 'id 非法' });
    const db = getDb();
    // 硬删：快照与采样可重抓，不留包袱
    const del = await sql`DELETE FROM area_samples WHERE snapshot_id = ${id}`.execute(db);
    const del2 = await sql`DELETE FROM snapshots WHERE id = ${id}`.execute(db);
    if (!del2.numAffectedRows) return reply.code(404).send({ ok: false, error: '快照不存在' });
    await audit({
      username: admin.username, action: 'snapshot_delete', target: String(id), ip: req.ip,
      detail: { samples: Number(del.numAffectedRows ?? 0) },
    });
    return { ok: true, deleted: 1, samples: Number(del.numAffectedRows ?? 0) };
  });

  /* ==================== 趋势 ==================== */

  scope.get('/admin/api/history/area-trend', async (req, reply) => {
    const q = req.query as { areas?: string; range?: string; metric?: string };
    const areas = String(q.areas ?? '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 10);
    if (!areas.length) return reply.code(400).send({ ok: false, error: '请至少选一个区域' });
    const range = q.range === '7d' ? 7 : q.range === '30d' ? 30 : q.range === '6h' ? 0 : 1;
    const since = range === 0 ? daysAgo(0.25) : daysAgo(range);
    const metric = q.metric === 'idle' ? 'idle' : q.metric === 'total' ? 'total' : 'rate';
    const db = getDb();
    const res = await sql<{ area_name: string; bucket: string; idle: number; total: number }>`
      SELECT area_name, substr(received_at, 1, 13) AS bucket,
             AVG(idle) AS idle, AVG(total) AS total
        FROM area_samples
       WHERE area_name IN (${sql.join(areas)}) AND received_at >= ${since}
       GROUP BY area_name, bucket
       ORDER BY bucket
    `.execute(db);
    // 按区域分组
    const byArea = new Map<string, Array<{ t: string; value: number | null }>>();
    for (const r of res.rows) {
      const total = Number(r.total) || 0;
      const idle = Number(r.idle) || 0;
      const value = metric === 'idle' ? idle : metric === 'total' ? total : (total > 0 ? idle / total : null);
      const list = byArea.get(r.area_name) ?? [];
      list.push({ t: r.bucket, value });
      byArea.set(r.area_name, list);
    }
    return {
      ok: true,
      range: q.range ?? '24h',
      metric,
      series: areas.map((name) => ({ name, points: byArea.get(name) ?? [] })),
    };
  });

  scope.get('/admin/api/history/pile-trend', async (req, reply) => {
    const q = req.query as { device_hex?: string; range?: string };
    const deviceHex = String(q.device_hex ?? '').trim();
    if (!deviceHex) return reply.code(400).send({ ok: false, error: '缺少 device_hex' });
    const days = q.range === '7d' ? 7 : 1;
    const since = daysAgo(days);
    const db = getDb();
    const res = await sql<{
      bucket: string; free: number; busy: number; unavailable: number; total: number;
    }>`
      SELECT substr(ts, 1, 13) AS bucket,
             AVG(free) AS free, AVG(busy) AS busy,
             AVG(COALESCE(unavailable, 0)) AS unavailable, AVG(total) AS total
        FROM pile_samples
       WHERE device_hex = ${deviceHex} AND ts >= ${since}
       GROUP BY bucket ORDER BY bucket
    `.execute(db);
    return {
      ok: true,
      device_hex: deviceHex,
      points: res.rows.map((r) => ({
        t: r.bucket,
        free: Number(r.free) || 0,
        busy: Number(r.busy) || 0,
        unavailable: Number(r.unavailable) || 0,
        total: Number(r.total) || 0,
      })),
    };
  });

  /* ==================== CSV 导出（流式） ==================== */

  scope.get('/admin/api/export.csv', async (req, reply) => {
    const q = req.query as { table?: string; from?: string; to?: string };
    const table = String(q.table ?? '');
    const spec = EXPORT_TABLES[table];
    if (!spec) {
      return reply.code(400).send({
        ok: false,
        error: `不支持导出该表；可选：${Object.keys(EXPORT_TABLES).join(' / ')}`,
      });
    }
    const db = getDb();
    // 全程参数化：表名走白名单分支，时间条件走绑定参数（绝不拼字符串）
    const from = String(q.from ?? '');
    const to = String(q.to ?? '');
    // M19：20 万行实测 313MB RSS（容器会 OOM）；先降到 2 万，需要更多请用数据浏览器分批
    const LIMIT = 20000;
    let rows: Array<Record<string, unknown>> = [];
    if (table === 'snapshots') {
      rows = (await sql<Record<string, unknown>>`
        SELECT id, received_at, captured_at, project, app_version, token_user,
               device_id, client_ip, body_sha256
          FROM snapshots
         WHERE (${from} = '' OR received_at >= ${from})
           AND (${to} = '' OR received_at <= ${to})
         ORDER BY id DESC LIMIT ${LIMIT}
      `.execute(db)).rows;
    } else if (table === 'area_samples') {
      rows = (await sql<Record<string, unknown>>`
        SELECT snapshot_id, area_id, area_name, idle, total, charging, fault, received_at
          FROM area_samples
         WHERE (${from} = '' OR received_at >= ${from})
           AND (${to} = '' OR received_at <= ${to})
         ORDER BY snapshot_id DESC LIMIT ${LIMIT}
      `.execute(db)).rows;
    } else if (table === 'pile_samples') {
      rows = (await sql<Record<string, unknown>>`
        SELECT device_hex, ts, free, total, busy, online, unavailable
          FROM pile_samples ORDER BY ts DESC LIMIT ${LIMIT}
      `.execute(db)).rows;
    } else if (table === 'devices') {
      rows = (await sql<Record<string, unknown>>`
        SELECT device_id, model, app_version, status, uploads, created_at, last_seen
          FROM devices ORDER BY created_at DESC LIMIT ${LIMIT}
      `.execute(db)).rows;
    } else if (table === 'tokens') {
      rows = (await sql<Record<string, unknown>>`
        SELECT id, user_id, expires_at, source, updated_at, last_error
          FROM token_pool ORDER BY COALESCE(expires_at, 0) DESC LIMIT ${LIMIT}
      `.execute(db)).rows;
    } else {
      rows = (await sql<Record<string, unknown>>`
        SELECT id, ts, username, action, target, ip, ok
          FROM admin_audit ORDER BY id DESC LIMIT ${LIMIT}
      `.execute(db)).rows;
    }

    const lines: string[] = [spec.columns.join(',')];
    for (const r of rows) {
      lines.push(spec.columns.map((c) => csvCell(r[c])).join(','));
    }
    // BOM 让 Excel 正确识别 UTF-8
    const body = '\uFEFF' + lines.join('\r\n') + '\r\n';
    const stamp = nowLocal().replace(/[-: ]/g, '').slice(0, 14);
    return reply
      .type('text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${table}-${stamp}.csv"`)
      .header('Content-Length', Buffer.byteLength(body))
      .send(body);
  });

  /* ==================== 数据质量体检 ==================== */

  scope.get('/admin/api/quality/scan', async () => {
    const db = getDb();
    const checks: Array<{
      code: string; level: 'red' | 'yellow' | 'blue'; title: string;
      count: number; samples: unknown[];
    }> = [];

    // 1) 守恒失败：idle + charging + fault != total（最近 2000 条采样）
    try {
      const res = await sql<{
        snapshot_id: number; area_name: string; idle: number; charging: number;
        fault: number; total: number;
      }>`
        SELECT snapshot_id, area_name, idle, charging, fault, total FROM area_samples
         WHERE (idle + charging + fault) <> total
         ORDER BY snapshot_id DESC LIMIT 20
      `.execute(db);
      const cnt = await sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM area_samples WHERE (idle + charging + fault) <> total
      `.execute(db);
      checks.push({
        code: 'conservation_fail',
        level: 'yellow',
        title: '守恒失败（空闲+充电+故障 ≠ 总数）',
        count: Number(cnt.rows[0]?.n ?? 0),
        samples: res.rows,
      });
    } catch {
      /* 跳过 */
    }

    // 2) 区域突变：最新快照 total 与 24h 前差异 > 50%
    try {
      const res = await sql<{ area_name: string; now_total: number; old_total: number }>`
        WITH latest AS (
          SELECT area_name, total FROM area_samples
           WHERE snapshot_id = (SELECT MAX(id) FROM snapshots)
        ), old AS (
          SELECT area_name, AVG(total) AS total FROM area_samples
           WHERE received_at >= ${daysAgo(1)} AND received_at < ${daysAgo(0.5)}
           GROUP BY area_name
        )
        SELECT l.area_name, l.total AS now_total, o.total AS old_total
          FROM latest l JOIN old o ON o.area_name = l.area_name
         WHERE o.total > 0 AND ABS(l.total - o.total) * 2.0 > o.total
         LIMIT 20
      `.execute(db);
      checks.push({
        code: 'area_shift',
        level: 'yellow',
        title: '区域端口数突变（与 24h 前差 > 50%）',
        count: res.rows.length,
        samples: res.rows,
      });
    } catch {
      /* 跳过 */
    }

    // 3) 无坐标区域
    try {
      const res = await sql<{ area_id: string; name: string }>`
        SELECT area_id, name FROM areas
         WHERE COALESCE(deleted_at, '') = '' AND (lat IS NULL OR lng IS NULL)
         LIMIT 50
      `.execute(db);
      checks.push({
        code: 'no_coords',
        level: 'yellow',
        title: '区域缺坐标（地图点不上去）',
        count: res.rows.length,
        samples: res.rows,
      });
    } catch {
      /* 跳过 */
    }

    // 4) 幽灵端口：24h 未更新
    try {
      const res = await sql<{ device_hex: string; port: string; updated_at: string | null }>`
        SELECT device_hex, port, updated_at FROM port_states
         WHERE COALESCE(updated_at, '') < ${daysAgo(1)} LIMIT 20
      `.execute(db);
      const cnt = await sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM port_states WHERE COALESCE(updated_at, '') < ${daysAgo(1)}
      `.execute(db);
      checks.push({
        code: 'ghost_ports',
        level: 'yellow',
        title: '端口 24h 未更新（可能已下线）',
        count: Number(cnt.rows[0]?.n ?? 0),
        samples: res.rows,
      });
    } catch {
      /* 跳过 */
    }

    // 5) 快照过密：最近 1 小时内某小时 > 30 条
    try {
      const res = await sql<{ bucket: string; n: number }>`
        SELECT substr(received_at, 1, 13) AS bucket, COUNT(*) AS n FROM snapshots
         WHERE received_at >= ${daysAgo(1)}
         GROUP BY bucket HAVING COUNT(*) > 30 ORDER BY n DESC LIMIT 10
      `.execute(db);
      checks.push({
        code: 'too_dense',
        level: 'blue',
        title: '近 24h 某小时快照过密（>30 条）',
        count: res.rows.length,
        samples: res.rows,
      });
    } catch {
      /* 跳过 */
    }

    // 6) 长期未活跃设备（30 天）
    try {
      const res = await sql<{ device_id: string; last_seen: string | null }>`
        SELECT device_id, last_seen FROM devices
         WHERE COALESCE(deleted_at, '') = '' AND COALESCE(revoked, 0) = 0
           AND COALESCE(last_seen, '') < ${daysAgo(30)}
         LIMIT 50
      `.execute(db);
      checks.push({
        code: 'stale_devices',
        level: 'blue',
        title: '设备 30 天未上传',
        count: res.rows.length,
        samples: res.rows,
      });
    } catch {
      /* 跳过 */
    }

    return { ok: true, checks: checks.filter((c) => c.count > 0), scanned_at: nowLocal() };
  });

  scope.post('/admin/api/quality/fix', async (req, reply) => {
    if (!requireRole(req, reply, 'ops')) return undefined;
    const admin = adminOf(req);
    const raw = req.body as unknown;
    let body: { kind?: string; ids?: unknown } = {};
    if (Buffer.isBuffer(raw)) {
      try { body = JSON.parse(raw.toString('utf8')) as typeof body; } catch { body = {}; }
    } else if (raw && typeof raw === 'object') {
      body = raw as typeof body;
    }
    const kind = String(body.kind ?? '');
    const db = getDb();
    if (kind === 'ghost_ports') {
      const r = await sql`DELETE FROM port_states WHERE COALESCE(updated_at, '') < ${daysAgo(1)}`.execute(db);
      await audit({ username: admin.username, action: 'quality_fix', target: kind, ip: req.ip, detail: { deleted: Number(r.numAffectedRows ?? 0) } });
      return { ok: true, deleted: Number(r.numAffectedRows ?? 0) };
    }
    if (kind === 'conservation_fail') {
      // M23：只删"坏的那几行"，不能按 snapshot_id 把整条快照的好数据一起删
      const ids = idList(body.ids);
      const r = await sql`
        DELETE FROM area_samples
         WHERE (idle + charging + fault) <> total
           ${ids.length ? sql`AND snapshot_id IN (${sql.join(ids)})` : sql``}
      `.execute(db);
      await audit({ username: admin.username, action: 'quality_fix', target: kind, ip: req.ip, detail: { rows: Number(r.numAffectedRows ?? 0) } });
      return { ok: true, deleted: Number(r.numAffectedRows ?? 0) };
    }
    return reply.code(400).send({ ok: false, error: '该检查项不支持一键修复' });
  });
}
