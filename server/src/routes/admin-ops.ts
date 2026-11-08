/**
 * 管理端：节点网络 / 任务调度 / 运行日志 / 配置中心 / 流量与限流。
 *
 * 白名单规则（已确认）：`生效 = dedupe(GitHub nodes.json ∪ 本地覆盖层 app_settings.p2p_extra_peers)`
 * 去重键 peerId，字段以本地覆盖层为准；新增/删除只影响本地层，改完热更新（不重启）。
 */
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { getDb } from '../db/index.js';
import {
  P2P_ENABLED, P2P_TRUST_NON_WHITELIST, NODE_NAME, NODE_P2P_ADDR, NODE_URL, SERVER_VERSION,
} from '../config.js';
import { p2pHandle, p2pPeers, p2pSelfId, p2pSelfName } from '../domain/p2p.js';
import { readSettings, writeSetting, type LocalPeer } from '../domain/adminsettings.js';
import { getWorkerState, workerRound } from '../domain/worker.js';
import { banlistStats } from '../domain/banlist.js';
import { logBufferStats, recentLogs } from '../logger.js';
import { allPaths, topEndpoints, trafficSummary } from '../domain/traffic.js';
import { peerCredibility } from '../domain/p2pvalidate.js';
import { audit } from '../domain/adminaudit.js';
import { adminOf, daysAgo, nowLocal, readBody, requireRole } from './admin-util.js';

