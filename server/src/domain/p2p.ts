/**
 * P2P 去中心化共享：libp2p + gossipsub 广播原始快照。
 *
 * 设计（P9）：
 *  - topic "charge-snapshots"，广播快照 payload（JSON），body_sha256 幂等去重
 *  - peerId 白名单：消息来源必须命中白名单（权威源 GitHub raw，本地缓存兜底）
 *  - 节点私钥持久化到 P2P_KEY_FILE（Ed25519 hex），peerId 跨重启稳定
 *  - P2P_ENABLED 默认 true（config 默认开启；镜像 ENV 兜底 false，compose 显式注入 true）
 */
import fs from 'node:fs';
import path from 'node:path';
import { createLibp2p, type Libp2p } from 'libp2p';
import { multiaddr } from '@multiformats/multiaddr';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { identify } from '@libp2p/identify';
import { bootstrap } from '@libp2p/bootstrap';
import { mdns } from '@libp2p/mdns';
import {
  generateKeyPair,
  privateKeyFromProtobuf,
  privateKeyToProtobuf,
} from '@libp2p/crypto/keys';
import type { PubSub, Message } from '@libp2p/interface';
import {
  NODE_NAME,
  NODE_P2P_ADDR,
  NODE_URL,
  P2P_BOOTSTRAP,
  P2P_ENABLED,
  P2P_KEY_FILE,
  P2P_LISTEN_PORT,
  P2P_MDNS,
  P2P_TRUST_NON_WHITELIST,
  P2P_WHITELIST_CACHE,
  P2P_WHITELIST_DEFAULT,
  P2P_WHITELIST_URL,
  SERVER_VERSION,
} from '../config.js';
import { sql } from '../db/index.js';
import { getDb } from '../db/index.js';
import { logger } from '../logger.js';
import { storeSnapshot, snapshotDigest } from './worker.js';
import { validatePayload } from './store.js';
import { recordValidation, validateIncoming } from './p2pvalidate.js';
import { getSetting } from './adminsettings.js';
import { nowStr } from './store.js';

const TOPIC = 'charge-snapshots';
const STATUS_TOPIC = 'charge-status';

export interface SnapshotMessage {
  v: 1;
  sender: string;
  sender_version?: string;
  ts: string;
  body_sha256: string;
  payload: Record<string, unknown>;
}

export interface StatusMessage {
  v: 1;
  sender: string;
  name: string;
  version: string;
  url: string;
  /** 本节点公网 P2P 地址（NODE_P2P_ADDR），供已连接节点在重连/迁移时使用 */
  p2p?: string;
  ts: string;
  stats: { snapshots: number; areas: number; devices: number; ports: number };
}

export interface P2pPeerInfo {
  peer_id: string;
  addr: string | null;
  connected: boolean;
  name: string | null;
  version: string | null;
  url: string | null;
  /** 是否在 nodes.json 白名单里（false = 网络上能连到、但数据默认不被采纳的节点） */
  whitelisted: boolean;
  last_seen: string | null;
  stats: { snapshots: number; areas: number; devices: number; ports: number } | null;
}

export interface P2pHandle {
  peerId: string;
  addresses: string[];
  broadcast(msg: Omit<SnapshotMessage, 'v' | 'sender'>): Promise<void>;
  /** cb 的第二个参数是 libp2p 签名验证的来源 peerId（不可伪造），不是消息里的 sender */
  onSnapshot(cb: (msg: SnapshotMessage, fromId: string) => Promise<void>): void;
  peers(): P2pPeerInfo[];
  /** 热更新白名单（原地改 Set，不重启；新增的节点调用方自己 dial） */
  setWhitelist(ids: Iterable<string>): void;
  /** 当前白名单大小 */
  whitelistSize(): number;
  /** 当前白名单内容（给后台展示与合并用） */
  whitelistIds(): string[];
  /** 断开某个 peer */
  hangUp(peerId: string): Promise<void>;
  dial(addr: string): Promise<void>;
  stop(): Promise<void>;
}

export interface P2pOptions {
  listenPort?: number;
  bootstrapAddrs?: string[];
  /** 白名单里带的节点地址（自动互连，无需手配 bootstrap） */
  autoAddrs?: string[];
  enableMdns?: boolean;
  whitelist?: Set<string>;
  keyFile?: string;
}

