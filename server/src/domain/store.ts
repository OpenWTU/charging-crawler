/**
 * 领域写读：区域登记/播种、上传数据逐区校验、端口清洗、单桩采样。
 *
 * ⚠️ 与 `cloud/store.py`、`cloud/snapshots.py`、`cloud/ports.py` 的写路径逐函数对齐。
 * 注意：这些是写入操作，只在「读写模式」下调用（P8 切换后 Node 不再只读）。
 */
import { createHash } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { getDb, type Db } from '../db/index.js';
import type { Database } from '../db/types.js';
import { PORT_RE, PORT_STATUS_MAX } from '../config.js';
import { statusGroup, type PortGroup } from './port-status.js';
import { logger } from '../logger.js';

export const MAX_PORTS_PER_DEVICE = 32;
export const MAX_PORT_ITEMS = 500;

/** 区域稳定 ID：md5(name) 前 16 位（与 cloud/geo.py 一致） */
export function areaIdForName(name: string): string {
  return createHash('md5').update(name, 'utf8').digest('hex').slice(0, 16);
}

/** 与 Python 的 now_str() 一致：本地时间 "YYYY-MM-DD HH:MM:SS" */
export function nowStr(d = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

/* ---------------- 快照校验（cloud/snapshots.py::validate_payload） ---------------- */

export interface CleanArea {
  name: string;
  id?: string;
  address?: string;
  total_port: number;
  idle_port: number;
  charging_port: number;
  fault_port: number;
}

export interface CleanPayload {
  captured_at: string;
  project: string;
  app_version: string;
  token_user: string;
  areas: CleanArea[];
}

export function validatePayload(obj: unknown): CleanPayload {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('payload 不是对象');
  }
  const o = obj as Record<string, unknown>;
  const areas = o.areas;
  if (!Array.isArray(areas) || areas.length === 0 || areas.length > 500) {
    throw new Error('areas 缺失或数量异常');
  }
  const cleanAreas: CleanArea[] = [];
  for (const a of areas) {
    if (!a || typeof a !== 'object' || Array.isArray(a)) {
      throw new Error('area 不是对象');
    }
    const ao = a as Record<string, unknown>;
    const name = ao.name;
    if (typeof name !== 'string' || !name.trim()) {
      throw new Error('area.name 非法');
    }
    const item: CleanArea = {
      name: name.trim().slice(0, 80),
      total_port: 0,
      idle_port: 0,
      charging_port: 0,
      fault_port: 0,
    };
    if (typeof ao.id === 'string') item.id = ao.id.slice(0, 200);
    if (typeof ao.address === 'string') item.address = ao.address.slice(0, 200);
    for (const key of ['total_port', 'idle_port', 'charging_port', 'fault_port'] as const) {
      const v = ao[key];
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 10000) {
        throw new Error(`area.${key} 非法`);
      }
      item[key] = v;
    }
    cleanAreas.push(item);
  }
  return {
    captured_at: String(o.captured_at ?? '').slice(0, 32),
    project: String(o.project ?? '').slice(0, 80),
    app_version: String(o.app_version ?? '').slice(0, 32),
    token_user: String(o.token_user ?? '').slice(0, 40),
    areas: cleanAreas,
  };
}

/* ---------------- 逐区校验（cloud/store.py::split_valid_areas） ---------------- */

export interface SplitResult {
  valid: CleanArea[];
  skipped: Array<[string, string]>;
  duplicate: boolean;
}

export async function splitValidAreas(
  areas: CleanArea[],
  db: Db = getDb(),
): Promise<SplitResult> {
  const knownRes = await sql<{ name: string }>`SELECT name FROM areas`.execute(db);
  const known = new Set(knownRes.rows.map((r) => String(r.name)));

  // 首次上传（areas 表为空）会接受任意区名来建立 known 集合——这是初始化必需，
  // 但必须限制单次数量，否则一次请求就能灌进成千上万伪造区名污染公共库
  // 与 validatePayload 的 500 上限对齐：卡 200 会让真实区数 >200 的全新节点永远无法引导
  const MAX_FIRST_UPLOAD_AREAS = 500;
  if (known.size === 0 && areas.length > MAX_FIRST_UPLOAD_AREAS) {
    logger.warn(
      { count: areas.length, limit: MAX_FIRST_UPLOAD_AREAS },
      '[store] 首次上传区域数超限，整批拒绝',
    );
    return {
      valid: [],
      skipped: [[`*${areas.length}`, `首次上传区域数超过 ${MAX_FIRST_UPLOAD_AREAS}`]],
      duplicate: false,
    };
  }

  const valid: CleanArea[] = [];
  const skipped: Array<[string, string]> = [];
  const seen = new Set<string>();
  for (const area of areas) {
    const name = area.name;
    if (seen.has(name)) return { valid: [], skipped: [], duplicate: true };
    seen.add(name);
    const idle = area.idle_port;
    const total = area.total_port;
    const charging = area.charging_port;
    const fault = area.fault_port;
    if (Math.min(idle, total, charging, fault) < 0) {
      skipped.push([name, '数据不守恒']);
      continue;
    }
    if (idle + charging + fault !== total) {
      skipped.push([name, '数据不守恒']);
      continue;
    }
    if (known.size > 0 && !known.has(name)) {
      skipped.push([name, '未知充电区']);
      continue;
    }
    valid.push(area);
  }
  return { valid, skipped, duplicate: false };
}

