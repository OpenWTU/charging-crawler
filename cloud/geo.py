"""地理计算：区域稳定 ID、坐标解析、球面距离。

不变量：纯函数，无状态、无 IO；坐标非法一律返回 None 而不是抛异常。
"""

from __future__ import annotations

import hashlib
import math


def area_id_for_name(name: str) -> str:
    """区域稳定 ID：md5(name) 前 16 位，跨库/重启不变。"""
    return hashlib.md5(name.encode("utf-8")).hexdigest()[:16]


EARTH_RADIUS_M = 6371000.0


def parse_coord(value: object, low: float, high: float) -> float | None:
    """解析坐标：数字或数字字符串，超出 [low, high] 返回 None。"""
    if isinstance(value, bool):
        return None
    try:
        if isinstance(value, (int, float)):
            num = float(value)
        elif isinstance(value, str):
            text = value.strip()
            if not text:
                return None
            num = float(text)
        else:
            return None
    except (TypeError, ValueError, OverflowError):
        return None
    if not math.isfinite(num) or not (low <= num <= high):
        return None
    return num


def haversine_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """两点球面距离（米），WGS84 坐标用平均地球半径即可。"""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dlat = p2 - p1
    dlng = math.radians(lng2 - lng1)
    a = (math.sin(dlat / 2) ** 2
         + math.cos(p1) * math.cos(p2) * math.sin(dlng / 2) ** 2)
    return 2 * EARTH_RADIUS_M * math.asin(min(1.0, math.sqrt(a)))