/** 读取或生成 Ed25519 私钥（protobuf hex 持久化） */
export async function loadOrCreateKey(keyFile: string): Promise<Uint8Array> {
  const dir = path.dirname(keyFile);
  if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(keyFile)) {
    const hex = fs.readFileSync(keyFile, 'ascii').trim();
    // 校验内容：截断/空文件会让 privateKeyFromProtobuf 抛错并触发整站降级，
    // 这里提前给出可诊断的错误（绝不静默覆盖——覆盖会丢 peerId）
    if (hex.length < 100 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
      throw new Error(
        `节点私钥文件损坏: ${keyFile}（${hex.length} 字符，应为偶数长度 hex；`
          + '请从备份恢复，或删掉它让节点以新身份重新加入白名单）',
      );
    }
    return new Uint8Array(Buffer.from(hex, 'hex'));
  }
  const key = await generateKeyPair('Ed25519');
  // lgtm[js/clear-text-storage-of-sensitive-data]：节点私钥必须以文件持久化才能跨重启保持 peerId，
  // 文件权限 0600，且明确约定绝不上传仓库（P2P_KEY_FILE 留在服务器本地）
  fs.writeFileSync(keyFile, Buffer.from(privateKeyToProtobuf(key)).toString('hex'), {
    encoding: 'ascii',
    mode: 0o600,
  });
  return privateKeyToProtobuf(key);
}

/** 白名单解析结果：peerId 集合 + 可主动连接的地址 */
/** 是否采纳非白名单节点数据：settings 优先，null 时回退 env */
async function trustNonWhitelist(): Promise<boolean> {
  try {
    const s = await getSetting('p2p_trust_non_whitelist');
    return s === null ? P2P_TRUST_NON_WHITELIST : s;
  } catch {
    return P2P_TRUST_NON_WHITELIST;
  }
}

export interface WhitelistResult {
  ids: Set<string>;
  addrs: string[];
}

/** 从 GitHub raw 拉取白名单；失败回退本地缓存；都失败返回空（拒绝所有外部消息） */
export async function loadWhitelist(
  url: string,
  cacheFile: string,
  fetchImpl: typeof fetch = fetch,
): Promise<WhitelistResult> {
  const parse = (text: string): WhitelistResult => {
    const ids = new Set<string>();
    const addrs: string[] = [];
    try {
      const data = JSON.parse(text) as Record<string, unknown>;
      // 新格式（nodes.json，与 App 目录合并）：{ nodes: [{ peerId, name, url, p2p }] }
      const nodes = Array.isArray(data.nodes) ? data.nodes : null;
      if (nodes) {
        for (const item of nodes) {
          if (!item || typeof item !== 'object') continue;
          const rec = item as Record<string, unknown>;
          const id = String(rec.peerId ?? rec.id ?? '').trim();
          const p2pAddr = String(rec.p2p ?? rec.addr ?? '').trim();
          if (id) ids.add(id);
          if (id && p2pAddr) {
            addrs.push(p2pAddr.includes('/p2p/') ? p2pAddr : `${p2pAddr}/p2p/${id}`);
          }
        }
      } else {
        // 兼容旧格式：{ peers: [...] }
        const list = Array.isArray(data.peers) ? data.peers : [];
        for (const item of list) {
          if (typeof item === 'string') {
            if (item) ids.add(item);
          } else if (item && typeof item === 'object') {
            const rec = item as Record<string, unknown>;
            const id = String(rec.id ?? '').trim();
            const addr = String(rec.addr ?? '').trim();
            if (id) ids.add(id);
            if (id && addr) {
              addrs.push(addr.includes('/p2p/') ? addr : `${addr}/p2p/${id}`);
            }
          }
        }
      }
    } catch {
      /* 解析失败返回空 */
    }
    return { ids, addrs };
  };
  try {
    // Accept: application/vnd.github.raw 让 contents API 直接返回原始文本
    const res = await fetchImpl(url, {
      signal: AbortSignal.timeout(10_000),
      headers: { Accept: 'application/vnd.github.raw' },
    });
    if (res.ok) {
      const text = await res.text();
      const peers = parse(text);
      try {
        fs.writeFileSync(cacheFile, text, 'utf8');
      } catch {
        /* 缓存失败不影响 */
      }
      logger.info({ count: peers.ids.size, addrs: peers.addrs.length }, '[p2p] 白名单已从远程加载');
      return peers;
    }
  } catch (e) {
    logger.warn({ err: e }, '[p2p] 白名单远程加载失败，尝试缓存');
  }
  try {
    const peers = parse(fs.readFileSync(cacheFile, 'utf8'));
    logger.info({ count: peers.ids.size, addrs: peers.addrs.length }, '[p2p] 白名单从缓存加载');
    return peers;
  } catch {
    /* 缓存也没有，继续尝试镜像内默认值 */
  }
  try {
    const peers = parse(fs.readFileSync(P2P_WHITELIST_DEFAULT, 'utf8'));
    logger.info({ count: peers.ids.size, addrs: peers.addrs.length }, '[p2p] 白名单从镜像默认值加载');
    return peers;
  } catch {
    logger.warn('[p2p] 无白名单（远程/缓存/镜像默认都不可用），拒绝所有外部消息');
    return { ids: new Set<string>(), addrs: [] };
  }
}

