"""离线回测 /api/now 到达预测：现行算法 vs 现行模型（cloud/app.py 中的实现）。

用法（在仓库根目录）：
    python tools/backtest_prediction.py --db <历史库副本路径> [--stride 1]

- 只读：不会写数据库，也不会访问网络/生产环境。
- 无未来数据泄漏：每个回测时刻 T 只用 received_at <= T 的样本；目标值取 T+Δ 之后
  最近的样本（±窗口），趋势/历史/风险率都由 cloud.app.prediction_stats 在
  now_dt=T 下计算，和线上调用的是同一份代码。
- 现行算法（旧版）在本文件内按旧公式逐项复刻：OLS 斜率不收缩、predicted_idle =
  idle + trend_10m、ETA 用趋势/同星期同小时空闲率。
- 现行模型（新版）：predicted_idle = 持久化值；trend_10m 按 t 统计量收缩；
  到达概率/ETA 用满区释放风险率。

输出：数据概况、覆盖与样本间隔、MAE 对比表、到达准确率/召回、ETA 校准。
"""

from __future__ import annotations

import argparse
import collections
import datetime as dt
import math
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from cloud import app as cloud_app  # noqa: E402

HORIZONS = (10, 15, 30)
TOL_PRE_MIN = 3.0
TOL_POST_MIN = 7.0


def parse_args():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", required=True, help="历史库副本（只读）")
    ap.add_argument("--stride", type=int, default=1, help="每 N 个快照取 1 个回测时刻")
    ap.add_argument("--split", default="2026-11-02T12:00:00",
                    help="训练/测试分段（本地时间 ISO；默认按本文样本中点）")
    return ap.parse_args()


def quantile(values, q):
    if not values:
        return 0.0
    vals = sorted(values)
    return vals[min(len(vals) - 1, int(len(vals) * q))]


def load_samples(conn):
    rows = conn.execute(
        "SELECT area_name, received_at, idle, total FROM area_samples "
        "ORDER BY area_name, received_at").fetchall()
    by_area = collections.defaultdict(list)
    for name, stamp, idle, total in rows:
        by_area[name].append((stamp, int(idle), int(total)))
    return by_area


def target_at(samples, stamp, delta):
    """取 stamp+delta 分钟附近最近的样本 idle；窗口 [-3, +7] 分钟。"""
    base = dt.datetime.strptime(stamp, "%Y-%m-%d %H:%M:%S")
    lo = (base + dt.timedelta(minutes=delta - TOL_PRE_MIN)).strftime("%Y-%m-%d %H:%M:%S")
    hi = (base + dt.timedelta(minutes=delta + TOL_POST_MIN)).strftime("%Y-%m-%d %H:%M:%S")
    best = None
    best_gap = None
    for s in samples:
        if s[0] < lo:
            continue
        if s[0] > hi:
            break
        gap = abs((dt.datetime.strptime(s[0], "%Y-%m-%d %H:%M:%S") - base)
                  .total_seconds() - delta * 60)
        if best_gap is None or gap < best_gap:
            best, best_gap = s[1], gap
    return best


def wait_until_free(samples, stamp, max_min=120.0, max_gap_min=30.0):
    """从 stamp 起第一个 idle>0 的样本；返回 (等待分钟, 是否观测到)。

    相邻样本间隔 > max_gap_min 视为采集断档，返回 (None, False)（删失）。
    """
    base = dt.datetime.strptime(stamp, "%Y-%m-%d %H:%M:%S")
    prev = base
    for s in samples:
        if s[0] <= stamp:
            continue
        ts = dt.datetime.strptime(s[0], "%Y-%m-%d %H:%M:%S")
        if (ts - prev).total_seconds() / 60.0 > max_gap_min:
            return None, False
        prev = ts
        wait = (ts - base).total_seconds() / 60.0
        if wait > max_min:
            return None, False
        if s[1] > 0:
            return wait, True
    return None, False


