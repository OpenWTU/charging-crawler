"""安全原语：token 密钥与加解密、口令 scrypt、管理会话、限流与登录失败计数。

不变量：
* ``TOKEN_KEY_FILE`` / ``ADMIN_USER`` / ``ADMIN_PASS`` / ``ADMIN_PASS_HASH`` 从
  :mod:`cloud.config` 导入，测试会在 cloud.app 门面上重绑定这些名字（门面会把
  赋值广播回本模块），因此模块内**必须**按模块级全局变量读取，不能缓存副本；
* 会话与限流状态（SESSIONS / RATE）同样是 config 里的共享容器，调用方清空的是
  同一对象。
"""

from __future__ import annotations

import base64
import collections
import hashlib
import hmac
import os
import secrets
import sqlite3
import time
from pathlib import Path

from .config import (
    ADMIN_LOGIN_MAX_FAILS,
    ADMIN_LOGIN_WINDOW,
    ADMIN_PASS,
    ADMIN_PASS_HASH,
    ADMIN_SESSION_MAX,
    ADMIN_SESSION_TTL,
    ADMIN_USER,
    RATE,
    RATE_LOCK,
    SESSIONS,
    SESSION_LOCK,
    TOKEN_KEY_FILE,
    now_str,
)


def _token_key() -> bytes:
    p = Path(TOKEN_KEY_FILE)
    if p.exists():
        return bytes.fromhex(p.read_text(encoding="ascii").strip())
    if os.environ.get("CHARGE_TOKEN_KEY_STRICT") == "1":
        raise RuntimeError(f"token key 缺失: {p}（生产环境禁止自动重建）")
    key = os.urandom(32)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(key.hex(), encoding="ascii")
    try:
        os.chmod(p, 0o600)
    except OSError:
        pass
    return key


def encrypt_token(token: str) -> str:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    nonce = os.urandom(12)
    ct = AESGCM(_token_key()).encrypt(nonce, token.encode("utf-8"), None)
    return "v1:" + base64.b64encode(nonce + ct).decode("ascii")


def decrypt_token(stored: str) -> str:
    if not stored.startswith("v1:"):
        return stored
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    raw = base64.b64decode(stored[3:])
    return AESGCM(_token_key()).decrypt(raw[:12], raw[12:], None).decode("utf-8")


def validate_token_key(conn: sqlite3.Connection) -> None:
    """启动时校验 token_key 与库内密文匹配；缺失/不匹配直接拒绝启动。

    默认 strict：只要 devices/token_pool/tokens 里已有数据而 key 缺失，就禁止
    自动生成新 key（否则会把设备 secret 和 token 池变成永久不可解）。
    全新空库仍允许首次自动生成。
    """
    p = Path(TOKEN_KEY_FILE)
    counts = 0
    for table in ("devices", "token_pool", "tokens"):
        try:
            counts += int(conn.execute(
                f"SELECT COUNT(*) FROM {table}").fetchone()[0])
        except sqlite3.Error:
            continue
    strict = os.environ.get("CHARGE_TOKEN_KEY_STRICT") == "1"
    if not p.exists():
        if strict or counts:
            raise RuntimeError(
                f"token key 缺失: {p}（库内已有 {counts} 条加密数据，拒绝自动重建）")
        return
    try:
        raw = bytes.fromhex(p.read_text(encoding="ascii").strip())
        if len(raw) != 32:
            raise ValueError("key 长度不是 32 字节")
    except Exception as exc:
        raise RuntimeError(f"token key 非法: {p}: {exc}") from exc
    if not counts:
        return
    probe = conn.execute(
        "SELECT secret_enc FROM devices WHERE secret_enc IS NOT NULL "
        "AND secret_enc <> '' LIMIT 1").fetchone()
    if probe is None:
        probe = conn.execute(
            "SELECT token FROM token_pool WHERE token IS NOT NULL "
            "AND token <> '' LIMIT 1").fetchone()
    if probe is not None:
        try:
            decrypt_token(str(probe[0]))
        except Exception as exc:
            raise RuntimeError(
                f"token key 与数据库不匹配: {p}（请恢复对应 token_key）") from exc


def rate_ok(ip: str, bucket: str, limit: int, window: int = 60) -> bool:
    now = time.time()
    with RATE_LOCK:
        key = (ip, bucket)
        q = RATE.setdefault(key, collections.deque())
        while q and now - q[0] > window:
            q.popleft()
        if not q:
            RATE.pop(key, None)
            q = RATE.setdefault(key, collections.deque())
        if len(q) >= limit:
            return False
        q.append(now)
        return True


WEAK_PASSWORDS = {"12345678", "123456789", "password", "password1", "admin123",
                  "admin1234", "qwerty123", "11111111", "abc12345", "88888888"}