export async function startP2p(opts: P2pOptions = {}): Promise<P2pHandle> {
  const listenPort = opts.listenPort ?? P2P_LISTEN_PORT;
  const whitelist = opts.whitelist ?? new Set<string>();
  // 显式 bootstrap + 白名单里的节点地址（新增节点自动互连）
  const bootstrapAddrs = [
    ...new Set([...(opts.bootstrapAddrs ?? P2P_BOOTSTRAP), ...(opts.autoAddrs ?? [])]),
  ];
  const enableMdns = opts.enableMdns ?? P2P_MDNS;
  const keyFile = opts.keyFile ?? P2P_KEY_FILE;

  const rawKey = await loadOrCreateKey(keyFile);
  // crypto 5.x 的 interface 是 3.x，libp2p 2.x 的 interface 是 2.x；
  // 但 libp2p 2 内部 peer-id 用的就是 crypto 5，运行时结构一致，类型断言绕过
  const privateKey = privateKeyFromProtobuf(rawKey) as unknown as import('@libp2p/interface').PrivateKey;

  const discovery = [];
  if (enableMdns) discovery.push(mdns());
  if (bootstrapAddrs.length) {
    discovery.push(bootstrap({ list: bootstrapAddrs, timeout: 30_000 }));
  }

  const node: Libp2p = await createLibp2p({
    addresses: { listen: [`/ip4/0.0.0.0/tcp/${listenPort}`] },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    peerDiscovery: discovery,
    privateKey,
    services: {
      identify: identify(),
      pubsub: gossipsub({ allowPublishToZeroTopicPeers: true }),
    },
  });

  const pubsub = node.services.pubsub as PubSub;
  pubsub.subscribe(TOPIC);
  pubsub.subscribe(STATUS_TOPIC);

  const selfId = node.peerId.toString();
  const selfName = NODE_NAME || selfId.slice(0, 8);

  // 记录最近收到消息的节点元数据（名称/版本/活跃/统计，用于 /status 节点卡片）
  const peerMeta = new Map<string, {
  name: string;
  version: string;
  url: string;
  addr: string;
  last_seen: string;
  stats: StatusMessage['stats'] | null;
}>();

/** L11：peerMeta 只增不删（开了 trust 时外部节点可刷），定期清超过 24h 没活跃的 */
function sweepPeerMeta(): void {
  if (peerMeta.size < 200) return;
  // L6（复审）：last_seen 是本地时间串（nowStr 生成），原来用 toISOString() 是 UTC → 偏 8 小时
  const d = new Date(Date.now() - 24 * 3600_000);
  const p2 = (x: number): string => String(x).padStart(2, '0');
  const cutoff = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} `
    + `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
  for (const [id, meta] of peerMeta) {
    if (meta.last_seen && meta.last_seen < cutoff) peerMeta.delete(id);
  }
}

  /** 本机数据统计（心跳附带） */
  async function selfStats(): Promise<StatusMessage['stats']> {
    try {
      const db = getDb();
      const r = await sql<{
        snapshots: number; areas: number; devices: number; ports: number;
      }>`
        SELECT
          (SELECT COUNT(*) FROM snapshots) AS snapshots,
          (SELECT COUNT(*) FROM areas) AS areas,
          (SELECT COUNT(*) FROM devices) AS devices,
          (SELECT COUNT(*) FROM port_states) AS ports
      `.execute(db);
      const c = r.rows[0];
      return { snapshots: c?.snapshots ?? 0, areas: c?.areas ?? 0, devices: c?.devices ?? 0, ports: c?.ports ?? 0 };
    } catch {
      return { snapshots: 0, areas: 0, devices: 0, ports: 0 };
    }
  }

  /** 广播状态心跳（节点名称 + 版本 + 数据统计） */
  async function broadcastStatus() {
    const msg: StatusMessage = {
      v: 1,
      sender: selfId,
      name: selfName,
      version: SERVER_VERSION,
      url: NODE_URL,
      p2p: NODE_P2P_ADDR || undefined,
      ts: nowStr(),
      stats: await selfStats(),
    };
    try {
      await pubsub.publish(STATUS_TOPIC, new TextEncoder().encode(JSON.stringify(msg)));
    } catch {
      /* 心跳失败忽略 */
    }
  }

  // 启动即广播一次，之后每 60 秒一次
  void broadcastStatus();
  const statusTimer = setInterval(() => void broadcastStatus(), 60_000);

  const handle: P2pHandle = {
    peerId: selfId,
    // 优先用显式配置的公网地址（NODE_P2P_ADDR）；否则回退到 libp2p 监听到的地址
    // （注意容器内多为 172.x/127.0.0.1，对外不可达，所以生产应显式配 NODE_P2P_ADDR）
    addresses: NODE_P2P_ADDR
      ? [NODE_P2P_ADDR.includes('/p2p/') ? NODE_P2P_ADDR : `${NODE_P2P_ADDR.replace(/\/$/, '')}/p2p/${selfId}`]
      : node.getMultiaddrs().map((a) => a.toString()),

    async broadcast(msg) {
      const full: SnapshotMessage = {
        v: 1,
        sender: selfId,
        sender_version: SERVER_VERSION,
        ...msg,
      };
      await pubsub.publish(TOPIC, new TextEncoder().encode(JSON.stringify(full)));
    },

    onSnapshot(cb) {
      pubsub.addEventListener('message', async (evt: CustomEvent<Message>) => {
        const detail = evt.detail;
        const { topic, data } = detail;
        if (topic !== TOPIC) return;
        // 鉴权用 libp2p 签名验证的来源 peerId（SignedMessage.from，不可伪造），
        // 而不是消息内容里自填的 sender（可伪造）
        if (detail.type !== 'signed') return;
        const fromId = detail.from.toString();
        // 白名单外节点：默认丢弃；信任开关打开时也采纳
        // （读 app_settings 而非启动期常量，否则后台切开关是假的 —— 审查 M1）
        if (!whitelist.has(fromId) && !(await trustNonWhitelist())) return;
        let msg: SnapshotMessage;
        try {
          msg = JSON.parse(new TextDecoder().decode(data));
        } catch {
          return;
        }
        if (msg.v !== 1) return;
        // 记录节点版本与最近活跃时间
        const prev = peerMeta.get(fromId);
        sweepPeerMeta();
        peerMeta.set(fromId, {
          name: prev?.name ?? fromId.slice(0, 8),
          version: msg.sender_version ?? prev?.version ?? 'unknown',
          url: prev?.url ?? '',
          addr: prev?.addr ?? '',
          last_seen: msg.ts,
          stats: prev?.stats ?? null,
        });
        // 回调异常必须就地捕获：事件回调里丢弃的 Promise rejection 会让 Node 24 直接退出进程
        void Promise.resolve(cb(msg, fromId)).catch((e: unknown) => {
          logger.warn({ err: e }, '[p2p] onSnapshot 回调异常');
        });
      });

      // 状态心跳：更新节点元数据（名称/版本/统计）
      pubsub.addEventListener('message', async (evt: CustomEvent<Message>) => {
        const detail = evt.detail;
        const { topic, data } = detail;
        if (topic !== STATUS_TOPIC) return;
        if (detail.type !== 'signed') return;
        const fromId = detail.from.toString();
        if (!whitelist.has(fromId) && !(await trustNonWhitelist())) return;
        let msg: StatusMessage;
        try {
          msg = JSON.parse(new TextDecoder().decode(data));
        } catch {
          return;
        }
        if (msg.v !== 1) return;
        peerMeta.set(fromId, {
          name: msg.name || fromId.slice(0, 8),
          version: msg.version || 'unknown',
          url: msg.url || '',
          addr: msg.p2p || peerMeta.get(fromId)?.addr || '',
          last_seen: msg.ts,
          stats: msg.stats ?? null,
        });
      });
    },

    peers() {
      return node.getPeers().map((p) => {
        const meta = peerMeta.get(p.toString());
        return {
          peer_id: p.toString(),
          addr: meta?.addr || null,
          connected: true,
          name: meta?.name ?? null,
          version: meta?.version ?? null,
          url: meta?.url || null,
          whitelisted: whitelist.has(p.toString()),
          last_seen: meta?.last_seen ?? null,
          stats: meta?.stats ?? null,
        };
      });
    },

    async dial(addr) {
      await node.dial(multiaddr(addr));
    },

    // 白名单是同一个 Set 引用，原地增删后消息处理闭包立即可见（不重启）
    setWhitelist(ids) {
      const next = new Set(ids);
      for (const id of [...whitelist]) {
        if (!next.has(id)) whitelist.delete(id);
      }
      for (const id of next) whitelist.add(id);
    },

    whitelistSize() {
      return whitelist.size;
    },

    whitelistIds() {
      return [...whitelist];
    },

    // 从当前连接里找目标并关闭（不引入 peerIdFromString，避免新增依赖）
    async hangUp(peerId) {
      for (const conn of node.getConnections()) {
        if (conn.remotePeer.toString() === peerId) {
          await conn.close();
        }
      }
    },

    async stop() {
      clearInterval(statusTimer);
      await node.stop();
    },
  };

  return handle;
}

