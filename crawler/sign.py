"""签名算法：复刻快充 H5 前端 $base.getMd5hash 的逻辑。

前端源码要点（assets/index.e40d1d73.js）：
  parts = 登录 ? [url尾部, userId, token, appid, 时间戳前9位, 随机串]
               : [url尾部, 时间戳前9位, 随机串]
  排序：按长度降序（长度相同保持原顺序）
  交换：第 2 个元素与最后一个元素互换
  拼接后取 MD5，得到 X-Signature

为什么"url 尾部"？前端 formatSignatureUrl(url, "quickuser50") 取的是
"quickuser50" 之后的路径 + 查询串，例如 "/nearArea/xxx?isNearBy=Y"。
"""

from __future__ import annotations

import hashlib
import random
import string
import time

ALPHABET = string.digits + string.ascii_lowercase + string.ascii_uppercase
SIGN_MARK = "quickuser50"


def create_random_seq(length: int = 16) -> str:
    return "".join(random.choice(ALPHABET) for _ in range(length))


def join_by_length_desc(parts: list[str]) -> str:
    # Python 的 sorted 是稳定排序，等长元素保持传入顺序，等价于 JS 的稳定 sort
    ordered = sorted(parts, key=len, reverse=True)
    if len(ordered) >= 3:
        ordered[1], ordered[-1] = ordered[-1], ordered[1]
    return "".join(ordered)


def compute_signature(tail: str, user_id: str, token: str, appid: str, ts9: str, seq: str) -> str:
    parts = [tail, user_id, token, appid, ts9, seq] if token else [tail, ts9, seq]
    return hashlib.md5(join_by_length_desc(parts).encode("utf-8")).hexdigest()


def build_headers(full_url: str, user_id: str, token: str, appid: str) -> dict[str, str]:
    idx = full_url.find(SIGN_MARK)
    if idx == -1:
        raise ValueError(f"URL 中没有 {SIGN_MARK}: {full_url}")
    tail = full_url[idx + len(SIGN_MARK):]
    ts = str(int(time.time() * 1000))
    seq = create_random_seq()
    sig = compute_signature(tail, user_id, token, appid, ts[:9], seq)
    headers = {
        "content-type": "application/x-www-form-urlencoded",
        "X-Timestamp": ts,
        "X-Signature": sig,
        "X-seq": seq,
        "X-AppID": appid,
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers
