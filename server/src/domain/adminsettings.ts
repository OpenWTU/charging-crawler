/**
 * 运行时设置（`app_settings` 表）的读写与类型化。
 *
 * 设计：
 *  - 表是 key/value（都是 TEXT），值统一用 JSON 存，读时按 schema 解析并套默认值
 *  - 内存缓存 + 写入时失效，保证「后台改完立即生效」
 *  - 所有写入都记 `config_history` 与 `admin_audit`
 *  - 环境变量仍是一等公民：`p2p_trust_non_whitelist` 为 null 时跟随 env
 */
import { sql } from 'kysely';
import { getDb } from '../db/index.js';
import { logger } from '../logger.js';

/* ---------------- 白名单本地覆盖层 ---------------- */

export interface LocalPeer {
  peerId: string;
  addr?: string;
  url?: string;
  name?: string;
}

/* ---------------- schema ---------------- */

export interface AppSettings {
  /** 新设备是否自动审批（默认 true = 保持原有自动审批行为） */
  device_auto_approve: boolean;
  /** 是否采纳非白名单节点数据；null = 跟随 env P2P_TRUST_NON_WHITELIST */
  p2p_trust_non_whitelist: boolean | null;
  /** 跨节点互校模式 */
  p2p_validate_mode: 'off' | 'warn' | 'strict';
  p2p_validate_threshold: number;
  p2p_validate_window_sec: number;
  p2p_validate_min_areas: number;
  /** 白名单本地覆盖层（与 GitHub nodes.json 合并、按 peerId 去重） */
  p2p_extra_peers: LocalPeer[];
  /** worker 间隔秒（需重启生效） */
  worker_interval_sec: number;
  /** 数据保留天数 */
  data_retention_days: number;
}

export const SETTINGS_DEFAULTS: AppSettings = {
  device_auto_approve: true,
  p2p_trust_non_whitelist: null,
  p2p_validate_mode: 'strict',
  p2p_validate_threshold: 0.5,
  p2p_validate_window_sec: 600,
  p2p_validate_min_areas: 3,
  p2p_extra_peers: [],
  worker_interval_sec: 600,
  data_retention_days: 90,
};

export type SettingKey = keyof AppSettings;

/** 各键的取值范围/枚举（后台表单据此校验） */
export const SETTING_SCHEMA: Record<
  SettingKey,
  { type: 'bool' | 'bool_or_null' | 'enum' | 'number' | 'peers'; enum?: string[]; min?: number; max?: number; note?: string }
> = {
  device_auto_approve: { type: 'bool', note: '关闭后新设备注册为待审批' },
  p2p_trust_non_whitelist: { type: 'bool_or_null', note: 'null = 跟随环境变量' },
  p2p_validate_mode: { type: 'enum', enum: ['off', 'warn', 'strict'] },
  p2p_validate_threshold: { type: 'number', min: 0.1, max: 0.9 },
  p2p_validate_window_sec: { type: 'number', min: 60, max: 3600 },
  p2p_validate_min_areas: { type: 'number', min: 1, max: 20 },
  p2p_extra_peers: { type: 'peers' },
  worker_interval_sec: { type: 'number', min: 60, max: 86400, note: '需重启生效' },
  data_retention_days: { type: 'number', min: 7, max: 3650 },
};

/* ---------------- 缓存 ---------------- */

function nowLocal(): string {
  const d = new Date();
  const p = (x: number): string => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
    + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

let cache: AppSettings | null = null;

export function invalidateSettingsCache(): void {
  cache = null;
}

function coerce<K extends SettingKey>(key: K, raw: unknown): AppSettings[K] {
  const def = SETTINGS_DEFAULTS[key];
  if (raw === undefined || raw === null) return def;
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (key === 'device_auto_approve' || key === 'p2p_trust_non_whitelist') {
      if (v === null) return null as AppSettings[K];
      return (v === true || v === 'true' || v === 1 || v === '1') as AppSettings[K];
    }
    if (key === 'p2p_validate_mode') {
      return (['off', 'warn', 'strict'].includes(String(v)) ? String(v) : def) as AppSettings[K];
    }
    if (key === 'p2p_extra_peers') {
      return (Array.isArray(v) ? v : []) as AppSettings[K];
    }
    let n = Number(v);
    if (!Number.isFinite(n)) return def;
    // L4：读取侧也钳制，防止手工改库写入越界值
    const spec = SETTING_SCHEMA[key];
    if (spec?.min !== undefined) n = Math.max(spec.min, n);
    if (spec?.max !== undefined) n = Math.min(spec.max, n);
    return n as AppSettings[K];
  } catch {
    return def;
  }
}

