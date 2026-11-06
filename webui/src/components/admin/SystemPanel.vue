<template>
  <section
id="admin-panel-system" class="panel"
           role="tabpanel" aria-labelledby="admin-tab-system" tabindex="0">
    <div class="panel-head">
      <div>
        <h2>系统</h2>
        <p>版本信息与后台任务最近一次运行状态</p>
      </div>
      <span class="muted">只读</span>
    </div>
    <div v-if="error" class="fail">
      <span>系统信息加载失败：{{ error }}</span>
      <button class="btn ghost sm" :disabled="loading" @click="load()">
        {{ loading ? '重试中…' : '重试' }}
      </button>
    </div>
    <div v-else-if="sys" class="sys-grid">
      <div class="sys-card">
        <div class="sys-label">App 版本</div>
        <div class="sys-value">
          {{ sys.version.versionName }}
          <span class="muted">({{ sys.version.versionCode ?? '—' }})</span>
        </div>
      </div>
      <div class="sys-card">
        <div class="sys-label">后台任务最近运行</div>
        <div class="sys-value mono">{{ sys.worker.last_run || '—' }}</div>
        <div class="sys-sub">
          结果：<span class="mono">{{ resultText(sys.worker.last_result) }}</span>
          · 来源 {{ workerSource }}
        </div>
      </div>
      <div class="sys-card">
        <div class="sys-label">管理员账号</div>
        <div class="sys-value">{{ sys.admin_user || '—' }}</div>
        <div class="sys-sub">{{ sys.admin_configured ? '已配置环境变量' : '未配置' }}</div>
      </div>
      <div class="sys-card">
        <div class="sys-label">服务器时间</div>
        <div class="sys-value mono">{{ sys.server_time }}</div>
        <div class="sys-sub">Python {{ sys.python }}</div>
      </div>
      <div class="sys-card">
        <div class="sys-label">快照总数</div>
        <div class="sys-value">{{ sys.snapshot_count }}</div>
        <div class="sys-sub">全部来源（App + 后台任务）</div>
      </div>
      <div class="sys-card">
        <div class="sys-label">后台任务调度</div>
        <div class="sys-value">启动后 30s 首跑，之后每 10 分钟</div>
        <div class="sys-sub">本次进程已跑 {{ sys.worker.runs }} 次</div>
      </div>
    </div>
    <div v-else class="empty">加载中…</div>
  </section>
</template>

<script setup>
/**
 * 系统面板（只读）：版本、后台任务最近运行、账号、服务器时间、快照总数。
 * 加载失败只影响本面板，显示「重试」。
 */
import { computed, ref, watch } from 'vue';
import { adminRequest } from '../../api/index.js';
import { resultText } from './adminFormat.js';
import { errorText } from './useAdminList.js';

const props = defineProps({
  active: { type: Boolean, default: false },
  refreshToken: { type: Number, default: 0 },
});

const data = ref(null);
const loading = ref(false);
const error = ref('');
let seq = 0;

const sys = computed(() => data.value);

const workerSource = computed(() => {
  const map = { memory: '内存', log: '日志', none: '—' };
  return map[data.value?.worker?.source] || '—';
});

async function load() {
  seq += 1;
  const mine = seq;
  loading.value = !data.value;
  error.value = '';
  try {
    const d = await adminRequest('/admin/api/system');
    if (mine !== seq) return false;
    data.value = d;
    return true;
  } catch (err) {
    if (mine !== seq) return false;
    error.value = errorText(err);
    return false;
  } finally {
    if (mine === seq) loading.value = false;
  }
}

watch(() => props.active, (v) => {
  if (!v) return;
  if (data.value && !error.value) return;
  load();
}, { immediate: true });

watch(() => props.refreshToken, () => { if (props.active) load(); });
</script>
