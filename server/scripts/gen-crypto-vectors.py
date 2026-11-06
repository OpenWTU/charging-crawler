# -*- coding: utf-8 -*-
"""生成密码学对拍向量：AES-256-GCM + HMAC-SHA256。

输出 JSON，供 server/scripts/crypto-parity.ts 读取后用 Node crypto 复算对比。
AES-GCM 用 cryptography 的 Cipher 手动指定 nonce（AESGCM.encrypt 不能指定），
这样两边能在同一 nonce 下逐字节对比密文。
"""
import base64
import hashlib
import hmac
import json
from pathlib import Path

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

# 固定测试向量
key = bytes(range(32))          # 00 01 02 ... 1f
nonce = bytes(range(12))        # 00 01 02 ... 0b
plaintext = "测试token:eyJhbGciOiJIUzI1NiJ9.payload.signature".encode("utf-8")

# 固定 nonce 的 AES-GCM
cipher = Cipher(algorithms.AES(key), modes.GCM(nonce))
enc = cipher.encryptor()
ct = enc.update(plaintext) + enc.finalize()
tag = enc.tag

# HMAC 设备签名
secret = "a" * 64
ts = "1700000000"
nonce2 = "deadbeefcafe1234"
body = '{"areas":[{"name":"10栋宿舍楼1号充电区","idle_port":1,"total_port":10}]}'.encode("utf-8")
sig = hmac.new(
    secret.encode(), ts.encode() + b"\n" + nonce2.encode() + b"\n" + body,
    hashlib.sha256,
).hexdigest()

# 一个完整密文（固定 nonce 1..12，格式 "v1:base64(nonce+ct+tag)"，供 Node 解密验证）
nonce_r = bytes(range(1, 13))

vector = {
    "key_hex": key.hex(),
    "nonce_hex": nonce.hex(),
    "plaintext_utf8": plaintext.decode("utf-8"),
    "ct_hex": ct.hex(),
    "tag_hex": tag.hex(),
    "hmac": {
        "secret": secret,
        "ts": ts,
        "nonce": nonce2,
        "body_base64": base64.b64encode(body).decode("ascii"),
        "sig_hex": sig,
    },
}

# 完整密文（固定 nonce 1..12，供 Node 解密验证）
cipher_r = Cipher(algorithms.AES(key), modes.GCM(nonce_r))
enc_r = cipher_r.encryptor()
ct_r = enc_r.update(plaintext) + enc_r.finalize()
tag_r = enc_r.tag
vector["encrypt_token_full"] = "v1:" + base64.b64encode(nonce_r + ct_r + tag_r).decode("ascii")

out = Path(r"D:\charging-crawler\server\scripts\crypto-vectors.json")
out.write_text(json.dumps(vector, ensure_ascii=False, indent=2), encoding="utf-8")
print("已生成:", out)
print("ct_hex   =", ct.hex()[:32], "...")
print("tag_hex  =", tag.hex())
print("sig_hex  =", sig)
print("full     =", vector["encrypt_token_full"][:48], "...")
