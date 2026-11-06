/**
 * 端口族路由：/api/areas-ports、/api/area-ports、/api/pile/:device
 *
 * ⚠️ 响应结构与 `cloud/http/api_ports.py` 逐字段一致（P2 要对拍 100% 相同）：
 *   _api_areas_ports → GET /api/areas-ports  {ok,total,truncated,areas[{area,devices,summary}]}
 *   _api_area_ports  → GET /api/area-ports   {ok,area,devices,updated_at,summary}
 *   _pile_detail     → GET /api/pile/:device {ok,device,ports,history}
 *
 * SQL 也与 Python 版逐字一致（包括 ORDER BY / LIMIT），这样排序结果相同。
 */
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import {
  AREA_PORTS_DEVICE_LIMIT,
  AREAS_PORTS_LIMIT,
  PILE_HISTORY_LIMIT,
} from '../config.js';
import { getDb } from '../db/index.js';
import { type PortRow, portsHealth, statusGroup, summarizeDevices } from '../domain/ports.js';

interface JoinedRow {
  device_hex: string;
  code: string | null;
  area_name: string | null;
  ctrl_at: string | null;
  qr_device_no: string | null;
  port: string | null;
  status: string | null;
  port_at: string | null;
}

interface DeviceOut {
  device_hex: string;
  code: string | null;
  qr_device_no: string | null;
  updated_at: string;
  ports: Array<{ port: string; status: string | null; group: string }>;
  total?: number;
  free?: number;
  busy?: number;
  unavailable?: number;
  unknown?: number;
  statuses?: Record<string, number>;
  state?: string;
  stale?: boolean;
  online?: boolean;
  error?: string | null;
}

/** 把一组 JOIN 行聚合成设备对象（与 Python 的 dict 组装顺序一致） */
function buildDevices(
  rows: readonly JoinedRow[],
  opts: { skipNullPorts: boolean },
): DeviceOut[] {
  const order: string[] = [];
  const byHex = new Map<string, { dev: DeviceOut; portRows: PortRow[] }>();

  for (const r of rows) {
    let slot = byHex.get(r.device_hex);
    if (!slot) {
      const dev: DeviceOut = {
        device_hex: r.device_hex,
        code: r.code,
        qr_device_no: r.qr_device_no,
        updated_at: r.ctrl_at ?? '',
        ports: [],
      };
      slot = { dev, portRows: [] };
      byHex.set(r.device_hex, slot);
      order.push(r.device_hex);
    }
    if (opts.skipNullPorts && r.port === null) continue;
    slot.dev.ports.push({
      port: String(r.port),
      status: r.status,
      group: statusGroup(r.status),
    });
    slot.portRows.push([r.port, r.status, r.port_at] as const);
  }

  return order.map((hex) => {
    const { dev, portRows } = byHex.get(hex)!;
    const latestPortAt = portRows.reduce(
      (acc: string, row) => {
        const v = row[2] ?? '';
        return v > acc ? v : acc;
      },
      '',
    );
    dev.updated_at = latestPortAt || dev.updated_at || '';
    const health = portsHealth(portRows, dev.updated_at);
    // 键顺序与 Python 的 dev.update(_ports_health(...)) 一致
    dev.total = health.total;
    dev.free = health.free;
    dev.busy = health.busy;
    dev.unavailable = health.unavailable;
    dev.unknown = health.unknown;
    dev.statuses = health.statuses;
    dev.state = health.state;
    dev.stale = health.stale;
    dev.online = health.online;
    dev.error = health.error;
    return dev;
  });
}

/** 全区端口总览（/api/areas-ports） */
export async function areasPortsPayload(): Promise<{
  ok: true;
  total: number;
  truncated: boolean;
  areas: Array<{ area: string; devices: DeviceOut[]; summary: ReturnType<typeof summarizeDevices> }>;
}> {
  const db = getDb();

  // 与 Python 相同的两条 SQL（子查询带 LIMIT，再 JOIN / 统计）
  const rowsRes = await sql<JoinedRow>`
    SELECT c.device_hex, c.code, c.area_name, c.updated_at AS ctrl_at,
           c.qr_device_no, p.port, p.status, p.updated_at AS port_at
      FROM (SELECT device_hex, code, area_name, updated_at, qr_device_no
              FROM controllers ORDER BY area_name, device_hex LIMIT ${AREAS_PORTS_LIMIT}) c
      JOIN port_states p ON p.device_hex = c.device_hex
     ORDER BY c.area_name, c.device_hex, p.port
  `.execute(db);

  const totalRes = await sql<{ n: number }>`
    SELECT COUNT(DISTINCT c.device_hex) AS n
      FROM controllers c
      JOIN port_states p ON p.device_hex = c.device_hex
  `.execute(db);
  const total = Number(totalRes.rows[0]?.n ?? 0);

  // 按 area_name 分组（保持 SQL 的 ORDER BY 顺序）
  const areaOrder: string[] = [];
  const areaRows = new Map<string, JoinedRow[]>();
  for (const r of rowsRes.rows) {
    const key = String(r.area_name ?? '');
    let list = areaRows.get(key);
    if (!list) {
      list = [];
      areaRows.set(key, list);
      areaOrder.push(key);
    }
    list.push(r);
  }

  const devices = buildDevices(rowsRes.rows, { skipNullPorts: false });
  const devByHex = new Map(devices.map((d) => [d.device_hex, d]));

  const areas = areaOrder.map((area) => {
    const areaDevices = (areaRows.get(area) ?? [])
      .map((r) => devByHex.get(r.device_hex))
      .filter((d): d is DeviceOut => !!d)
      // 去重（同一设备多端口会重复出现），保序
      .filter((d, i, arr) => arr.findIndex((x) => x.device_hex === d.device_hex) === i);
    return { area, devices: areaDevices, summary: summarizeDevices(areaDevices) };
  });

  return { ok: true, total, truncated: total > devices.length, areas };
}