def password_weak(password: str, user: str = "") -> str:
    pw = str(password or "")
    if len(pw) < 8:
        return "密码至少 8 位"
    low = pw.lower()
    if low in WEAK_PASSWORDS or low == str(user).lower():
        return "密码过于常见"
    if pw.isdigit():
        return "密码不能是纯数字"
    if pw.isalpha():
        return "密码不能是纯字母"
    return ""


def hash_password(password: str) -> str:
    salt = os.urandom(16)
    dk = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=16384, r=8, p=1,
                        dklen=32)
    return "scrypt:" + salt.hex() + ":" + dk.hex()


def verify_password(password: str, stored: str) -> bool:
    try:
        algo, salt_hex, hash_hex = stored.split(":", 2)
        if algo != "scrypt":
            return False
        dk = hashlib.scrypt(password.encode("utf-8"), salt=bytes.fromhex(salt_hex),
                            n=16384, r=8, p=1, dklen=32)
        return hmac.compare_digest(dk.hex(), hash_hex)
    except Exception:
        return False


def ensure_default_admin(conn: sqlite3.Connection) -> None:
    if conn.execute("SELECT COUNT(*) FROM admin_users").fetchone()[0]:
        return
    if not ADMIN_PASS:
        return
    conn.execute(
        "INSERT OR IGNORE INTO admin_users(username, pass_hash, created_at, updated_at) "
        "VALUES (?,?,?,?)",
        (ADMIN_USER, hash_password(ADMIN_PASS), now_str(), now_str()))
    conn.commit()


def admin_configured() -> bool:
    return bool(ADMIN_USER and (ADMIN_PASS or ADMIN_PASS_HASH))


def admin_credentials_ok(user: str, password: str) -> bool:
    """校验 ADMIN_USER / ADMIN_PASS（或 ADMIN_PASS_HASH），口令永不写死在代码里。"""
    if not admin_configured():
        return False
    try:
        if not hmac.compare_digest(str(user).encode("utf-8"),
                                   ADMIN_USER.encode("utf-8")):
            return False
    except (UnicodeError, TypeError):
        return False
    if ADMIN_PASS_HASH:
        try:
            _, salt_hex, hash_hex = ADMIN_PASS_HASH.split(":", 2)
            derived = hashlib.scrypt(password.encode("utf-8"),
                                     salt=bytes.fromhex(salt_hex),
                                     n=16384, r=8, p=1, dklen=32).hex()
            return hmac.compare_digest(derived, hash_hex)
        except Exception:
            return False
    try:
        return hmac.compare_digest(str(password).encode("utf-8"),
                                   ADMIN_PASS.encode("utf-8"))
    except (UnicodeError, TypeError):
        return False


def login_allowed(ip: str) -> bool:
    """按 IP 统计登录失败：5 次 / 5 分钟，超过则暂缓所有登录尝试。"""
    now = time.time()
    with RATE_LOCK:
        q = RATE.setdefault((ip, "admin_login_fail"), collections.deque())
        while q and now - q[0] > ADMIN_LOGIN_WINDOW:
            q.popleft()
        return len(q) < ADMIN_LOGIN_MAX_FAILS


def login_record_failure(ip: str) -> None:
    with RATE_LOCK:
        RATE.setdefault((ip, "admin_login_fail"), collections.deque()).append(time.time())


def login_clear_failures(ip: str) -> None:
    with RATE_LOCK:
        RATE.pop((ip, "admin_login_fail"), None)


def session_login(user: str) -> str:
    """创建会话，返回 32 位十六进制随机 token。"""
    token = secrets.token_hex(16)
    now = time.time()
    with SESSION_LOCK:
        for old_token, sess in list(SESSIONS.items()):
            if sess["expires"] <= now:
                SESSIONS.pop(old_token, None)
        SESSIONS[token] = {"user": user, "created": now,
                           "expires": now + ADMIN_SESSION_TTL}
    return token


def session_touch(token: str) -> dict | None:
    """读取会话并滑动续期；过期/不存在返回 None。"""
    if not token:
        return None
    now = time.time()
    with SESSION_LOCK:
        sess = SESSIONS.get(token)
        if not sess:
            return None
        if sess["expires"] <= now:
            SESSIONS.pop(token, None)
            return None
        sess["expires"] = now + ADMIN_SESSION_TTL
        if now - sess.get("created", now) > ADMIN_SESSION_MAX:
            SESSIONS.pop(token, None)
            return None
        return dict(sess)


def session_user(token: str) -> str:
    if not token:
        return ""
    with SESSION_LOCK:
        sess = SESSIONS.get(token)
        return sess["user"] if sess else ""


def session_drop(token: str) -> None:
    if not token:
        return
    with SESSION_LOCK:
        SESSIONS.pop(token, None)


def read_secret(path: Path) -> str:
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(secrets.token_hex(32), encoding="utf-8")
    return path.read_text(encoding="utf-8").strip()
