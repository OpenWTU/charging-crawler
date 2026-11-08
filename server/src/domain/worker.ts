/**
 * 抓取编排：从 token 池轮换取 token，先区域快照再端口状态；worker 单循环。
 *
 * ⚠️ 与 cloud/refresh.py、cloud/snapshots.py::store_snapshot、cloud/ports.py::_sync_ports_impl
 * 逐函数对齐。互斥用单线程事件循环的 busy 标志（Python 是 threading.Lock，语义等价：
 * 同一时刻只有一轮刷新在跑）。
 *
 * 测试**绝不真实调用 ap3202**——serverRefreshOnce/syncPortsImpl 接受可注入的
 * call 函数，测试传 mock。
 */
import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { getDb, type Db } from '../db/index.js';
import { WORKER_INTERVAL } from '../config.js';
import { decryptToken } from './crypto.js';
import { isAuthError, call as callPlatform } from './crawler.js';
import { logger } from '../logger.js';
import { broadcastSnapshot } from './p2p.js';
import { pickToken, markPoolError, type TokenCandidate } from './tokens.js';
import {
  cleanPortEntries,
  nowStr,
  recordPileSample,
  splitValidAreas,
  upsertArea,
  type CleanArea,
  type CleanPort,
} from './store.js';

export type Call = (path: string, params: Record<string, unknown>, opts: {
  token?: string;
  userId?: string;
  appid?: string;
  timeout?: number;
}) => Promise<{ code?: number; msg?: string; data?: unknown; [k: string]: unknown }>;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 模拟 Python json.dumps(sort_keys=True) 的稳定序列化（去重键用） */
export function stableStringify(obj: unknown): string {
  if (Array.isArray(obj)) return `[${obj.map(stableStringify).join(',')}]`;
  if (obj && typeof obj === 'object') {
    const keys = Object.keys(obj as Record<string, unknown>).sort();
    return (
      '{' +
      keys
        .map((k) => `${JSON.stringify(k)}:${stableStringify((obj as Record<string, unknown>)[k])}`)
        .join(',') +
      '}'
    );
  }
  return JSON.stringify(obj);
}

/**
 * 快照去重摘要（上传落库与 P2P 广播必须用同一个函数，否则同一份数据两个摘要 → 重复落库）。
 *
 * 排除 captured_at（采集时刻由客户端给，重传时可能微调）与接收端字段。
 */
export function snapshotDigest(payload: Record<string, unknown>): string {
  const stable: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    // M5（复审）：_suspect 是本地判定标记，不该影响"内容是否相同"的判断 ——
    // 否则同一条数据 accept 版与 suspect 版摘要不同，会被存两份。
    if (k === 'captured_at' || k === 'received_at' || k === 'client_ip' || k === '_suspect') continue;
    stable[k] = v;
  }
  return createHash('sha256').update(stableStringify(stable), 'utf8').digest('hex');
}

/* ---------------- 快照落库（cloud/snapshots.py::store_snapshot） ---------------- */

export async function storeSnapshot(
  payload: Record<string, unknown>,
  source: string,
  db: Db = getDb(),
): Promise<number> {
  const cutoff = nowStr(new Date(Date.now() - 1800 * 1000));
  const { valid } = await splitValidAreas(payload.areas as CleanArea[], db);
  if (!valid.length) throw new Error('没有可用区域');
  // 必须与 P2P 广播、上传落库共用同一个摘要函数，否则三处各算一套 → 去重失效
  const digest = snapshotDigest({ ...payload, areas: valid });
  const dup = await sql<{ id: number }>`
    SELECT id FROM snapshots WHERE body_sha256 = ${digest} AND received_at >= ${cutoff}
    ORDER BY id DESC LIMIT 1
  `.execute(db);
  if (dup.rows[0]) return Number(dup.rows[0].id);

  const stamp = nowStr();
  let rid = 0;
  await db.transaction().execute(async (trx) => {
    const ins = await trx
      .insertInto('snapshots')
      .values({
        received_at: stamp,
        captured_at: String(payload.captured_at ?? ''),
        project: String(payload.project ?? ''),
        app_version: String(payload.app_version ?? 'server'),
        token_user: String(payload.token_user ?? ''),
        client_ip: source,
        device_id: null,
        real_ip: null,
        body_sha256: digest,
        payload: JSON.stringify({ ...payload, areas: valid }),
      })
      .executeTakeFirst();
    rid = Number(ins?.insertId ?? 0);
    for (const a of valid) {
      const aid = await upsertArea(a.name, trx);
      await trx
        .insertInto('area_samples')
        .values({
          snapshot_id: rid,
          area_id: aid,
          area_name: a.name,
          idle: a.idle_port,
          total: a.total_port,
          charging: a.charging_port,
          fault: a.fault_port,
          received_at: stamp,
        })
        .execute();
    }
  });
  return rid;
}