def old_fields(item, idle, total):
    """按旧版实现复刻 /api/now 预测字段（用于对照）。"""
    hist_samples = int(item.get("hist_samples") or 0)
    hist_free = int(item.get("hist_free") or 0)
    hist_rate = hist_free / hist_samples if hist_samples else None
    n = int(item.get("trend_n") or 0)
    tmin, tmax = item.get("tmin"), item.get("tmax")
    trend10 = None
    if n >= 3 and tmin is not None and tmax is not None:
        span = (float(tmax) - float(tmin)) * 1440.0
        if span >= cloud_app.NOW_TREND_MIN_SPAN_MIN:
            sx = float(item.get("sx") or 0.0)
            sy = float(item.get("sy") or 0.0)
            sxy = float(item.get("sxy") or 0.0)
            sxx = float(item.get("sxx") or 0.0)
            denom = n * sxx - sx * sx
            if abs(denom) >= 1e-12:
                trend10 = (n * sxy - sx * sy) / denom * 10.0
                cap = float(total) if total else float("inf")
                trend10 = max(-cap, min(cap, trend10))
    predicted = None
    if trend10 is not None:
        cap = float(total) if total else float("inf")
        predicted = max(0.0, min(cap, idle + trend10))
    p = None
    if predicted is not None:
        p = 1.0 - math.exp(-predicted)
    elif hist_rate is not None:
        p = hist_rate
    eta = None
    if idle == 0:
        if trend10 is not None and trend10 > 0:
            eta = min(cloud_app.NOW_ETA_MAX_MINUTES, max(1, math.ceil(10.0 / trend10)))
        elif hist_rate and hist_samples >= 4:
            eta = min(cloud_app.NOW_ETA_MAX_MINUTES,
                      max(1, math.ceil(10.0 * (1 - hist_rate) / hist_rate)))
    return dict(trend_10m=trend10, predicted_idle=predicted, p=p, eta=eta,
                hist_rate=hist_rate, hist_samples=hist_samples)


def mae(pairs):
    if not pairs:
        return None
    return sum(abs(p - t) for p, t in pairs) / len(pairs)


def auc_brier(pairs):
    """pairs: [(prob, actual_bool)]"""
    if not pairs:
        return None
    n = len(pairs)
    pos = [p for p, y in pairs if y]
    neg = [p for p, y in pairs if not y]
    auc = None
    if pos and neg:
        ordered = sorted([(p, 1) for p in pos] + [(p, 0) for p in neg])
        rank_sum = 0.0
        i = 0
        while i < len(ordered):
            j = i
            while j + 1 < len(ordered) and ordered[j + 1][0] == ordered[i][0]:
                j += 1
            avg_rank = (i + j) / 2.0 + 1
            rank_sum += avg_rank * sum(1 for k in range(i, j + 1) if ordered[k][1])
            i = j + 1
        auc = ((rank_sum - len(pos) * (len(pos) + 1) / 2.0)
               / (len(pos) * len(neg)))
    brier = sum((p - (1.0 if y else 0.0)) ** 2 for p, y in pairs) / n
    return auc, brier


def arrival_at_threshold(pairs, threshold=0.5):
    tp = sum(1 for p, y in pairs if p >= threshold and y)
    fp = sum(1 for p, y in pairs if p >= threshold and not y)
    fn = sum(1 for p, y in pairs if p < threshold and y)
    n = len(pairs)
    acc = (tp + n - tp - fp - fn) / n
    prec = tp / (tp + fp) if tp + fp else 0.0
    rec = tp / (tp + fn) if tp + fn else 0.0
    return dict(acc=acc, prec=prec, rec=rec)


def profile(conn):
    print("## 数据概况\n")
    q = lambda sql, *a: conn.execute(sql, a).fetchall()
    print("- area_samples：%d 行，%s ~ %s，%d 个区，%d 个快照" % (
        q("SELECT COUNT(*) FROM area_samples")[0][0],
        q("SELECT MIN(received_at) FROM area_samples")[0][0],
        q("SELECT MAX(received_at) FROM area_samples")[0][0],
        q("SELECT COUNT(DISTINCT area_name) FROM area_samples")[0][0],
        q("SELECT COUNT(*) FROM snapshots")[0][0]))
    print("- pile_samples：%d 行，%s ~ %s，%d 个设备" % (
        q("SELECT COUNT(*) FROM pile_samples")[0][0],
        q("SELECT MIN(ts) FROM pile_samples")[0][0],
        q("SELECT MAX(ts) FROM pile_samples")[0][0],
        q("SELECT COUNT(DISTINCT device_hex) FROM pile_samples")[0][0]))
    snaps = [r[0] for r in q("SELECT received_at FROM snapshots ORDER BY received_at")]
    stamps = [dt.datetime.strptime(s, "%Y-%m-%d %H:%M:%S") for s in snaps]
    gaps = [(b - a).total_seconds() / 60.0 for a, b in zip(stamps, stamps[1:])]
    print("- 快照间隔（分钟）：中位 %.1f，p90 %.1f，最大 %.1f（共 %d 个间隔）" % (
        quantile(gaps, 0.5), quantile(gaps, 0.9), max(gaps), len(gaps)))
    by_area = load_samples(conn)
    pgaps = []
    for samples in by_area.values():
        st = [dt.datetime.strptime(s[0], "%Y-%m-%d %H:%M:%S") for s in samples]
        pgaps += [(b - a).total_seconds() / 60.0 for a, b in zip(st, st[1:])]
    print("- 单区样本间隔（分钟）：中位 %.1f，p90 %.1f，最大 %.1f" % (
        quantile(pgaps, 0.5), quantile(pgaps, 0.9), max(pgaps)))
    print("- 每小时样本量（行/小时，含所有日）：")
    rows = q("SELECT strftime('%H', received_at) h, COUNT(*) FROM area_samples "
             "GROUP BY 1 ORDER BY 1")
    present = dict(rows)
    line = []
    for h in range(24):
        line.append("%02d:%d" % (h, present.get("%02d" % h, 0)))
    print("  " + "  ".join(line))
    missing = [h for h in range(24) if present.get("%02d" % h, 0) == 0]
    print("- 完全缺失的小时：%s" % (", ".join("%02d" % h for h in missing) or "无"))
    print("- 日覆盖：")
    for day, n, areas in q("SELECT substr(received_at,1,10), COUNT(*), "
                           "COUNT(DISTINCT area_name) FROM area_samples "
                           "GROUP BY 1 ORDER BY 1"):
        print("  %s：%d 行 / %d 区" % (day, n, areas))
    dist = q("SELECT c, COUNT(*) FROM (SELECT area_name, strftime('%w', received_at) d, "
             "strftime('%H', received_at) h, COUNT(*) c FROM area_samples "
             "GROUP BY 1,2,3) GROUP BY c ORDER BY c")
    total_slots = sum(c for _, c in dist)
    print("- (区, 星期, 小时) 历史槽位：%d 个，样本数分布 %s" % (
        total_slots, ", ".join("%d:%d" % (k, v) for k, v in dist)))
    print()


