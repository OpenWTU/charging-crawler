/**
 * P2P 去中心化共享：libp2p + gossipsub 广播原始快照。
 *
 * 设计（P9）：
 *  - topic "charge-snapshots"，广播快照 payload（JSON），body_sha256 幂等去重
 *  - peerId 白名单：消息来源必须命中白名单（权威源 GitHub raw，本地缓存兜底）
 *  - 节点私钥持久化到 P2P_KEY_FILE（Ed25519 hex），peerId 跨重启稳定
 *  - 默认 P2P_ENABLED=false 不启动，单节点不受影响
 */
import { createHash } from 'node:crypto';
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
  P2P_BOOTSTRAP,
  P2P_ENABLED,
  P2P_KEY_FILE,
  P2P_LISTEN_PORT,
  P2P_MDNS,
  P2P_WHITELIST_CACHE,
  P2P_WHITELIST_DEFAULT,
  P2P_WHITELIST_URL,
  SERVER_VERSION,
} from '../config.js';
import { sql } from '../db/index.js';
import { getDb } from '../db/index.js';
import { logger } from '../logger.js';
import { storeSnapshot, stableStringify } from './worker.js';
import { nowStr } from './store.js';

const TOPIC = 'charge-snapshots';

export interface SnapshotMessage {
  v: 1;
  sender: string;
  sender_version?: string;
  ts: string;
  body_sha256: string;
  payload: Record<string, unknown>;
}

export interface P2pPeerInfo {
  peer_id: string;
  addr: string | null;
  connected: boolean;
  version: string | null;
  last_seen: string | null;
}

export interface P2pHandle {
  peerId: string;
  addresses: string[];
  broadcast(msg: Omit<SnapshotMessage, 'v' | 'sender'>): Promise<void>;
  onSnapshot(cb: (msg: SnapshotMessage) => Promise<void>): void;
  peers(): P2pPeerInfo[];
  dial(addr: string): Promise<void>;
  stop(): Promise<void>;
}

export interface P2pOptions {
  listenPort?: number;
  bootstrapAddrs?: string[];
  enableMdns?: boolean;
  whitelist?: Set<string>;
  keyFile?: string;
}