/* ---------------- 区域快照抓取（cloud/refresh.py::server_refresh_once） ---------------- */

function uniqueByName<T extends { name?: unknown }>(areas: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const a of areas) {
    const n = String(a.name ?? '');
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(a);
  }
  return out;
}

export async function serverRefreshOnce(
  callImpl: Call = callPlatform,
  db: Db = getDb(),
): Promise<string> {
  const candidates = await pickToken(3, db);
  if (!candidates.length) return 'no-token';

  const collected = new Map<string, CleanArea>();
  const skippedMap = new Map<string, string>();
  const failed = new Map<string, string>();
  let retryIds = new Set<string>();
  let last = 'no-token';
  let uid = '';
  let project = '';

  for (const cand of candidates) {
    let token: string;
    try {
      token = decryptToken(cand.enc);
    } catch (e) {
      await markPoolError(cand.id, cand.uid, `decrypt-fail: ${e}`, false, db);
      last = 'decrypt-fail';
      continue;
    }
    let areaList: Array<Record<string, unknown>> = [];
    const attemptFailed: Array<Record<string, unknown>> = [];
    try {
      const user = await callImpl('user/userInfo', {}, { token, userId: cand.uid });
      const data = (user.data ?? {}) as Record<string, unknown>;
      const projectId = data.projectId;
      if (!projectId) {
        last = 'no-project';
        continue;
      }
      project = String(data.projectName ?? '');
      // 记录本次抓取所用的令牌属主（快照的 token_user 字段），原来漏赋值导致恒为空
      uid = String(cand.uid ?? '');
      const near = await callImpl(
        'nearArea/list',
        { projectId: String(projectId) },
        { token, userId: cand.uid },
      );
      areaList = (near.data as Array<Record<string, unknown>>) ?? [];
      if (retryIds.size) areaList = areaList.filter((a) => retryIds.has(String(a.id)));
      if (!areaList.length) {
        last = 'empty';
        continue;
      }
      for (const a of areaList) {
        const aid = String(a.id);
        try {
          const st = await callImpl(`nearArea/${aid}`, { isNearBy: 'Y' }, { token, userId: cand.uid });
          await sleep(250);
          let d = st.data;
          if (!d) {
            attemptFailed.push(a);
            continue;
          }
          const dd = (Array.isArray(d) && d.length ? d[0] : d) as Record<string, unknown>;
          collected.set(aid, {
            id: aid,
            name: String(a.areaName ?? aid),
            address: String(dd.address ?? ''),
            total_port: Number(dd.totalPort ?? 0),
            idle_port: Number(dd.idlePort ?? 0),
            charging_port: Number(dd.chargingPort ?? 0),
            fault_port: Number(dd.faultPort ?? 0),
          });
          failed.delete(aid);
        } catch (e) {
          if (isAuthError(e)) throw e;
          attemptFailed.push(a);
        }
      }
    } catch (e) {
      if (isAuthError(e)) {
        await markPoolError(cand.id, cand.uid, `auth-expired: ${e}`, true, db);
        last = 'auth-expired';
        retryIds = new Set(areaList.map((a) => String(a.id)).filter((x) => !collected.has(x)));
        continue;
      }
      last = `error:${e}`;
      continue;
    }

    const { valid, skipped } = await splitValidAreas(uniqueByName([...collected.values()]), db);
    for (const [id, a] of collected) if (!valid.some((v) => v.name === a.name)) collected.delete(id);
    for (const [name, reason] of skipped) skippedMap.set(name, reason);
    // M14：原实现把 attemptFailed 整体写回 failed，但成功时会 failed.delete(aid)，
    // 于是已成功的区域又被塞回来 → 下一个 token 重抓、fail:N 虚高、误触 worker_fail 告警。
    // 只补「本轮尝试过但仍不在 failed 里、且确实没成功采集」的区域。
    for (const a of attemptFailed) {
      const aid = String(a.id);
      if (!collected.has(aid) && !failed.has(aid)) failed.set(aid, String(a.areaName ?? aid));
    }
    retryIds = new Set(failed.keys());
    if (!retryIds.size) break;
    last = `fail:${retryIds.size}`;
  }

  const { valid: validAreas } = await splitValidAreas(uniqueByName([...collected.values()]), db);
  if (!validAreas.length) {
    if (skippedMap.size) return `no-valid-area:${skippedMap.size}`;
    if (failed.size) return last.startsWith('fail:') ? last : `fail:${failed.size}`;
    return last;
  }
  try {
    const snap = {
      captured_at: nowStr(),
      project,
      app_version: 'server',
      token_user: uid,
      areas: validAreas as unknown as CleanArea[],
    };
    await storeSnapshot(snap, 'server', db);
    // P2P 广播（未启用时 no-op）：服务端抓取的新快照也共享给白名单节点
    void broadcastSnapshot(snap as unknown as Record<string, unknown>);
  } catch (e) {
    logger.error({ err: e }, '[refresh] 入库失败');
    return 'store-error';
  }
  const parts = [`ok:${validAreas.length}`];
  if (skippedMap.size) parts.push(`skipped:${skippedMap.size}`);
  if (failed.size) parts.push(`fail:${failed.size}`);
  return parts.join(' ');
}

