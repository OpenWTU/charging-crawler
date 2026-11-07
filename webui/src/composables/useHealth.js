/**
 * 数据健康条（顶部）的字段解析与文案。
 *
 * 不变量：
 *  - 字段全部来自 /api/overview（旧版 App 桥可能没有），缺失一律退化成「—」/隐藏，
 *    绝不因为健康字段缺失而阻塞主列表或进入错误态；
 *  - 「令牌快过期」只在 token_ready === true 且剩余 ≤15 分钟时提醒，同一次会话只提醒一次。
 */
import { computed, watch } from 'vue';
import { showToast } from 'vant';
import { parseCaptured, toMs, fmtExp, tsText, agoText } from '../format.js';

const TOKEN_WARN_KEY = 'charge_token_warned';

function healthNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 概览返回体 → 健康字段；无可识别字段时返回 null（健康条整体隐藏）。
 */
export function readHealth(d) {
  if (!d || typeof d !== 'object') return null;
  const pool = d.token_pool && typeof d.token_pool === 'object' ? d.token_pool : null;
  const poolValid = pool ? healthNum(pool.valid) : null;
  const h = {
    generated_at: healthNum(d.generated_at),
    last_scan_at: String(d.last_scan_at || d.received_at || ''),
    token_ready: typeof d.token_ready === 'boolean'
      ? d.token_ready
      : (poolValid !== null ? poolValid > 0 : null),
    token_valid: healthNum(d.token_valid != null ? d.token_valid : (pool ? pool.valid : null)),
    earliest_exp: healthNum(d.earliest_exp != null ? d.earliest_exp : (pool ? pool.earliest_exp : null)),
    // 令牌时间的数据来源：有 token_pool 说明来自服务器；否则是本地令牌时间（App 桥降级/旧后端）
    token_source: pool ? 'server' : 'local',
    interval: healthNum(d.interval),
    error_count: healthNum(d.error_count),
    pool,
  };
  const known = h.generated_at !== null || !!h.last_scan_at || h.token_ready !== null
    || h.earliest_exp !== null || h.error_count !== null;
  return known ? h : null;
}

/**
 * @param {import('vue').Ref} health  readHealth() 的结果
 * @param {import('vue').Ref<number>} nowTick 节拍（相对时间随它刷新）
 */
export function useHealth(health, nowTick) {
  const healthErrorCount = computed(() => {
    const n = health.value && health.value.error_count;
    return typeof n === 'number' && n > 0 ? n : 0;
  });
  const healthTokenKnown = computed(() => !!(health.value && health.value.token_ready !== null));
  const healthScanAt = computed(() => {
    const h = health.value;
    if (!h) return 0;
    return parseCaptured(h.last_scan_at) || (h.generated_at ? toMs(h.generated_at) : 0);
  });
  const healthScanText = computed(() => (healthScanAt.value ? agoText(healthScanAt.value, nowTick.value) : '—'));
  const scanTone = computed(() => {
    const at = healthScanAt.value;
    if (!at) return 'is-muted';
    return nowTick.value - at < 15 * 60 * 1000 ? 'is-ok' : 'is-warn';
  });

  // ---- 令牌覆盖时间 + 15 分钟内快过期提醒（P2-7）----
  // 优先 token_pool.cover_until（池里最后覆盖到何时），否则退回 earliest_exp；
  // 两者都缺失时整段隐藏（旧后端/旧桥）。
  const tokenCoverAt = computed(() => {
    const h = health.value;
    if (!h) return 0;
    const p = h.pool;
    const candidates = [p && p.cover_until, h.earliest_exp];
    for (const v of candidates) {
      const ms = toMs(v);
      if (ms > 0) return ms;
    }
    return 0;
  });
  const tokenCoverText = computed(() => {
    const at = tokenCoverAt.value;
    if (!at) return '';
    // 用完整时间（含日期）：跨天时「覆盖到 08:00」看不出是哪天
    const text = tsText(fmtExp(at));
    return text ? '覆盖到 ' + text : '';
  });
  // 剩余分钟（仅令牌确认可用且 ≤15 分钟时 >0；状态未知不提醒，避免误报）
  const tokenWarnMinutes = computed(() => {
    const h = health.value;
    if (!h || h.token_ready !== true) return 0;
    const at = tokenCoverAt.value;
    if (!at) return 0;
    const left = at - nowTick.value;
    if (left <= 0 || left > 15 * 60 * 1000) return 0;
    return Math.max(1, Math.ceil(left / 60000));
  });
  const tokenHealthClass = computed(() => {
    const h = health.value;
    if (tokenWarnMinutes.value > 0) return 'is-warn';
    // 只有「服务器来源且服务器令牌不可用」才标红；
    // 降级到本地令牌且本地未过期时不算异常，不显示警告。
    if (h && h.token_source === 'server' && h.token_ready === false) return 'is-bad';
    return '';
  });

  let tokenWarnShown = false;
  function warnTokenExpiring(mins) {
    if (tokenWarnShown) return;
    tokenWarnShown = true;
    try {
      if (sessionStorage.getItem(TOKEN_WARN_KEY) === '1') return;
      sessionStorage.setItem(TOKEN_WARN_KEY, '1');
    } catch { /* 无 sessionStorage 时只靠本页实例的判重 */ }
    const src = health.value && health.value.token_source === 'local' ? '本地令牌' : '服务器令牌';
    showToast(src + '约 ' + mins + ' 分钟后过期，请到 App 重新抓取');
  }
  watch(tokenWarnMinutes, (m) => { if (m > 0) warnTokenExpiring(m); });

  const healthScanTitle = computed(() => {
    const h = health.value;
    if (!h) return '';
    const parts = [];
    if (h.last_scan_at) parts.push('最后扫描：' + h.last_scan_at);
    if (h.generated_at) parts.push('生成于 ' + tsText(h.generated_at));
    if (h.interval) parts.push('采集间隔 ' + h.interval + ' 秒');
    if (h.error_count !== null) parts.push('最近错误 ' + h.error_count + ' 次');
    return parts.join(' · ');
  });
  const healthTokenTitle = computed(() => {
    const h = health.value;
    if (!h) return '';
    const parts = [];
    const src = h.token_source === 'local' ? '本地令牌' : '服务器令牌池';
    parts.push(src);
    if (h.token_valid !== null) parts.push('有效令牌 ' + h.token_valid + ' 个');
    if (h.earliest_exp !== null) parts.push('最早过期 ' + tsText(h.earliest_exp));
    const p = h.pool;
    if (p) {
      if (p.count !== undefined && p.count !== null
          && p.valid !== undefined && p.valid !== null) {
        parts.push('令牌池 ' + p.valid + '/' + p.count);
      }
      if (p.cover_until) parts.push('覆盖到 ' + tsText(p.cover_until));
      if (p.long_lived !== undefined && p.long_lived !== null) {
        parts.push('长期令牌 ' + (p.long_lived === true ? '是'
          : p.long_lived === false ? '否' : p.long_lived));
      }
    }
    if (tokenWarnMinutes.value > 0) parts.push('约 ' + tokenWarnMinutes.value + ' 分钟后过期');
    return parts.filter(Boolean).join(' · ');
  });

  return {
    healthErrorCount, healthTokenKnown, healthScanAt, healthScanText, scanTone,
    tokenCoverAt, tokenCoverText, tokenWarnMinutes, tokenHealthClass,
    healthScanTitle, healthTokenTitle,
  };
}
