"""端口：上传/平台数据的清洗、落库、同步与健康分组。

不变量：
* :func:`_clean_port_entries` 是上传与平台 sync 共用的唯一清洗规则（strict 供上传
  抛错、宽松供 sync 跳过脏数据），单设备端口数上限 MAX_PORTS_PER_DEVICE；
* 状态一律按精确值判断，不做子串匹配（"空闲(故障)" 不算空闲）；
* 单桩采样同一设备同一秒只保留一条（REPLACE），供单桩详情趋势使用；
* ``sync_ports`` 用一把 PORT_SYNC_LOCK 串行化，避免并发打平台接口。
"""

from __future__ import annotations

import collections
import sqlite3
import sys
import time

from .config import (
    MAX_PORT_ITEMS,
    MAX_PORTS_PER_DEVICE,
    PORT_GROUP_BUSY,
    PORT_GROUP_FREE,
    PORT_GROUP_UNAVAILABLE,
    PORT_GROUP_UNKNOWN,
    PORT_RE,
    PORT_STALE_SECONDS,
    PORT_STATUS_GROUPS,
    PORT_STATUS_MAX,
    PORT_SYNC_LOCK,
    invalidate_areas_ports_cache,
    now_str,
)
from .security import decrypt_token
from .tokens import _is_auth_error, _mark_pool_error, _pick_token


def status_group(status: object) -> str:
    """端口状态原文 -> 分组（free / busy / unavailable / unknown）。

    不变量（数据契约 v2）：无法识别或为空的状态**保留原文**，分组判为 unknown，
    不再像 v1 那样把原文改写成「其他」——原文是排查平台新状态的唯一线索。
    """
    return PORT_STATUS_GROUPS.get(str(status or "").strip(), PORT_GROUP_UNKNOWN)


def _clean_port_entries(raw: object, *, strict: bool = True) -> list[dict]:
    """清洗单个设备的端口列表，上传与 sync 共用同一套规则。

    - port 必须匹配 PORT_RE（1-8 位字母数字/下划线/连字符）；
    - 重复端口去重，保留最后一次出现的 status；
    - status 去空白后不超过 16 字符；
    - 单设备最多 MAX_PORTS_PER_DEVICE 个端口。
    strict=True（上传）遇到非法直接抛 ValueError；strict=False（平台 sync）
    跳过非法项、截断超长内容，保证平台脏数据不会打断整个同步。
    """
    if not isinstance(raw, list):
        if strict:
            raise ValueError("端口列表必须是数组")
        return []
    cleaned: "collections.OrderedDict[str, str]" = collections.OrderedDict()
    for item in raw:
        if not isinstance(item, dict):
            if strict:
                raise ValueError("端口项必须是对象")
            continue
        port = item.get("port")
        if isinstance(port, bool) or not isinstance(port, (str, int, float)):
            if strict:
                raise ValueError("port 必须是字符串")
            port = ""
        else:
            port = str(port)
        port = port.strip()
        if not PORT_RE.match(port):
            if strict:
                raise ValueError("port 非法")
            continue
        status = item.get("status")
        if status is None:
            status = ""
        elif isinstance(status, bool) or not isinstance(status, (str, int, float)):
            if strict:
                raise ValueError("status 必须是字符串")
            status = ""
        else:
            status = str(status)
        status = status.strip()
        if len(status) > PORT_STATUS_MAX:
            if strict:
                raise ValueError("status 过长")
            status = status[:PORT_STATUS_MAX]
        # 数据契约 v2：状态原文一律保留（无法识别只体现为 group="unknown"）。
        # 重复端口：先删再插，保证保留最后一次的 status
        cleaned.pop(port, None)
        cleaned[port] = status
    entries = [{"port": port, "status": status, "group": status_group(status)}
               for port, status in cleaned.items()]
    if len(entries) > MAX_PORTS_PER_DEVICE:
        if strict:
            raise ValueError("端口数量超限")
        entries = entries[:MAX_PORTS_PER_DEVICE]
    return entries


