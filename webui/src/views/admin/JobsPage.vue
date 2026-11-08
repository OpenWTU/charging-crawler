<template>
  <div class="a-grid">
    <p v-if="error" class="a-err">{{ error }}</p>

    <section class="a-cards">
      <div class="a-card">
        <div class="lbl">worker 状态</div>
        <div class="val a-small">{{ worker.last_result || '未运行' }}</div>
        <div class="sub">累计 {{ stats.total }} 轮，成功 {{ stats.ok }}</div>
      </div>
      <div class="a-card">
        <div class="lbl">最近一轮</div>
        <div class="val a-small">{{ worker.last_run || '—' }}</div>
        <div class="sub">运行次数 {{ worker.runs ?? 0 }}</div>
      </div>
    </section>

    <section class="a-panel a-pad">
      <div class="a-toolbar">
        <button class="a-btn sm primary" :disabled="busy" @click="run">{{ busy ? '已触发…' : '立即抓取一轮' }}</button>
        <button class="a-btn sm" @click="load">刷新</button>
        <span class="a-spacer" />
        <button class="a-btn sm" @click="purge">清理 30 天前记录</button>
      </div>
    </section>

    <section class="a-panel">
      <div class="a-head"><h2>轮次历史（最近 20）</h2></div>
      <table class="a-tbl">
        <thead><tr><th>时间</th><th>结果</th></tr></thead>
        <tbody>
          <tr v-for="r in runs" :key="r.id">
            <td class="a-small">{{ r.ts }}</td>
            <td>
              <span class="a-tag" :class="/ok/.test(r.result) ? 'ok' : 'warn'">{{ r.result }}</span>
            </td>
          </tr>
          <tr v-if="!runs.length"><td colspan="2" class="a-empty">暂无记录</td></tr>
        </tbody>
      </table>
    </section>

    <section class="a-panel a-pad">
      <h2 class="a-small">定时任务</h2>
      <table class="a-tbl">
        <thead><tr><th>任务</th><th>计划</th><th>备注</th></tr></thead>
        <tbody>
          <tr v-for="t in timers" :key="t.name">
            <td>{{ t.name }}</td>
            <td class="a-small">{{ t.schedule }}</td>
            <td class="a-small a-muted">{{ t.note || (t.last ? '上次 ' + t.last : '—') }}</td>
          </tr>
        </tbody>
      </table>
    </section>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue';
import { apiGet, apiPost } from '../../api/adminApi.js';

const worker = ref({});
const runs = ref([]);
const stats = ref({ total: 0, ok: 0 });
const timers = ref([]);
const error = ref('');
const busy = ref(false);

async function load() {
  error.value = '';
  try {
    const d = await apiGet('/admin/api/jobs');
    worker.value = d.worker || {};
    runs.value = d.runs || [];
    stats.value = d.stats || { total: 0, ok: 0 };
    timers.value = d.timers || [];
  } catch (e) {
    error.value = e.message || '加载失败';
  }
}

async function run() {
  busy.value = true;
  try {
    await apiPost('/admin/api/jobs/worker/run', {});
    window.alert('已触发，约 10–30 秒后刷新可看结果');
    setTimeout(load, 15000);
  } catch (e) {
    error.value = e.message || '触发失败';
  } finally {
    busy.value = false;
  }
}

async function purge() {
  if (!window.confirm('删除 30 天前的轮次记录？')) return;
  try {
    const d = await apiPost('/admin/api/jobs/worker-runs/purge', { before_days: 30 });
    window.alert(`已删除 ${d.deleted} 条`);
    await load();
  } catch (e) {
    error.value = e.message || '清理失败';
  }
}

onMounted(load);
</script>
