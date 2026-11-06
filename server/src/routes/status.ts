/**
 * 公开状态页：GET /status，只读无登录。
 *
 * 整合（按用户决策「令牌池 + 在线节点整合到一个公开页，无管理后台」）：
 *  - token_pool 统计（总数/有效/最早到期/长寿命）
 *  - worker 状态（上次运行/结果/轮数）
 *  - peers：在线节点列表（P9 libp2p 才有数据，P7 先空结构）
 *  - banlist：当前被自动拉黑的设备/IP 数量
 */
import type { FastifyInstance } from 'fastify';
import { tokenPoolStats } from '../domain/health.js';
import { getWorkerState } from '../domain/worker.js';
import { banlistStats } from '../domain/banlist.js';
import { nowStr } from '../domain/store.js';
import { P2P_ENABLED } from '../config.js';

export async function registerStatusRoutes(app: FastifyInstance): Promise<void> {
  app.get('/status', async (_req, reply) => {
    const pool = await tokenPoolStats();
    const worker = getWorkerState();
    const banned = banlistStats();
    return reply.send({
      ok: true,
      server_time: nowStr(),
      node: 'node',
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
      // P9 libp2p 接入后填充；P7 先给空结构，前端无需改动
      peers: {
        online: 0,
        whitelist: 0,
        nodes: [] as Array<{ peer_id: string; addr: string | null; connected: boolean }>,
      },
      banlist: {
        devices: banned.devices,
        ips: banned.ips,
      },
    });
  });
}
