<template>
  <div class="a-grid">
    <p v-if="error" class="a-err">{{ error }}</p>

    <section class="a-panel a-pad">
      <h2 class="a-small">当前版本</h2>
      <dl class="a-kv" style="margin-top:10px">
        <div><dt>服务版本</dt><dd class="a-mono">{{ cur.server_version || '—' }}</dd></div>
        <div><dt>version.json</dt><dd class="a-mono a-small">{{ cur.version_file || '—' }}</dd></div>
        <div><dt>已运行</dt><dd>{{ uptime }}</dd></div>
        <div><dt>待执行更新</dt><dd class="a-mono a-small">{{ upd.pending_request || '无' }}</dd></div>
      </dl>
      <p class="a-small a-muted" style="margin-top:10px">{{ upd.mechanism }}</p>
    </section>

    <section class="a-panel a-pad">
      <h2 class="a-small">触发更新</h2>
      <p class="a-small a-muted">
        后台不直接执行 docker；只写触发文件，由宿主机 systemd timer 在 03:00 执行。
        需立即生效请到服务器手动跑 <code class="a-mono">update-node.sh</code>。
      </p>
      <div class="a-toolbar" style="margin-top:10px">
        <input v-model.trim="tag" class="a-input" placeholder="v2.3.9" />
        <button class="a-btn sm primary" @click="requestUpdate">写入触发</button>
      </div>
    </section>

    <section class="a-panel">
      <div class="a-head"><h2>更新历史（最近 30 行）</h2></div>
      <pre v-if="history.length" class="logpre">{{ history.join('\n') }}</pre>
      <p v-else class="a-empty">没有更新日志（或路径不可读）</p>
    </section>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { apiGet, apiPost } from '../../api/adminApi.js';

const cur = ref({});
const upd = ref({});
const history = ref([]);
const tag = ref('');
const error = ref('');

const uptime = computed(() => {
  const s = Number(cur.value.uptime_sec) || 0;
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d ? `${d} 天 ${h} 小时` : h ? `${h} 小时 ${m} 分` : `${m} 分`;
});

async function load() {
  error.value = '';
  try {
    const d = await apiGet('/admin/api/release');
    cur.value = d.current || {};
    upd.value = d.update || {};
    history.value = d.history || [];
  } catch (e) {
    error.value = e.message || '加载失败';
  }
}

async function requestUpdate() {
  if (!/^v?\d+\.\d+\.\d+$/.test(tag.value)) {
    error.value = '格式应为 vX.Y.Z';
    return;
  }
  try {
    const d = await apiPost('/admin/api/release/update', { tag: tag.value });
    window.alert(d.note || '已写入');
    await load();
  } catch (e) {
    error.value = e.message || '写入失败';
  }
}

onMounted(load);
</script>

<style scoped>
.logpre {
  margin: 0; padding: 10px; max-height: 320px; overflow: auto;
  font-family: var(--font-mono); font-size: 12px; line-height: 1.5;
  background: var(--neutral-bg, #f8fafc); border-radius: var(--r-sm);
  white-space: pre-wrap; word-break: break-all;
}
</style>
