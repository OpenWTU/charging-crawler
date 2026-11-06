/**
 * P2P 测试：节点生命周期 + 两节点广播/订阅（白名单内）。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startP2p, type SnapshotMessage } from '../src/domain/p2p.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charge-p2p-test-'));

describe('P2P 节点生命周期', () => {
  it('能启动并停止（有 peerId）', async () => {
    const port = 42000 + Math.floor(Math.random() * 1000);
    const h = await startP2p({ listenPort: port, keyFile: path.join(tmpDir, 'k1') });
    expect(h.peerId).toBeTruthy();
    expect(h.addresses.length).toBeGreaterThan(0);
    await h.stop();
  }, 30_000);
});

describe('两节点广播/订阅', () => {
  it('白名单内节点能收到广播', async () => {
    const portA = 43100 + Math.floor(Math.random() * 500);
    const portB = 43600 + Math.floor(Math.random() * 500);
    const keyA = path.join(tmpDir, 'ka');
    const keyB = path.join(tmpDir, 'kb');

    const a = await startP2p({ listenPort: portA, keyFile: keyA, whitelist: new Set() });
    const b = await startP2p({
      listenPort: portB,
      keyFile: keyB,
      whitelist: new Set([a.peerId]), // B 只信任 A
    });

    const received: SnapshotMessage[] = [];
    b.onSnapshot(async (msg) => {
      received.push(msg);
    });

    // B 显式 dial A（比 bootstrap 更快更可控）
    await b.dial(`/ip4/127.0.0.1/tcp/${portA}/p2p/${a.peerId}`);

    // 等 gossipsub mesh 建立（subscribe 传播）
    await sleep(4000);

    await a.broadcast({
      ts: '2026-11-06 00:00:00',
      body_sha256: 'e2e-test-sha',
      payload: { project: 'p2p-test', app_version: '0', areas: [] },
    });

    // 等消息传播（轮询）
    for (let i = 0; i < 20; i += 1) {
      await sleep(500);
      if (received.length > 0) break;
    }

    expect(received.length).toBeGreaterThan(0);
    expect(received[0]!.sender).toBe(a.peerId);
    expect(received[0]!.body_sha256).toBe('e2e-test-sha');

    await a.stop();
    await b.stop();
  }, 90_000);
});