/* ---------------- 全局实例（集成点） ---------------- */

let p2pInstance: P2pHandle | null = null;
let p2pWhitelistSize = 0;
/** 白名单为空时的重试定时器（stopP2p 里要清掉，否则停机后仍在拉 GitHub） */
let whitelistRetryTimer: NodeJS.Timeout | null = null;

/** 收到广播 → 落库（body_sha256 去重）。白名单已在 onSnapshot 层校验。 */
async function ingestSnapshot(msg: SnapshotMessage, fromId: string): Promise<void> {
  const db = getDb();
  // 与 storeSnapshot 用同样的 30 分钟去重窗口：不算时间窗的话，夜间 idle==total 这类
  // 「内容完全相同但时间不同」的正常快照会被永久判重丢弃
  const cutoff = nowStr(new Date(Date.now() - 1800 * 1000));
  try {
    const dup = await sql<{ id: number }>`
      SELECT id FROM snapshots
       WHERE body_sha256 = ${msg.body_sha256} AND received_at >= ${cutoff}
       LIMIT 1
    `.execute(db);
    if (dup.rows[0]) return; // 已存在（可能是自己广播回来）

    // 跨节点互校（详见 docs/p2p-validation.md）：与本节点「同一时刻」的数据比对
    const vr = await validateIncoming(msg.payload, msg.ts, db);
    if (vr.decision !== 'accept' || vr.deviation !== null) {
      // accept 且算出了 deviation 也记一条，用于统计节点可信度
      await recordValidation(fromId, msg.ts, msg.payload?.captured_at as string | undefined,
        msg.body_sha256, vr, db);
    }
    if (vr.decision === 'drop') {
      logger.warn(
        {
          peer: fromId.slice(0, 16),
          sha: msg.body_sha256.slice(0, 12),
          deviation: vr.deviation,
          reason: vr.reason,
        },
        '[p2p] 快照偏差过大，已丢弃',
      );
      return;
    }
    // suspect（warn 模式）：落库但打标记，便于事后筛出
    const payload = vr.decision === 'suspect'
      ? { ...msg.payload, _suspect: true }
      : msg.payload;
    // M8：P2P 来的 payload 不能直接落库
    // ① 形状没校验过 —— 多出来的字段（token、_suspect、任意垃圾）会被 /api/latest 原样下发
    // ② 去重判据用的是发送方自报的 body_sha256（可伪造），必须本地重算
    let safePayload: Record<string, unknown>;
    try {
      safePayload = validatePayload(payload) as unknown as Record<string, unknown>;
    } catch (e) {
      logger.warn({ err: e, peer: fromId.slice(0, 16) }, '[p2p] payload 形状非法，已丢弃');
      return;
    }
    // M5（复审）：validatePayload 只返回白名单字段，会把上面打的 _suspect 洗掉 ——
    // warn 模式「落库并打标」于是名存实亡（事后筛不出被判定可疑的快照）。这里补回。
    const suspectRaw = (payload as Record<string, unknown>)._suspect;
    if (suspectRaw) (safePayload as Record<string, unknown>)._suspect = suspectRaw;
    const localDigest = snapshotDigest(safePayload);
    if (localDigest !== msg.body_sha256) {
      // 摘要不一致：消息可能被篡改，或发送方用了不同序列化 —— 以本地重算为准继续去重
      logger.warn(
        { peer: fromId.slice(0, 16), claimed: msg.body_sha256.slice(0, 12), actual: localDigest.slice(0, 12) },
        '[p2p] 摘要与本地重算不一致',
      );
    }
    await storeSnapshot(safePayload, 'p2p', db);
    logger.info(
      {
        peer: fromId.slice(0, 16),
        sha: msg.body_sha256.slice(0, 12),
        validation: vr.decision,
        deviation: vr.deviation,
      },
      '[p2p] 收到并落库快照',
    );
  } catch (e) {
    logger.warn({ err: e }, '[p2p] 快照落库失败');
  }
}

