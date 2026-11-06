/**
 * 平台 API 签名（复刻 crawler/sign.py，即快充 H5 前端 $base.getMd5hash）。
 *
 * 算法：
 *   parts = token ? [url尾部, userId, token, appid, 时间戳前9位, 随机串]
 *                 : [url尾部, 时间戳前9位, 随机串]
 *   按长度降序稳定排序 → 第 2 个与最后一个互换 → 拼接 → MD5 小写 hex
 *
 * ⚠️ 与 Python 逐字节一致（有对拍测试固化）。
 */
import { createHash, randomBytes } from 'node:crypto';

export const SIGN_MARK = 'quickuser50';
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

export function createRandomSeq(length = 16): string {
  let s = '';
  for (let i = 0; i < length; i += 1) {
    // rejection sampling：拒绝 ≥248 的字节，让 0..247 均匀（248 = 4×62），消除取模偏置
    let b = randomBytes(1)[0]!;
    while (b >= 248) b = randomBytes(1)[0]!;
    s += ALPHABET[b % ALPHABET.length]!;
  }
  return s;
}

/** 按长度降序稳定排序；若 ≥3 个元素，第 2 个与最后一个互换 */
export function joinByLengthDesc(parts: string[]): string {
  const ordered = [...parts].sort((a, b) => b.length - a.length); // 降序稳定
  if (ordered.length >= 3) {
    const tmp = ordered[1]!;
    ordered[1] = ordered[ordered.length - 1]!;
    ordered[ordered.length - 1] = tmp;
  }
  return ordered.join('');
}

export function computeSignature(
  tail: string,
  userId: string,
  token: string,
  appid: string,
  ts9: string,
  seq: string,
): string {
  const parts = token ? [tail, userId, token, appid, ts9, seq] : [tail, ts9, seq];
  // lgtm[js/weak-cryptographic-algorithm]：平台签名算法必须 MD5（与 Python crawler/sign.py 逐字节对拍）
  return createHash('md5').update(joinByLengthDesc(parts), 'utf8').digest('hex');
}

export interface SignHeaders {
  'content-type': string;
  'X-Timestamp': string;
  'X-Signature': string;
  'X-seq': string;
  'X-AppID': string;
  Authorization?: string;
}

export function buildHeaders(
  fullUrl: string,
  userId: string,
  token: string,
  appid: string,
  seq?: string,
  tsMs?: string,
): SignHeaders {
  const idx = fullUrl.indexOf(SIGN_MARK);
  if (idx === -1) throw new Error(`URL 中没有 ${SIGN_MARK}: ${fullUrl}`);
  const tail = fullUrl.slice(idx + SIGN_MARK.length);
  const ts = tsMs ?? String(Date.now());
  const s = seq ?? createRandomSeq();
  const sig = computeSignature(tail, userId, token, appid, ts.slice(0, 9), s);
  const headers: SignHeaders = {
    'content-type': 'application/x-www-form-urlencoded',
    'X-Timestamp': ts,
    'X-Signature': sig,
    'X-seq': s,
    'X-AppID': appid,
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}
