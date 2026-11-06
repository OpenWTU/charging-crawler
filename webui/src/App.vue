<template>
  <van-config-provider :theme="theme">
    <div class="app">
      <header class="topcard">
        <!-- 刷新进度线：贴在卡片顶部内侧，2.5px 不遮挡任何文字，宽度随进度增长 -->
        <div
v-if="showProgress" class="top-progress" :style="{ width: progressPct + '%' }"
             role="progressbar" :aria-valuenow="progressPct" aria-valuemin="0" aria-valuemax="100"></div>
        <div class="hero-top">
          <div class="hero-text">
            <h1>校园充电桩</h1>
            <p class="sub">{{ subtitle }}</p>
          </div>
          <button
v-if="isApp" class="refresh" type="button"
                  aria-label="刷新数据" @click="refreshNow()">
            <van-icon name="replay" :class="{ spin: refreshing }" />
            <span>刷新</span>
          </button>
          <a v-else class="refresh" href="/admin/login" aria-label="管理员登录">
            <van-icon name="setting-o" />
            <span>管理员</span>
          </a>
        </div>
        <!-- 数据健康条：只展示概览里的新字段，任何字段缺失都退化为「—」，不阻塞主列表 -->
        <div v-if="healthErrorCount > 0" class="health-error" role="alert">
          <van-icon name="warning-o" />
          <span>采集异常 {{ healthErrorCount }} 次，数据可能不是最新</span>
        </div>
        <div v-if="health" class="health" aria-label="数据健康状态">
          <span class="hb" :title="healthScanTitle">
            <i class="hb-dot" :class="scanTone"></i>
            最后更新 <b>{{ healthScanText }}</b>
          </span>
          <span
v-if="healthTokenKnown" class="hb hb-token" :class="tokenHealthClass"
                :title="healthTokenTitle">
            <van-icon name="shield-o" />
            <template v-if="tokenWarnMinutes > 0">令牌约 {{ tokenWarnMinutes }} 分钟后过期</template>
            <template v-else>令牌{{ health.token_ready === false ? '不可用' : '正常' }}<template v-if="tokenCoverText"><span class="hb-exp"> · {{ tokenCoverText }}</span></template></template>
          </span>
        </div>
      </header>

      <div v-if="tokenInvalid || tokenUnset" class="token-alert">
        <van-icon name="warning-o" />
        <div class="token-alert-text">
          <b>{{ tokenUnset ? '尚未设置令牌' : '登录令牌已失效' }}</b>
          <span>{{ tokenUnset ? '去「令牌」页获取后才能刷新实时数据' : '数据可能无法更新，请重新获取令牌' }}</span>
        </div>
        <button type="button" @click="goToken">去获取</button>
      </div>

      <main class="content">
        <section v-show="tab === TAB.LIVE">
          <HomeView
ref="homeRef" :live="live" :active="tab === TAB.LIVE" :now-tick="nowTick"
                    @refresh="refreshNow()" @reload="reload()" @locate="locateNow" />
        </section>

        <section v-show="tab === TAB.ANALYTICS">
          <AnalyticsView :active="tab === TAB.ANALYTICS" :theme="theme" />
        </section>

        <section v-if="isApp" v-show="tab === TAB.TOKEN">
          <TokenPanel :active="tab === TAB.TOKEN" @done="onTokenDone" />
        </section>
        <section v-if="isApp" v-show="tab === TAB.SETTINGS">
          <SettingsSheet
:active="tab === TAB.SETTINGS" :version="appVersion"
                         :checking="upChecking" :theme-pref="themePref"
                         @theme-change="setThemePref"
                         @check-update="checkUpdateNow"
                         @upload-token-change="onUploadTokenChange" />
        </section>
      </main>

      <van-tabbar v-model="tab" fixed safe-area-inset-bottom>
        <van-tabbar-item
v-for="item in tabItems" :key="item.name"
                         :name="item.name" :icon="item.icon">
          {{ item.label }}
        </van-tabbar-item>
      </van-tabbar>

      <UpdateDialog
v-model:show="showUpdate" :up="up" :app-version="appVersion"
                    @install="doUpdate" />
    </div>
  </van-config-provider>
</template>

