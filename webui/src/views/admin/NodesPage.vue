<template>
  <div class="a-grid">
    <p v-if="error" class="a-err">{{ error }}</p>

    <!-- 策略 -->
    <section class="a-panel a-pad">
      <div class="a-toolbar">
        <h2>P2P 策略</h2>
        <span class="a-spacer" />
        <button class="a-btn sm" @click="load">刷新</button>
      </div>
      <dl class="a-kv" style="margin-top:10px">
        <div><dt>P2P</dt><dd>{{ policy.enabled ? (policy.running ? '已启动' : '已启用未启动') : '未启用' }}</dd></div>
        <div><dt>白名单</dt><dd>{{ policy.whitelist_count }}（GitHub {{ policy.github_count }} / 本地 {{ policy.local_count }}）</dd></div>
        <div><dt>互校模式</dt><dd>{{ policy.validate_mode }}</dd></div>
        <div>
          <dt>采纳非白名单数据</dt>
          <dd>
            <select v-if="isSuper" class="a-select" :value="policy.trust_non_whitelist === null ? 'null' : String(policy.trust_non_whitelist)" @change="setTrust($event.target.value)">
              <option value="null">跟随环境变量（当前 {{ policy.trust_non_whitelist_effective ? '接受' : '丢弃' }}）</option>
              <option value="true">接受</option>
              <option value="false">丢弃</option>
            </select>
          </dd>
        </div>
      </dl>
    </section>

    <!-- 节点表 -->
    <section class="a-panel">
      <div class="a-head"><h2>节点（{{ peers.length }}）</h2></div>
      <table class="a-tbl">
        <thead>
          <tr>
            <th>名称</th><th>版本</th><th>白名单</th><th>在线</th><th>可信度</th>
            <th>地址</th><th class="num">快照</th><th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="p in peers" :key="p.peer_id">
            <td>{{ p.name || (p.peer_id || '').slice(0, 12) }}</td>
            <td class="a-mono a-small">{{ p.version || '—' }}</td>
            <td>
              <span class="a-tag" :class="p.whitelisted ? 'ok' : 'warn'">{{ p.whitelisted ? '已登记' : '未受信' }}</span>
            </td>
            <td><span class="a-tag" :class="p.connected ? 'ok' : 'off'">{{ p.connected ? '在线' : '离线' }}</span></td>
            <td class="a-small">
              <template v-if="p.credibility">
                {{ p.credibility.pass }}/{{ p.credibility.pass + p.credibility.fail }}
                <span v-if="p.credibility.rate !== null" class="a-muted">({{ Math.round(p.credibility.rate * 100) }}%)</span>
              </template>
              <span v-else class="a-muted">—</span>
            </td>
            <td class="a-mono a-small wrap">{{ p.addr || p.url || '—' }}</td>
            <td class="num">{{ p.stats?.snapshots ?? 0 }}</td>
            <td>
              <button class="a-btn sm" @click="viewValidation(p.peer_id)">互校</button>
              <button v-if="canWrite" class="a-btn sm" @click="disconnect(p.peer_id)">断开</button>
            </td>
          </tr>
          <tr v-if="!peers.length"><td colspan="8" class="a-empty">暂无其他节点</td></tr>
        </tbody>
      </table>
    </section>

    <!-- 设备可信度（App 上传的合理性判定） -->
    <section class="a-panel">
      <div class="a-head">
        <h2>设备可信度（{{ devices.length }}）</h2>
        <span class="a-muted a-small">App 上传时与本节点 ±10 分钟历史快照比对；偏差超阈值的记为可疑（仍入库，只打 _suspect 标记）</span>
      </div>
      <table v-if="devices.length" class="a-tbl">
        <thead>
          <tr>
            <th>设备</th>
            <th class="num">通过</th>
            <th class="num">可疑</th>
            <th class="num">总数</th>
            <th class="num">平均偏差</th>
            <th>最近判定</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="d in devices" :key="d.device_id">
            <td class="a-mono a-small wrap">{{ (d.device_id || '').slice(0, 20) }}…</td>
            <td class="num">{{ d.pass }}</td>
            <td class="num">
              <span v-if="d.suspect" class="a-tag warn">{{ d.suspect }}</span>
              <span v-else class="a-muted">0</span>
            </td>
            <td class="num">{{ d.total }}</td>
            <td class="num">{{ d.avg_deviation === null ? '—' : d.avg_deviation }}</td>
            <td class="a-small">{{ d.last_ts || '—' }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else class="a-muted a-small" style="padding:12px">
        暂无记录。设备上传时若能在 ±10 分钟内找到本节点的历史快照，就会产生一条判定；
        连续两次上传间隔超过 10 分钟会被判为「无基准」而不记录。
      </p>
    </section>

    <!-- 白名单管理 -->
    <section class="a-panel a-pad">
      <h2 class="a-small">白名单（本地覆盖层）</h2>
      <p class="a-small a-muted">
        生效 = GitHub nodes.json ∪ 本地覆盖层，按 peerId 去重（本地字段优先）。
        从 GitHub 来的只能改仓库；本地层可随时增删，改完热更新不重启。
      </p>
      <div class="a-toolbar" style="margin:10px 0">
        <input v-model.trim="form.peerId" class="a-input" placeholder="peerId（12D3Koo…）" style="min-width:280px" />
        <input v-model.trim="form.addr" class="a-input" placeholder="/ip4/x.x.x.x/tcp/4001" />
        <input v-model.trim="form.url" class="a-input" placeholder="https://..." />
        <input v-model.trim="form.name" class="a-input" placeholder="名称" />
        <button v-if="canWrite" class="a-btn sm primary" @click="addPeer">加入白名单</button>
      </div>
      <table class="a-tbl">
        <thead><tr><th>来源</th><th>peerId / 名称</th><th>地址</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="id in whitelist.github" :key="'g' + id">
            <td><span class="a-tag info">nodes.json</span></td>
            <td class="a-mono a-small">{{ (id || '').slice(0, 20) }}…</td>
            <td class="a-muted a-small">需改仓库</td>
            <td><span class="a-small a-muted">不可在此删除</span></td>
          </tr>
          <tr v-for="p in whitelist.local" :key="'l' + p.peerId">
            <td><span class="a-tag ok">本地</span></td>
            <td>
              <span class="a-mono a-small">{{ (p.peerId || '').slice(0, 20) }}…</span>
              <span v-if="p.name" class="a-muted"> · {{ p.name }}</span>
            </td>
            <td class="a-mono a-small">{{ p.addr || p.url || '—' }}</td>
            <td><button v-if="canWrite" class="a-btn sm danger" @click="removePeer(p.peerId)">删除</button></td>
          </tr>
          <tr v-if="!whitelist.github.length && !whitelist.local.length">
            <td colspan="4" class="a-empty">白名单为空</td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- 互校明细 -->
    <div v-if="validation" class="a-drawer-mask" role="dialog" aria-modal="true" @click.self="validation = null">
      <aside class="a-drawer">
        <header>
          <h2>互校判定</h2>
          <button class="a-btn sm" @click="validation = null">关闭</button>
        </header>
        <p class="a-small a-muted">
          通过 {{ validation.stats.pass }} · 未通过 {{ validation.stats.fail }} · 无基准 {{ validation.stats.unknown }}
        </p>
        <table class="a-tbl">
          <thead><tr><th>时间</th><th>判定</th><th class="num">偏差</th><th>原因</th></tr></thead>
          <tbody>
            <tr v-for="v in validation.items" :key="v.id">
              <td class="a-small">{{ v.ts }}</td>
              <td>
                <span class="a-tag" :class="v.decision === 'accept' ? 'ok' : v.decision === 'suspect' ? 'warn' : 'err'">
                  {{ v.decision }}
                </span>
              </td>
              <td class="num">{{ v.deviation === null ? '—' : (v.deviation * 100).toFixed(0) + '%' }}</td>
              <td class="a-small a-muted">{{ v.reason }}</td>
            </tr>
            <tr v-if="!validation.items.length"><td colspan="4" class="a-empty">暂无判定记录</td></tr>
          </tbody>
        </table>
      </aside>
    </div>
  </div>
</template>

<script setup>
import { reactive, ref } from 'vue';
import { usePageLoad } from './usePageLoad.js';
import { useRole } from './useRole.js';
import { apiDelete, apiGet, apiFetch, apiPost } from '../../api/adminApi.js';

const error = ref('');
const policy = ref({});
const peers = ref([]);
const devices = ref([]);
const whitelist = ref({ github: [], local: [] });
const validation = ref(null);
const form = reactive({ peerId: '', addr: '', url: '', name: '' });
const { canWrite, isSuper } = useRole();

async function load() {
  error.value = '';
  try {
    const d = await apiGet('/admin/api/nodes');
    policy.value = d.policy || {};
    peers.value = d.peers || [];
    whitelist.value = d.whitelist || { github: [], local: [] };
    // 设备可信度单独一个接口：失败不该连累上面的节点信息
    try {
      const c = await apiGet('/admin/api/device-credibility');
      devices.value = c.devices || [];
    } catch {
      devices.value = [];
    }
  } catch (e) {
    error.value = e.message || '加载失败';
  }
}

async function setTrust(v) {
  const value = v === 'null' ? null : v === 'true';
  try {
    await apiFetch('/admin/api/nodes/policy', { method: 'PATCH', body: { trust_non_whitelist: value } });
    await load();
  } catch (e) {
    error.value = e.message || '设置失败';
  }
}

async function addPeer() {
  if (!form.peerId) { error.value = '请填 peerId'; return; }
  try {
    await apiPost('/admin/api/nodes/whitelist', { ...form });
    form.peerId = ''; form.addr = ''; form.url = ''; form.name = '';
    await load();
  } catch (e) {
    error.value = e.message || '添加失败';
  }
}

async function removePeer(peerId) {
  if (!window.confirm('从本地白名单移除？')) return;
  try {
    await apiDelete(`/admin/api/nodes/whitelist/${encodeURIComponent(peerId)}`);
    await load();
  } catch (e) {
    error.value = e.message || '删除失败';
  }
}

async function viewValidation(peerId) {
  try {
    validation.value = await apiGet(`/admin/api/nodes/${encodeURIComponent(peerId)}/validation`);
  } catch (e) {
    error.value = e.message || '加载失败';
  }
}

async function disconnect(peerId) {
  if (!window.confirm('断开该节点连接？')) return;
  try {
    await apiPost('/admin/api/nodes/disconnect', { peer_id: peerId });
    await load();
  } catch (e) {
    error.value = e.message || '断开失败';
  }
}

// S1（复审实测）：KeepAlive 让页面只加载一次 —— 切回来是旧数据。
// 用 onActivated 替代 onMounted（首次挂载也会触发，不会双跑）。
usePageLoad(load);
</script>
