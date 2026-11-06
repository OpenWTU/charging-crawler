/**
 * 平台签名对拍固化：Node 实现 vs crawler/sign.py 生成的向量。
 * 锁定 MD5 签名算法逐字节一致（服务端 worker 抓平台数据的凭证）。
 */
import { describe, it, expect } from 'vitest';
import { computeSignature, joinByLengthDesc } from '../src/domain/sign.js';

describe('joinByLengthDesc（长度降序 + 第2与最后互换）', () => {
  it('5 元素', () => {
    expect(joinByLengthDesc(['a', 'bbbb', 'cc', 'ddddd', 'e'])).toBe('dddddeccabbbb');
  });

  it('3 元素', () => {
    expect(joinByLengthDesc(['x', 'yyy', 'z'])).toBe('yyyzx');
  });
});

describe('computeSignature（MD5 小写 hex，与 Python 一致）', () => {
  const cases: Array<[string, string, string, string, string, string, string]> = [
    [
      '/nearArea/xxx?isNearBy=Y', '10001', 'eyJhbGciOiJIUzI1NiJ9.abc.def', 'wx123',
      '170000000', 'abc123XYZ7890abc', 'eeb41c6a98a4fb42eef1605be2378c33',
    ],
    [
      '/nearArea/list?projectId=1', '10001', 'eyJhbGciOiJIUzI1NiJ9.abc.def', 'wx123',
      '170000000', 'abc123XYZ7890abc', '4c5f548216232c1d1bdee6c1b53f22d6',
    ],
    [
      '/charge/ports?fromType=3', '10001', '', 'wx123',
      '170000000', 'short', '858d4223e3e4fd43db8e8b49d2e3affa',
    ],
    [
      '/user/userInfo', '', 'tok', '',
      '999999999', 'a'.repeat(16), 'e137acda6c03072b5b52606026410688',
    ],
  ];

  for (const [tail, uid, token, appid, ts9, seq, want] of cases) {
    it(`${tail}`, () => {
      expect(computeSignature(tail, uid, token, appid, ts9, seq)).toBe(want);
    });
  }
});
