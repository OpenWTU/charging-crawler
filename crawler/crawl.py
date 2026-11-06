"""抓取编排：登录态 -> 项目信息 -> 充电区列表 -> 逐个充电区状态快照 -> 入库。

注意：
- 抓取全程持有跨进程锁（scheduler / 页面「立即抓取」不会同时跑）；
- 每个充电区单独提交，避免长时间持有 SQLite 写事务；
- 任何异常都写回 crawl_runs，便于区分「没抓」「抓了但失败」。
"""

from __future__ import annotations

import json

from . import api, db
from .token import Token


def fetch_user(token: Token, appid: str = "") -> dict:
    resp = api.call("user/userInfo", token=token.value, user_id=token.user_id, appid=appid)
    if resp.get("code") != 200:
        raise api.ApiError(f"userInfo 失败: {resp}")
    return resp["data"]


def fetch_areas(token: Token, project_id: int, appid: str = "") -> list[dict]:
    resp = api.call("nearArea/list", {"projectId": project_id}, token=token.value,
                    user_id=token.user_id, appid=appid)
    if resp.get("code") != 200:
        raise api.ApiError(f"nearArea/list 失败: {resp}")
    return resp.get("data") or []


def fetch_area_status(token: Token, area_id: str, appid: str = "") -> dict | None:
    resp = api.call(f"nearArea/{area_id}", {"isNearBy": "Y"}, token=token.value,
                    user_id=token.user_id, appid=appid)
    if resp.get("code") != 200:
        return None
    data = resp.get("data") or []
    return data[0] if data else None


def run(db_path: str, token: Token, *, appid: str = "", delay: float = 0.25,
        limit: int | None = None, project_override: int | None = None,
        verbose: bool = True) -> dict:
    with db.crawl_lock(db_path):
        conn = db.connect(db_path)
        run_id = db.start_run(conn, note=f"user={token.user_id}")
        conn.commit()
        errors: list[str] = []
        ok = 0
        try:
            try:
                user = fetch_user(token, appid)
            except api.AuthExpired:
                raise
            # 新账号可能还没绑定小区：userInfo 的 projectId 为空，此时允许用 --project 指定
            project_id = user.get("projectId") or project_override
            project_name = user.get("projectName") or ""
            if not project_id:
                raise api.ApiError("账号没有 projectId（未绑定小区），请先在 H5 里绑定，或用 --project 指定")
            db.upsert_project(conn, str(project_id), project_name,
                              user.get("gzhCompany") or "", user.get("projectPhone") or "")
            conn.commit()
            if verbose:
                print(f"账号 userId={token.user_id}  项目: {project_name or '(未知)'} (id={project_id})  "
                      f"余额: {user.get('realBalance')}")

            areas = fetch_areas(token, project_id, appid)
            if limit:
                areas = areas[:limit]
            if verbose:
                print(f"充电区: {len(areas)} 个")

            for i, area in enumerate(areas, 1):
                name = area.get("areaName") or area.get("id") or "?"
                try:
                    area_id = area.get("id")
                    if not area_id:
                        errors.append(f"{name}: 缺少 id，跳过")
                        continue
                    status = fetch_area_status(token, area_id, appid)
                    if not status:
                        errors.append(f"{name} 无状态数据")
                        continue
                    with conn:  # upsert + 快照同一事务，失败自动回滚
                        db.upsert_area(conn, area_id, str(project_id), project_name,
                                       name, status)
                        # 数据契约 v2：原始响应整包落库（raw_json），与结构化字段并存。
                        db.insert_status(conn, area_id, status,
                                         raw_json=json.dumps(status,
                                                             ensure_ascii=False))
                    ok += 1
                    if verbose:
                        print(f"  [{i}/{len(areas)}] {name}: 空闲 {status.get('idlePort')} / "
                              f"充电中 {status.get('chargingPort')} / 故障 {status.get('faultPort')} / "
                              f"总 {status.get('totalPort')}")
                except api.AuthExpired:
                    raise
                except Exception as exc:  # 单个充电区失败不中断整轮抓取
                    errors.append(f"{name}: {exc}")
                api.polite_sleep(delay)
        except api.AuthExpired:
            raise
        except Exception as exc:
            errors.append(f"fatal: {exc}")
            raise
        finally:
            try:
                db.finish_run(conn, run_id, ok, errors)
                conn.commit()
            finally:
                conn.close()
        return {"run_id": run_id, "areas_ok": ok, "errors": errors, "db": db_path}
