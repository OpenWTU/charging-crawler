/**
 * 实时数据层：概览（区域列表/更新时间/健康字段）、全区端口、区域坐标、/api/now、定位。
 *
 * 不变量：
 *  1. 首屏三态：loaded（是否完成过一次加载）/ loadError（最近一次失败原因），
 *     loading = 未完成且无错误；失败不再静默，可重试；
 *  2. 端口与坐标加载失败时**保留上一份数据**，绝不清空（否则行内端口 chip 全消失、
 *     筛选口径突然回退）；
 *  3. 每个请求都带序号，迟到的旧响应直接丢弃；
 *  4. 定位失败永不抛错，只在用户主动点击时提示。
 */
import { computed, ref } from 'vue';
import {
  getOverview, getAreasPorts, getAreaCoords, getNow, getLocation, getSettings, isApp,
} from '../api/index.js';
import {
  validGeo, toGcj, gcjToBd, distanceM, readGeoCache, writeGeoCache, clearGeoCache,
} from '../geo.js';
import { parseCaptured } from '../format.js';
import { readHealth } from './useHealth.js';

export function useLiveData(notify) {
  const toast = typeof notify === 'function' ? notify : () => {};
  // 概览加载成功后的装配回调（启动节拍、刷新端口/坐标、自动刷新判定…），
  // 由 App.vue 注入，数据层不反向依赖 UI。
  let onLoaded = null;
  function setOnLoaded(fn) { onLoaded = typeof fn === 'function' ? fn : null; }

  const areas = ref([]);
  const updatedAt = ref('');
  // 概览里的健康字段（generated_at / last_scan_at / token_ready / error_count ...），
  // 老版本 App 桥没有这些字段时为 null，健康条整体隐藏，不影响列表。
  const health = ref(null);
  const loaded = ref(false);
  const loadError = ref('');
  const loading = computed(() => !loaded.value && !loadError.value);

  const areaPorts = ref({});
  const areaCoords = ref(new Map());
  const nowList = ref([]);

  // 令牌态：token_present=false 时区分「从未设置」与「已失效」（有历史 expires_at 才算失效）
  const tokenInvalid = ref(false);
  const tokenUnset = ref(false);

  // 定位 + 距离权重排序：坐标缓存有效期内复用，不重复请求定位；
  // 网页端只有用户点「开启定位」才请求，失败不打扰用户。
  const geo = ref(null); // { lat, lng } | null
  const locating = ref(false);

  let nowSeq = 0;
  let reloadSeq = 0;

  const dataAt = computed(() => parseCaptured(updatedAt.value));

  function loadTokenState() {
    if (!isApp) return;
    try {
      const s = getSettings() || {};
      if (s.token_present === false) {
        tokenInvalid.value = Number(s.expires_at || 0) > 0;
        tokenUnset.value = !tokenInvalid.value;
      } else {
        tokenInvalid.value = false;
        tokenUnset.value = false;
      }
    } catch { /* 读取失败时保持上一次状态 */ }
  }

  function clearTokenFlags() {
    tokenInvalid.value = false;
    tokenUnset.value = false;
  }

  async function loadAreaCoords() {
    try {
      const d = await getAreaCoords();
      const m = new Map();
      (d.areas || []).forEach((a) => { if (a && a.name) m.set(a.name, a); });
      if (m.size) areaCoords.value = m; // 空结果不清空已有坐标，避免距离突然消失
    } catch { /* ignore */ }
  }

  // 端口数据失败/超时：保留上一份，绝不清空
  async function loadAllPorts() {
    try {
      const d = await getAreasPorts();
      const rows = d && Array.isArray(d.areas) ? d.areas : null;
      if (!rows) {
        console.warn('[areas-ports] 返回形状异常，保留上一份端口数据');
        return;
      }
      const m = {};
      rows.forEach((a) => {
        if (a && a.area) m[a.area] = Array.isArray(a.devices) ? a.devices : [];
      });
      areaPorts.value = m;
    } catch (e) {
      console.warn('[areas-ports] 加载失败，保留上一份端口数据', e);
    }
  }

  async function loadNow() {
    const seq = ++nowSeq;
    try {
      const c = geo.value;
      const cbd = c ? gcjToBd(c) : null;
      const d = await getNow(cbd && cbd.lat, cbd && cbd.lng);
      if (seq !== nowSeq) return; // 期间又发起了新请求（如定位完成）：以最新一次为准
      nowList.value = (d && d.areas) || [];
    } catch {
      // 保留上一份 nowList：刷新/上传期间请求超时不应让推荐与预测瞬间消失
    }
  }

  /**
   * 概览加载：成功 → 覆盖区域列表/更新时间/健康字段，并触发 onLoaded 装配；
   * 失败 → 记录 loadError（首屏显示「加载失败 · 重试」），不阻塞健康条/端口面板。
   */
  async function reload() {
    const seq = ++reloadSeq;
    try {
      const d = await getOverview();
      if (seq !== reloadSeq) return;
      areas.value = (d.snapshot && d.snapshot.areas) || [];
      updatedAt.value = (d.snapshot && d.snapshot.captured_at) || '';
      // 健康条字段与列表同源，但解析失败也只清空健康条，不触发列表错误态
      try { health.value = readHealth(d); } catch { health.value = null; }
      loadError.value = '';
      loaded.value = true;
      loadTokenState();
      if (onLoaded) onLoaded();
    } catch (e) {
      if (seq !== reloadSeq) return;
      // 不再静默：记录失败原因，首屏显示「加载失败 · 重试」
      loaded.value = true;
      loadError.value = friendlyMsg(e);
      console.warn('[overview] 加载失败', e);
    }
  }

  function friendlyMsg(e) {
    const msg = (e && (e.message || String(e))) || '';
    if (!msg || /failed to fetch|networkerror|load failed|network request failed/i.test(msg)) {
      return '网络连接失败，请检查网络后重试';
    }
    return msg;
  }

  async function locateNow(silent = false) {
    if (locating.value) return;
    locating.value = true;
    try {
      const c = await getLocation(); // 永不抛错；失败返回 null
      if (!c) {
        const had = !!geo.value;
        clearGeoCache();
        if (!silent) toast('未获取到定位，请检查定位权限');
        if (had) { geo.value = null; await loadNow(); }
        return;
      }
      geo.value = toGcj(c);
      writeGeoCache(geo.value);
      if (!silent) toast('已定位 · 按距离推荐');
      await loadNow(); // 用坐标重新取 score / distance_m
    } catch (e) {
      if (!silent) toast('定位失败，请稍后重试');
      console.warn('[geo] 定位失败', e);
    } finally {
      locating.value = false;
    }
  }

  function initGeo() {
    const cached = readGeoCache();
    if (cached) { geo.value = cached; return; } // 5 分钟内直接复用，不请求定位
    if (isApp) locateNow(true); // App 原生定位无权限弹窗；网页端等用户点「开启定位」
  }

  // App 每 30s 校正一次位置（仅 App）
  async function trackGeo() {
    if (!isApp || document.hidden || !geo.value) return;
    try {
      const g = await getLocation();
      if (validGeo(g && g.lat, g && g.lng)) {
        const gcj = toGcj(g);
        const moved = distanceM(geo.value.lat, geo.value.lng, gcj.lat, gcj.lng);
        if (moved > 2) {
          geo.value = gcj;
          writeGeoCache(geo.value);
        }
      }
    } catch { /* ignore */ }
  }

  return {
    areas, updatedAt, health, loaded, loadError, loading, dataAt,
    areaPorts, areaCoords, nowList,
    tokenInvalid, tokenUnset, loadTokenState, clearTokenFlags,
    geo, locating, locateNow, initGeo, trackGeo,
    reload, loadNow, loadAllPorts, loadAreaCoords, setOnLoaded,
  };
}