/** 启动全局 P2P（P2P_ENABLED=true 时由 server 调用） */
/** 当前 P2P 句柄（未启动时 null） */
export function p2pHandle(): P2pHandle | null {
  return p2pInstance;
}

export async function initP2p(): Promise<P2pHandle | null> {
  if (!P2P_ENABLED) return null;
  if (p2pInstance) return p2pInstance;
  const wl = await loadWhitelist(P2P_WHITELIST_URL, P2P_WHITELIST_CACHE);
  p2pInstance = await startP2p({ whitelist: wl.ids, autoAddrs: wl.addrs });
  p2pWhitelistSize = wl.ids.size;
  p2pInstance.onSnapshot(ingestSnapshot);
  logger.info(
    { peerId: p2pInstance.peerId, whitelist: wl.ids.size, autoAddrs: wl.addrs.length },
    '[p2p] 已启动',
  );
  // 白名单为空 = 所有外部消息都被拒。此时每 5 分钟重试拉取（否则要人工重启才能恢复）
  if (wl.ids.size === 0 && !whitelistRetryTimer) {
    whitelistRetryTimer = setInterval(() => {
      void loadWhitelist(P2P_WHITELIST_URL, P2P_WHITELIST_CACHE)
        .then((retry) => {
          if (retry.ids.size === 0) return;
          for (const id of retry.ids) wl.ids.add(id);
          p2pWhitelistSize = wl.ids.size;
          logger.info({ whitelist: wl.ids.size }, '[p2p] 白名单重试成功');
          if (whitelistRetryTimer) {
            clearInterval(whitelistRetryTimer);
            whitelistRetryTimer = null;
          }
          // bootstrap 只在启动时跑过一次，这里补一次 dial，让已有节点主动连上新节点
          for (const addr of retry.addrs) {
            void p2pInstance?.dial(addr).catch(() => {
              /* 对方可能还没起来，下次心跳/重启再试 */
            });
          }
        })
        .catch(() => {
          /* 下个周期继续 */
        });
    }, 5 * 60_000);
    whitelistRetryTimer.unref?.();
  }
  return p2pInstance;
}