<script setup>
/**
 * App 装配层：只负责「布局 + 页签 + App 全局桥事件注册」。
 *
 * 数据与行为都在 composables（useLiveData / useRefresh / useUpdate / useTheme / usePolling /
 * useAppBridge），页面在 views/HomeView、views/AnalyticsView，样式在 styles/app.css。
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { showToast } from 'vant';
import { getSettings, isApp } from './api/index.js';
import HomeView from './views/HomeView.vue';
import AnalyticsView from './views/AnalyticsView.vue';
import TokenPanel from './components/TokenPanel.vue';
import SettingsSheet from './components/SettingsSheet.vue';
import UpdateDialog from './components/UpdateDialog.vue';
import { useTheme } from './composables/useTheme.js';
import { useLiveData } from './composables/useLiveData.js';
import { useHealth } from './composables/useHealth.js';
import { useRefresh } from './composables/useRefresh.js';
import { useUpdate } from './composables/useUpdate.js';
import { useIntervals, useAdaptiveTicker } from './composables/usePolling.js';
import { useAppBridge } from './composables/useAppBridge.js';
import { hhmm } from './format.js';
import { validGeo, toGcj, writeGeoCache } from './geo.js';

// ---- 标签页：具名 tab，上传令牌开关只增减页签，不再让数字索引漂移 ----
const TAB = Object.freeze({ LIVE: 'live', ANALYTICS: 'analytics', TOKEN: 'token', SETTINGS: 'settings' });
const uploadTokenOn = ref(true);
const tab = ref(TAB.LIVE);
const homeRef = ref(null);

const tabItems = computed(() => {
  const items = [{ name: TAB.LIVE, icon: 'home-o', label: '实时' }];
  if (!isApp || uploadTokenOn.value) {
    items.push({ name: TAB.ANALYTICS, icon: 'bar-chart-o', label: '分析' });
  }
  if (isApp) {
    items.push({ name: TAB.TOKEN, icon: 'shield-o', label: '令牌' });
    items.push({ name: TAB.SETTINGS, icon: 'setting-o', label: '设置' });
  }
  return items;
});
const tabNames = computed(() => tabItems.value.map((item) => item.name));

function onUploadTokenChange(v) {
  const on = !!v;
  if (uploadTokenOn.value === on) return;
  uploadTokenOn.value = on;
  // 分析页被隐藏时回到实时页，避免停在不可见的页签上
  if (!tabNames.value.includes(tab.value)) tab.value = TAB.LIVE;
}

// ---- 主题 / 数据 / 刷新 / 更新 ----
const { theme, themePref, setThemePref, watchSystem } = useTheme();
const live = useLiveData(showToast);
const {
  areas, updatedAt, health, tokenInvalid, tokenUnset, geo, locateNow,
  reload, loadNow, loadAllPorts, loadAreaCoords, initGeo, trackGeo, loadTokenState,
} = live;

const {
  refreshing, progress, progressPct, showProgress,
  refreshNow, maybeAutoRefresh, onRefreshProgress, onRefreshDone,
} = useRefresh({
  dataAt: live.dataAt,
  reload,
  loadTokenState,
  tokenUnset,
  tokenInvalid,
  onNeedToken: () => { tab.value = TAB.TOKEN; },
});

const { nowTick, start: startTick, resume: resumeTick } = useAdaptiveTicker({
  dataAt: live.dataAt,
  onTick: maybeAutoRefresh,
});

const {
  healthErrorCount, healthTokenKnown, healthScanText, scanTone,
  tokenCoverText, tokenWarnMinutes, tokenHealthClass,
  healthScanTitle, healthTokenTitle,
} = useHealth(health, nowTick);

const {
  appVersion, upChecking, showUpdate, up,
  doUpdate, checkUpdateNow, onUpdateChecking, onUpdateInfo, onUpdateError, autoCheck,
} = useUpdate({ onAfterCheck: maybeAutoRefresh });

// 概览加载成功后的装配：启动节拍 + 端口/坐标 + 自动刷新判定
live.setOnLoaded(() => {
  startTick();
  maybeAutoRefresh();
  loadAllPorts();
  loadAreaCoords();
});

const subtitle = computed(() => {
  if (refreshing.value) return '正在更新 ' + (progress.value || '…');
  if (!live.loaded.value) return ''; // 首屏加载中不显示「本地缓存」的误导文案
  const t = hhmm(updatedAt.value);
  if (!t) return '';
  const base = '更新于 ' + t;
  return areas.value.length ? base + ' · ' + areas.value.length + ' 个区' : base;
});

function goToken() {
  live.clearTokenFlags();
  tab.value = TAB.TOKEN;
}

function onTokenDone() {
  live.clearTokenFlags();
  tab.value = TAB.LIVE;
  // 令牌刚保存/抓取成功：先立即刷新概览，让顶部「令牌正常/不可用」马上反映，
  // 不依赖 refreshNow 的完整链路（其 App 分支可能因原生状态未同步而被拦截）。
  reload();
  refreshNow(true);
}

// ---- App 全局桥事件 ----
const { every, clearAll: clearIntervals } = useIntervals();

function onVisibilityChange() {
  if (document.hidden) return;
  resumeTick();
}

function onNativeLocation(raw) {
  try {
    const g = JSON.parse(raw);
    const c = validGeo(g && g.lat, g && g.lng);
    if (!c) return;
    geo.value = toGcj(c);
    writeGeoCache(geo.value);
    loadNow();
  } catch { /* ignore */ }
}

