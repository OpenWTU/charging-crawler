"""快照校验与入库：上传 payload 白名单校验 + 服务端抓取快照落库。

不变量：
* :func:`validate_payload` 只保留白名单字段并做长度/取值校验，多一个字段都不透传；
* :func:`store_snapshot` 30 分钟内按 body_sha256 去重（同一份数据不重复入库），
  单事务写 snapshots + area_samples；写成功后才让预测缓存失效。
"""

from __future__ import annotations

import hashlib
import json
import time

from .config import now_str
from .prediction import invalidate_prediction_cache
from .store import split_valid_areas, upsert_area


def validate_payload(obj: object) -> dict:
    if not isinstance(obj, dict):
        raise ValueError("payload 不是对象")
    areas = obj.get("areas")
    if not isinstance(areas, list) or not areas or len(areas) > 500:
        raise ValueError("areas 缺失或数量异常")
    clean_areas = []
    for a in areas:
        if not isinstance(a, dict):
            raise ValueError("area 不是对象")
        name = a.get("name")
        if not isinstance(name, str) or not name.strip():
            raise ValueError("area.name 非法")
        item = {"name": name.strip()[:80]}
        for key in ("id", "address"):
            if isinstance(a.get(key), str):
                item[key] = a[key][:200]
        for key in ("total_port", "idle_port", "charging_port", "fault_port"):
            v = a.get(key)
            if not isinstance(v, int) or v < 0 or v > 10000:
                raise ValueError(f"area.{key} 非法")
            item[key] = v
        clean_areas.append(item)
    return {
        "captured_at": str(obj.get("captured_at") or "")[:32],
        "project": str(obj.get("project") or "")[:80],
        "app_version": str(obj.get("app_version") or "")[:32],
        "token_user": str(obj.get("token_user") or "")[:40],
        "areas": clean_areas,
    }


def store_snapshot(conn, lock, payload: dict, source: str) -> int:
    cutoff = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(time.time() - 1800))
    with lock:
        # H1：调用方通常已过滤；这里兜底再拆一次，全部非法才失败。
        valid_areas, _skipped, _duplicate = split_valid_areas(conn, payload["areas"])
        if not valid_areas:
            raise ValueError("没有可用区域")
        payload = {**payload, "areas": valid_areas}
        stable = {k: v for k, v in payload.items() if k != "captured_at"}
        raw = json.dumps(stable, ensure_ascii=False, sort_keys=True).encode()
        digest = hashlib.sha256(raw).hexdigest()
        dup = conn.execute(
            "SELECT id FROM snapshots WHERE body_sha256 = ? AND received_at >= ? "
            "ORDER BY id DESC LIMIT 1", (digest, cutoff)).fetchone()
        if dup:
            return int(dup[0])
        # 单事务：快照 + 区域样本 + 区域登记，仅一次 commit
        with conn:
            cur = conn.execute(
                """INSERT INTO snapshots(received_at, captured_at, project,
                                         app_version, token_user, client_ip,
                                         body_sha256, payload)
                   VALUES (?,?,?,?,?,?,?,?)""",
                (now_str(), payload.get("captured_at", ""),
                 payload.get("project", ""),
                 payload.get("app_version", "server"),
                 payload.get("token_user", ""), source, digest,
                 json.dumps(payload, ensure_ascii=False)))
            rid = cur.lastrowid
            stamp = now_str()
            conn.executemany(
                """INSERT INTO area_samples(snapshot_id, area_id, area_name, idle,
                                            total, charging, fault, received_at)
                   VALUES (?,?,?,?,?,?,?,?)""",
                [(rid, upsert_area(conn, a["name"]), a["name"], a["idle_port"],
                  a["total_port"], a["charging_port"], a["fault_port"], stamp)
                 for a in payload["areas"]])
    invalidate_prediction_cache()
    return rid