/** 读取或生成 Ed25519 私钥（protobuf hex 持久化） */
export async function loadOrCreateKey(keyFile: string): Promise<Uint8Array> {
  const dir = path.dirname(keyFile);
  if (dir) fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(keyFile)) {
    const hex = fs.readFileSync(keyFile, 'ascii').trim();
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

/** 从 GitHub raw 拉取白名单；失败回退本地缓存；都失败返回空（拒绝所有外部消息） */
export async function loadWhitelist(
  url: string,
  cacheFile: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Set<string>> {
  const parse = (text: string): Set<string> => {
    try {
      const data = JSON.parse(text) as { peers?: unknown };
      const list = Array.isArray(data.peers) ? data.peers.map(String) : [];
      return new Set(list);
    } catch {
      return new Set();
    }
  };
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
    if (res.ok) {
      const text = await res.text();
      const peers = parse(text);
      try {
        fs.writeFileSync(cacheFile, text, 'utf8');
      } catch {
        /* 缓存失败不影响 */
      }
      logger.info({ count: peers.size }, '[p2p] 白名单已从远程加载');
      return peers;
    }
  } catch (e) {
    logger.warn({ err: e }, '[p2p] 白名单远程加载失败，尝试缓存');
  }
  try {
    const peers = parse(fs.readFileSync(cacheFile, 'utf8'));
    logger.info({ count: peers.size }, '[p2p] 白名单从缓存加载');
    return peers;
  } catch {
    /* 缓存也没有，继续尝试镜像内默认值 */
  }
  try {
    const peers = parse(fs.readFileSync(P2P_WHITELIST_DEFAULT, 'utf8'));
    logger.info({ count: peers.size }, '[p2p] 白名单从镜像默认值加载');
    return peers;
  } catch {
    logger.warn('[p2p] 无白名单（远程/缓存/镜像默认都不可用），拒绝所有外部消息');
    return new Set();
  }
}

export async function startP2p(opts: P2pOptions = {}): Promise<P2pHandle> {
  const listenPort = opts.listenPort ?? P2P_LISTEN_PORT;
  const whitelist = opts.whitelist ?? new Set<string>();
  const bootstrapAddrs = opts.bootstrapAddrs ?? P2P_BOOTSTRAP;
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

  // 记录最近收到消息的节点版本/时间（用于 /status 展示节点详情）
  const peerMeta = new Map<string, { version: string; last_seen: string }>();

  const handle: P2pHandle = {
    peerId: node.peerId.toString(),
    addresses: node.getMultiaddrs().map((a) => a.toString()),

    async broadcast(msg) {
      const full: SnapshotMessage = {
        v: 1,
        sender: node.peerId.toString(),
        sender_version: SERVER_VERSION,
        ...msg,
      };
      await pubsub.publish(TOPIC, new TextEncoder().encode(JSON.stringify(full)));
    },

    onSnapshot(cb) {
      pubsub.addEventListener('message', (evt: CustomEvent<Message>) => {
        const { topic, data } = evt.detail;
        if (topic !== TOPIC) return;
        let msg: SnapshotMessage;
        try {
          msg = JSON.parse(new TextDecoder().decode(data));
        } catch {
          return;
        }
        if (msg.v !== 1) return;
        if (!whitelist.has(msg.sender)) return;
        // 记录节点版本与最近活跃时间
        peerMeta.set(msg.sender, {
          version: msg.sender_version ?? 'unknown',
          last_seen: msg.ts,
        });
        void cb(msg);
      });
    },

    peers() {
      return node.getPeers().map((p) => {
        const meta = peerMeta.get(p.toString());
        return {
          peer_id: p.toString(),
          addr: null,
          connected: true,
          version: meta?.version ?? null,
          last_seen: meta?.last_seen ?? null,
        };
      });
    },

    async dial(addr) {
      await node.dial(multiaddr(addr));
    },

    async stop() {
      await node.stop();
    },
  };

  return handle;
}

/* ---------------- 全局实例（集成点） ---------------- */

let p2pInstance: P2pHandle | null = null;
let p2pWhitelistSize = 0;

/** 收到广播 → 落库（body_sha256 去重）。白名单已在 onSnapshot 层校验。 */
async function ingestSnapshot(msg: SnapshotMessage): Promise<void> {
  const db = getDb();
  const dup = await sql<{ id: number }>`
    SELECT id FROM snapshots WHERE body_sha256 = ${msg.body_sha256} LIMIT 1
  `.execute(db);
  if (dup.rows[0]) return; // 已存在（可能是自己广播回来）
  try {
    await storeSnapshot(msg.payload, 'p2p', db);
    logger.info({ sender: msg.sender.slice(0, 16), sha: msg.body_sha256.slice(0, 12) }, '[p2p] 收到并落库快照');
  } catch (e) {
    logger.warn({ err: e }, '[p2p] 快照落库失败');
  }
}

/** 启动全局 P2P（P2P_ENABLED=true 时由 server 调用） */
export async function initP2p(): Promise<P2pHandle | null> {
  if (!P2P_ENABLED) return null;
  if (p2pInstance) return p2pInstance;
  const whitelist = await loadWhitelist(P2P_WHITELIST_URL, P2P_WHITELIST_CACHE);
  p2pInstance = await startP2p({ whitelist });
  p2pWhitelistSize = whitelist.size;
  p2pInstance.onSnapshot(ingestSnapshot);
  logger.info({ peerId: p2pInstance.peerId, whitelist: whitelist.size }, '[p2p] 已启动');
  return p2pInstance;
}

/** 广播一个快照（上传/worker 落库后调用）；返回 body_sha256 供日志 */
export async function broadcastSnapshot(payload: Record<string, unknown>): Promise<string> {
  if (!p2pInstance) return '';
  const stable: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) if (k !== 'captured_at') stable[k] = v;
  const digest = createHash('sha256').update(stableStringify(stable), 'utf8').digest('hex');
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

export function p2pSelfAddrs(): string[] {
  return p2pInstance ? p2pInstance.addresses : [];
}

export function p2pWhitelistCount(): number {
  return p2pWhitelistSize;
}

export async function stopP2p(): Promise<void> {
  if (p2pInstance) {
    await p2pInstance.stop();
    p2pInstance = null;
  }
}
