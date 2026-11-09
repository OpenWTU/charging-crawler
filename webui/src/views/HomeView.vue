<template>
  <section>
    <!-- 统计条只属于实时页 -->
    <!--
      统计条在「首屏加载」与「刷新中」都换成脉冲骨架占位：
      原来加载时 statText 返回 '—'，三个破折号并排比数字还显眼，且刷新时会先跳一次旧值再跳新值。
      aria-busy 让读屏器知道这几格正在加载；骨架样式复用 app.css 的 skelPulse。
    -->
    <div class="stats" :aria-busy="busy ? 'true' : 'false'">
      <div class="stat">
        <b v-if="!busy" class="num-idle">{{ statText(sum.idle) }}</b>
        <i v-else class="stat-ph" aria-label="空闲数加载中"></i>
        <span>空闲</span>
      </div>
      <div class="stat">
        <b v-if="!busy" class="num-charging">{{ statText(sum.charging) }}</b>
        <i v-else class="stat-ph" aria-label="充电中数加载中"></i>
        <span>充电中</span>
      </div>
      <div class="stat">
        <b v-if="!busy" class="num-fault">{{ statText(sum.fault) }}</b>
        <i v-else class="stat-ph" aria-label="故障数加载中"></i>
        <span>故障</span>
      </div>
    </div>

    <!-- 首屏三态 + 刷新中：加载占位（不先显示 0/0/0，也不在刷新时闪旧值） -->
    <template v-if="busy">
      <div class="skel skel-search"></div>
      <div v-for="i in 3" :key="i" class="skel skel-row">
        <span class="skel-line w60"></span>
        <span class="skel-line w22"></span>
      </div>
    </template>
    <template v-else>
      <!-- 定位状态条：有坐标时按距离加权推荐，没有坐标时保持按空闲排序 -->
      <div class="geo-bar">
        <span class="geo-hint">
          <van-icon :name="geo ? 'location-o' : 'guide-o'" />
          {{ geo ? '已定位 · 按距离推荐' : '未定位 · 按空闲推荐' }}
        </span>
        <button
class="geo-btn" type="button" :disabled="locating"
                @click="emit('locate', false)">
          {{ locating ? '定位中…' : (geo ? '重新定位' : '开启定位') }}
        </button>
      </div>

      <!-- 首屏三态：加载失败（不再静默） -->
      <div v-if="loadError" class="state-card is-error" role="alert">
        <van-icon name="warning-o" class="state-icon" />
        <b>加载失败</b>
        <span class="state-sub">{{ loadError }}</span>
        <button type="button" class="state-btn" @click="emit('reload')">重试</button>
      </div>

      <template v-if="areas.length">
        <button
v-if="topNow && !q.trim() && areaFilter === 'all'" class="nowcard" type="button"
                @click="focusRow(topNow.name)">
          <span class="nowdot"></span>
          <span>
            建议去 <b>{{ topNow.name }}</b> · 空闲 {{ topNow.free_port }}/{{ topNow.ports_total }}
            <em v-if="topDelta > 0" class="now-delta"> · 近30分钟空闲 +{{ topDelta }} 个</em>
            <em v-if="distText(topNow.name)"> · 距离 {{ distText(topNow.name) }}</em>
            <em v-if="topPredictionText" class="pred-line"> · {{ topPredictionText }}</em>
          </span>
        </button>
        <div class="search">
          <van-icon name="search" />
          <input
v-model="q" placeholder="搜索区域名 / 桩号 / 设备号 / 二维码"
                 aria-label="搜索区域名、桩号、设备号或二维码" />
        </div>
        <div class="filters" role="group" aria-label="筛选充电区">
          <button
v-for="f in filters" :key="f.key" type="button"
                  class="filter-chip" :class="{ active: areaFilter === f.key }"
                  :aria-pressed="areaFilter === f.key ? 'true' : 'false'"
                  @click="areaFilter = f.key">
{{ f.label }}
</button>
        </div>
        <div class="list">
          <div
