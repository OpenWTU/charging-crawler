/**
 * 安全原语：token 密钥与 AES-256-GCM 加解密、设备 HMAC 签名。
 *
 * ⚠️ 必须与 `cloud/security.py` 逐字节一致（P5 有跨语言对拍脚本验证）：
 *   encrypt_token  → "v1:" + base64(nonce(12) + ct + tag(16))
 *   decrypt_token  → 拆出 nonce/ct+tag，AES-256-GCM 解密，AAD=None
 *   HMAC 设备签名  → HMAC-SHA256(key=device_secret_utf8,
 *                     msg=ts + "\n" + nonce + "\n" + body).hex()
 *
 * scrypt 管理员口令哈希**刻意不移植**：管理后台已删除（设备自动审批、公开状态页），
 * 不再需要管理员登录。
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { TOKEN_KEY_FILE } from '../config.js';

/** 读取 token 主密钥（32 字节 hex）；缺失且 STRICT 时报错，否则自动生成 */
export function tokenKey(): Buffer {
  if (fs.existsSync(TOKEN_KEY_FILE)) {
    const raw = fs.readFileSync(TOKEN_KEY_FILE, 'ascii').trim();
    const key = Buffer.from(raw, 'hex');
    if (key.length !== 32) throw new Error(`token key 长度不是 32 字节: ${TOKEN_KEY_FILE}`);
    return key;
  }
  if (process.env.CHARGE_TOKEN_KEY_STRICT === '1') {
    throw new Error(`token key 缺失: ${TOKEN_KEY_FILE}（生产环境禁止自动重建）`);
  }
  const key = randomBytes(32);
  const sep = TOKEN_KEY_FILE.includes('/') ? '/' : '\\';
  const dir = TOKEN_KEY_FILE.slice(0, TOKEN_KEY_FILE.lastIndexOf(sep));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(TOKEN_KEY_FILE, key.toString('hex'), { encoding: 'ascii', mode: 0o600 });
  return key;
}

/** 纯函数：AES-256-GCM 加密，返回 {ct, tag}（供对拍注入固定 key/nonce） */
export function aesGcmEncrypt(
  key: Buffer,
  nonce: Buffer,
  plaintext: Buffer,
): { ct: Buffer; tag: Buffer } {
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ct, tag };
}

/** 纯函数：AES-256-GCM 解密 */
export function aesGcmDecrypt(key: Buffer, nonce: Buffer, ct: Buffer, tag: Buffer): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

/** 纯函数：HMAC-SHA256(key_utf8, msg)，返回小写 hex */
export function hmacSha256Hex(key: string, msg: Buffer): string {
  return createHmac('sha256', Buffer.from(key, 'utf8')).update(msg).digest('hex');
}

/** AES-256-GCM 加密 token → "v1:" + base64(nonce + ct + tag)。与 Python 一致 */
export function encryptToken(token: string): string {
  const nonce = randomBytes(12);
  const { ct, tag } = aesGcmEncrypt(tokenKey(), nonce, Buffer.from(token, 'utf8'));
  return 'v1:' + Buffer.concat([nonce, ct, tag]).toString('base64');
}

/** AES-256-GCM 解密 "v1:..." 密文；无 "v1:" 前缀则原样返回（与 Python 一致） */
export function decryptToken(stored: string): string {
  if (!stored.startsWith('v1:')) return stored;
  const raw = Buffer.from(stored.slice(3), 'base64');
  const nonce = raw.subarray(0, 12);
  const body = raw.subarray(12); // ct + tag(16)
  const tag = body.subarray(body.length - 16);
  const ct = body.subarray(0, body.length - 16);
  return aesGcmDecrypt(tokenKey(), nonce, ct, tag).toString('utf8');
}

/**
 * 设备上传签名：HMAC-SHA256(key=device_secret_utf8,
 * msg=ts + "\n" + nonce + "\n" + body)，返回小写 hex。
 * 与 Python 的 `hmac.new(secret.encode(), ts.encode()+b"\n"+nonce.encode()+b"\n"+body, sha256).hexdigest()` 一致。
 */
export function deviceSignature(secret: string, ts: string, nonce: string, body: Buffer): string {
  const msg = Buffer.concat([
    Buffer.from(ts, 'utf8'),
    Buffer.from('\n', 'utf8'),
    Buffer.from(nonce, 'utf8'),
    Buffer.from('\n', 'utf8'),
    body,
  ]);
  return hmacSha256Hex(secret, msg);
}

/** 常量（与 cloud/config.py 一致） */
export const MAX_BODY = 1000 * 1024;
export const MAX_SKEW = 600;
export const NONCE_RE = /^[A-Fa-f0-9]{16,64}$/;