export async function registerAdminOpsRoutes(scope: FastifyInstance): Promise<void> {
  /* ==================== 节点网络 ==================== */

  scope.get('/admin/api/nodes', async () => {
    const settings = await readSettings();
    const handle = p2pHandle();
    const peers = p2pPeers();
    const local = settings.p2p_extra_peers;
    const githubIds = (handle?.whitelistIds() ?? []).filter(
      (id) => !local.some((p) => p.peerId === id),
    );
    // 每个节点的可信度（并发查，失败不影响主体）
    const creds = await Promise.all(
      peers.map((p) => peerCredibility(p.peer_id, 20).catch(() => null)),
    );
    const credMap = new Map(creds.filter(Boolean).map((c) => [c!.peer_id, c!]));
    return {
      ok: true,
      policy: {
        enabled: P2P_ENABLED,
        running: !!p2pSelfId(),
        // null = 跟随 env
        trust_non_whitelist: settings.p2p_trust_non_whitelist,
        trust_non_whitelist_effective: settings.p2p_trust_non_whitelist
          ?? P2P_TRUST_NON_WHITELIST,
        validate_mode: settings.p2p_validate_mode,
        whitelist_count: handle?.whitelistSize() ?? 0,
        github_count: githubIds.length,
        local_count: local.length,
      },
      self: {
        peer_id: p2pSelfId(),
        name: NODE_NAME || p2pSelfName(),
        addr: NODE_P2P_ADDR,
        url: NODE_URL,
        version: SERVER_VERSION,
      },
      whitelist: {
        github: githubIds,
        local,
      },
      peers: peers.map((p) => {
        const cred = credMap.get(p.peer_id);
        return {
          ...p,
          credibility: cred
            ? { pass: cred.pass, fail: cred.fail, unknown: cred.unknown, total: cred.total, rate: cred.credibility }
            : null,
        };
      }),
    };
  });

  /** 把「当前 whitelist ∪ 本地覆盖层」推给运行中的 P2P（热更新） */
  async function syncWhitelist(localPeers: LocalPeer[]): Promise<number> {
    const handle = p2pHandle();
    if (!handle) return 0;
    const current = new Set(handle.whitelistIds().filter(
      (id) => !localPeers.some((p) => p.peerId === id),
    ));
    for (const p of localPeers) current.add(p.peerId);
    handle.setWhitelist(current);
    // 新增的带地址的节点直接 dial（连不上也不报错，下一轮心跳会重试）
    for (const p of localPeers) {
      if (p.addr) {
        void handle.dial(p.addr).catch(() => {});
      }
    }
    return current.size;
  }

  scope.post('/admin/api/nodes/whitelist', async (req, reply) => {
    if (!requireRole(req, reply, 'ops')) return undefined;
    const admin = adminOf(req);
    const body = readBody<{ peerId?: unknown; addr?: unknown; url?: unknown; name?: unknown }>(req);
    const peerId = String(body.peerId ?? '').trim();
    if (peerId.length < 20) return reply.code(400).send({ ok: false, error: 'peerId 太短，请填完整' });
    const settings = await readSettings();
    const next: LocalPeer[] = settings.p2p_extra_peers.filter((p) => p.peerId !== peerId);
    next.push({
      peerId,
      addr: body.addr ? String(body.addr).trim() : undefined,
      url: body.url ? String(body.url).trim() : undefined,
      name: body.name ? String(body.name).trim() : undefined,
    });
    await writeSetting('p2p_extra_peers', next, admin.username);
    const size = await syncWhitelist(next);
    await audit({
      username: admin.username, action: 'nodes_whitelist_add', target: peerId, ip: req.ip,
      detail: { addr: body.addr ?? null, total: size },
    });
    return { ok: true, whitelist_count: size };
  });

  scope.delete('/admin/api/nodes/whitelist/:peerId', async (req, reply) => {
    if (!requireRole(req, reply, 'ops')) return undefined;
    const admin = adminOf(req);
    const peerId = String((req.params as { peerId?: string }).peerId ?? '');
    const settings = await readSettings();
    const exists = settings.p2p_extra_peers.some((p) => p.peerId === peerId);
    if (!exists) {
      return reply.code(400).send({
        ok: false,
        error: '该节点来自 GitHub nodes.json，只能通过改仓库移除；本地覆盖层里没有它',
      });
    }
    const next = settings.p2p_extra_peers.filter((p) => p.peerId !== peerId);
    await writeSetting('p2p_extra_peers', next, admin.username);
    const size = await syncWhitelist(next);
    await audit({ username: admin.username, action: 'nodes_whitelist_del', target: peerId, ip: req.ip, detail: { total: size } });
    return { ok: true, whitelist_count: size };
  });

  scope.patch('/admin/api/nodes/policy', async (req, reply) => {
    if (!requireRole(req, reply, 'ops')) return undefined;
    const admin = adminOf(req);
    const body = readBody<{ trust_non_whitelist?: unknown }>(req);
    const v = body.trust_non_whitelist;
    if (v !== null && typeof v !== 'boolean') {
      return reply.code(400).send({ ok: false, error: '需要 true / false / null（null=跟随环境变量）' });
    }
    await writeSetting('p2p_trust_non_whitelist', v, admin.username);
    await audit({ username: admin.username, action: 'nodes_policy', target: 'trust_non_whitelist', ip: req.ip, detail: { value: v } });
    return { ok: true, trust_non_whitelist: v, note: '新值在下一次消息校验时生效（已运行的连接不受影响）' };
  });

  scope.post('/admin/api/nodes/dial', async (req, reply) => {
    if (!requireRole(req, reply, 'ops')) return undefined;
    const admin = adminOf(req);
    const body = readBody<{ addr?: unknown }>(req);
    const addr = String(body.addr ?? '').trim();
    const handle = p2pHandle();
    if (!handle) return reply.code(400).send({ ok: false, error: 'P2P 未启动' });
    if (!addr.startsWith('/ip4/') && !addr.startsWith('/dns')) {
      return reply.code(400).send({ ok: false, error: '地址需为 /ip4/... 或 /dns... 形式' });
    }
    try {
      await handle.dial(addr);
      await audit({ username: admin.username, action: 'nodes_dial', target: addr, ip: req.ip });
      return { ok: true };
    } catch (e) {
      return reply.code(502).send({ ok: false, error: e instanceof Error ? e.message : '连接失败' });
    }
  });

  scope.post('/admin/api/nodes/disconnect', async (req, reply) => {
    if (!requireRole(req, reply, 'ops')) return undefined;
    const admin = adminOf(req);
    const body = readBody<{ peer_id?: unknown }>(req);
    const peerId = String(body.peer_id ?? '').trim();
    const handle = p2pHandle();
    if (!handle) return reply.code(400).send({ ok: false, error: 'P2P 未启动' });
    if (!peerId) return reply.code(400).send({ ok: false, error: '缺少 peer_id' });
    await handle.hangUp(peerId);
    await audit({ username: admin.username, action: 'nodes_disconnect', target: peerId, ip: req.ip });
    return { ok: true };
  });

  /** 某节点的互校判定明细 */
  scope.get('/admin/api/nodes/:peerId/validation', async (req) => {
    const peerId = String((req.params as { peerId?: string }).peerId ?? '');
    const limit = Math.min(Number((req.query as { limit?: string }).limit) || 50, 200);
    const res = await sql<{
      id: number; ts: string; decision: string; reason: string;
      deviation: number | null; comparable: number | null;
      base_snapshot_id: number | null; body_sha256: string | null; detail: string | null;
    }>`
      SELECT id, ts, decision, reason, deviation, comparable,
             base_snapshot_id, body_sha256, detail
        FROM p2p_validation WHERE peer_id = ${peerId}
       ORDER BY id DESC LIMIT ${limit}
    `.execute(getDb());
    const cred = await peerCredibility(peerId, 20);
    return {
      ok: true,
      stats: cred,
      items: res.rows.map((r) => {
        let detail: unknown = null;
        try {
          detail = r.detail ? JSON.parse(r.detail) : null;
        } catch {
          detail = null;
        }
        return { ...r, detail };
      }),
    };
  });

  /* ==================== 任务与调度 ==================== */

  scope.get('/admin/api/jobs', async () => {
    const worker = getWorkerState();
    const db = getDb();
    const runs = await sql<{ id: number; ts: string; result: string }>`
      SELECT id, ts, result FROM worker_runs ORDER BY id DESC LIMIT 20
    `.execute(db);
    const counts = await sql<{ total: number; ok: number }>`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN result LIKE 'areas=ok%' THEN 1 ELSE 0 END) AS ok
        FROM worker_runs
    `.execute(db).catch(() => ({ rows: [{ total: 0, ok: 0 }] }));
    return {
      ok: true,
      worker,
      runs: runs.rows,
      stats: {
        total: Number(counts.rows[0]?.total ?? 0),
        ok: Number(counts.rows[0]?.ok ?? 0),
      },
      timers: [
        { name: '抓取 worker', schedule: '每 10 分钟', last: worker.last_run ?? null },
        { name: '镜像自动更新', schedule: '每天 03:00', note: '宿主机 systemd timer' },
      ],
    };
  });

  scope.post('/admin/api/jobs/worker/run', async (req, reply) => {
    if (!requireRole(req, reply, 'ops')) return undefined;
    const admin = adminOf(req);
    // 异步触发，立即返回（一轮可能几十秒）
    void workerRound().catch(() => {});
    await audit({ username: admin.username, action: 'worker_run', ip: req.ip });
    return { ok: true, note: '已触发，约 10–30 秒后可在轮次历史看到结果' };
  });

  scope.post('/admin/api/jobs/worker-runs/purge', async (req, reply) => {
    if (!requireRole(req, reply, 'ops')) return undefined;
    const admin = adminOf(req);
    const body = readBody<{ before_days?: unknown }>(req);
    const days = Math.max(1, Math.min(Number(body.before_days) || 30, 3650));
    const r = await sql`DELETE FROM worker_runs WHERE ts < ${daysAgo(days)}`.execute(getDb());
    await audit({ username: admin.username, action: 'worker_runs_purge', ip: req.ip, detail: { days, deleted: Number(r.numAffectedRows ?? 0) } });
    return { ok: true, deleted: Number(r.numAffectedRows ?? 0) };
  });

  /* ==================== 运行日志 ==================== */

  scope.get('/admin/api/logs', async (req) => {
    const q = req.query as { level?: string; q?: string; since_seq?: string; limit?: string };
    const levelMap: Record<string, number> = { error: 50, warn: 40, info: 30, debug: 20 };
    const items = recentLogs({
      level: levelMap[q.level ?? ''] ?? 0,
      q: q.q,
      sinceSeq: Number(q.since_seq) || 0,
      limit: Number(q.limit) || 200,
    });
    return { ok: true, items, stats: logBufferStats() };
  });

  /* ==================== 配置中心 ==================== */

  scope.get('/admin/api/config', async () => {
    const settings = await readSettings();
    const db = getDb();
    const history = await sql<{
      id: number; ts: string; username: string | null; key: string;
      old_value: string | null; new_value: string | null;
    }>`
      SELECT id, ts, username, key, old_value, new_value
        FROM config_history ORDER BY id DESC LIMIT 30
    `.execute(db);
    return {
      ok: true,
      settings,
      history: history.rows,
      env: [
        { key: 'NODE_ENV', configured: true, value: process.env.NODE_ENV ?? null },
        { key: 'SERVER_VERSION', configured: true, value: SERVER_VERSION },
        { key: 'NODE_NAME', configured: !!NODE_NAME, value: NODE_NAME || null },
        { key: 'NODE_URL', configured: !!NODE_URL, value: NODE_URL || null },
        { key: 'NODE_P2P_ADDR', configured: !!NODE_P2P_ADDR, value: NODE_P2P_ADDR || null },
        { key: 'P2P_ENABLED', configured: true, value: String(P2P_ENABLED) },
        { key: 'P2P_TRUST_NON_WHITELIST', configured: true, value: String(P2P_TRUST_NON_WHITELIST) },
        { key: 'REGISTER_TOKEN', configured: !!process.env.REGISTER_TOKEN },
        { key: 'ADMIN_SESSION_SECRET', configured: !!process.env.ADMIN_SESSION_SECRET },
        { key: 'ADMIN_INIT_PASSWORD', configured: !!process.env.ADMIN_INIT_PASSWORD },
        { key: 'TRUST_PROXY', configured: !!process.env.TRUST_PROXY, value: process.env.TRUST_PROXY ?? null },
      ],
      readonly_env_note: '环境变量只读；可运行时改的项走上面 settings（写 app_settings，立即生效）',
      ts: nowLocal(),
    };
  });

  /* ==================== 流量与限流 ==================== */

  scope.get('/admin/api/traffic/summary', async (req) => {
    const hours = Math.min(Math.max(Number((req.query as { range?: string }).range) || 24, 1), 168);
    const s = trafficSummary(hours);
    return { ok: true, hours, ...s };
  });

  scope.get('/admin/api/traffic/endpoints', async (req) => {
    const hours = Math.min(Math.max(Number((req.query as { range?: string }).range) || 24, 1), 168);
    return { ok: true, hours, endpoints: topEndpoints(hours, 20), paths: allPaths() };
  });

  scope.get('/admin/api/traffic/banlist', async () => {
    const stats = banlistStats();
    const { listBans } = await import('../domain/banlist.js');
    return { ok: true, ...stats, items: listBans(100) };
  });

  scope.post('/admin/api/traffic/unban', async (req, reply) => {
    if (!requireRole(req, reply, 'ops')) return undefined;
    const admin = adminOf(req);
    const body = readBody<{ target?: unknown }>(req);
    const target = String(body.target ?? '').trim();
    if (!target) return reply.code(400).send({ ok: false, error: '缺少 target' });
    const { unbanById } = await import('../domain/banlist.js');
    const ok = unbanById(target);
    await audit({ username: admin.username, action: 'unban', target, ip: req.ip, ok });
    return { ok, note: ok ? '已解封' : '未找到该封禁记录（可能已过期）' };
  });
}