v-for="a in list" :id="rowId(a.name)" :key="a.name" class="row"
               role="button" tabindex="0"
               :aria-label="a.name + (a.free_port > 0 ? '，空闲 ' + a.free_port + ' 个' : '，已满')"
               :class="{ 'is-highlight': highlightName === a.name }" @click="openCard(a)"
               @keydown.enter.self.prevent="openCard(a)"
               @keydown.space.self.prevent="openCard(a)">
            <div class="row-main">
              <div class="row-title">
                {{ a.name }}
                <span v-if="a.state === 'full'" class="row-full-tag">已满</span>
              </div>
              <div class="row-meta">充电中 {{ a.charging_port }}<template v-if="a.fault_port"> · 故障 {{ a.fault_port }}</template></div>
              <div v-if="a.pred_text" class="row-pred">{{ a.pred_text }}</div>
              <div v-for="d in (areaPorts[a.name] || [])" :key="d.device_hex" class="ports-inline">
                <span
v-for="p in d.ports" :key="p.port" class="port-chip"
                      role="img"
                      :class="'p-' + portTone(p)"
                      :aria-label="'端口 ' + p.port + '，' + portStatusText(portStatus(p))"
                      :title="'端口 ' + p.port + '：' + portStatusText(portStatus(p))">{{ p.port }}<span class="sr-only"> {{ portStatusText(portStatus(p)) }}</span></span>
              </div>
            </div>
            <div class="row-side">
              <button
type="button" class="fav-btn" :class="{ 'is-on': a.fav }"
                      :aria-pressed="a.fav ? 'true' : 'false'"
                      :aria-label="a.fav ? '取消收藏 ' + a.name : '收藏置顶 ' + a.name"
                      :title="a.fav ? '取消收藏' : '收藏置顶'"
                      @click.stop="toggleFav(a.name)" @keydown.stop>
                <van-icon :name="a.fav ? 'star' : 'star-o'" />
              </button>
              <div class="row-num" :class="a.free_port > 0 ? 'num-idle' : 'num-fault'">
                {{ a.free_port }}<small>/{{ a.ports_total }}</small>
              </div>
              <button
v-if="!isApp" type="button" class="row-hist"
                      @click.stop="openHist(a.name)"
                      @keydown.stop>
历史
</button>
              <span v-if="distText(a.name)" class="row-dist">{{ distText(a.name) }}</span>
            </div>
          </div>
          <div v-if="!list.length" class="state-card is-empty">
            <span v-if="q.trim()" class="state-sub">没有匹配「{{ q.trim() }}」的充电区或充电桩</span>
            <span v-else-if="areaFilter === 'free'" class="state-sub">当前没有空闲端口的充电区</span>
            <span v-else-if="areaFilter === 'full'" class="state-sub">当前没有已满的充电区</span>
            <span v-else-if="areaFilter === 'offline'" class="state-sub">当前没有失联的充电区</span>
            <span v-else class="state-sub">暂无充电区数据</span>
          </div>
        </div>
      </template>

      <!-- 首屏三态：空数据（无错误时引导刷新） -->
      <div v-else-if="!loadError" class="state-card is-empty">
        <van-icon name="info-o" class="state-icon is-info" />
        <b>暂无数据，点刷新获取</b>
        <button type="button" class="state-btn" @click="emit('refresh')">刷新</button>
      </div>
    </template>

    <PortSheet
v-model:show="showPorts" :area="portsArea" :devices="portsDevices"
               :summary="portsSummary" :loading="portsLoading" :error="portsError"
               :updated-text="portsUpdatedText" :hit-key="highlightDevice"
               @retry="retryPorts" />

    <AreaCard
v-model:show="showCard" :name="cardName" :area="cardArea"
              :dist-text="cardArea ? distText(cardName) : ''" :pred-text="cardPredText"
              :amap-url="amapUrl" :fav="isFav(cardName)"
              @toggle-fav="toggleFav" @go-amap="goAmap" @open-ports="openPorts" />

    <HistorySheet v-model:show="showHist" :name="histName" />
  </section>
</template>

<script setup>
/**
 * 实时页：统计条、定位条、搜索/筛选、充电区列表、推荐卡，以及三个弹层
 * （端口详情 / 充电区详情 / 历史）。
 *
 * 数据来源：live（App.vue 的 useLiveData()）——区域列表、全区端口、坐标、/api/now、定位；
 * 本组件只持有「页面级 UI 状态」（搜索词、筛选、弹层开关、搜索命中的设备）。
 * 端口色板一律走 group（见 portStatus.js），单行数字/筛选/排序共用 useAreaSelection 的口径。
 */