def _clean_ports(raw_ports: object, allowed_devices=None) -> list[dict]:
    """严格校验上传的 ports 字段，返回 [{device_hex, ports:[{port,status}]}]。

    ports 可缺省或为 null（视为没有端口数据）；只要出现就必须是数组，每项必须
    是对象且 device_hex 在 controllers 白名单、ports 为数组。任一不合规抛
    ValueError，调用方在写 nonce/快照/端口之前回 400 invalid_ports。
    """
    if raw_ports is None:
        return []
    if not isinstance(raw_ports, list):
        raise ValueError("ports 必须是数组")
    if len(raw_ports) > MAX_PORT_ITEMS:
        raise ValueError("ports 设备项超限")
    allowed = {str(dev).strip().upper(): str(dev).strip()
               for dev in (allowed_devices or ())}
    merged: "collections.OrderedDict[str, list]" = collections.OrderedDict()
    for item in raw_ports:
        if not isinstance(item, dict):
            raise ValueError("ports 项必须是对象")
        device = item.get("device_hex")
        if not isinstance(device, str) or not device.strip():
            raise ValueError("device_hex 非法")
        canonical = allowed.get(device.strip().upper())
        if not canonical:
            raise ValueError(f"未知设备 {device.strip()[:16]}")
        # H5：同一设备出现多个条目时合并端口，避免后者整体覆盖前者。
        merged.setdefault(canonical, []).extend(
            _clean_port_entries(item.get("ports"), strict=True))
    return [{"device_hex": dev,
             "ports": _clean_port_entries(entries, strict=True)}
            for dev, entries in merged.items()]


def status_counts(ports) -> dict:
    """逐状态计数：``{状态原文: 数量}``，供前端在端口详情里按细分状态展示。

    与 ``ports_summary`` 的四分组并行存在：分组用于快速判定"有没有空位"，
    逐状态计数用于把「充电中 / 已充满 / 浮充」这类**同一分组内的不同状态**
    分别显示出来（用户诉求：不要把它们聚合成一个"占用"）。

    空/缺失状态统一记为 ``"未知"``，未知的状态原文照旧保留在 ``ports[].status``。
    """
    out: dict = {}
    for row in ports:
        raw = str(row[1] or "").strip()
        key = raw if raw else "未知"
        out[key] = out.get(key, 0) + 1
    return out


def _ports_health(ports, updated_at):
    """端口健康：空闲/已满/不可用/无数据 + 是否过期（按分组判断，不做子串匹配）。

    state 口径（数据契约 v2）：
    * 无端口 -> unknown；
    * free > 0 -> free；
    * free == 0 且 busy > 0 -> full；
    * free == 0 且 busy == 0（全部不可用）-> unavailable。
    ``busy = total - free - unavailable``，即「无法识别」仍计入 busy，保持 v1 语义，
    避免旧客户端把陌生状态误判成「全部不可用」。
    """
    groups = [status_group(r[1]) for r in ports]
    total = len(ports)
    free = sum(1 for g in groups if g == PORT_GROUP_FREE)
    unavailable = sum(1 for g in groups if g == PORT_GROUP_UNAVAILABLE)
    unknown = sum(1 for g in groups if g == PORT_GROUP_UNKNOWN)
    busy = total - free - unavailable
    latest = max((r[2] or "" for r in ports), default=updated_at or "")
    stale = True
    if latest:
        try:
            stale = time.time() - time.mktime(
                time.strptime(latest, "%Y-%m-%d %H:%M:%S")) > PORT_STALE_SECONDS
        except Exception:
            stale = True
    if not ports:
        state, error = "unknown", "无端口数据"
    elif free:
        state, error = "free", None
    elif busy:
        state, error = "full", None
    else:
        state, error = "unavailable", None
    return {"total": total, "free": free, "busy": busy,
            "unavailable": unavailable, "unknown": unknown,
            "statuses": status_counts(ports),
            "state": state, "stale": stale,
            "online": bool(ports) and not stale, "error": error}


def ports_summary(ports) -> dict:
    """按分组汇总端口行 [(port, status, updated_at)]，供 /api/*-ports 的 summary。

    ``busy = total - free - unavailable``，即无法识别的端口仍算在 busy 里（v1 兼容），
    因此恒有 ``free + busy + unavailable == total``，而 ``unknown`` 是 busy 的子集，
    只用于让前端把「陌生状态」单独标灰。
    """
    groups = [status_group(r[1]) for r in ports]
    total = len(groups)
    free = sum(1 for g in groups if g == PORT_GROUP_FREE)
    unavailable = sum(1 for g in groups if g == PORT_GROUP_UNAVAILABLE)
    unknown = sum(1 for g in groups if g == PORT_GROUP_UNKNOWN)
    return {"free": free, "busy": total - free - unavailable,
            "unavailable": unavailable, "unknown": unknown, "total": total,
            "statuses": status_counts(ports)}


