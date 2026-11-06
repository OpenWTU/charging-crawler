/**
 * 公开状态页：GET /status，只读无登录。
 *
 * 整合（按用户决策「令牌池 + 在线节点整合到一个公开页，无管理后台」）：
 *  - server：时间/运行时长/内存/Node 版本/后端版本/数据库大小
 *  - data：快照总数、区域/设备/端口数、最近上传时间
 *  - token_pool 统计（总数/有效/最早到期/长寿命）
 *  - worker 状态（上次运行/结果/轮数）
 *  - peers：本机 peerId/地址、白名单数、在线节点（含版本/最近活跃）
 *  - banlist：当前被自动拉黑的设备/IP 数量
 */
import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { tokenPoolStats } from '../domain/health.js';
import { getWorkerState } from '../domain/worker.js';
import { banlistStats } from '../domain/banlist.js';
import { nowStr } from '../domain/store.js';
import { DATABASE_PATH, P2P_ENABLED, SERVER_VERSION } from '../config.js';
import { getDb } from '../db/index.js';
import { p2pPeers, p2pSelfAddrs, p2pSelfId, p2pWhitelistCount } from '../domain/p2p.js';

export async function registerStatusRoutes(app: FastifyInstance): Promise<void> {
  app.get('/status', async (_req, reply) => {
    const pool = await tokenPoolStats();
    const worker = getWorkerState();
    const banned = banlistStats();
    const db = getDb();

    const rows = await sql<{
      snapshots: number;
      areas: number;
      devices: number;
      ports: number;
      last_upload: string | null;
    }>`
      SELECT
        (SELECT COUNT(*) FROM snapshots) AS snapshots,
        (SELECT COUNT(*) FROM areas) AS areas,
        (SELECT COUNT(*) FROM devices) AS devices,
        (SELECT COUNT(*) FROM port_states) AS ports,
        (SELECT MAX(received_at) FROM snapshots) AS last_upload
    `.execute(db);
    const counts = rows.rows[0];
    let dbSize = 0;
    try {
      dbSize = fs.statSync(DATABASE_PATH).size;
    } catch {
      dbSize = 0;
    }

    return reply.send({
      ok: true,
      server_time: nowStr(),
      node: 'node',
      server: {
        version: SERVER_VERSION,
        node_version: process.version,
        uptime_sec: Math.round(process.uptime()),
        memory_rss: process.memoryUsage().rss,
        db_size: dbSize,
      },
      data: {
        snapshots: counts?.snapshots ?? 0,
        areas: counts?.areas ?? 0,
        devices: counts?.devices ?? 0,
        ports: counts?.ports ?? 0,
        last_upload: counts?.last_upload ?? null,
      },
      p2p_enabled: P2P_ENABLED,
      token_pool: {
        count: pool.count,
        valid: pool.valid,
        earliest_exp: pool.earliest_exp,
        cover_until: pool.cover_until,
        long_lived: pool.long_lived,
      },
      worker: {
        last_run: worker.last_run ?? null,
        last_result: worker.last_result ?? null,
        runs: worker.runs,
        started_at: worker.started_at ?? null,
      },
      peers: {
        self: p2pSelfId(),
        self_addrs: p2pSelfAddrs(),
        online: p2pPeers().length,
        whitelist: p2pWhitelistCount(),
        nodes: p2pPeers(),
      },
      banlist: {
        devices: banned.devices,
        ips: banned.ips,
      },
    });
  });
}
