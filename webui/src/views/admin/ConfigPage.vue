<template>
  <div class="a-grid">
    <p v-if="error" class="a-err">{{ error }}</p>

    <!-- 可改设置 -->
    <section class="a-panel a-pad">
      <h2 class="a-small">可运行时修改（写 app_settings，改完立即生效）</h2>
      <table class="a-tbl" style="margin-top:10px">
        <thead><tr><th>键</th><th>值</th><th>说明</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="row in editableRows" :key="row.key">
            <td class="a-mono a-small">{{ row.key }}</td>
            <td>
              <select
v-if="row.type === 'bool'" v-model="draft[row.key]" class="a-select">
                <option :value="true">开</option><option :value="false">关</option>
              </select>
              <select
v-else-if="row.type === 'bool_or_null'" v-model="draft[row.key]" class="a-select">
                <option :value="null">跟随环境变量</option>
                <option :value="true">开</option><option :value="false">关</option>
              </select>
              <select v-else-if="row.type === 'enum'" v-model="draft[row.key]" class="a-select">
                <option v-for="o in row.enum" :key="o" :value="o">{{ o }}</option>
              </select>
              <input v-else-if="row.type === 'number'" v-model.number="draft[row.key]" type="number" class="a-input" style="width:100px" />
              <span v-else class="a-small a-muted">（在节点网络页管理）</span>
            </td>
            <td class="a-small a-muted">{{ row.note || '' }}</td>
            <td>
          <button v-if="canWrite && (isSuper || !SUPER_ONLY_SETTINGS.includes(row.key))" class="a-btn sm" @click="save(row.key)">保存</button>
          <span v-else class="a-small a-muted">仅超管可改</span>
        </td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- 环境变量 -->
    <section class="a-panel a-pad">
      <h2 class="a-small">环境变量（只读，脱敏）</h2>
      <table class="a-tbl" style="margin-top:10px">
        <thead><tr><th>键</th><th>状态</th></tr></thead>
        <tbody>
          <tr v-for="e in env" :key="e.key">
            <td class="a-mono a-small">{{ e.key }}</td>
            <td>
              <span class="a-tag" :class="e.configured ? 'ok' : 'off'">{{ e.configured ? '已配置' : '未配置' }}</span>
              <span v-if="e.value !== null && e.value !== undefined" class="a-small a-muted"> · {{ e.value }}</span>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- 变更历史 -->
    <section class="a-panel a-pad">
      <h2 class="a-small">变更历史</h2>
      <table class="a-tbl" style="margin-top:10px">
        <thead><tr><th>时间</th><th>账号</th><th>键</th><th>旧值</th><th>新值</th></tr></thead>
        <tbody>
          <tr v-for="h in history" :key="h.id">
            <td class="a-small">{{ h.ts }}</td>
            <td class="a-small">{{ h.username || '—' }}</td>
            <td class="a-mono a-small">{{ h.key }}</td>
            <td class="a-mono a-small a-muted">{{ h.old_value ?? '—' }}</td>
            <td class="a-mono a-small">{{ h.new_value ?? '—' }}</td>
          </tr>
          <tr v-if="!history.length"><td colspan="5" class="a-empty">暂无变更</td></tr>
        </tbody>
      </table>
    </section>
  </div>
</template>

<script setup>
import { computed, onActivated, reactive, ref } from 'vue';
import { SUPER_ONLY_SETTINGS, useRole } from './useRole.js';
import { apiGet, apiPost } from '../../api/adminApi.js';

const settings = ref({});
const schema = ref({});
const env = ref([]);
const history = ref([]);
const draft = reactive({});
const error = ref('');
const { isSuper } = useRole();

const editableRows = computed(() => Object.keys(schema.value)
  .filter((k) => k !== 'p2p_extra_peers')
  .map((k) => ({ key: k, ...schema.value[k] })));

async function load() {
  error.value = '';
  try {
    const d = await apiGet('/admin/api/config');
    settings.value = d.settings || {};
    env.value = d.env || [];
    history.value = d.history || [];
    for (const [k, v] of Object.entries(settings.value)) draft[k] = v;
    const me = await apiGet('/admin/api/me');
    schema.value = me.settings_schema || {};
  } catch (e) {
    error.value = e.message || '加载失败';
  }
}

async function save(key) {
  try {
    await apiPost('/admin/api/settings', { key, value: draft[key] });
    await load();
  } catch (e) {
    error.value = e.message || '保存失败';
  }
}

// S1（复审实测）：KeepAlive 让页面只加载一次 —— 切回来是旧数据。
// 用 onActivated 替代 onMounted（首次挂载也会触发，不会双跑）。
onActivated(load);
</script>
