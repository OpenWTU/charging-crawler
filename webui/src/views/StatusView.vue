<template>
  <div class="status-wrap">
    <h2 class="page-title">状态</h2>

    <div v-if="loading && !data" class="state-card">
      <van-loading size="20" /> 正在读取服务器状态…
    </div>
    <div v-else-if="error" class="state-card is-empty">
      <van-icon name="warning-o" class="state-icon is-info" />
      <b>状态读取失败</b>
      <span class="state-sub">{{ errorText }}</span>
      <button type="button" class="state-btn" @click="load">重试</button>
    </div>

    <template v-else-if="data">
      <!-- 服务器 -->
      <section class="status-card">
        <h3>服务器</h3>
        <dl class="kv">
          <div><dt>服务器时间</dt><dd>{{ data.server_time }}</dd></div>
          <div><dt>后端版本</dt><dd>{{ data.server?.version ?? '—' }}</dd></div>
          <div><dt>Node 版本</dt><dd>{{ data.server?.node_version ?? '—' }}</dd></div>
          <div><dt>运行时长</dt><dd>{{ fmtUptime(data.server?.uptime_sec) }}</dd></div>
          <div><dt>内存占用</dt><dd>{{ fmtBytes(data.server?.memory_rss) }}</dd></div>
          <div><dt>数据库大小</dt><dd>{{ fmtBytes(data.server?.db_size) }}</dd></div>
        </dl>
      </section>

      <!-- 数据规模 -->
      <section class="status-card">
        <h3>数据规模</h3>
        <dl class="kv">
          <div><dt>快照总数</dt><dd>{{ data.data?.snapshots ?? 0 }}</dd></div>
          <div><dt>区域数</dt><dd>{{ data.data?.areas ?? 0 }}</dd></div>
          <div><dt>设备数</dt><dd>{{ data.data?.devices ?? 0 }}</dd></div>
          <div><dt>端口数</dt><dd>{{ data.data?.ports ?? 0 }}</dd></div>
          <div><dt>最近数据</dt><dd>{{ data.data?.last_upload ?? '—' }}</dd></div>
        </dl>
      </section>

      <!-- Token 池 -->
      <section class="status-card">
        <h3>登录令牌池</h3>
        <dl class="kv">
          <div><dt>有效 / 总数</dt><dd>{{ data.token_pool?.valid ?? 0 }} / {{ data.token_pool?.count ?? 0 }}</dd></div>
          <div><dt>最早过期</dt><dd>{{ fmtEpoch(data.token_pool?.earliest_exp) }}</dd></div>
          <div><dt>覆盖到</dt><dd>{{ fmtEpoch(data.token_pool?.cover_until) }}</dd></div>
          <div><dt>长效令牌</dt><dd>{{ data.token_pool?.long_lived ?? 0 }} 个</dd></div>
        </dl>
      </section>

      <!-- Worker -->
      <section class="status-card">
        <h3>抓取 Worker</h3>
        <dl class="kv">
          <div><dt>上次结果</dt><dd>{{ data.worker?.last_result ?? '—' }}</dd></div>
          <div><dt>上次运行</dt><dd>{{ data.worker?.last_run ?? '—' }}</dd></div>
          <div><dt>运行次数</dt><dd>{{ data.worker?.runs ?? 0 }}</dd></div>
          <div><dt>进程启动</dt><dd>{{ data.worker?.started_at ?? '—' }}</dd></div>
        </dl>
      </section>

      <!-- 节点 -->
      <section class="status-card">
        <h3>节点（{{ data.p2p_enabled ? 'P2P 已启用' : 'P2P 未启用' }}）</h3>
        <dl class="kv">
          <div><dt>当前节点名称</dt><dd>{{ data.peers?.self_name || short(data.peers?.self) }}</dd></div>
          <div><dt>当前节点 peerId</dt><dd class="mono">{{ short(data.peers?.self) }}</dd></div>
          <div><dt>白名单节点</dt><dd>{{ data.peers?.whitelist ?? 0 }}</dd></div>
          <div><dt>在线节点</dt><dd>{{ data.peers?.online ?? 0 }}</dd></div>
        </dl>
        <div v-if="(data.peers?.nodes || []).length" class="peer-list">
          <div
v-for="n in data.peers.nodes" :key="n.peer_id" class="peer-card"
               :class="{ 'is-clickable': !!n.url }" @click="askSwitch(n)">
            <div class="peer-head">
              <b>{{ n.name || short(n.peer_id) }}</b>
              <span class="tag" :class="n.connected ? 'is-on' : 'is-off'">
                {{ n.connected ? '在线' : '离线' }}
              </span>
            </div>
            <div class="peer-meta">
              <span class="mono">{{ fmtV(n.version) }}</span>
              <small>{{ n.last_seen ? '活跃 ' + n.last_seen : '暂无活跃' }}</small>
            </div>
            <div v-if="n.stats" class="peer-stats">
              <span>快照 {{ n.stats.snapshots }}</span>
              <span>区域 {{ n.stats.areas }}</span>
              <span>设备 {{ n.stats.devices }}</span>
              <span>端口 {{ n.stats.ports }}</span>
            </div>
          </div>
        </div>
        <p v-else class="muted">暂无在线节点（单节点部署时为空，正常）</p>
      </section>

      <!-- 安全 -->
      <section class="status-card">
        <h3>自动拉黑</h3>
        <dl class="kv">
          <div><dt>拉黑设备</dt><dd>{{ data.banlist?.devices ?? 0 }}</dd></div>
          <div><dt>拉黑 IP</dt><dd>{{ data.banlist?.ips ?? 0 }}</dd></div>
        </dl>
      </section>

      <p class="footnote">状态页公开只读，无登录；每 30 秒自动刷新</p>
    </template>
  </div>