/** 按 name 登记区域并刷新 last_seen，返回 area_id（cloud/store.py::upsert_area） */
export async function upsertArea(name: string, db: Db = getDb()): Promise<string> {
  const aid = areaIdForName(name);
  const stamp = nowStr();
  await db
    .insertInto('areas')
    .values({ area_id: aid, name, first_seen: stamp, last_seen: stamp })
    .onConflict((oc) => oc.column('name').doUpdateSet({ last_seen: stamp }))
    .execute();
  const r = await sql<{ area_id: string }>`SELECT area_id FROM areas WHERE name = ${name}`.execute(db);
  return String(r.rows[0]?.area_id ?? aid);
}

/* ---------------- 端口清洗（cloud/ports.py::_clean_ports / _clean_port_entries） ---------------- */

export interface CleanPort {
  port: string;
  status: string;
  group: PortGroup;
}

export function cleanPortEntries(raw: unknown, strict: boolean): CleanPort[] {
  if (!Array.isArray(raw)) {
    if (strict) throw new Error('端口列表必须是数组');
    return [];
  }
  const cleaned = new Map<string, string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      if (strict) throw new Error('端口项必须是对象');
      continue;
    }
    const io = item as Record<string, unknown>;
    let port: string;
    const p = io.port;
    if (typeof p === 'boolean' || !['string', 'number'].includes(typeof p)) {
      if (strict) throw new Error('port 必须是字符串');
      port = '';
    } else {
      port = String(p);
    }
    port = port.trim();
    if (!PORT_RE.test(port)) {
      if (strict) throw new Error('port 非法');
      continue;
    }
    let status: string;
    const s = io.status;
    if (s === null || s === undefined) {
      status = '';
    } else if (typeof s === 'boolean' || !['string', 'number'].includes(typeof s)) {
      if (strict) throw new Error('status 必须是字符串');
      status = '';
    } else {
      status = String(s);
    }
    status = status.trim();
    if (status.length > PORT_STATUS_MAX) {
      if (strict) throw new Error('status 过长');
      status = status.slice(0, PORT_STATUS_MAX);
    }
    cleaned.delete(port); // 重复端口：先删再插，保留最后一次 status
    cleaned.set(port, status);
  }
  const entries: CleanPort[] = [...cleaned.entries()].map(([port, status]) => ({
    port,
    status,
    group: statusGroup(status),
  }));
  if (entries.length > MAX_PORTS_PER_DEVICE) {
    if (strict) throw new Error('端口数量超限');
    return entries.slice(0, MAX_PORTS_PER_DEVICE);
  }
  return entries;
}

/** 严格校验上传的 ports 字段，返回 [{device_hex, ports:[...]}] */
export function cleanPorts(
  rawPorts: unknown,
  allowedDevices?: ReadonlySet<string>,
): Array<{ device_hex: string; ports: CleanPort[] }> {
  if (rawPorts === null || rawPorts === undefined) return [];
  if (!Array.isArray(rawPorts)) throw new Error('ports 必须是数组');
  if (rawPorts.length > MAX_PORT_ITEMS) throw new Error('ports 设备项超限');
  const allowed = new Map<string, string>();
  for (const dev of allowedDevices ?? []) {
    const s = String(dev).trim();
    allowed.set(s.toUpperCase(), s);
  }
  const merged = new Map<string, CleanPort[]>();
  for (const item of rawPorts) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('ports 项必须是对象');
    }
    const io = item as Record<string, unknown>;
    const device = io.device_hex;
    if (typeof device !== 'string' || !device.trim()) throw new Error('device_hex 非法');
    const canonical = allowed.get(device.trim().toUpperCase());
    if (!canonical) throw new Error(`未知设备 ${device.trim().slice(0, 16)}`);
    const entries = cleanPortEntries(io.ports, true);
    const existing = merged.get(canonical) ?? [];
    merged.set(canonical, existing.concat(entries));
  }
  return [...merged.entries()].map(([device_hex, ports]) => ({
    device_hex,
    ports: cleanPortEntries(ports.map((p) => ({ port: p.port, status: p.status })), true),
  }));
}

/* ---------------- 单桩采样（cloud/ports.py::record_pile_sample） ---------------- */

function pileCounts(statuses: string[]): { free: number; total: number; busy: number } {
  const values = statuses.map((s) => String(s ?? ''));
  const total = values.length;
  const free = values.filter((s) => s === '空闲').length;
  return { free, total, busy: total - free };
}

function pileUnavailable(statuses: string[]): number {
  return statuses.filter((s) => statusGroup(s) === 'unavailable').length;
}

export async function recordPileSample(
  deviceHex: string,
  ts: string,
  statuses: string[],
  online = true,
  db: Db = getDb(),
): Promise<void> {
  const { free, total, busy } = pileCounts(statuses);
  const unavailable = pileUnavailable(statuses);
  await db
    .insertInto('pile_samples')
    .values({
      device_hex: deviceHex,
      ts,
      free,
      total,
      busy,
      online: online ? 1 : 0,
      unavailable,
    })
    .onConflict((oc) =>
      oc.columns(['device_hex', 'ts']).doUpdateSet({
        free,
        total,
        busy,
        online: online ? 1 : 0,
        unavailable,
      }),
    )
    .execute();
}
