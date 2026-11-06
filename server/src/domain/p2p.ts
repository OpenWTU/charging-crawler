/**
 * P2P 去中心化共享：libp2p + gossipsub 广播原始快照。
 *
 * 设计（P9）：
 *  - topic "charge-snapshots"，广播快照 payload（JSON），body_sha256 幂等去重
 *  - peerId 白名单：消息来源必须命中白名单（权威源 GitHub raw，部署时也可本地注入）
 *  - 默认 P2P_ENABLED=false 不启动，单节点不受影响
 *
 * 私钥持久化：libp2p 默认临时私钥（每次重启 peerId 变）。要稳定 peerId 必须
 * 持久化 privateKey——TODO：P9 后续用 P2P_KEY_FILE 存 Ed25519 私钥 hex。
 */
import { createLibp2p, type Libp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { identify } from '@libp2p/identify';
import { bootstrap } from '@libp2p/bootstrap';
import { mdns } from '@libp2p/mdns';
import type { PubSub, Message } from '@libp2p/interface';

const TOPIC = 'charge-snapshots';

export interface SnapshotMessage {
  v: 1;
  sender: string; // 来源节点 peerId
  ts: string;
  body_sha256: string;
  payload: Record<string, unknown>;
}

export interface P2pPeerInfo {
  peer_id: string;
  addr: string | null;
  connected: boolean;
}

export interface P2pHandle {
  peerId: string;
  addresses: string[];
  broadcast(msg: Omit<SnapshotMessage, 'v' | 'sender'>): Promise<void>;
  onSnapshot(cb: (msg: SnapshotMessage) => Promise<void>): void;
  peers(): P2pPeerInfo[];
  stop(): Promise<void>;
}

export interface P2pOptions {
  listenPort?: number;
  bootstrapAddrs?: string[];
  enableMdns?: boolean;
  whitelist?: Set<string>;
}

export async function startP2p(opts: P2pOptions = {}): Promise<P2pHandle> {
  const listenPort = opts.listenPort ?? 4001;
  const whitelist = opts.whitelist ?? new Set<string>();
  const bootstrapAddrs = opts.bootstrapAddrs ?? [];
  const enableMdns = opts.enableMdns ?? false;

  const discovery = [];
  if (enableMdns) discovery.push(mdns());
  if (bootstrapAddrs.length) {
    discovery.push(
      bootstrap({
        list: bootstrapAddrs,
        timeout: 30_000,
      }),
    );
  }

  const node: Libp2p = await createLibp2p({
    addresses: { listen: [`/ip4/0.0.0.0/tcp/${listenPort}`] },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    peerDiscovery: discovery,
    services: {
      identify: identify(),
      pubsub: gossipsub({ allowPublishToZeroTopicPeers: true }),
    },
  });

  const pubsub = node.services.pubsub as PubSub;

  const handle: P2pHandle = {
    peerId: node.peerId.toString(),
    addresses: node.getMultiaddrs().map((a) => a.toString()),

    async broadcast(msg) {
      const full: SnapshotMessage = {
        v: 1,
        sender: node.peerId.toString(),
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
          return; // 非法消息忽略
        }
        if (msg.v !== 1) return;
        // 白名单：来源必须命中（白名单空 = 拒绝所有外部消息）
        if (!whitelist.has(msg.sender)) return;
        void cb(msg);
      });
    },

    peers() {
      return node.getPeers().map((p) => ({
        peer_id: p.toString(),
        addr: null,
        connected: true,
      }));
    },

    async stop() {
      await node.stop();
    },
  };

  return handle;
}