function onAppResume() {
  reload();
  maybeAutoRefresh();
}

// Android 新事件：window.__onUploadDone(JSON字符串 {ok, msg})。
// 上传失败时明确提示且不刷新端口，避免把旧数据当成本轮上传结果展示。
function onUploadDone(raw) {
  const payload = typeof raw === 'string' ? safeParse(raw) : raw;
  const s = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
  if (s && s.ok === false) {
    showToast('上传失败：' + (s.msg || '请稍后重试'));
    return;
  }
  // 上传发生在 __onRefreshDone 之后：等云端真正写入后再刷新当前端口面板，
  // 并且刷新概览——顶部健康条的 token_ready / 采集异常计数 / 最后更新时间都来自
  // /api/overview，不 reload 会一直显示旧的「令牌不可用」。
  reload();
  if (homeRef.value) homeRef.value.refreshPortsIfOpen();
  loadAllPorts();
  loadNow();
}

// Android OverviewCache 拉取 /api/overview 成功后主动推送（__onOverview）：
// 这是云端 token_pool/健康字段变化时唯一的主动通知，接住它立即刷新健康条。
// 不需要解析 raw——reload() 会重新读 getState 桥，拿到的就是最新缓存。
function onOverview() {
  reload();
}

function safeParse(raw) {
  try { return JSON.parse(raw); } catch { return null; }
}

// Android 返回键：按「最上层弹层优先」关闭并返回 true；无弹层返回 false，
// 由 Android 侧决定是否退到后台（900ms 兜底）。
function onBackPressed() {
  if (showUpdate.value) { showUpdate.value = false; return true; }
  if (homeRef.value && homeRef.value.closeTopLayer()) return true;
  return false;
}

// 全局桥事件统一登记/摘除；清理时同时停掉轮询与监听
const bridge = useAppBridge({
  autoCheck, nativeLocation: onNativeLocation, appResume: onAppResume, backPressed: onBackPressed,
  refreshProgress: onRefreshProgress, refreshDone: onRefreshDone, uploadDone: onUploadDone,
  overview: onOverview,
  updateChecking: onUpdateChecking, updateInfo: onUpdateInfo, updateError: onUpdateError,
});

function teardown() {
  clearIntervals();
  try { document.removeEventListener('visibilitychange', onVisibilityChange); } catch { /* ignore */ }
  bridge.teardown();
}

onMounted(() => {
  // 防重复注册：同一 window 上只允许一套定时器/监听/全局回调
  if (!bridge.mount()) return;

  initGeo(); // 先读坐标缓存：有缓存时首次 loadNow 就带坐标（网页端不自动请求定位）
  reload();
  loadNow();
  loadAllPorts();
  loadAreaCoords();

  // 3 个轮询：定位校正（仅 App）/ 实时推荐 + 概览 / 网页整页刷新，全部登记以便卸载清理
  if (isApp) every(30000, trackGeo);
  // App 端顶部健康条（token_ready / 采集异常 / 最后更新）也来自 /api/overview，
  // 但 App 没有网页端的 30s reload——这里 60s 兜底一次，防止无任何事件时健康条长期停旧。
  every(60000, () => { loadNow(); reload(); });
  if (!isApp) every(30000, () => { reload(); });

  document.addEventListener('visibilitychange', onVisibilityChange);
  startTick();
  watchSystem();

  if (!isApp) return;
  try { uploadTokenOn.value = getSettings().upload_token !== false; } catch { /* ignore */ }
  bridge.scheduleAutoCheck(2600, autoCheck);
});

onUnmounted(teardown);

watch(tab, (v) => {
  // 分析页数据由 AnalyticsView 自己按 active 加载；这里只负责回到实时页时恢复节拍
  if (v === TAB.LIVE) startTick();
});
</script>
