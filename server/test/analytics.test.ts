/**
 * pyRound 必须与 Python 的 round() 完全一致 —— 这是 /api/analytics 对拍的前提。
 *
 * Python 的 round 跟随**二进制浮点真实值**，不是十进制字面值：
 *   0.1625 存为 0.16250000000000000555 → round(.,3) = 0.163
 *   0.0375 存为 0.03749999999999999861 → round(.,3) = 0.037
 * 这两例是最容易被"先抹平再舍入"实现搞错的地方。
 */
import { describe, it, expect } from 'vitest';
import { pyRound } from '../src/domain/analytics.js';

describe('pyRound 对齐 Python round()', () => {
  it('浮点真实值略大于一半时进位（26/160）', () => {
    // 26/160 = 0.1625，二进制存为 0.16250000000000000555
    expect(pyRound(26 / 160, 3)).toBe(0.163);
  });

  it('浮点真实值略小于一半时舍去（3/80）', () => {
    // 3/80 = 0.0375，二进制存为 0.03749999999999999861
    expect(pyRound(3 / 80, 3)).toBe(0.037);
  });

  it('正好一半且末位为偶数 → 不进位（银行家舍入）', () => {
    // 0.125 可被二进制精确表示，属于真正的"正好一半"
    expect(pyRound(0.125, 2)).toBe(0.12);
  });

  it('正好一半且末位为奇数 → 进位（银行家舍入）', () => {
    expect(pyRound(0.135, 2)).toBe(0.14);
  });

  it('普通舍入与进位', () => {
    expect(pyRound(1 / 3, 4)).toBe(0.3333);
    expect(pyRound(2 / 3, 3)).toBe(0.667);
    expect(pyRound(0.5, 0)).toBe(0); // 0.5 正好一半，取偶 → 0
    expect(pyRound(1.5, 0)).toBe(2); // 1.5 正好一半，取偶 → 2
  });

  it('无需舍入时原值返回', () => {
    expect(pyRound(0.25, 3)).toBe(0.25);
    expect(pyRound(7, 2)).toBe(7);
  });

  it('负数与整数值', () => {
    expect(pyRound(-0.1625, 3)).toBe(-0.163);
    expect(pyRound(-3 / 80, 3)).toBe(-0.037);
    expect(pyRound(0, 3)).toBe(0);
  });

  it('非有限值原样返回', () => {
    expect(pyRound(Number.NaN, 2)).toBeNaN();
    expect(pyRound(Number.POSITIVE_INFINITY, 2)).toBe(Number.POSITIVE_INFINITY);
  });
});
