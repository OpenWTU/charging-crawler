"""抓取编排：从 token 池轮换取 token，先区域快照再端口状态；worker 单循环。

不变量：
* 一轮 = ``refresh_round``：先 ``server_refresh_once`` 再 ``sync_ports``，同一把
  REFRESH_LOCK 串行，worker 与 /api/refresh 手动刷新共用；
* token 候选最多 TOKEN_TRY_LIMIT 个，认证失败标记失效并换下一个，只重试失败区域；
* 结果串形如 ``areas=ok:3|ports=ok:10/160``，任一段带 ``fail:`` 则整轮不算成功
  （:func:`_round_ok`）；
* worker 每 WORKER_INTERVAL 秒跑一轮，并清理 90 天前的历史数据。
"""

from __future__ import annotations

import sys
import threading
import time

from .config import REFRESH_LOCK, WORKER_INTERVAL, WORKER_STATE, now_str
from .ports import sync_ports
from .security import decrypt_token
from .snapshots import store_snapshot
from .store import split_valid_areas
from .tokens import _is_auth_error, _mark_pool_error, _pick_token


def server_refresh_once(conn, lock) -> str:
    """从 token 池取候选（最多 3 个）逐个尝试；认证失败标记失效，其它失败换下一个。

    H1：区域逐区校验，未知区/不守恒区只跳过本区并计入 skipped，全部区非法才算失败；
    H4：单个区域请求失败计入 fail，并换下一个候选只重试失败区域；
        结果里带 fail 时 round 不算成功（由 _round_ok 判定）。
    """
    candidates = _pick_token(conn, lock)
    if not candidates:
        return "no-token"
    from crawler.api import call

    def _unique_by_name(areas):
        """平台若返回同名区域，只保留第一个，避免被误判成“客户端重复提交”。"""
        seen: set = set()
        out: list = []
        for item in areas:
            if item["name"] in seen:
                continue
            seen.add(item["name"])
            out.append(item)
        return out

    collected: dict = {}          # area_id -> area dict（跨候选去重）
    skipped_map: dict = {}        # area_name -> reason
    failed: dict = {}             # area_id -> area_name（仍失败）
    retry_ids: set = set()
    last = "no-token"
    uid = ""
    project = ""
    for pool_id, uid, enc, _exp in candidates:
        try:
            token = decrypt_token(enc)
        except Exception as exc:
            # H2：解密失败只记 last_error，不把 token 置过期，保留修复密钥后恢复的可能。
            _mark_pool_error(conn, lock, pool_id, uid,
                             f"decrypt-fail: {exc}", expire=False)
            last = "decrypt-fail"
            continue
        area_list: list = []
        attempt_failed: list = []
        try:
            user = call("user/userInfo", token=token, user_id=uid)
            data = user.get("data") or {}
            project_id = data.get("projectId")
            if not project_id:
                last = "no-project"
                continue
            project = data.get("projectName") or ""
            area_list = call("nearArea/list", {"projectId": project_id},
                             token=token, user_id=uid).get("data") or []
            if retry_ids:
                area_list = [a for a in area_list
                             if str(a.get("id")) in retry_ids]
            if not area_list:
                last = "empty"
                continue
            for a in area_list:
                aid = str(a.get("id"))
                try:
                    st = call("nearArea/" + aid, {"isNearBy": "Y"},
                              token=token, user_id=uid).get("data")
                    time.sleep(0.25)
                    if not st:
                        attempt_failed.append(a)
                        continue
                    st = st[0] if isinstance(st, list) and st else st
                    collected[aid] = {
                        "id": aid, "name": a.get("areaName") or aid,
                        "address": st.get("address", ""),
                        "total_port": int(st.get("totalPort") or 0),
                        "idle_port": int(st.get("idlePort") or 0),
                        "charging_port": int(st.get("chargingPort") or 0),
                        "fault_port": int(st.get("faultPort") or 0),
                    }
                    failed.pop(aid, None)
                except Exception as exc:
                    if _is_auth_error(exc):
                        raise
                    attempt_failed.append(a)
        except Exception as exc:
            if _is_auth_error(exc):
                _mark_pool_error(conn, lock, pool_id, uid,
                                 f"auth-expired: {exc}")
                last = "auth-expired"
                # 认证中途失效：下个候选只补还没抓到的区域
                retry_ids = {str(a.get("id")) for a in area_list} - set(collected)
                continue
            last = "error:%s" % exc
            continue
        with lock:
            valid_now, skipped_now, _dup = split_valid_areas(
                conn, _unique_by_name(list(collected.values())))
        collected = {str(a["id"]): a for a in valid_now}
        for name, reason in skipped_now:
            skipped_map[name] = reason
        for a in attempt_failed:
            failed[str(a.get("id"))] = a.get("areaName") or str(a.get("id"))
        retry_ids = set(failed)
        if not retry_ids:
            break
        last = "fail:%d" % len(retry_ids)
    with lock:
        valid_areas, _skipped_final, _dup = split_valid_areas(
            conn, _unique_by_name(list(collected.values())))
    if not valid_areas:
        if skipped_map:
            return "no-valid-area:%d" % len(skipped_map)
        if failed:
            return last if last.startswith("fail:") else \
                "fail:%d" % len(failed)
        return last
    try:
        store_snapshot(conn, lock, {
            "captured_at": now_str(), "project": project, "app_version": "server",
            "token_user": uid, "areas": valid_areas,
        }, "server")
    except Exception as exc:
        sys.stderr.write(f"[refresh] 入库失败: {exc!r}\n")
        return "store-error"
    parts = ["ok:%d" % len(valid_areas)]
    if skipped_map:
        parts.append("skipped:%d" % len(skipped_map))
    if failed:
        parts.append("fail:%d" % len(failed))
    return " ".join(parts)