</template>

<script setup>
/**
 * 状态页：公开 /status 的可视化（分组：服务器 / 数据 / 令牌池 / worker / 节点 / 拉黑）。
 * 网页端直接 fetch，App 内走 AndroidHost.getStatus 桥（api/status.js 已封装）。
 */
import { onMounted, onUnmounted, ref } from 'vue';
import { showConfirmDialog } from 'vant';
import { getStatus, switchNode } from '../api/status.js';
import { friendlyErrorText } from '../api/transport.js';

const props = defineProps({
  active: { type: Boolean, default: false },
});

const data = ref(null);
const loading = ref(false);
const error = ref('');
const errorText = ref('');
let timer = 0;

async function load() {
  loading.value = true;
  error.value = '';
  try {
    data.value = await getStatus();
  } catch (e) {
    error.value = 'status-load-failed';
    errorText.value = friendlyErrorText(e);
  } finally {
    loading.value = false;
  }
}

/** 点击节点卡片：弹窗确认切换 */
function askSwitch(n) {
  if (!n.url) return;
  showConfirmDialog({
    title: '切换连接节点',
    message: `切换到「${n.name || short(n.peer_id)}」（${n.url}）？`,
    confirmButtonText: '切换',
    cancelButtonText: '取消',
  }).then(() => {
    const ok = switchNode(n.url);
    if (!ok) {
      showConfirmDialog({ title: '提示', message: '当前版本不支持手动切换，请更新 App', confirmButtonText: '知道了' });
    }
  }).catch(() => {});
}

function fmtUptime(sec) {
  const n = Number(sec) || 0;
  const d = Math.floor(n / 86400);
  const h = Math.floor((n % 86400) / 3600);
  const m = Math.floor((n % 3600) / 60);
  if (d > 0) return `${d} 天 ${h} 小时`;
  if (h > 0) return `${h} 小时 ${m} 分`;
  return `${m} 分`;
}

function fmtBytes(b) {
  const n = Number(b) || 0;
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
}

function fmtEpoch(sec) {
  const n = Number(sec);
  if (!n || n <= 0) return '—';
  const d = new Date(n * 1000);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtV(v) {
  if (!v) return '—';
  const s = String(v);
  return s.startsWith('v') ? s : 'v' + s;
}

function short(id) {
  if (!id) return '—';
  const s = String(id);
  return s.length > 18 ? s.slice(0, 10) + '…' + s.slice(-6) : s;
}

onMounted(() => {
  load();
  timer = setInterval(() => {
    if (props.active && !error.value) load();
  }, 30000);
});
onUnmounted(() => clearInterval(timer));
</script>

<style scoped>
.status-wrap { display: flex; flex-direction: column; gap: 12px; padding: 12px; }
.status-card { background: var(--card); border-radius: 10px; padding: 12px; }
.status-card h3 { margin: 0 0 8px; font-size: 14px; }
.kv { margin: 0; display: grid; gap: 6px; }
.kv > div { display: flex; justify-content: space-between; font-size: 13px; }
.kv dt { color: var(--muted, #888); }
.kv dd { margin: 0; font-variant-numeric: tabular-nums; }
.mono { font-family: ui-monospace, monospace; }
.muted { color: var(--muted, #888); font-size: 12px; margin: 6px 0 0; }
.peer-list { margin-top: 8px; display: grid; gap: 8px; }
.peer-card { background: var(--surface-2, #f7f8fa); border-radius: 8px; padding: 10px; display: grid; gap: 6px; }
.peer-card.is-clickable { cursor: pointer; }
.peer-card.is-clickable:active { opacity: 0.75; }
.peer-head { display: flex; justify-content: space-between; align-items: center; font-size: 14px; }
.peer-head .tag { font-size: 11px; padding: 2px 8px; border-radius: 10px; }
.peer-head .tag.is-on { background: var(--ok-bg, #e8f5e9); color: var(--ok, #2e7d32); }
.peer-head .tag.is-off { background: var(--neutral-soft-bg, #f0f0f0); color: var(--muted, #888); }
.peer-meta { display: flex; justify-content: space-between; font-size: 12px; color: var(--muted, #888); }
.peer-stats { display: flex; gap: 10px; flex-wrap: wrap; font-size: 12px; color: var(--text, #333); }
.peer-stats span { background: var(--card, #fff); border-radius: 6px; padding: 3px 8px; }
.footnote { color: var(--muted, #888); font-size: 11px; text-align: center; margin: 4px 0 0; }
</style>