def area_port_group_counts(conn) -> dict:
    """按区域统计 (端口总数, 不可用数)，供 ``/api/now`` 的 ``unavailable_ports``。

    口径说明（数据契约 v2）：``unavailable`` 来自端口级明细，包含禁用 / 绑定 / 维护 /
    各类硬件故障，比平台的 ``faultPort``（只统计"故障"一类）更全。因此这里优先用明细；
    没有端口明细的区域不会出现在返回值里，调用方据此回退到平台 ``faultPort``。

    返回 ``{area_name: (total_ports, unavailable_ports)}``；``port_states`` 是当前态表
    （每设备每端口一行），行数在千级以内，单次 GROUP BY 开销可忽略。
    """
    rows = conn.execute(
        "SELECT c.area_name, COUNT(*), "
        "SUM(CASE WHEN p.status_group = ? THEN 1 ELSE 0 END) "
        "FROM port_states p JOIN controllers c ON c.device_hex = p.device_hex "
        "WHERE c.area_name IS NOT NULL AND c.area_name <> '' "
        "GROUP BY c.area_name", (PORT_GROUP_UNAVAILABLE,)).fetchall()
    return {str(name): (int(total), int(bad or 0))
            for name, total, bad in rows}


def area_port_state(idle: int, total: int, unavailable: int = 0) -> str:
    """区域级端口状态（``/api/now`` 的 ``port_state``），口径与 :func:`_ports_health` 对齐。

    * ``total <= 0`` -> unknown（没有端口数据）；
    * ``idle == 0 且 busy == 0`` -> unavailable（全都不可用）；
    * ``idle == 0 且 busy > 0`` -> full（满区）；
    * ``0 < idle < total`` -> busy（还有空位，但部分占用）；
    * ``idle >= total`` -> free（全空）。
    """
    total_i = max(int(total or 0), 0)
    idle_i = max(int(idle or 0), 0)
    unavail_i = max(int(unavailable or 0), 0)
    if total_i <= 0:
        return "unknown"
    busy_i = total_i - idle_i - unavail_i
    if idle_i <= 0:
        return "full" if busy_i > 0 else "unavailable"
    if idle_i >= total_i:
        return PORT_GROUP_FREE
    return PORT_GROUP_BUSY


def _pile_counts(statuses) -> tuple[int, int, int]:
    """由端口状态列表算 (free, total, busy)：只把精确“空闲”视为空闲。"""
    values = [str(s or "") for s in statuses]
    total = len(values)
    free = sum(1 for s in values if s == "空闲")
    return free, total, total - free


def _pile_unavailable(statuses) -> int:
    """不可用端口数（pile_samples.unavailable，数据契约 v2 新增列）。"""
    return sum(1 for s in statuses if status_group(s) == PORT_GROUP_UNAVAILABLE)


def record_pile_sample(conn: sqlite3.Connection, device_hex: str, ts: str,
                       statuses, online: bool = True) -> None:
    """写一条单桩采样；同一设备同一秒只保留最新一条（REPLACE）。调用方持锁。"""
    free, total, busy = _pile_counts(statuses)
    conn.execute(
        "INSERT OR REPLACE INTO pile_samples(device_hex, ts, free, total, busy, "
        "online, unavailable) VALUES (?,?,?,?,?,?,?)",
        (device_hex, ts, free, total, busy, 1 if online else 0,
         _pile_unavailable(statuses)))


def _extract_ports(data: object) -> list[dict]:
    """归一化 charge/ports 的 data，复用统一端口清洗规则（宽松模式）。"""
    if isinstance(data, list):
        if data and all(isinstance(x, dict) and isinstance(x.get("ports"), list)
                        for x in data):
            merged = []
            for x in data:
                merged.extend(x.get("ports") or [])
            return _clean_port_entries(merged, strict=False)
        return _clean_port_entries(data, strict=False)
    if not isinstance(data, dict):
        return []
    return _clean_port_entries(data.get("ports"), strict=False)