import { computed, nextTick, onUnmounted, ref, watch } from 'vue';
import PortSheet from '../components/PortSheet.vue';
import AreaCard from '../components/AreaCard.vue';
import HistorySheet from '../components/HistorySheet.vue';
import { getAreaPorts, openAmap, isApp } from '../api/index.js';
import { useAreaSelection } from '../composables/useAreaSelection.js';
import { portTone, portStatus, portStatusText } from '../portStatus.js';
import { agoText, parseCaptured } from '../format.js';
import { coordNum, validGeo, bdToGcj } from '../geo.js';

const props = defineProps({
  // useLiveData() 返回值（含 areas / areaPorts / areaCoords / nowList / geo / 加载态）
  live: { type: Object, required: true },
  // 当前页签是否为实时页（搜索命中自动开面板只在实时页生效）
  active: { type: Boolean, default: true },
  // 节拍时间戳：端口面板「最后更新 x 分钟前」随它刷新
  nowTick: { type: Number, default: 0 },
  // 刷新中（App 抓取 / 手动刷新）：统计条与列表都切加载占位
  refreshing: { type: Boolean, default: false },
});

const emit = defineEmits(['refresh', 'reload', 'locate']);

// 数据源 refs 解构成顶层绑定：模板里直接读（保持响应性）
const { areas, areaPorts, areaCoords, geo, locating, loadError, loaded } = props.live;

const {
  q, areaFilter, filters, list, sum, statText,
  isFav, toggleFav, distText, areaPortsStat, predictionLine,
  topNow, topPredictionText, topDelta, findSingleDevice,
} = useAreaSelection(props.live);

const loading = computed(() => !loaded.value && !loadError.value);
/**
 * 是否展示「加载占位」：首屏未完成，或正在刷新。
 *
 * 只判 loading 的话，点刷新后统计条会先停在上一次的旧数字上，
 * 等新数据回来再跳一次 —— 看起来像"卡住了"。刷新时同样给占位。
 * 加载失败（loadError 非空）不算 busy，要露出错误态与重试按钮。
 */
const busy = computed(() => !loadError.value && (loading.value || props.refreshing));

// ---- 点「建议去」：滚动到对应行并高亮 2 秒（不筛选列表）----
const highlightName = ref('');
// 搜索命中单台桩时，端口面板里高亮该设备（deviceKey 字符串）
const highlightDevice = ref('');
let highlightTimer = 0;
let searchOpenTimer = 0;
let lastSearchOpenQ = '';

function rowId(name) {
  return 'area-' + name;
}

function focusRow(name) {
  if (!name) return;
  // 目标被搜索词或筛选挡住时先还原列表：只清搜索词不够（筛选停在「已满/探不到」时
  // 空闲区域的行根本不在 DOM 里），否则高亮与滚动会静默失效。
  if (!list.value.some((a) => a.name === name)) {
    q.value = '';
    areaFilter.value = 'all';
  }
  highlightName.value = name;
  if (highlightTimer) clearTimeout(highlightTimer);
  highlightTimer = setTimeout(() => {
    highlightTimer = 0;
    highlightName.value = '';
  }, 2000);
  nextTick(() => {
    const el = document.getElementById(rowId(name));
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  });
}

// ---- 端口详情弹层 ----
const showPorts = ref(false);
const portsArea = ref('');
const portsData = ref(null);
const portsLoading = ref(false);
const portsError = ref('');
let portsSeq = 0;

const portsDevices = computed(() => {
  const d = portsData.value;
  return d && Array.isArray(d.devices) ? d.devices : [];
});
// v2 summary：后端给了就用（含计数），没给就是按端口现算的兜底
const portsSummary = computed(() => (portsData.value && portsData.value.summary) || null);
// 端口数据显示「x 分钟前」，随 nowTick 自动刷新
const portsDataAt = computed(() => {
  const d = portsData.value;
  if (!d) return 0;
  let at = parseCaptured(d.updated_at);
  (Array.isArray(d.devices) ? d.devices : []).forEach((x) => {
    const v = parseCaptured(x && x.updated_at);
    if (v > at) at = v;
  });
  return at;
});
const portsUpdatedText = computed(() => (portsDataAt.value ? agoText(portsDataAt.value, props.nowTick) : '—'));

async function loadPorts(name) {
  const seq = ++portsSeq;
  portsLoading.value = true;
  portsError.value = '';
  try {
    const d = await getAreaPorts(name);
    if (seq !== portsSeq) return;
    portsData.value = d || null;
  } catch (e) {
    if (seq !== portsSeq) return;
    portsData.value = null;
    portsError.value = '暂无法获取端口数据';
    console.warn('[area-ports] 加载失败', e);
  } finally {
    if (seq === portsSeq) portsLoading.value = false;
  }
}

