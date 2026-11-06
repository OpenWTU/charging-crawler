/**
 * 密码学对拍固化测试：Node 实现 vs Python 生成的固定向量。
 *
 * 向量由 `scripts/gen-crypto-vectors.py` 生成（cloud/security.py 的 AES-256-GCM
 * 与 HMAC-SHA256 实现），这里把结果硬编码，锁死「Node 实现逐字节一致」。
 * 若未来 Node 或 Python 任一侧改动，此测试会立刻红。
 */
import { describe, it, expect } from 'vitest';
import { aesGcmEncrypt, aesGcmDecrypt, deviceSignature } from '../src/domain/crypto.js';

const KEY = Buffer.from('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f', 'hex');
const NONCE = Buffer.from('000102030405060708090a0b', 'hex');
const PLAINTEXT = Buffer.from('测试token:eyJhbGciOiJIUzI1NiJ9.payload.signature', 'utf8');

const CT_HEX =
  'a1b75df36a70b674e624f9b1d4903205e191e45dbf1215356d1dacb453004a8b2f60cf85c3ae73fc5ad7168ae6e65c4d9c3c';
const TAG_HEX = '720aeea2f0e562abc9766479f24c2cc5';
const SIG_HEX = '158ed72e2e5f7a78f968a222cfaf03f1269e1f5e76043761792212d7d2be2493';
const FULL = 'v1:AQIDBAUGBwgJCgsM41/RPUMBhOknxw19dWqgQCAEgpfYBBqM9CWwFdDfPPyqlPqmAtqN+57f04Kruowo7JMJ2SJ5P5bPJELh/tpNMVv0';

describe('AES-256-GCM（与 Python AESGCM 逐字节一致）', () => {
  it('固定 key+nonce 的密文一致', () => {
    const { ct, tag } = aesGcmEncrypt(KEY, NONCE, PLAINTEXT);
    expect(ct.toString('hex')).toBe(CT_HEX);
    expect(tag.toString('hex')).toBe(TAG_HEX);
  });

  it('解密 "v1:" 密文还原明文', () => {
    const raw = Buffer.from(FULL.slice(3), 'base64');
    const nonce = raw.subarray(0, 12);
    const body = raw.subarray(12);
    const tag = body.subarray(body.length - 16);
    const ct = body.subarray(0, body.length - 16);
    expect(aesGcmDecrypt(KEY, nonce, ct, tag).toString('utf8')).toBe(
      PLAINTEXT.toString('utf8'),
    );
  });

  it('往返自洽', () => {
    const { ct, tag } = aesGcmEncrypt(KEY, NONCE, PLAINTEXT);
    expect(aesGcmDecrypt(KEY, NONCE, ct, tag).toString('utf8')).toBe(
      PLAINTEXT.toString('utf8'),
    );
  });
});

describe('HMAC-SHA256 设备签名（与 Python 逐字节一致）', () => {
  it('ts\\nnonce\\nbody 的签名一致', () => {
    const body = Buffer.from(
      'eyJhcmVhcyI6W3sibmFtZSI6IjEw5qCL5a6/6IiN5qW8MeWPt+WFheeUteWMuiIsImlkbGVfcG9ydCI6MSwidG90YWxfcG9ydCI6MTB9XX0=',
      'base64',
    );
    const sig = deviceSignature('a'.repeat(64), '1700000000', 'deadbeefcafe1234', body);
    expect(sig).toBe(SIG_HEX);
  });
});
