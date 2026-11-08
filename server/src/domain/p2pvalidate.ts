/**
 * 跨节点数据互校（P2P 一致性校验）。
 *
 * 完整设计见 `docs/p2p-validation.md`。四步：
 *   ① 定时刻（captured_at ?? 广播 ts）
 *   ② 选基准（本节点 [t0±W] 内最近的快照，upload 优先）
 *   ③ 按 name 对齐 + total 相同才可比
 *   ④ 算偏差（空闲率差 + 故障差加权）→ 按模式 accept / suspect / drop
 *
 * 约束：
 *  - 校验自身任何异常都 **accept**（保险丝不能掐断数据流）
 *  - 无基准 / 可比区域不足 → accept（让新节点不被饿死）
 *  - 只丢单条快照，不拉黑节点
 */
import { sql } from 'kysely';
import type { Db } from '../db/index.js';
import { getDb } from '../db/index.js';
import { readSettings } from './adminsettings.js';
import { logger } from '../logger.js';

export type ValidateMode = 'off' | 'warn' | 'strict';
export type Decision = 'accept' | 'suspect' | 'drop';

export type ValidateReason =
  | 'mode_off'
  | 'no_baseline'
  | 'insufficient_overlap'
  | 'within_threshold'
  | 'deviation_exceeded'
  | 'invalid_payload'
  | 'error';

export interface ValidateConfig {
  mode: ValidateMode;
  threshold: number;
  windowSec: number;
  minAreas: number;
  faultMinAbs: number;
  faultMinRel: number;
}

/** 故障差的权重（命中时直接给这个偏差值；要 > 默认阈值 0.5 才能保证一定判为异常） */
const FAULT_WEIGHT = 0.6;

export interface AreaCompare {
  name: string;
  total: number;
  remote_idle: number;
  local_idle: number;
  remote_charging: number;
  local_charging: number;
  remote_fault: number;
  local_fault: number;
  deviation: number;
}

export interface SkippedArea {
  name: string;
  why: 'total_mismatch' | 'zero_total' | 'missing_local' | 'missing_remote';
}

export interface ValidateResult {
  decision: Decision;
  reason: ValidateReason;
  deviation: number | null;
  baseSnapshotId: number | null;
  comparable: number;
  detail: {
    threshold: number;
    window_sec: number;
    min_areas: number;
    areas: AreaCompare[];
    skipped: SkippedArea[];
    over_ratio?: number;
    total_mismatch_ratio?: number;
    error?: string;
  };
}

interface RawArea {
  name?: unknown;
  idle_port?: unknown;
  total_port?: unknown;
  charging_port?: unknown;
  fault_port?: unknown;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** 读配置（走 app_settings 缓存，改完立即生效） */
export async function readValidateConfig(): Promise<ValidateConfig> {
  const s = await readSettings();
  return {
    mode: s.p2p_validate_mode,
    threshold: s.p2p_validate_threshold,
    windowSec: s.p2p_validate_window_sec,
    minAreas: s.p2p_validate_min_areas,
    faultMinAbs: 3,
    // 故障差的相对门槛用 10%：48 口的区域差 5 口就算明显（20% 太严，会漏掉真实故障）
    faultMinRel: 0.1,
  };
}

/** 时间字符串 → 秒级 epoch（支持 `2026-11-08 10:00:00`、ISO、带时区/`Z`） */
function toEpoch(ts: string): number {
  const s = String(ts).trim();
  if (!s) return NaN;
  // 先按原样 Date.parse（ISO/带时区都能处理）；失败再按本地格式兜底
  let ms = Date.parse(s);
  if (Number.isFinite(ms)) return ms / 1000;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s);
  if (!m) return NaN;
  ms = new Date(
    Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    Number(m[4]), Number(m[5]), Number(m[6]),
  ).getTime();
  return Number.isFinite(ms) ? ms / 1000 : NaN;
}

