"""带签名的 HTTP 客户端（标准库 urllib，不需要 requests）。"""

from __future__ import annotations

import json
import time
import urllib.parse
import urllib.request

from .sign import build_headers

BASE = "https://ap3202.haokuaichong.cn/quickuser50/"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36 "
    "MicroMessenger/7.0.20.1781 XWEB/25819"
)


class ApiError(RuntimeError):
    pass


class AuthExpired(ApiError):
    pass


def _encode_query(params: dict) -> str:
    return "&".join(f"{k}={urllib.parse.quote(str(v), safe='')}" for k, v in params.items())


def call(path: str, params: dict | None = None, *, token: str = "", user_id: str = "",
         appid: str = "", timeout: float = 15.0) -> dict:
    query = _encode_query(params or {})
    url = f"{BASE}{path}{'?' + query if query else ''}"
    headers = build_headers(url, user_id, token, appid)
    headers["User-Agent"] = USER_AGENT
    req = urllib.request.Request(url, headers=headers, method="GET")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = resp.read().decode("utf-8")
    try:
        data = json.loads(body)
    except json.JSONDecodeError as exc:
        raise ApiError(f"返回不是 JSON: {body[:200]!r}") from exc
    code = data.get("code")
    if code in (20001, 70006, 70004):
        raise AuthExpired(f"登录态失效（code={code}）：{data.get('msg')}")
    return data


def polite_sleep(seconds: float = 0.25) -> None:
    time.sleep(seconds)
