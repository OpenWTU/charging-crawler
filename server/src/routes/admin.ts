/**
 * 节点后台管理（预留）。
 *
 * 现状：只提供**只读**的 P2P 策略视图，信息与公开的 /status 重叠，不构成新增泄露。
 *
 * TODO（后续迭代）：
 *  1. 管理员登录（口令 + 会话，复用云端的登录方式，禁止裸奔）
 *  2. 白名单在线编辑（写 nodes.json 的本地覆盖层，或走 GitHub PR 流程）
 *  3. 节点详细配置（NODE_NAME / NODE_URL / P2P_TRUST_NON_WHITELIST 的运行时覆盖）
 *  4. 操作审计（谁在什么时候改了哪个开关）
 *
 * 加写操作前必须先加鉴权：本文件末尾的 `assertAdmin` 是占位符，
 * 现在是 `throw`，任何依赖它的写端点都会直接 503，不会误开权限。
 */
import type { FastifyInstance } from 'fastify';
import { P2P_ENABLED, P2P_TRUST_NON_WHITELIST, NODE_NAME, NODE_URL, NODE_P2P_ADDR } from '../config.js';
import { p2pPeers, p2pSelfId, p2pWhitelistCount } from '../domain/p2p.js';

/** 管理端鉴权占位：登录功能落地前，任何写操作都不可用 */
function assertAdmin(): never {
  throw new Error('admin_auth_not_implemented');
}

export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
  /* ---------------- 只读：P2P 策略与节点概览 ---------------- */
  app.get('/admin/api/p2p', async (_req, reply) => {
    const peers = p2pPeers();
    return reply.send({
      ok: true,
      readonly: true, // 当前管理页只读，写操作待管理员登录
      policy: {
        p2p_enabled: P2P_ENABLED,
        // 是否采纳非白名单节点的数据（默认 false）
        trust_non_whitelist: P2P_TRUST_NON_WHITELIST,
        whitelist_count: p2pWhitelistCount(),
      },
      self: {
        peer_id: p2pSelfId(),
        name: NODE_NAME,
        url: NODE_URL,
        p2p_addr: NODE_P2P_ADDR,
      },
      peers: peers.map((p) => ({
        peer_id: p.peer_id,
        name: p.name,
        version: p.version,
        url: p.url,
        addr: p.addr,
        connected: p.connected,
        whitelisted: p.whitelisted,
        last_seen: p.last_seen,
        stats: p.stats,
      })),
    });
  });

  /* ---------------- 写操作占位（鉴权落地后再实现） ---------------- */
  app.patch('/admin/api/p2p/policy', async (_req, reply) => {
    try {
      assertAdmin();
    } catch {
      return reply.code(503).send({
        ok: false,
        error: '管理端鉴权尚未实现；如需修改策略请改环境变量 P2P_TRUST_NON_WHITELIST 后重启',
      });
    }
    return reply.code(503).send({ ok: false, error: 'unreachable' });
  });
}