/** 本地时间字符串 ± 秒 → 同格式字符串（用于 SQL 区间比较） */
function shiftLocal(ts: string, deltaSec: number): string {
  const base = toEpoch(ts);
  if (!Number.isFinite(base)) return ts;
  const d = new Date((base + deltaSec) * 1000);
  const p = (x: number): string => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
    + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 本机当前时间字符串（与 nowStr 同格式） */
function nowLocal(): string {
  const d = new Date();
  const p = (x: number): string => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
    + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 找基准快照（时间最接近 t0，upload 优先） */
async function findBaseline(
  t0: string,
  windowSec: number,
  db: Db,
): Promise<{ id: number; payload: string; captured_at: string | null } | null> {
  const from = shiftLocal(t0, -windowSec);
  const to = shiftLocal(t0, windowSec);
  const res = await sql<{ id: number; payload: string; captured_at: string | null }>`
    SELECT id, payload, captured_at FROM snapshots
     WHERE captured_at IS NOT NULL
       -- M9：只信本节点自己采的数据（device_id 非空 = App 上传/本机 worker），
       -- 否则恶意节点先发一条"基准"就能让所有诚实节点被判偏差
       AND device_id IS NOT NULL
       AND captured_at >= ${from} AND captured_at <= ${to}
     ORDER BY
       CASE WHEN device_id IS NOT NULL THEN 0 ELSE 1 END,
       ABS(julianday(captured_at) - julianday(${t0}))
     LIMIT 1
  `.execute(db);
  return res.rows[0] ?? null;
}

function areasOf(payload: unknown): RawArea[] {
  if (!payload || typeof payload !== 'object') return [];
  const rec = payload as Record<string, unknown>;
  const list = rec.areas;
  return Array.isArray(list) ? (list as RawArea[]) : [];
}

/**
 * 主入口：校验一条来自其他节点的快照。
 *
 * 永远返回结果，不抛错（内部异常 → accept + reason='error'）。
 */
export async function validateIncoming(
  payload: Record<string, unknown>,
  msgTs: string | undefined,
  db: Db = getDb(),
): Promise<ValidateResult> {
  const cfg = await readValidateConfig();
  const baseDetail = {
    threshold: cfg.threshold,
    window_sec: cfg.windowSec,
    min_areas: cfg.minAreas,
    areas: [] as AreaCompare[],
    skipped: [] as SkippedArea[],
  };

  if (cfg.mode === 'off') {
    return {
      decision: 'accept',
      reason: 'mode_off',
      deviation: null,
      baseSnapshotId: null,
      comparable: 0,
      detail: baseDetail,
    };
  }

  try {
    // ① 远端快照的"时刻"
    const capturedRaw = payload.captured_at;
    const t0 = (typeof capturedRaw === 'string' && capturedRaw.trim())
      ? capturedRaw.trim()
      : (msgTs ?? '').trim();
    if (!t0) {
      return {
        decision: 'accept', reason: 'no_baseline', deviation: null,
        baseSnapshotId: null, comparable: 0, detail: baseDetail,
      };
    }

    // 时钟异常：与本地当前时间相差 > 24h → 可能是补传历史，不判
    const t0Ms = Date.parse(t0.replace(' ', 'T'));
    if (Number.isFinite(t0Ms) && Math.abs(Date.now() - t0Ms) > 24 * 3600_000) {
      return {
        decision: 'accept', reason: 'no_baseline', deviation: null,
        baseSnapshotId: null, comparable: 0,
        detail: { ...baseDetail, skipped: [{ name: '*', why: 'missing_local' }] },
      };
    }

    // ② 选基准
    const baseline = await findBaseline(t0, cfg.windowSec, db);
    if (!baseline) {
      return {
        decision: 'accept', reason: 'no_baseline', deviation: null,
        baseSnapshotId: null, comparable: 0, detail: baseDetail,
      };
    }

    // ③ 按 name 对齐
    const remoteAreas = areasOf(payload);
    if (!remoteAreas.length) {
      return {
        decision: 'drop', reason: 'invalid_payload', deviation: null,
        baseSnapshotId: baseline.id, comparable: 0, detail: baseDetail,
      };
    }
    let localPayload: unknown;
    try {
      localPayload = JSON.parse(baseline.payload);
    } catch {
      localPayload = null;
    }
    const localAreas = areasOf(localPayload);

    const remoteByName = new Map<string, RawArea>();
    for (const a of remoteAreas) {
      const name = String(a.name ?? '').trim();
      if (name) remoteByName.set(name, a);
    }
    const localByName = new Map<string, RawArea>();
    for (const a of localAreas) {
      const name = String(a.name ?? '').trim();
      if (name) localByName.set(name, a);
    }

    const compares: AreaCompare[] = [];
    const skipped: SkippedArea[] = [];
    for (const [name, r] of remoteByName) {
      const l = localByName.get(name);
      if (!l) {
        skipped.push({ name, why: 'missing_local' });
        continue;
      }
      const total = num(r.total_port);
      const localTotal = num(l.total_port);
      // 先判 0：total=0 本身是无效数据，比"两边不一致"更准确
      if (!total || !localTotal) {
        skipped.push({ name, why: 'zero_total' });
        continue;
      }
      if (total !== localTotal) {
        skipped.push({ name, why: 'total_mismatch' });
        continue;
      }
      const remoteIdle = num(r.idle_port);
      const localIdle = num(l.idle_port);
      const remoteCharging = num(r.charging_port);
      const localCharging = num(l.charging_port);
      const remoteFault = num(r.fault_port);
      const localFault = num(l.fault_port);

      const idleDev = Math.abs(remoteIdle / total - localIdle / total);
      const faultGap = Math.abs(remoteFault - localFault);
      const faultDev = faultGap >= cfg.faultMinAbs && faultGap / total >= cfg.faultMinRel
        ? FAULT_WEIGHT
        : 0;

      compares.push({
        name,
        total,
        remote_idle: remoteIdle,
        local_idle: localIdle,
        remote_charging: remoteCharging,
        local_charging: localCharging,
        remote_fault: remoteFault,
        local_fault: localFault,
        deviation: Math.max(idleDev, faultDev),
      });
    }
    for (const name of localByName.keys()) {
      if (!remoteByName.has(name)) skipped.push({ name, why: 'missing_remote' });
    }

    // 可比区域太少 → 不判
    if (compares.length < cfg.minAreas) {
      return {
        decision: 'accept', reason: 'insufficient_overlap', deviation: null,
        baseSnapshotId: baseline.id, comparable: compares.length,
        detail: { ...baseDetail, areas: compares, skipped },
      };
    }

    // ④ 算偏差 + 决策
    //
    // M8：原来用 max(单区域偏差) 判定，1 口的小区域翻转就会丢掉整条快照（含所有正常区域）。
    // 改成「显著偏差区域的占比」，单点异常不再一票否决。
    // M7：total_mismatch 占比过高（远端把所有 total 都改了一位）时，本应 accept 会放行错数据，
    // 这里判 suspect 让它至少可见。
    const overThreshold = compares.filter((c) => c.deviation > cfg.threshold);
    const overRatio = compares.length ? overThreshold.length / compares.length : 0;
    const deviation = Math.max(...compares.map((c) => c.deviation));
    const needOver = Math.max(2, Math.ceil(compares.length * 0.4));
    const exceeded = overThreshold.length >= needOver
      || (compares.length === 1 && overThreshold.length === 1);
    const totalMismatchRatio = skipped.length
      ? skipped.filter((s) => s.why === 'total_mismatch').length / (skipped.length + compares.length)
      : 0;
    const detail = {
      ...baseDetail,
      areas: compares,
      skipped,
      over_ratio: Number(overRatio.toFixed(3)),
      total_mismatch_ratio: Number(totalMismatchRatio.toFixed(3)),
    };

    if (totalMismatchRatio > 0.5) {
      // 大部分区域的 total 都对不上：数据可疑，但不直接丢（可能是上游改版）
      return {
        decision: cfg.mode === 'strict' ? 'suspect' : 'accept',
        reason: 'deviation_exceeded',
        deviation,
        baseSnapshotId: baseline.id,
        comparable: compares.length,
        detail,
      };
    }

    if (exceeded) {
      const decision: Decision = cfg.mode === 'strict' ? 'drop' : 'suspect';
      return {
        decision,
        reason: 'deviation_exceeded',
        deviation,
        baseSnapshotId: baseline.id,
        comparable: compares.length,
        detail,
      };
    }

    return {
      decision: 'accept',
      reason: 'within_threshold',
      deviation,
      baseSnapshotId: baseline.id,
      comparable: compares.length,
      detail,
    };
  } catch (e) {
    // 保险丝：校验失败绝不能阻断数据流
    logger.warn({ err: e }, '[p2pvalidate] 校验异常，按采纳处理');
    return {
      decision: 'accept',
      reason: 'error',
      deviation: null,
      baseSnapshotId: null,
      comparable: 0,
      detail: { ...baseDetail, error: e instanceof Error ? e.message : String(e) },
    };
  }
}

/** 记录一次判定（drop/suspect 才需要，accept 也记便于统计可信度） */
export async function recordValidation(
  peerId: string,
  msgTs: string | undefined,
  capturedAt: string | undefined,
  bodySha: string | undefined,
  result: ValidateResult,
  db: Db = getDb(),
): Promise<void> {
  try {
    await sql`
      INSERT INTO p2p_validation
        (ts, peer_id, msg_ts, captured_at, base_snapshot_id, decision, reason,
         deviation, comparable, detail, body_sha256)
      VALUES (${nowLocal()}, ${peerId}, ${msgTs ?? null}, ${capturedAt ?? null},
              ${result.baseSnapshotId}, ${result.decision}, ${result.reason},
              ${result.deviation}, ${result.comparable},
              ${JSON.stringify(result.detail)}, ${bodySha ?? null})
    `.execute(db);
  } catch (e) {
    logger.warn({ err: e }, '[p2pvalidate] 判定记录写入失败');
  }
}

export interface PeerCredibility {
  peer_id: string;
  pass: number;
  fail: number;
  unknown: number;
  total: number;
  credibility: number | null;
}

/** 某节点近 N 次判定的可信度（供后台节点表展示） */
export async function peerCredibility(
  peerId: string,
  limit = 20,
  db: Db = getDb(),
): Promise<PeerCredibility> {
  const res = await sql<{ decision: string; reason: string; n: number }>`
    SELECT decision, reason, COUNT(*) AS n FROM (
      SELECT decision, reason FROM p2p_validation
       WHERE peer_id = ${peerId}
       ORDER BY id DESC LIMIT ${limit}
    ) GROUP BY decision, reason
  `.execute(db);
  let pass = 0;
  let fail = 0;
  let unknown = 0;
  for (const row of res.rows) {
    const n = Number(row.n);
    if (row.reason === 'no_baseline' || row.reason === 'insufficient_overlap'
      || row.reason === 'mode_off' || row.reason === 'error') {
      unknown += n;
    } else if (row.decision === 'drop' || row.decision === 'suspect') {
      fail += n;
    } else {
      pass += n;
    }
  }
  const total = pass + fail + unknown;
  return {
    peer_id: peerId,
    pass,
    fail,
    unknown,
    total,
    credibility: pass + fail > 0 ? pass / (pass + fail) : null,
  };
}
