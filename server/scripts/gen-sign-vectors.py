# -*- coding: utf-8 -*-
"""生成签名对拍向量：crawler/sign.py 的 compute_signature 结果，供 Node 复算对比。"""
import json
import sys
from pathlib import Path

sys.path.insert(0, r"D:\charging-crawler")
from crawler.sign import compute_signature, join_by_length_desc  # noqa: E402

cases = [
    # (tail, user_id, token, appid, ts9, seq)
    ("/nearArea/xxx?isNearBy=Y", "10001", "eyJhbGciOiJIUzI1NiJ9.abc.def", "wx123", "170000000", "abc123XYZ7890abc"),
    ("/nearArea/list?projectId=1", "10001", "eyJhbGciOiJIUzI1NiJ9.abc.def", "wx123", "170000000", "abc123XYZ7890abc"),
    ("/charge/ports?fromType=3", "10001", "", "wx123", "170000000", "short"),
    ("/user/userInfo", "", "tok", "", "999999999", "a" * 16),
]

out = []
for tail, uid, token, appid, ts9, seq in cases:
    out.append({
        "tail": tail,
        "uid": uid,
        "token": token,
        "appid": appid,
        "ts9": ts9,
        "seq": seq,
        "sig": compute_signature(tail, uid, token, appid, ts9, seq),
    })

# 单独验证 join_by_length_desc（含交换逻辑）
out_join = {
    "parts": ["a", "bbbb", "cc", "ddddd", "e"],
    "joined": join_by_length_desc(["a", "bbbb", "cc", "ddddd", "e"]),
    "parts3": ["x", "yyy", "z"],
    "joined3": join_by_length_desc(["x", "yyy", "z"]),
}

payload = {"cases": out, "join": out_join}
p = Path(r"D:\charging-crawler\server\scripts\sign-vectors.json")
p.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
print("已生成:", p)
for c in out:
    print("  sig:", c["sig"], "tail:", c["tail"][:30])
print("  joined:", out_join["joined"])
print("  joined3:", out_join["joined3"])
