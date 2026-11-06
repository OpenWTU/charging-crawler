/**
 * 充电区选择/排序/推荐口径：搜索、筛选、收藏置顶、距离评分、到达预测、区域空闲汇总。
 *
 * 不变量（改动前请先读）：
 *  1. 「一个区域的空闲数」只有一份口径 areaPortsStat()：有端口数据用端口汇总，
 *     没有才回退概览的 idle_port/total_port。列表数字、筛选、排序、推荐全部共用它，
 *     不允许各自再算一遍；
 *  2. areaState() 与端口面板徽章同源：没有端口数据 = 探不到（offline），
 *     不是「idle_port 为 0」；
 *  3. 预测字段全部来自 /api/now 扩展字段，缺失就不展示，不硬算、不伪装。
 */
import { computed, ref } from 'vue';
import { showToast } from 'vant';
import { coordNum, validGeo, bdToGcj, distanceM, fmtDist } from '../geo.js';
import { portTone } from '../portStatus.js';

const FAV_KEY = 'charge_favs';

// ---- 收藏充电区（P1-6）：localStorage 持久化，收藏置顶但仍受筛选约束 ----
function readFavs() {
  try {
    const raw = localStorage.getItem(FAV_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string' && x.trim()) : [];
  } catch { return []; }
}

const WALK_M_PER_MIN = 80;

export function decCode(code) {
  if (code === null || code === undefined || code === '') return '—';
  const n = Number(code);
  return Number.isFinite(n) ? String(n) : String(code);
}

// ---- 搜索索引键：区域名 + 每台设备的 device_hex / qr_device_no / code（桩号）----

export function deviceKey(d) {
  if (!d || typeof d !== 'object') return '';
  return String(d.device_hex || d.qr_device_no || decCode(d.code) || '').trim();
}

export function deviceKeys(d) {
  if (!d || typeof d !== 'object') return [];
  const keys = [];
  const push = (v) => {
    const s = v === null || v === undefined ? '' : String(v).trim().toLowerCase();
    if (s && s !== '—' && keys.indexOf(s) < 0) keys.push(s);
  };
  push(d.device_hex);
  push(d.qr_device_no);
  push(decCode(d.code));
  return keys;
}

export function matchesKey(keys, kw) {
  const k = String(kw || '').toLowerCase();
  return !!k && keys.some((s) => s.indexOf(k) >= 0);
}

/**
 * @param {{areas, areaPorts, areaCoords, nowList, geo}} src 均为实时数据层的 ref
 */
export function useAreaSelection(src) {
  const { areas, areaPorts, areaCoords, nowList, geo } = src;

  const q = ref('');
  const areaFilter = ref('all');
  const filters = [
    { key: 'all', label: '全部' },
    { key: 'free', label: '有空位' },
    { key: 'full', label: '已满' },
    { key: 'offline', label: '探不到' },
  ];

  // ---- 收藏 ----
  const favs = ref(readFavs());
  const favSet = computed(() => new Set(favs.value));

  function isFav(name) {
    return !!name && favSet.value.has(name);
  }

  function toggleFav(name) {
    if (!name) return;
    const set = new Set(favs.value);
    const on = !set.has(name);
    if (on) set.add(name); else set.delete(name);
    favs.value = Array.from(set);
    try { localStorage.setItem(FAV_KEY, JSON.stringify(favs.value)); } catch { /* 无 localStorage 时仅本会话生效 */ }
    // 筛选/搜索生效时，收藏项不一定立即出现在顶部，提示需说明「清空筛选后置顶」，
    // 避免用户误以为收藏没生效。
    const narrowed = areaFilter.value !== 'all' || !!String(q.value || '').trim();
    showToast(on ? (narrowed ? '已收藏，清除筛选后置顶' : '已收藏，排序置顶') : '已取消收藏');
  }

  const areaMap = computed(() => {
    const m = new Map();
    (areas.value || []).forEach((a) => { if (a && a.name) m.set(a.name, a); });
    return m;
  });
  const nowMap = computed(() => {
    const m = new Map();
    (nowList.value || []).forEach((n) => { if (n && n.name) m.set(n.name, n); });
    return m;
  });

  // 行内距离：优先用 overview 的 lat/lng 本地算（不依赖服务端 /api/now 的 distance_m）
  function distText(name) {
    if (!geo.value) return '';
    const a = areaCoords.value.get(name) || areaMap.value.get(name);
    const raw = a ? validGeo(a.lat, a.lng) : null;
    if (!raw) return '';
    const c = bdToGcj(raw);
    return fmtDist(distanceM(geo.value.lat, geo.value.lng, c.lat, c.lng));
  }

  // 本地距离与综合分：不依赖服务端 /api/now 的 distance_m/score
  function localDistM(name) {
    if (!geo.value) return null;
    const a = areaCoords.value.get(name) || areaMap.value.get(name);
    const raw = a ? validGeo(a.lat, a.lng) : null;
    if (!raw) return null;
    const c = bdToGcj(raw);
    return distanceM(geo.value.lat, geo.value.lng, c.lat, c.lng);
  }

  // ---- 到达预测（P1-4）：字段全部来自 /api/now 扩展，缺失一律不展示 ----
  function nowOf(name) {
    return nowMap.value.get(name) || null;
  }

  // 步行分钟：无定位/无坐标时为 null（不展示预测）
  function walkMinutes(name) {
    const d = localDistM(name);
    if (d === null) return null;
    return Math.max(1, Math.ceil(d / WALK_M_PER_MIN));
  }

  function predConfidence(name) {
    const n = nowOf(name);
    const c = n && typeof n.confidence === 'string' ? n.confidence.trim().toLowerCase() : '';
    return (c === 'high' || c === 'medium' || c === 'low') ? c : '';
  }

  function predEtaMinutes(name) {
    const n = nowOf(name);
    const eta = n ? coordNum(n.eta_min) : NaN;
    if (!Number.isFinite(eta) || eta <= 0) return null;
    return Math.round(eta);
  }

  function predProb(name) {
    const n = nowOf(name);
    const arrival = n ? coordNum(n.p_free_at_arrival) : NaN;
    if (Number.isFinite(arrival)) {
      return { value: Math.max(0, Math.min(1, arrival)), label: '到达概率' };
    }
    // 旧后端无到达概率时回退 10 分钟概率，文案保持可解释，不伪装成到达概率
    const p = n ? coordNum(n.p_free_10m) : NaN;
    return Number.isFinite(p)
      ? { value: Math.max(0, Math.min(1, p)), label: '10分钟概率' }
      : null;
  }

  // 回测结论：10-30 分钟尺度上最优的点估计就是当前空闲数，趋势外推会放大噪声
  function predFreeAt(name, freeNow) {
    const base = Number.isFinite(coordNum(freeNow)) ? coordNum(freeNow) : NaN;
    if (!Number.isFinite(base)) return null;
    const area = areas.value.find((x) => x.name === name);
    const total = area ? areaPortsStat(area).total : 0;
    const predicted = Math.max(0, Math.round(base));
    return total > 0 ? Math.min(total, predicted) : predicted;
  }

  // 组装一条预测：{ walk, free, predicted, eta, low }
  function predictionFor(name, freeNow) {
    const walk = walkMinutes(name);
    if (walk === null) return null;
    const free = Number.isFinite(coordNum(freeNow)) ? Math.max(0, Math.floor(coordNum(freeNow))) : 0;
    const conf = predConfidence(name);
    const out = { walk, free, predicted: null, eta: null, prob: predProb(name), low: conf === 'low' };
    if (free > 0) out.predicted = predFreeAt(name, free);
    else out.eta = predEtaMinutes(name);
    return out;
  }

  // 预测文案：行内只展示有内容的预测（避免每行重复「步行…」）；
  // 顶部推荐卡允许只显示步行分钟，并在无 eta 时给出「暂无可靠预测」。
  function predictionLine(name, freeNow, opts = {}) {
    const p = predictionFor(name, freeNow);
    if (!p) return '';
    const parts = [(opts.about ? '步行约 ' : '步行 ') + p.walk + ' 分钟'];
    if (p.free > 0) {
      if (p.predicted !== null) {
        parts.push('预计到时 ' + p.predicted + ' 个空位');
      } else if (!opts.fallback) {
        return ''; // 无 trend 字段：行内不硬算
      }
    } else if (p.eta !== null) {
      parts.push('预计约 ' + p.eta + ' 分钟后有空位');
    } else if (opts.fallback) {
      parts.push('暂无可靠预测');
    } else {
      return ''; // 已满且无 eta：行内不展示预测
    }
    let s = parts.join(' · ');
    if (p.prob && p.prob.value > 0 && parts.length > 1) {
      s += ' · ' + p.prob.label + ' ' + Math.round(p.prob.value * 100) + '%';
    }
    // 只有真的带了预测内容才标注「参考」，避免「步行约 38 分钟（参考）」这种噪声
    if (p.low && parts.length > 1) s += '（参考）';
    return s;
  }

  // ---- 区域空闲口径：端口数据优先，列表数字/筛选/推荐共用同一份汇总 ----
  // 之前排序按 idle_port、筛选按端口状态，会出现「有空位」筛选里显示 0/16 且排最后。
  function deviceFreeCount(d) {
    if (!d || typeof d !== 'object') return 0;
    const f = coordNum(d.free);
    if (Number.isFinite(f)) return Math.max(0, Math.floor(f));
    const st = String(d.state == null ? '' : d.state).trim().toLowerCase();
    if (st !== 'free') return 0;
    const ports = Array.isArray(d.ports) ? d.ports : [];
    const n = ports.filter((p) => portTone(p) === 'idle').length;
    return n || (ports.length ? 0 : 1); // 只有 free 标记、无端口明细时至少算 1 个空位
  }

  function deviceTotalCount(d) {
    if (!d || typeof d !== 'object') return 0;
    const t = coordNum(d.total);
    if (Number.isFinite(t)) return Math.max(0, Math.floor(t));
    return Array.isArray(d.ports) ? d.ports.length : 0;
  }

  // 区域空闲/总数：有端口数据用端口汇总，否则回退概览的 idle_port/total_port
  function areaPortsStat(a) {
    const devs = (a && a.name && areaPorts.value[a.name]) || [];
    if (devs.length) {
      const live = devs.filter((d) => !d.stale);
      if (!live.length) {
        return { free: 0, total: 0, fromPorts: true, stale: true };
      }
      let free = 0;
      let total = 0;
      for (const d of live) {
        free += deviceFreeCount(d);
        total += deviceTotalCount(d);
      }
      if (total > 0) return { free: Math.min(free, total), total, fromPorts: true, stale: false };
    }
    const idle = coordNum(a && a.idle_port);
    const tot = coordNum(a && a.total_port);
    return {
      free: Number.isFinite(idle) ? Math.max(0, Math.floor(idle)) : 0,
      total: Number.isFinite(tot) ? Math.max(0, Math.floor(tot)) : 0,
      fromPorts: false,
      stale: false,
    };
  }

  const maxFreeNow = computed(() => {
    let m = 1;
    for (const x of areas.value) {
      const f = areaPortsStat(x).free;
      if (f > 0) m = Math.max(m, f);
    }
    return m;
  });

  function localScoreOf(a) {
    const d = localDistM(a && a.name);
    if (d === null) return -1;
    const free = areaPortsStat(a).free;
    const distScore = 1 - Math.min(d, 1500) / 1500;
    const idleScore = free / maxFreeNow.value;
    return 0.7 * distScore + 0.3 * idleScore;
  }

  // 筛选状态与端口面板徽章同源同判定（/api/areas-ports 的 state/free/total）：
  // 「探不到」是「没有端口数据」，不是「idle_port 为 0」；没有端口数据才回退概览。
  function areaState(a) {
    if (!a) return 'offline';
    const st = areaPortsStat(a);
    if (st.stale) return 'offline';
    if (st.fromPorts) {
      if (st.free > 0) return 'free';
      if (st.total > 0) return 'full';
    }
    return (coordNum(a.idle_port) || 0) > 0 ? 'free' : 'offline';
  }

  function annotateArea(a) {
    const st = areaPortsStat(a);
    return Object.assign({}, a, { free_port: st.free, ports_total: st.total });
  }

  // 顶部推荐：优先「有空位」的区域；全满时若后端给了可靠 eta，推荐最快能空出来的那个
  const topNow = computed(() => {
    const rows = areas.value.filter((a) => areaState(a) === 'free');
    if (rows.length) return annotateArea(sortRanked(rows)[0]);
    const wait = areas.value
      .map((a) => ({ a, eta: predEtaMinutes(a.name) }))
      .filter((x) => x.eta !== null)
      .sort((x, y) => x.eta - y.eta);
    if (!wait.length) return null;
    return annotateArea(wait[0].a);
  });

  // 顶部推荐卡的预测句：「步行约 X 分钟 · 预计到时 Y 个空位」/「预计约 X 分钟后有空位」
  const topPredictionText = computed(() => {
    const t = topNow.value;
    if (!t) return '';
    return predictionLine(t.name, t.free_port, { about: true, fallback: true });
  });

  const topDelta = computed(() => {
    const n = topNow.value ? nowMap.value.get(topNow.value.name) : null;
    return n ? (coordNum(n.delta) || 0) : 0;
  });

  function nearBoost(a) {
    const d = localDistM(a && a.name);
    return d !== null && d < 200;
  }

  function sortRanked(rows, opts = {}) {
    // opts.favFirst：列表用（收藏置顶，即使已满）；顶部推荐不传，避免收藏干扰推荐
    const favFirst = opts.favFirst === true;
    const freeMap = new Map();
    const countMap = new Map();
    const favMap = new Map();
    const isFree = (x) => {
      const k = x && x.name;
      if (!freeMap.has(k)) freeMap.set(k, areaState(x) === 'free');
      return freeMap.get(k);
    };
    const freeOf = (x) => {
      const k = x && x.name;
      if (!countMap.has(k)) countMap.set(k, areaPortsStat(x).free);
      return countMap.get(k);
    };
    const isFavRow = (x) => {
      if (!favFirst) return 0;
      const k = x && x.name;
      if (!favMap.has(k)) favMap.set(k, isFav(k) ? 0 : 1);
      return favMap.get(k);
    };
    return rows.slice().sort((a, b) => {
      // 收藏置顶（收藏区内部仍走下面的空闲/距离/评分规则）
      const fa = isFavRow(a);
      const fb = isFavRow(b);
      if (fa !== fb) return fa - fb;
      // 按是否有空位分组（与 areaState 同一口径）：没有空位的排到最后
      const ea = isFree(a) ? 0 : 1;
      const eb = isFree(b) ? 0 : 1;
      if (ea !== eb) return ea - eb;
      const na = nearBoost(a) ? 0 : 1;
      const nb = nearBoost(b) ? 0 : 1;
      if (na !== nb) return na - nb; // 200m 内优先提到最前
      if (geo.value) {
        return (localScoreOf(b) - localScoreOf(a)) || (freeOf(b) - freeOf(a));
      }
      return freeOf(b) - freeOf(a);
    });
  }

  // ---- 搜索索引：区域名 + areaPorts 里每台设备的 device_hex / qr_device_no / code（桩号） ----
  const portIndex = computed(() => {
    const srcMap = areaPorts.value || {};
    const m = new Map();
    Object.keys(srcMap).forEach((name) => {
      const devs = Array.isArray(srcMap[name]) ? srcMap[name] : [];
      const keys = [];
      devs.forEach((d) => { keys.push(...deviceKeys(d)); });
      m.set(name, keys);
    });
    return m;
  });

  function areaMatches(a, kw) {
    if (String(a.name).toLowerCase().includes(kw.toLowerCase())) return true;
    return matchesKey(portIndex.value.get(a.name) || [], kw);
  }

  // 全库只有一台设备命中时返回它：用于自动打开所在区域的端口面板并高亮
  function findSingleDevice(kw) {
    const k = String(kw || '').trim().toLowerCase();
    if (!k) return null;
    const srcMap = areaPorts.value || {};
    let found = null;
    let count = 0;
    Object.keys(srcMap).forEach((name) => {
      if (count > 1) return;
      const devs = Array.isArray(srcMap[name]) ? srcMap[name] : [];
      devs.forEach((d) => {
        if (count > 1) return;
        if (matchesKey(deviceKeys(d), k)) {
          count += 1;
          found = { area: name, device: d, key: deviceKey(d) };
        }
      });
    });
    return count === 1 ? found : null;
  }

  const list = computed(() => {
    const kw = q.value.trim();
    const rows = areas.value.filter((a) => {
      if (kw && !areaMatches(a, kw)) return false;
      const st = areaState(a);
      if (areaFilter.value !== 'all' && st !== areaFilter.value) return false;
      return true;
    });
    // 行内主数字与筛选/排序同源：free_port/ports_total 由 areaPortsStat 汇总，缺端口数据才回退概览；
    // fav/pred_text 一并算好，模板里不再逐个调用函数
    return sortRanked(rows, { favFirst: true }).map((a) => {
      const st = areaPortsStat(a);
      return Object.assign({}, a, {
        free_port: st.free,
        ports_total: st.total,
        state: areaState(a),
        fav: isFav(a.name),
        pred_text: predictionLine(a.name, st.free),
      });
    });
  });

  // 统计条：空闲 / 充电中 / 故障 三数汇总（无数据时由 statText 显示占位）
  const sum = computed(() => areas.value.reduce((s, a) => {
    s.idle += a.idle_port; s.charging += a.charging_port; s.fault += a.fault_port; return s;
  }, { idle: 0, charging: 0, fault: 0 }));

  function statText(v) {
    return areas.value.length ? v : '—';
  }

  return {
    // 搜索 / 筛选
    q, areaFilter, filters, list, areaMatches,
    // 收藏
    favs, isFav, toggleFav,
    // 汇总 / 排序 / 推荐
    sum, statText, areaPortsStat, areaState, annotateArea, sortRanked,
    topNow, topPredictionText, topDelta,
    // 距离 / 预测
    distText, localDistM, predictionLine, predictionFor, predEtaMinutes,
    // 搜索索引
    deviceKey, deviceKeys, findSingleDevice, portIndex,
  };
}
