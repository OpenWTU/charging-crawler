/**
 * Kysely 表类型定义。
 *
 * ⚠️ 必须与 `migrations/sqlite/001_init.sql` + `002_migrate.sql` 完全对应。
 * 字段名、可空性、类型都按现有生产库的实际情况写（用 PRAGMA table_info 校对）。
 *
 * 迁移到 PostgreSQL 时，这里只需调整类型映射（如 INTEGER 0/1 → boolean），
 * 业务代码不变。
 */
import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';

/** SQLite 里的布尔：0/1 */
type Bool = ColumnType<number, number, number>;
/** SQLite 里的时间戳：TEXT（ISO 字符串）或 INTEGER，按列实际含义区分 */
type Text = string;
type Int = ColumnType<number, number, number>;

export interface SnapshotsTable {
  id: Generated<number>;
  received_at: Text;
  captured_at: Text | null;
  project: Text | null;
  app_version: Text | null;
  token_user: Text | null;
  client_ip: Text | null;
  device_id: Text | null;
  real_ip: Text | null;
  body_sha256: Text;
  payload: Text;
}

export interface NoncesTable {
  nonce: Text;
  seen_at: Int;
}

export interface AreaSamplesTable {
  snapshot_id: Int;
  area_id: Text | null;
  area_name: Text;
  idle: Int;
  total: Int;
  charging: Int;
  fault: Int;
  received_at: Text;
}

export interface AreasTable {
  area_id: Text;
  name: Text | null;
  first_seen: Text | null;
  last_seen: Text | null;
  lat: ColumnType<number | null, number | null, number | null>;
  lng: ColumnType<number | null, number | null, number | null>;
}

export interface AppSettingsTable {
  key: Text;
  value: Text | null;
}

export interface WorkerRunsTable {
  id: Generated<number>;
  ts: Text;
  result: Text;
}

export interface UploadAuditTable {
  id: Generated<number>;
  ts: Text;
  ip: Text | null;
  ua: Text | null;
  size: Int | null;
  result: Text | null;
  detail: Text | null;
}

export interface AdminUsersTable {
  username: Text;
  pass_hash: Text;
  created_at: Text;
  updated_at: Text;
  disabled: Bool;
}

export interface TokensTable {
  user_id: Text;
  token: Text;
  expires_at: Int;
  updated_at: Text;
}

export interface TokenPoolTable {
  id: Generated<number>;
  user_id: Text | null;
  token: Text | null;
  expires_at: Int | null;
  updated_at: Text | null;
  source: Text | null;
  last_error: Text | null;
}

export interface DevicesTable {
  device_id: Text;
  secret_enc: Text;
  model: Text | null;
  app_version: Text | null;
  created_at: Text;
  last_seen: Text | null;
  uploads: Int;
  revoked: Bool;
  status: Text;
}

export interface ControllersTable {
  device_hex: Text;
  code: Text | null;
  area_id: Text | null;
  area_name: Text | null;
  updated_at: Text | null;
  qr_device_no: Text | null;
}

export interface PortStatesTable {
  device_hex: Text;
  port: Text;
  status: Text | null;
  status_group: Text;
  updated_at: Text | null;
}

export interface PileSamplesTable {
  device_hex: Text;
  ts: Text;
  free: Int | null;
  total: Int | null;
  busy: Int | null;
  online: Int | null;
  unavailable: Int | null;
}

/** 可选表：只存在于爬虫/历史库，生产库不一定有 */
export interface AreaStatusTable {
  area_id: Text;
  raw_json: Text | null;
}

export interface Database {
  snapshots: SnapshotsTable;
  nonces: NoncesTable;
  area_samples: AreaSamplesTable;
  areas: AreasTable;
  app_settings: AppSettingsTable;
  worker_runs: WorkerRunsTable;
  upload_audit: UploadAuditTable;
  admin_users: AdminUsersTable;
  tokens: TokensTable;
  token_pool: TokenPoolTable;
  devices: DevicesTable;
  controllers: ControllersTable;
  port_states: PortStatesTable;
  pile_samples: PileSamplesTable;
  /** 可选表，查询前需确认存在 */
  area_status: AreaStatusTable;
}

export type Snapshot = Selectable<SnapshotsTable>;
export type NewSnapshot = Insertable<SnapshotsTable>;
export type UpdateSnapshot = Updateable<SnapshotsTable>;

export type PortState = Selectable<PortStatesTable>;
export type Controller = Selectable<ControllersTable>;
export type AreaRow = Selectable<AreasTable>;
export type PileSample = Selectable<PileSamplesTable>;
