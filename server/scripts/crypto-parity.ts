/**
 * 密码学对拍：Node 实现 vs Python 生成的向量（gen-crypto-vectors.py）。
 *
 * 验证三项：
 *  1. AES-256-GCM（固定 key+nonce）的 ct 与 tag 逐字节一致
 *  2. HMAC-SHA256 设备签名一致
 *  3. "v1:" 密文解密还原
 *
 * 用法：先 `python gen-crypto-vectors.py`，再 `npx tsx scripts/crypto-parity.ts`。
 */
import { readFileSync } from 'node:fs';
import {
  aesGcmEncrypt,
  aesGcmDecrypt,
  deviceSignature,
} from '../src/domain/crypto.js';

const here = new URL('.', import.meta.url);
const v = JSON.parse(
  readFileSync(new URL('./crypto-vectors.json', import.meta.url), 'utf8'),
);

const key = Buffer.from(v.key_hex, 'hex');
const nonce = Buffer.from(v.nonce_hex, 'hex');
const plaintext = Buffer.from(v.plaintext_utf8, 'utf8');

let failed = 0;
function check(label: string, got: string, want: string): void {
  const ok = got === want;
  if (!ok) failed += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok ? '' : `\n      got  ${got}\n      want ${want}`}`);
}

console.log('=== 密码学对拍（Python 向量 vs Node）===');

// 1. AES-GCM 固定 nonce
const { ct, tag } = aesGcmEncrypt(key, nonce, plaintext);
check('AES-GCM ct ', ct.toString('hex'), v.ct_hex);
check('AES-GCM tag', tag.toString('hex'), v.tag_hex);

// 2. HMAC 设备签名
const sig = deviceSignature(
  v.hmac.secret,
  v.hmac.ts,
  v.hmac.nonce,
  Buffer.from(v.hmac.body_base64, 'base64'),
);
check('HMAC-SHA256', sig, v.hmac.sig_hex);

// 3. 解密 "v1:" 完整密文
const full = v.encrypt_token_full as string;
const raw = Buffer.from(full.slice(3), 'base64');
const n = raw.subarray(0, 12);
const body = raw.subarray(12);
const t = body.subarray(body.length - 16);
const c = body.subarray(0, body.length - 16);
const dec = aesGcmDecrypt(key, n, c, t).toString('utf8');
check('decrypt    ', dec, v.plaintext_utf8);

// 4. 往返自洽（随机 nonce）
const randNonce = Buffer.from('0f0e0d0c0b0a09080706050403020100', 'hex');
const enc2 = aesGcmEncrypt(key, randNonce, plaintext);
const dec2 = aesGcmDecrypt(key, randNonce, enc2.ct, enc2.tag).toString('utf8');
check('round-trip ', dec2, v.plaintext_utf8);

console.log(failed === 0 ? '\n全部一致 ✓' : `\n${failed} 项不一致 ✗`);
process.exitCode = failed === 0 ? 0 : 1;
