/**
 * 地理计算（与 `cloud/geo.py` 一致）。
 * 纯函数、无 IO；坐标非法一律返回 null 而不是抛异常。
 */

export const EARTH_RADIUS_M = 6371000.0;

/** 解析坐标：数字或数字字符串，超出 [low, high] 返回 null */
export function parseCoord(value: unknown, low: number, high: number): number | null {
  if (typeof value === 'boolean') return null;
  let num: number;
  if (typeof value === 'number') {
    num = value;
  } else if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return null;
    num = Number(text);
  } else {
    return null;
  }
  if (!Number.isFinite(num) || num < low || num > high) return null;
  return num;
}

/** 两点球面距离（米），WGS84 坐标用平均地球半径即可 */
export function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const p1 = (lat1 * Math.PI) / 180;
  const p2 = (lat2 * Math.PI) / 180;
  const dlat = p2 - p1;
  const dlng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dlat / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dlng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1.0, Math.sqrt(a)));
}
