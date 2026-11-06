#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""服务器端跨语言对拍：Python(8788) vs Node(8791)，同一份生产库。"""
import json
import sys
import urllib.parse
import urllib.request

PY = "http://127.0.0.1:8788"
ND = "http://127.0.0.1:8791"
SKIP_KEYS = {"stale", "online", "generated_at"}


def get(base, path):
    try:
        with urllib.request.urlopen(base + path, timeout=30) as r:
            return r.status, json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode("utf-8"))
        except Exception:
            return e.code, None
    except Exception as e:
        return -1, {"__error__": str(e)[:100]}


def strip(v):
    """去掉依赖当前时间的字段"""
    if isinstance(v, list):
        return [strip(x) for x in v]
    if isinstance(v, dict):
        return {k: strip(x) for k, x in v.items() if k not in SKIP_KEYS}
    return v


def norm(v):
    """递归按键排序，数组保序"""
    if isinstance(v, list):
        return [norm(x) for x in v]
    if isinstance(v, dict):
        return {k: norm(v[k]) for k in sorted(v)}
    return v


def typename(v):
    """把 int/float 统一归为 number —— Python 的 0.0 与 JS 的 0 是同一个数值"""
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "bool"
    if isinstance(v, (int, float)):
        return "number"
    if isinstance(v, list):
        return "array"
    if isinstance(v, dict):
        return "object"
    return type(v).__name__


def diff(a, b, path="$", out=None, maxd=10):
    if out is None:
        out = []
    if len(out) >= maxd:
        return out
    ta, tb = typename(a), typename(b)
    if ta != tb:
        out.append("%s: 类型 py=%s node=%s" % (path, ta, tb))
        return out
    if isinstance(a, list):
        if len(a) != len(b):
            out.append("%s.length: py=%d node=%d" % (path, len(a), len(b)))
        for i in range(min(len(a), len(b))):
            diff(a[i], b[i], "%s[%d]" % (path, i), out, maxd)
            if len(out) >= maxd:
                break
        return out
    if isinstance(a, dict):
        for k in sorted(set(a) | set(b)):
            if k not in a:
                out.append("%s.%s: py 缺失" % (path, k))
            elif k not in b:
                out.append("%s.%s: node 缺失" % (path, k))
            else:
                diff(a[k], b[k], "%s.%s" % (path, k), out, maxd)
            if len(out) >= maxd:
                break
        return out
    if ta == "number":
        if abs(a - b) <= max(1e-9, abs(a) * 1e-9):
            return out
    if a != b:
        out.append("%s: py=%r node=%r" % (path, a, b))
    return out


def main():
    cases = [
        ("areas-ports", "/api/areas-ports"),
        ("overview", "/api/overview"),
        ("analytics", "/api/analytics"),
        ("now", "/api/now"),
        ("now+coords", "/api/now?lat=30.3811726&lng=114.3396025"),
        ("now+badcoords", "/api/now?lat=abc&lng=999"),
        ("pile 404", "/api/pile/NOSUCHDEV"),
        ("area-ports 缺参", "/api/area-ports"),
        ("history 缺参", "/api/history"),
        ("analytics 未知区", "/api/analytics?area=不存在的区"),
    ]

    # 用真实区域名补几个用例
    st, body = get(ND, "/api/areas-ports")
    if isinstance(body, dict) and body.get("areas"):
        for a in body["areas"][:3]:
            name = a.get("area", "")
            q = urllib.parse.quote(name)
            cases.append(("area-ports[%s]" % name, "/api/area-ports?area=" + q))
            cases.append(("history[%s]" % name, "/api/history?area=" + q + "&limit=50"))
        name0 = body["areas"][0].get("area", "")
        cases.append(
            ("analytics[%s]" % name0,
             "/api/analytics?area=" + urllib.parse.quote(name0) + "&weeks=8")
        )
        # 单桩详情
        dev = body["areas"][0]["devices"][0]["device_hex"]
        cases.append(("pile[%s]" % dev, "/api/pile/" + dev))

    print("=" * 60)
    print("服务器端对拍：Python 8788  vs  Node 8791")
    print("=" * 60)

    passed = 0
    for label, path in cases:
        s1, b1 = get(PY, path)
        s2, b2 = get(ND, path)
        if s1 != s2:
            print("\n✗ %s\n    HTTP 状态不同 py=%s node=%s" % (label, s1, s2))
            continue
        d = diff(norm(strip(b1)), norm(strip(b2)))
        if d:
            print("\n✗ %s  (%s)" % (label, s1))
            for x in d:
                print("    " + x)
        else:
            passed += 1
            print("✓ %s  (%s)" % (label, s1))

    print("\n" + "=" * 60)
    print("%d/%d 端点一致" % (passed, len(cases)))
    print("=" * 60)
    return 0 if passed == len(cases) else 1


if __name__ == "__main__":
    sys.exit(main())