def main():
    args = parse_args()
    split = dt.datetime.fromisoformat(args.split)
    conn = sqlite3.connect("file:%s?mode=ro" % Path(args.db), uri=True)
    profile(conn)
    by_area = load_samples(conn)
    snaps = conn.execute(
        "SELECT id, received_at FROM snapshots ORDER BY received_at").fetchall()
    origins = snaps[::max(1, args.stride)]
    samples = {"train": [], "test": []}
    for idx, (sid, stamp) in enumerate(origins):
        base = dt.datetime.strptime(stamp, "%Y-%m-%d %H:%M:%S")
        bucket = "train" if base < split else "test"
        rows = conn.execute(
            "SELECT area_name, idle, total FROM area_samples WHERE snapshot_id = ?",
            (sid,)).fetchall()
        if not rows:
            continue
        try:
            stats = cloud_app.prediction_stats(conn, now_dt=base)
        except Exception as exc:  # pragma: no cover - 诊断用
            print("skip %s: %s" % (stamp, exc))
            continue
        for name, idle, total in rows:
            idle, total = int(idle), int(total)
            item = stats.get(name) or {}
            old = old_fields(item, idle, total)
            new = cloud_app.prediction_fields(name, idle, stats, total)
            rec = dict(stamp=stamp, name=name, idle=idle, total=total,
                       old=old, new=new)
            area_samples = by_area[name]
            for d in HORIZONS:
                rec["tgt%d" % d] = target_at(area_samples, stamp, d)
            if idle == 0:
                rec["wait"], rec["wait_obs"] = wait_until_free(area_samples, stamp)
            samples[bucket].append(rec)
        if idx % 50 == 0:
            print("... %d/%d 个回测时刻" % (idx, len(origins)))
    print()

    for bucket in ("train", "test"):
        data = samples[bucket]
        print("=" * 78)
        print("## %s 段（%d 个区·时刻）" % ("训练" if bucket == "train" else "测试",
                                          len(data)))
        print()
        print("### 未来 Δ 分钟空闲数 MAE（点估计；n 为有真值且模型有输出的样本）")
        print("| 模型 | Δ=10 | Δ=15 | Δ=30 |")
        print("| --- | --- | --- | --- |")
        lines = []
        for label, key in (("现行算法（OLS 趋势外推）", "old"), ("新模型（持久化）", "new")):
            cells = []
            for d in HORIZONS:
                pairs = []
                for r in data:
                    tgt = r["tgt%d" % d]
                    if tgt is None:
                        continue
                    if key == "old":
                        pred = r["old"]["predicted_idle"]
                        if pred is None:
                            continue
                        # 15/30 分钟：把旧 10 分钟趋势线性外推（旧 API 没有该字段）
                        pred = max(0.0, min(r["total"], r["idle"]
                                            + r["old"]["trend_10m"] * d / 10.0))
                    else:
                        pred = r["new"]["predicted_idle"]
                        if pred is None:
                            continue
                    pairs.append((pred, tgt))
                cells.append("%.3f (n=%d)" % (mae(pairs), len(pairs)) if pairs else "-")
            lines.append("| %s | %s |" % (label, " | ".join(cells)))
        print("\n".join(lines))
        print()

        print("### 客户端 trend_10m 外推误差（webui：idle + trend_10m × 步行分钟/10，取整）")
        print("| 模型 | Δ=10 | Δ=15 | Δ=30 |")
        print("| --- | --- | --- | --- |")
        for label, key in (("现行算法趋势", "old"), ("收缩趋势", "new")):
            cells = []
            for d in HORIZONS:
                pairs = []
                for r in data:
                    tgt = r["tgt%d" % d]
                    trend = r[key]["trend_10m"]
                    if tgt is None or trend is None:
                        continue
                    pred = round(max(0.0, min(r["total"], r["idle"] + trend * d / 10.0)))
                    pairs.append((pred, tgt))
                cells.append("%.3f (n=%d)" % (mae(pairs), len(pairs)) if pairs else "-")
            print("| %s | %s |" % (label, " | ".join(cells)))
        print()

        print("### 到达时是否至少 1 个空位（10/15/30 分钟；阈值 0.5）")
        print("| 模型 | Δ | 准确率 | 召回（有空位） | 精确率 | AUC | Brier |")
        print("| --- | --- | --- | --- | --- | --- | --- |")
        for label, key in (("现行算法", "old"), ("新模型", "new")):
            for d in HORIZONS:
                pairs = []
                for r in data:
                    tgt = r["tgt%d" % d]
                    if tgt is None:
                        continue
                    p10 = r[key]["p"] if key == "old" else r[key]["p_free_10m"]
                    if p10 is None:
                        continue
                    if key == "old" and d > 10:
                        # 旧 API 无此字段：用趋势线性外推的空闲数转成泊松概率
                        if r["old"]["trend_10m"] is None:
                            p = p10
                        else:
                            pred = max(0.0, min(r["total"], r["idle"]
                                                + r["old"]["trend_10m"] * d / 10.0))
                            p = 1.0 - math.exp(-pred)
                    elif key == "new" and d > 10:
                        p = 1.0 - (1.0 - r["new"]["p_free_10m"]) ** (d / 10.0)
                    else:
                        p = p10
                    pairs.append((p, tgt > 0))
                if not pairs:
                    continue
                m = arrival_at_threshold(pairs)
                auc, brier = auc_brier(pairs)
                print("| %s | %d | %.4f | %.4f | %.3f | %.4f | %.4f |" % (
                    label, d, m["acc"], m["rec"], m["prec"],
                    auc if auc is not None else float("nan"), brier))
        print()

        print("### 满区（idle=0）ETA：现行算法 vs 新模型")
        print("| 模型 | 覆盖 | 中位 ETA | MAE(分钟) | P(实际等待<=ETA) | eta<=30 精确率 | 30 分钟内释放召回 |")
        print("| --- | --- | --- | --- | --- | --- | --- |")
        for label, key in (("现行算法", "old"), ("新模型", "new")):
            rows = []
            for r in data:
                if r["idle"] != 0 or r.get("wait") is None:
                    continue
                eta = r[key]["eta"] if key == "old" else r[key]["eta_min"]
                if eta is None:
                    continue
                rows.append((eta, r["wait"]))
            if not rows:
                print("| %s | 0 | - | - | - | - |" % label)
                continue
            cov = sum(1 for e, w in rows if w <= e) / len(rows)
            med = quantile([e for e, _ in rows], 0.5)
            err = sum(abs(e - w) for e, w in rows) / len(rows)
            base30 = [w for _, w in rows if w <= 30]
            recall30 = (sum(1 for e, w in rows if w <= 30 and e <= 30) / len(base30)
                        if base30 else float("nan"))
            pred30 = [(e, w) for e, w in rows if e <= 30]
            prec30 = (sum(1 for e, w in pred30 if w <= 30) / len(pred30)
                      if pred30 else float("nan"))
            print("| %s | %d | %.0f | %.1f | %.3f | %.3f | %.3f |" % (
                label, len(rows), med, err, cov, prec30, recall30))
        print()

        print("### 满区释放概率（10 分钟）区分度")
        for label, key in (("现行算法", "old"), ("新模型", "new")):
            pairs = [(r[key]["p"] if key == "old" else r[key]["p_free_10m"],
                      r["tgt10"] > 0) for r in data
                     if r["idle"] == 0 and r["tgt10"] is not None
                     and (r[key]["p"] if key == "old" else r[key]["p_free_10m"]) is not None]
            if pairs:
                auc, brier = auc_brier(pairs)
                print("- %s：AUC=%.4f，Brier=%.4f，n=%d" % (
                    label, auc if auc is not None else float("nan"), brier, len(pairs)))
        print()


if __name__ == "__main__":
    main()