/** 读全部设置（带缓存） */
export async function readSettings(): Promise<AppSettings> {
  if (cache) return cache;
  const out = { ...SETTINGS_DEFAULTS };
  try {
    const res = await sql<{ key: string; value: string | null }>`
      SELECT key, value FROM app_settings
    `.execute(getDb());
    for (const row of res.rows) {
      const key = row.key as SettingKey;
      if (!Object.hasOwn(SETTINGS_DEFAULTS, key)) continue;
      // 逐键沿用默认值类型
      Object.assign(out, { [key]: coerce(key, row.value) });
    }
  } catch (e) {
    logger.warn({ err: e }, '[settings] 读取失败，本次使用默认值（不写缓存，避免一次抖动永久生效）');
    return out;
  }
  cache = out;
  return out;
}

/** 单键读取（走缓存） */
export async function getSetting<K extends SettingKey>(key: K): Promise<AppSettings[K]> {
  const all = await readSettings();
  return all[key];
}

/** 校验并规范化一个待写入的值；非法时抛错（带可读文案） */
export function normalizeSetting(key: SettingKey, raw: unknown): unknown {
  const spec = SETTING_SCHEMA[key];
  if (!spec) throw new Error(`未知设置项: ${key}`);
  switch (spec.type) {
    case 'bool':
      if (typeof raw !== 'boolean') throw new Error('需要布尔值');
      return raw;
    case 'bool_or_null':
      if (raw === null) return null;
      if (typeof raw !== 'boolean') throw new Error('需要布尔值或 null');
      return raw;
    case 'enum': {
      const s = String(raw);
      if (!spec.enum?.includes(s)) throw new Error(`取值必须是 ${spec.enum?.join(' / ')}`);
      return s;
    }
    case 'number': {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new Error('需要数字');
      if (spec.min !== undefined && n < spec.min) throw new Error(`不能小于 ${spec.min}`);
      if (spec.max !== undefined && n > spec.max) throw new Error(`不能大于 ${spec.max}`);
      return n;
    }
    case 'peers': {
      if (!Array.isArray(raw)) throw new Error('需要数组');
      const out: LocalPeer[] = [];
      for (const item of raw) {
        if (!item || typeof item !== 'object') continue;
        const rec = item as Record<string, unknown>;
        const peerId = String(rec.peerId ?? '').trim();
        if (!peerId) continue;
        out.push({
          peerId,
          addr: rec.addr ? String(rec.addr).trim() : undefined,
          url: rec.url ? String(rec.url).trim() : undefined,
          name: rec.name ? String(rec.name).trim() : undefined,
        });
      }
      // 按 peerId 去重（同 key 后者覆盖前者）
      const map = new Map<string, LocalPeer>();
      for (const p of out) map.set(p.peerId, p);
      return [...map.values()];
    }
    default:
      throw new Error('未支持的设置类型');
  }
}

/** 写入一个设置（带变更历史）；调用方负责审计与权限 */
export async function writeSetting(
  key: SettingKey,
  raw: unknown,
  username: string | null,
): Promise<{ key: SettingKey; oldValue: unknown; newValue: unknown }> {
  const db = getDb();
  const value = normalizeSetting(key, raw);
  const oldRes = await sql<{ value: string | null }>`
    SELECT value FROM app_settings WHERE key = ${key}
  `.execute(db);
  const oldRaw = oldRes.rows[0]?.value ?? null;
  const encoded = JSON.stringify(value);

  // L3：两条写必须同事务，否则配置改了但历史没记
  await db.transaction().execute(async (trx) => {
    await sql`
      INSERT INTO app_settings (key, value) VALUES (${key}, ${encoded})
      ON CONFLICT (key) DO UPDATE SET value = excluded.value
    `.execute(trx);
    await sql`
      INSERT INTO config_history (ts, username, key, old_value, new_value)
      VALUES (${nowLocal()}, ${username}, ${key}, ${oldRaw}, ${encoded})
    `.execute(trx);
  });

  invalidateSettingsCache();
  logger.info({ key, by: username }, '[settings] 已更新');
  return { key, oldValue: coerce(key, oldRaw), newValue: value };
}
