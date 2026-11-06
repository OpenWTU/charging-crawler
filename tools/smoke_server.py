import http.client
import json
import subprocess
import sys
import tempfile
import time
from pathlib import Path
import urllib.request
import urllib.error

ROOT = Path(__file__).resolve().parents[1]
PY = sys.executable
PORT = 8799


def req(method, path, host, extra=None):
    conn = http.client.HTTPConnection("127.0.0.1", PORT, timeout=5)
    headers = {"Host": host}
    headers.update(extra or {})
    conn.request(method, path, headers=headers)
    resp = conn.getresponse()
    body = resp.read()
    conn.close()
    return resp.status, body


data_dir = tempfile.mkdtemp()
proc = subprocess.Popen(
    [PY, "-X", "utf8", "-m", "server.app", "--db", "data/stations.db",
     "--data-dir", data_dir, "--host", "127.0.0.1", "--port", str(PORT)],
    cwd=str(ROOT), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    for _ in range(50):
        try:
            if req("GET", "/health", "127.0.0.1")[0] == 200:
                break
        except OSError:
            time.sleep(0.1)
    checks = []
    checks.append(("health ok", req("GET", "/health", "127.0.0.1")[0] == 200))
    checks.append(("status evil host 403", req("GET", "/api/status", "evil.example")[0] == 403))
    checks.append(("status host:port ok", req("GET", "/api/status", "127.0.0.1:%d" % PORT)[0] == 200))
    checks.append(("refresh evil origin 403", req(
        "POST", "/api/refresh", "127.0.0.1:%d" % PORT,
        {"Origin": "http://evil.example", "Content-Length": "0"})[0] == 403))
    for name, ok in checks:
        print(("PASS " if ok else "FAIL ") + name)
    print("all pass:", all(ok for _, ok in checks))
finally:
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()

# HTTPS 平台可达性（不带 token，应返回 20001）
try:
    urllib.request.urlopen(urllib.request.Request(
        "https://ap3202.haokuaichong.cn/quickuser50/user/userInfo",
        headers={"User-Agent": "Mozilla/5.0"}), timeout=10)
except urllib.error.HTTPError as e:
    print("https status:", e.code)
except Exception as e:
    print("https error:", e)