/** 单区端口明细（/api/area-ports） */
export async function areaPortsPayload(area: string): Promise<{
  ok: true;
  area: string;
  devices: DeviceOut[];
  updated_at: string | null;
  summary: ReturnType<typeof summarizeDevices>;
}> {
  const db = getDb();

  // 注意 Python 用的是 LEFT JOIN（含无端口的设备）
  const rowsRes = await sql<JoinedRow>`
    SELECT c.device_hex, c.code, c.area_name, c.updated_at AS ctrl_at,
           c.qr_device_no, p.port, p.status, p.updated_at AS port_at
      FROM (SELECT device_hex, code, area_name, updated_at, qr_device_no
              FROM controllers WHERE area_name = ${area}
             ORDER BY device_hex LIMIT ${AREA_PORTS_DEVICE_LIMIT}) c
      LEFT JOIN port_states p ON p.device_hex = c.device_hex
     ORDER BY c.device_hex, p.port
  `.execute(db);

  const devices = buildDevices(rowsRes.rows, { skipNullPorts: true });
  const latest = devices.reduce(
    (acc: string, d) => {
      const v = d.updated_at ?? '';
      return v > acc ? v : acc;
    },
    '',
  );

  return {
    ok: true,
    area,
    devices,
    updated_at: latest || null,
    summary: summarizeDevices(devices),
  };
}

/** 单桩详情（/api/pile/:device） */
export async function pilePayload(rawDevice: string): Promise<
  | { ok: false; status: number; error: string }
  | { ok: true; pile: Record<string, unknown> }
> {
  const deviceHex = String(rawDevice ?? '').trim();
  if (!deviceHex || deviceHex.length > 32) {
    return { ok: false, status: 404, error: '设备不存在' };
  }
  const db = getDb();

  // Python 用 upper(device_hex) = upper(?) 做大小写不敏感匹配
  const ctrlRes = await sql<{
    device_hex: string;
    code: string | null;
    area_name: string | null;
    qr_device_no: string | null;
    updated_at: string | null;
  }>`
    SELECT device_hex, code, area_name, qr_device_no, updated_at
      FROM controllers WHERE upper(device_hex) = upper(${deviceHex})
  `.execute(db);
  const ctrl = ctrlRes.rows[0];
  if (!ctrl) return { ok: false, status: 404, error: '设备不存在' };

  const portsRes = await sql<{ port: string; status: string | null; updated_at: string | null }>`
    SELECT port, status, updated_at FROM port_states
     WHERE device_hex = ${ctrl.device_hex} ORDER BY port
  `.execute(db);

  const histRes = await sql<{
    ts: string;
    free: number | null;
    total: number | null;
    busy: number | null;
    online: number | null;
  }>`
    SELECT ts, free, total, busy, online FROM pile_samples
     WHERE device_hex = ${ctrl.device_hex} ORDER BY ts DESC LIMIT ${PILE_HISTORY_LIMIT}
  `.execute(db);

  // 与 Python 一致：health 用 (port, status, updated_at) 三元组 + ctrl.updated_at 兜底
  const portRows: PortRow[] = portsRes.rows.map(
    (r) => [r.port, r.status, r.updated_at] as const,
  );
  const health = portsHealth(portRows, ctrl.updated_at ?? '');
  const latest = portsRes.rows.reduce(
    (acc: string, r) => {
      const v = r.updated_at ?? '';
      return v > acc ? v : acc;
    },
    ctrl.updated_at ?? '',
  );

  // ⚠️ 响应结构：顶层只有 ok + pile，ports/history 都嵌在 pile 里
  return {
    ok: true,
    pile: {
      device_hex: ctrl.device_hex,
      code: ctrl.code,
      area_name: ctrl.area_name,
      qr_device_no: ctrl.qr_device_no,
      state: health.state,
      total: health.total,
      free: health.free,
      busy: health.busy,
      updated_at: latest || null,
      ports: portsRes.rows.map((r) => ({ port: r.port, status: r.status })),
      // Python 用 reversed(history) → 按时间升序
      history: [...histRes.rows].reverse().map((h) => ({
        ts: h.ts,
        free: h.free,
        total: h.total,
        busy: h.busy,
        online: Boolean(h.online),
      })),
    },
  };
}

export async function registerPortsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/areas-ports', async (_req, reply) => {
    const payload = await areasPortsPayload();
    return reply.send(payload);
  });

  app.get('/api/area-ports', async (req, reply) => {
    const area = String((req.query as Record<string, unknown>)?.area ?? '').trim();
    if (!area) {
      return reply.code(400).send({ ok: false, error: '缺少 area' });
    }
    const payload = await areaPortsPayload(area);
    return reply.send(payload);
  });

  app.get('/api/pile/*', async (req, reply) => {
    const raw = (req.params as Record<string, string>)['*'] ?? '';
    const payload = await pilePayload(decodeURIComponent(raw));
    if ('status' in payload && payload.ok === false) {
      return reply.code(payload.status).send({ ok: false, error: payload.error });
    }
    return reply.send(payload);
  });
}
