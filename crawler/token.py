"""从微信 PC 版内嵌浏览器（XWeb）的 Local Storage 里找快充站的 userToken。

原理：公众号网页在微信内置浏览器里登录后，uni.setStorageSync("userToken", ...)
会落进 Chromium 的 Local Storage LevelDB：
    ...\\radium\\web\\profiles\\<profile>\\Local Storage\\leveldb\\*.log|*.ldb
key 形如 `_http://ap3202.haokuaichong.cn userToken`，value 是一段 JWT。
"""

from __future__ import annotations

import base64
import glob
import json
import os
import re
from dataclasses import dataclass

JWT_RE = re.compile(rb"eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}")
MARK_RE = re.compile(rb"ap3202\.haokuaichong\.cn")


@dataclass
class Token:
    value: str
    user_id: str
    issued_at: int
    expires_at: int

    @property
    def expired(self) -> bool:
        import time
        return time.time() >= self.expires_at


def decode_payload(jwt: str) -> dict:
    payload = jwt.split(".")[1]
    payload += "=" * (-len(payload) % 4)
    return json.loads(base64.urlsafe_b64decode(payload))


def user_id_from(payload: dict) -> str:
    raw = payload["encryId"]
    if not isinstance(raw, str) or not raw:
        raise ValueError("encryId 缺失")
    decoded = base64.b64decode(raw).decode("utf-8")
    if not decoded:
        raise ValueError("encryId 为空")
    return decoded


def parse_jwt(jwt: str) -> Token | None:
    try:
        if not isinstance(jwt, str) or len(jwt.split(".")) != 3:
            return None
        payload = decode_payload(jwt)
        if not isinstance(payload, dict):
            return None
        if payload.get("aud") != "quick_user_api":
            return None
        iat = payload["iat"]
        exp = payload["exp"]
        if not isinstance(iat, (int, float)) or not isinstance(exp, (int, float)):
            return None
        return Token(jwt, user_id_from(payload), int(iat), int(exp))
    except (KeyError, ValueError, TypeError, IndexError, AttributeError,
            UnicodeDecodeError):
        return None


def _default_wechat_root() -> str:
    return os.path.join(os.environ.get("APPDATA", ""), "Tencent", "xwechat", "radium", "web", "profiles")


def find_tokens(wechat_root: str | None = None) -> list[Token]:
    root = wechat_root or _default_wechat_root()
    pattern = os.path.join(root, "*", "Local Storage", "leveldb", "*")
    found: dict[str, Token] = {}
    for path in glob.glob(pattern):
        try:
            with open(path, "rb") as fh:
                blob = fh.read(4 * 1024 * 1024)
        except OSError:
            continue
        if not MARK_RE.search(blob):
            continue
        for raw in JWT_RE.findall(blob):
            try:
                token = parse_jwt(raw.decode("ascii"))
            except Exception:  # 单段伪 JWT 不能让整轮扫描崩掉
                continue
            if token and token.value not in found:
                found[token.value] = token
    return sorted(found.values(), key=lambda t: t.issued_at, reverse=True)


def find_latest(wechat_root: str | None = None, *, include_expired: bool = False,
                user_id: str | None = None) -> Token | None:
    for token in find_tokens(wechat_root):
        if user_id and token.user_id != user_id:
            continue
        if include_expired or not token.expired:
            return token
    return None