/* ---------------- 端口同步（cloud/ports.py::_sync_ports_impl） ---------------- */

function extractPorts(data: unknown): CleanPort[] {
  if (Array.isArray(data)) {
    if (data.length && data.every((x) => x && typeof x === 'object' && Array.isArray((x as any).ports))) {
      const merged: Array<Record<string, unknown>> = [];
      for (const x of data) merged.push(...(((x as any).ports as Array<Record<string, unknown>>) ?? []));
      return cleanPortEntries(merged, false);
    }
    return cleanPortEntries(data as Array<Record<string, unknown>>, false);
  }
  if (!data || typeof data !== 'object') return [];
  return cleanPortEntries((data as any).ports, false);
}

export async function syncPortsImpl(
  callImpl: Call = callPlatform,
  onlyDevices?: string[],
  db: Db = getDb(),
): Promise<string> {
  const candidates = await pickToken(3, db);
  if (!candidates.length) return 'no-token';

  const devicesRes = onlyDevices?.length
    ? await sql<{ device_hex: string; code: string }>`
        SELECT device_hex, code FROM controllers
        WHERE code IS NOT NULL AND code <> '' AND device_hex IN (${sql.join(onlyDevices)})
      `.execute(db)
    : await sql<{ device_hex: string; code: string }>`
        SELECT device_hex, code FROM controllers WHERE code IS NOT NULL AND code <> ''
      `.execute(db);
  if (!devicesRes.rows.length) return 'empty';

  let remaining = devicesRes.rows.map((r) => ({ device_hex: String(r.device_hex), code: String(r.code) }));
  const done = new Map<string, number>();
  let last = 'no-token';
  let attempted = false;

  for (const cand of candidates) {
    if (!remaining.length) break;
    let token: string;
    try {
      token = decryptToken(cand.enc);
    } catch (e) {
      await markPoolError(cand.id, cand.uid, `decrypt-fail: ${e}`, false, db);
      last = 'decrypt-fail';
      continue;
    }
    attempted = true;
    const failedBatch: Array<{ device_hex: string; code: string }> = [];
    let authError = false;

    for (const dev of remaining) {
      let r;
      try {
        r = await callImpl('charge/ports', { fromType: 3, deviceId: dev.code }, { token, userId: cand.uid });
      } catch (e) {
        if (isAuthError(e)) {
          await markPoolError(cand.id, cand.uid, `auth-expired: ${e}`, true, db);
          authError = true;
          break;
        }
        failedBatch.push(dev);
        await sleep(250);
        continue;
      }
      const ports = extractPorts(r.data);
      if (!ports.length) {
        failedBatch.push(dev);
        await sleep(250);
        continue;
      }
      const stamp = nowStr();
      try {
        await db.transaction().execute(async (trx) => {
          // 只在「本次拿到的端口数 >= 库里该设备已有的端口数」时才清理多余端口：
          // 上游有时只返回部分端口，无条件 NOT IN 删除会把有效端口删掉
          const cur = await sql<{ n: number }>`
            SELECT COUNT(*) AS n FROM port_states WHERE device_hex = ${dev.device_hex}
          `.execute(trx);
          const existing = Number(cur.rows[0]?.n ?? 0);
          if (ports.length >= existing) {
            const marks = sql.join(ports.map((p) => p.port));
            await sql`DELETE FROM port_states WHERE device_hex = ${dev.device_hex} AND port NOT IN (${marks})`.execute(trx);
          }
          // 兜底：上游若长期只返回部分端口，「NOT IN 清理」永不触发，真下线的端口会永久残留
          //（公开页的空位数会偏大）。按 updated_at 清掉超过 24 小时没再出现的端口。
          const staleCut = nowStr(new Date(Date.now() - 24 * 3600 * 1000));
          await sql`DELETE FROM port_states WHERE device_hex = ${dev.device_hex} AND updated_at < ${staleCut}`.execute(trx);
          for (const p of ports) {
            await trx
              .insertInto('port_states')
              .values({ device_hex: dev.device_hex, port: p.port, status: p.status, status_group: p.group, updated_at: stamp })
              .onConflict((oc) =>
                oc.columns(['device_hex', 'port']).doUpdateSet({
                  status: p.status,
                  status_group: p.group,
                  updated_at: stamp,
                }),
              )
              .execute();
          }
          await sql`UPDATE controllers SET updated_at = ${stamp} WHERE device_hex = ${dev.device_hex}`.execute(trx);
          await recordPileSample(dev.device_hex, stamp, ports.map((p) => p.status), true, trx);
        });
      } catch (e) {
        logger.error({ err: e, device_hex: dev.device_hex }, '[ports] 写库失败');
        failedBatch.push(dev);
        await sleep(250);
        continue;
      }
      done.set(dev.device_hex, ports.length);
      await sleep(250);
    }

    if (authError) {
      last = 'auth-expired';
      continue;
    }
    remaining = failedBatch;
    if (!remaining.length) break;
    last = `fail:${remaining.length}`;
  }

  const total = [...done.values()].reduce((a, b) => a + b, 0);
  const failed = remaining.length;
  if (!done.size) {
    if (!attempted) return last;
    if (failed >= devicesRes.rows.length && (last === 'auth-expired' || last === 'decrypt-fail')) return last;
    return `fail:${failed}`;
  }
  let result = `ok:${done.size}/${total}`;
  if (failed) result += ` fail:${failed}`;
  return result;
}

