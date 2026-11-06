import hashlib
import hmac
import json
import secrets
import time
import urllib.parse
import urllib.request

BASE = "https://charge.example.com"
secret = open(r"cloud/data/upload_secret.txt", encoding="utf-8").read().strip()

body = json.dumps({
    "captured_at": "2026-10-31 23:30:00",
    "project": "纺织大学阳光校区",
    "app_version": "2.3",
    "token_user": "12345678",
    "areas": [{"id": "1", "name": "6号充电区", "total_port": 16,
               "idle_port": 7, "charging_port": 9, "fault_port": 0}],
}, ensure_ascii=False).encode()
ts = str(int(time.time()))
nonce = secrets.token_hex(8)
sig = hmac.new(secret.encode(), ts.encode() + b"\n" + nonce.encode() + b"\n" + body,
               hashlib.sha256).hexdigest()
req = urllib.request.Request(BASE + "/api/snapshot", data=body, method="POST", headers={
    "Content-Type": "application/json",
    "X-Charge-Timestamp": ts,
    "X-Charge-Nonce": nonce,
    "X-Charge-Signature": sig,
})
print("upload:", urllib.request.urlopen(req, timeout=15).read().decode())
print("overview:", urllib.request.urlopen(BASE + "/api/overview", timeout=10).read().decode()[:160])
area = urllib.parse.quote("6号充电区")
print("history:", urllib.request.urlopen(
    BASE + "/api/history?limit=5&area=" + area, timeout=10).read().decode()[:200])
print("version:", urllib.request.urlopen(BASE + "/api/version", timeout=10).read().decode()[:80])