def refresh_round(conn, lock) -> str:
    """一轮完整刷新：先区域快照再端口状态（worker / 手动刷新共用）。

    返回形如 "areas=ok:3|ports=ok:10/160" 的字符串，便于写 worker_runs 与展示。
    """
    if not REFRESH_LOCK.acquire(blocking=False):
        return "skip:busy"
    try:
        areas = server_refresh_once(conn, lock)
        ports = sync_ports(conn, lock)
        return f"areas={areas}|ports={ports}"
    finally:
        REFRESH_LOCK.release()


def refresh_locked(conn, lock) -> str:
    """兼容入口：只抓区域快照（保留给旧脚本），worker 用 refresh_round。"""
    if not REFRESH_LOCK.acquire(blocking=False):
        return "skip:busy"
    try:
        return server_refresh_once(conn, lock)
    finally:
        REFRESH_LOCK.release()


def _round_ok(result: str) -> bool:
    """H4：任一段带 fail: 就整轮不算成功；至少要有一段以 ok 开头。"""
    saw_ok = False
    for part in str(result).split("|"):
        _key, _sep, value = part.partition("=")
        if "fail:" in value:
            return False
        if value.startswith("ok"):
            saw_ok = True
    return saw_ok


def worker_round(httpd) -> str:
    """执行一轮刷新并记录 worker 状态 / worker_runs / 历史清理。"""
    conn = httpd.RequestHandlerClass.db
    result = refresh_round(conn, httpd.db_lock)
    WORKER_STATE["last_run"] = now_str()
    WORKER_STATE["last_result"] = result
    WORKER_STATE["runs"] = int(WORKER_STATE.get("runs") or 0) + 1
    with httpd.db_lock:
        conn.execute("INSERT INTO worker_runs(ts, result) VALUES (?,?)",
                     (now_str(), result))
        conn.execute("DELETE FROM worker_runs WHERE id < "
                     "(SELECT MAX(id) - 500 FROM worker_runs)")
        cutoff = time.strftime("%Y-%m-%d %H:%M:%S",
                               time.localtime(time.time() - 90 * 86400))
        conn.execute("DELETE FROM area_samples WHERE received_at < ?", (cutoff,))
        conn.execute("DELETE FROM snapshots WHERE received_at < ?", (cutoff,))
        conn.execute("DELETE FROM pile_samples WHERE ts < ?", (cutoff,))
        conn.execute("DELETE FROM upload_audit WHERE ts < ?", (cutoff,))
        conn.commit()
    sys.stderr.write(f"[worker] {now_str()} {result}\n")
    return result


def start_worker(httpd) -> threading.Thread:
    """单一循环：每 WORKER_INTERVAL 秒跑一轮（先区域后端口），启动后先跑一轮。"""
    def loop():
        WORKER_STATE["started_at"] = now_str()
        while True:
            try:
                worker_round(httpd)
            except Exception as exc:
                sys.stderr.write(f"[worker] 异常: {exc!r}\n")
            time.sleep(WORKER_INTERVAL)

    t = threading.Thread(target=loop, name="refresh-worker", daemon=True)
    t.start()
    return t