/* ---------------- 编排与 worker ---------------- */

let refreshBusy = false;
let portsBusy = false;

export function roundOk(result: string): boolean {
  let sawOk = false;
  for (const part of String(result).split('|')) {
    const value = part.includes('=') ? part.slice(part.indexOf('=') + 1) : part;
    if (value.includes('fail:')) return false;
    if (value.startsWith('ok')) sawOk = true;
  }
  return sawOk;
}

export async function refreshRound(
  callImpl: Call = callPlatform,
  db: Db = getDb(),
): Promise<string> {
  if (refreshBusy) return 'skip:busy';
  refreshBusy = true;
  try {
    const areas = await serverRefreshOnce(callImpl, db);
    const ports = await syncPortsImpl(callImpl, undefined, db);
    return `areas=${areas}|ports=${ports}`;
  } finally {
    refreshBusy = false;
  }
}

export interface WorkerState {
  last_run?: string;
  last_result?: string;
  runs: number;
  started_at?: string;
}

const workerState: WorkerState = { runs: 0 };

export function getWorkerState(): WorkerState {
  return { ...workerState };
}

export async function workerRound(
  callImpl: Call = callPlatform,
  db: Db = getDb(),
): Promise<string> {
  const result = await refreshRound(callImpl, db);
  const stamp = nowStr();
  workerState.last_run = stamp;
  workerState.last_result = result;
  workerState.runs += 1;
  try {
    await db.insertInto('worker_runs').values({ ts: stamp, result }).execute();
    await sql`
      DELETE FROM worker_runs WHERE id < (SELECT MAX(id) - 500 FROM worker_runs)
    `.execute(db);
    // M12（复审实测）：这里原来硬编码 90 天，后台的 data_retention_days 从来没被读过；
    // 而且 p2p_validation / admin_audit / config_history / alert_state 完全没有清理，无界增长。
    let retentionDays = 90;
    try {
      const { getSetting } = await import('./adminsettings.js');
      const v = Number(await getSetting('data_retention_days'));
      if (Number.isFinite(v) && v >= 7) retentionDays = v;
    } catch { /* 用默认 */ }
    const cutoff = nowStr(new Date(Date.now() - retentionDays * 86400 * 1000));
    await sql`DELETE FROM area_samples WHERE received_at < ${cutoff}`.execute(db);
    await sql`DELETE FROM snapshots WHERE received_at < ${cutoff}`.execute(db);
    await sql`DELETE FROM pile_samples WHERE ts < ${cutoff}`.execute(db);
    await sql`DELETE FROM upload_audit WHERE ts < ${cutoff}`.execute(db);
    // M22：审计与互校明细也按保留期清（p2p_validation.detail 每条带整份 areas，最占空间）
    await sql`DELETE FROM p2p_validation WHERE ts < ${cutoff}`.execute(db).catch((e) => {
      logger.warn({ err: e }, '[worker] 清理 p2p_validation 失败');
    });
    await sql`DELETE FROM admin_audit WHERE ts < ${cutoff}`.execute(db).catch((e) => {
      logger.warn({ err: e }, '[worker] 清理 admin_audit 失败');
    });
    await sql`DELETE FROM config_history WHERE ts < ${cutoff}`.execute(db).catch((e) => {
      logger.warn({ err: e }, '[worker] 清理 config_history 失败');
    });
    await sql`DELETE FROM alert_state WHERE last_at < ${cutoff}`.execute(db).catch((e) => {
      logger.warn({ err: e }, '[worker] 清理 alert_state 失败');
    });
  } catch (e) {
    logger.error({ err: e }, '[worker] 记录失败');
  }
  logger.info({ result }, '[worker] 一轮完成');
  return result;
}