async function openPorts(name, hitKey = '') {
  portsArea.value = name;
  portsData.value = null;
  portsError.value = '';
  highlightDevice.value = String(hitKey || '').trim();
  showPorts.value = true;
  await loadPorts(name);
}

function retryPorts() {
  if (portsArea.value) loadPorts(portsArea.value);
}

// 输入防抖：命中唯一设备时自动打开端口面板；同一关键词只自动打开一次
watch(q, (v) => {
  const kw = String(v || '').trim();
  if (searchOpenTimer) { clearTimeout(searchOpenTimer); searchOpenTimer = 0; }
  if (!kw) {
    highlightDevice.value = '';
    lastSearchOpenQ = '';
    return;
  }
  searchOpenTimer = setTimeout(() => {
    searchOpenTimer = 0;
    if (!props.active || showCard.value || kw === lastSearchOpenQ) return;
    const hit = findSingleDevice(kw);
    if (!hit || !hit.key) return;
    lastSearchOpenQ = kw;
    highlightDevice.value = hit.key;
    if (showPorts.value && portsArea.value === hit.area) {
      // 面板已在该区域：滚动交给 PortSheet（hitKey 变化时它自己滚）
      return;
    }
    openPorts(hit.area, hit.key);
  }, 500);
});

// 面板被手动关闭后允许同一关键词再次触发自动打开，但输入不变时不会重复弹
watch(showPorts, (v) => { if (!v) lastSearchOpenQ = ''; });

// ---- 充电区详情弹层 ----
const showCard = ref(false);
const cardName = ref('');
const cardArea = ref(null);

function openCard(a) {
  cardName.value = a && a.name ? a.name : '';
  cardArea.value = a || null;
  showCard.value = true;
}

// 卡片里的到达预测：与列表同一套口径，无定位/无趋势字段时为空串（自动隐藏）
const cardPredText = computed(() => {
  const a = cardArea.value;
  const name = cardName.value;
  if (!a || !name) return '';
  const free = Number.isFinite(coordNum(a.free_port)) ? coordNum(a.free_port) : areaPortsStat(a).free;
  return predictionLine(name, free);
});
const amapUrl = computed(() => {
  const a = areaCoords.value.get(cardName.value)
    || areas.value.find((x) => x && x.name === cardName.value);
  if (!a || !validGeo(a.lat, a.lng)) return '';
  const p = bdToGcj({ lat: a.lat, lng: a.lng });
  return 'https://uri.amap.com/navigation?to=' + p.lng + ',' + p.lat + ','
    + encodeURIComponent(a.name || cardName.value) + '&callnative=1';
});

function goAmap() {
  const a = areaCoords.value.get(cardName.value)
    || areas.value.find((x) => x && x.name === cardName.value);
  if (!a || !validGeo(a.lat, a.lng)) return;
  const p = bdToGcj({ lat: a.lat, lng: a.lng });
  const s = props.geo || null;
  openAmap(cardName.value, p.lat, p.lng, s && s.lat, s && s.lng);
}

// ---- 历史弹层（网页端）----
const showHist = ref(false);
const histName = ref('');

function openHist(name) {
  if (isApp) return;
  histName.value = name;
  showHist.value = true;
}

/**
 * App 返回键：按「最上层弹层优先」关闭；返回 true 表示本组件消费了这次返回。
 * 顺序与旧实现一致：卡片 → 历史 → 端口面板。
 */
function closeTopLayer() {
  if (showCard.value) { showCard.value = false; return true; }
  if (showHist.value) { showHist.value = false; return true; }
  if (showPorts.value) { showPorts.value = false; return true; }
  return false;
}

// 上传完成后（App 侧）：端口面板开着就刷新它，避免把旧数据当本轮结果展示
function refreshPortsIfOpen() {
  if (showPorts.value && portsArea.value) loadPorts(portsArea.value);
}

defineExpose({ closeTopLayer, refreshPortsIfOpen });

// 轻微5：highlightTimer / searchOpenTimer 原来没有在卸载时清
// （HomeView 由 v-show 常驻，影响有限，但计时器应配平）
onUnmounted(() => {
  if (highlightTimer) { clearTimeout(highlightTimer); highlightTimer = 0; }
  if (searchOpenTimer) { clearTimeout(searchOpenTimer); searchOpenTimer = 0; }
});
</script>