def _sync_ports_impl(conn, lock, only_devices=None) -> str:
    """同步 controllers 下每个控制器 10 个端口状态（健壮版）。

    H4：池内最多尝试 3 个候选；认证失败标记 last_error 并换下一个；
    任何非认证失败也会换下一个候选、只重试失败设备；
    最终仍失败的设备计入 fail（round 因此不算成功）。
    H2：解密失败只记录 last_error，不把 token 置过期。
    """
    from crawler.api import call
    candidates = _pick_token(conn, lock)
    if not candidates:
        return "no-token"
    with lock:
        sql = ("SELECT device_hex, code FROM controllers "
               "WHERE code IS NOT NULL AND code <> ''")
        params = []
        if only_devices:
            sql += " AND device_hex IN (%s)" % ",".join("?" * len(only_devices))
            params = list(only_devices)
        devices = conn.execute(sql, params).fetchall()
    if not devices:
        return "empty"
    remaining = list(devices)
    done: dict = {}                # device_hex -> 端口数（成功设备）
    last = "no-token"
    attempted = False
    for pool_id, uid, enc, _exp in candidates:
        if not remaining:
            break
        try:
            token = decrypt_token(enc)
        except Exception as exc:
            _mark_pool_error(conn, lock, pool_id, uid,
                             f"decrypt-fail: {exc}", expire=False)
            last = "decrypt-fail"
            continue
        attempted = True
        failed_batch: list = []
        auth_error = False
        for device_hex, code in remaining:
            try:
                r = call("charge/ports", {"fromType": 3, "deviceId": str(code)},
                         token=token, user_id=uid)
            except Exception as exc:
                if _is_auth_error(exc):
                    _mark_pool_error(conn, lock, pool_id, uid,
                                     f"auth-expired: {exc}")
                    auth_error = True
                    break
                failed_batch.append((device_hex, code))
                time.sleep(0.25)
                continue
            data = r.get("data")
            ports = [(p["port"], p["status"], p["group"])
                     for p in _extract_ports(data)]
            if not ports:
                failed_batch.append((device_hex, code))
                time.sleep(0.25)
                continue
            ts = now_str()
            try:
                with lock, conn:
                    marks = ",".join("?" * len(ports))
                    conn.execute(
                        f"DELETE FROM port_states WHERE device_hex = ? "
                        f"AND port NOT IN ({marks})",
                        [device_hex] + [p for p, _s, _g in ports])
                    for port, status, group in ports:
                        conn.execute(
                            "INSERT INTO port_states(device_hex, port, status, "
                            "status_group, updated_at) VALUES (?,?,?,?,?) "
                            "ON CONFLICT(device_hex, port) DO UPDATE SET "
                            "status=excluded.status, "
                            "status_group=excluded.status_group, "
                            "updated_at=excluded.updated_at",
                            (device_hex, port, status, group, ts))
                    conn.execute(
                        "UPDATE controllers SET updated_at = ? WHERE device_hex = ?",
                        (ts, device_hex))
                    record_pile_sample(conn, device_hex, ts,
                                       [s for _p, s, _g in ports])
            except Exception as exc:
                sys.stderr.write(f"[ports] 写库失败 {device_hex}: {exc!r}\n")
                failed_batch.append((device_hex, code))
                time.sleep(0.25)
                continue
            done[device_hex] = len(ports)
            invalidate_areas_ports_cache()
            time.sleep(0.25)
        if auth_error:
            last = "auth-expired"
            continue          # 同一个 remaining 换下一个候选重试
        remaining = failed_batch
        if not remaining:
            break
        last = "fail:%d" % len(remaining)
    total = sum(done.values())
    failed = len(remaining)
    if not done:
        if not attempted:
            return last
        if failed >= len(devices) and last in ("auth-expired", "decrypt-fail"):
            return last
        return "fail:%d" % failed
    result = "ok:%d/%d" % (len(done), total)
    if failed:
        result += " fail:%d" % failed
    return result


def sync_ports(conn, lock, only_devices=None) -> str:
    """唯一入口：懒刷新 / worker / 手动同步共用一把锁，避免并发打平台。"""
    if not PORT_SYNC_LOCK.acquire(blocking=False):
        return "busy"
    try:
        return _sync_ports_impl(conn, lock, only_devices=only_devices)
    finally:
        PORT_SYNC_LOCK.release()