/** 启动 worker 定时器（P8 切换后由读写模式的 Node 调用）；返回停止函数 */
export function startWorker(
  callImpl: Call = callPlatform,
  db: Db = getDb(),
  // L2：允许 settings 覆盖（后台「worker 间隔」原来是死配置，改了没效果）
  intervalMs = WORKER_INTERVAL * 1000,
): () => Promise<void> {
  let stopped = false;
  workerState.started_at = nowStr();
  // 跟踪「当前正在跑的那一轮」（不能只记第一轮，否则 stop 等不到后续轮次）
  const state: { current: Promise<void> } = { current: Promise.resolve() };
  const tick = async (): Promise<void> => {
      // L2：每轮从 app_settings 重新取间隔（后台改完下一轮生效，不用重启）
      // L5（复审）：调用方显式传了 intervalMs（测试/工具）就尊重它，只有走默认值时才读 settings
      let effectiveIntervalMs = intervalMs;
      if (intervalMs === WORKER_INTERVAL * 1000) {
        try {
          const { getSetting } = await import('./adminsettings.js');
          const sec = Number(await getSetting('worker_interval_sec'));
          if (Number.isFinite(sec) && sec >= 60) effectiveIntervalMs = sec * 1000;
        } catch { /* 用默认 */ }
      }
    if (stopped) return;
    state.current = (async () => {
      try {
        await workerRound(callImpl, db);
      } catch (e) {
        logger.error({ err: e }, '[worker] 异常');
      }
    })();
    try {
      await state.current;
    } catch {
      /* 上面已记日志 */
    }
    if (!stopped) setTimeout(tick, effectiveIntervalMs).unref?.();
  };
  // 启动后立即跑一轮（与 Python start_worker 一致）
  void tick();
  // 返回 async：等当前轮次结束再返回（最多等 5 秒，避免一轮几百个桩时关不掉容器）
  return async () => {
    stopped = true;
    await Promise.race([
      state.current.catch(() => {}),
      // unref：提前返回后别让这个定时器继续拖住事件循环（否则单测/脚本要多等几秒才退出）
      new Promise<void>((r) => {
        const t = setTimeout(r, 5_000);
        t.unref?.();
      }),
    ]);
  };
}
