"""App 上传的 JWT 解析 + token 池（多 token 轮换的唯一来源）。

不变量：
* token_pool 里存的是加密串（v1: AES-GCM），``tokens`` 表只做兼容镜像；
* :func:`_pick_token` 返回未过期候选，``decrypt-fail`` 的坏 token 排到最后；
* 认证类错误（AuthExpired / HTTP 401）用 :func:`_mark_pool_error` 置过期，
  解密失败只记 last_error、不置过期（保留修好密钥后恢复的可能）。
"""

from __future__ import annotations

import base64
import json
import sqlite3
import time

from .config import TOKEN_LONG_LIVED_SECONDS, TOKEN_TRY_LIMIT, now_str


def parse_token(token: str):
    """解析 App 上传的 JWT，返回 (user_id, expires_at) 或 None。"""
    try:
        parts = token.split(".")
        if len(parts) != 3:
            return None
        pad = "=" * (-len(parts[1]) % 4)
        payload = json.loads(base64.urlsafe_b64decode(parts[1] + pad))
        if payload.get("aud") != "quick_user_api":
            return None
        exp = int(payload.get("exp") or 0)
        uid = base64.b64decode(payload.get("encryId") or "").decode("utf-8")
        if not uid or exp <= time.time() or exp > time.time() + 7200:
            return None
        return uid, exp
    except Exception:
        return None


def _pool_upsert(conn: sqlite3.Connection, user_id: str, enc: str, exp: int,
                 source: str = "upload") -> int:
    """写入 token 池：同 user_id 覆盖更新，否则新增；新写入清空 last_error。"""
    stamp = now_str()
    row = conn.execute(
        "SELECT id FROM token_pool WHERE user_id = ? "
        "ORDER BY expires_at DESC LIMIT 1", (user_id,)).fetchone()
    if row:
        conn.execute(
            "UPDATE token_pool SET token = ?, expires_at = ?, updated_at = ?, "
            "source = ?, last_error = NULL WHERE id = ?",
            (enc, int(exp), stamp, source, row[0]))
        return int(row[0])
    cur = conn.execute(
        "INSERT INTO token_pool(user_id, token, expires_at, updated_at, source, "
        "last_error) VALUES (?,?,?,?,?,NULL)",
        (user_id, enc, int(exp), stamp, source))
    return int(cur.lastrowid or 0)


def _mark_pool_error(conn: sqlite3.Connection, lock, pool_id: int, user_id: str,
                     message: str, *, expire: bool = True) -> None:
    """标记某个 token 的 last_error；expire=True 时同时置为已过期（不再被选中）。

    兼容表 tokens 同 user_id 同步置过期，保证 /admin/api/summary 与池一致。
    """
    stamp = now_str()
    detail = str(message or "")[:200]
    with lock:
        if expire:
            conn.execute(
                "UPDATE token_pool SET last_error = ?, updated_at = ?, expires_at = 0 "
                "WHERE id = ?", (detail, stamp, pool_id))
            conn.execute(
                "UPDATE tokens SET expires_at = 0 WHERE user_id = ? AND expires_at > 0",
                (user_id,))
        else:
            conn.execute(
                "UPDATE token_pool SET last_error = ?, updated_at = ? WHERE id = ?",
                (detail, stamp, pool_id))
        conn.commit()


def _pick_token(conn: sqlite3.Connection, lock, limit: int = TOKEN_TRY_LIMIT) -> list:
    """从 token_pool 取未过期 token，按 expires_at DESC 返回多个候选。

    H2：曾经解密失败的 token（last_error 以 decrypt-fail 开头）不删除、不过期，
    但排在健康 token 之后，避免坏 token 长期占满 3 个候选位。
    """
    with lock:
        return conn.execute(
            "SELECT id, user_id, token, expires_at FROM token_pool "
            "WHERE expires_at > ? "
            "ORDER BY (last_error LIKE 'decrypt-fail%') ASC, expires_at DESC "
            "LIMIT ?",
            (int(time.time()), int(limit))).fetchall()


def token_pool_stats(conn: sqlite3.Connection, lock) -> dict:
    """池健康：总数 / 有效数 / 最早到期（覆盖到何时）/ 长寿命数。"""
    now_ts = int(time.time())
    with lock:
        rows = conn.execute("SELECT expires_at FROM token_pool").fetchall()
    exps = [int(r[0] or 0) for r in rows]
    valid = [e for e in exps if e > now_ts]
    earliest = min(valid) if valid else None
    return {
        "count": len(exps),
        "valid": len(valid),
        "earliest_exp": earliest,
        # cover_until 与 earliest_exp 同值：有效 token 最早到期即数据最多覆盖到何时。
        "cover_until": earliest,
        "long_lived": sum(1 for e in valid
                          if e - now_ts > TOKEN_LONG_LIVED_SECONDS),
    }


def _is_auth_error(exc: BaseException) -> bool:
    """平台登录态失效：crawler.api.AuthExpired 或 HTTP 401。"""
    try:
        from crawler.api import AuthExpired
    except Exception:
        AuthExpired = ()  # type: ignore[assignment]
    if AuthExpired and isinstance(exc, AuthExpired):
        return True
    return getattr(exc, "code", None) == 401


def _active_tokens(conn: sqlite3.Connection, lock, limit: int = 5) -> list:
    with lock:
        return conn.execute(
            "SELECT user_id, token FROM token_pool WHERE expires_at > ? "
            "ORDER BY expires_at DESC LIMIT ?",
            (int(time.time()), limit)).fetchall()


def _expire_token(conn: sqlite3.Connection, lock, user_id: str) -> None:
    """把某个用户的 token 置为过期（池 + 兼容表），供脚本复用。"""
    with lock:
        conn.execute("UPDATE token_pool SET expires_at = 0 WHERE user_id = ?",
                     (user_id,))
        conn.execute("UPDATE tokens SET expires_at = 0 WHERE user_id = ?",
                     (user_id,))
        conn.commit()