/** 广播一个快照（上传/worker 落库后调用）；返回 body_sha256 供日志 */
export async function broadcastSnapshot(payload: Record<string, unknown>): Promise<string> {
  if (!p2pInstance) return '';
  // 与上传落库共用 snapshotDigest，保证同一份数据在两端摘要一致（否则去重失效）
  const digest = snapshotDigest(payload);
  try {
    await p2pInstance.broadcast({ ts: nowStr(), body_sha256: digest, payload });
    return digest;
  } catch (e) {
    logger.warn({ err: e }, '[p2p] 广播失败');
    return digest;
  }
}

/** 当前在线节点（/status 用） */
export function p2pPeers(): P2pPeerInfo[] {
  return p2pInstance ? p2pInstance.peers() : [];
}

export function p2pSelfId(): string | null {
  return p2pInstance ? p2pInstance.peerId : null;
}

/** 本机节点名称（NODE_NAME 或 peerId 前 8 位） */
export function p2pSelfName(): string {
  const id = p2pInstance ? p2pInstance.peerId : '';
  return NODE_NAME || (id ? id.slice(0, 8) : '');
}

export function p2pSelfAddrs(): string[] {
  return p2pInstance ? p2pInstance.addresses : [];
}

/** 当前白名单数量（直接读 handle，避免与后台改动不同步） */
export function p2pWhitelistCount(): number {
  return p2pInstance?.whitelistSize() ?? p2pWhitelistSize;
}

export async function stopP2p(): Promise<void> {
  if (whitelistRetryTimer) {
    clearInterval(whitelistRetryTimer);
    whitelistRetryTimer = null;
  }
  if (p2pInstance) {
    await p2pInstance.stop();
    p2pInstance = null;
  }
}
