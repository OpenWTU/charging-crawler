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
          <span v-else class="a-small a-muted">
            {{ SUPER_ONLY_SETTINGS.includes(row.key) ? '仅超管可改' : '需要运维及以上权限' }}
          </span>
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
import { computed, reactive, ref } from 'vue';
import { usePageLoad } from './usePageLoad.js';
import { SUPER_ONLY_SETTINGS, useRole } from './useRole.js';
import { apiGet, apiPost } from '../../api/adminApi.js';

const settings = ref({});
const schema = ref({});
const env = ref([]);
const history = ref([]);
const draft = reactive({});
const error = ref('');
// S6: 原来只解构 isSuper，模板用 canWrite 得到 undefined
// → 超管也看不到任何保存按钮（生产构建剥掉了 dev 警告，CDP 抓不到）
const { isSuper, canWrite } = useRole();

const editableRows = computed(() => Object.keys(schema.value)
  .filter((k) => k !== 'p2p_extra_peers')
  .map((k) => ({ key: k, ...schema.value[k] })));

// L12（复审）：切回时不要丢掉未保存的草稿 —— 只在「首次加载」时初始化 draft
let draftInited = false;

async function load() {
  error.value = '';
  try {
    const d = await apiGet('/admin/api/config');
    settings.value = d.settings || {};
    env.value = d.env || [];
    history.value = d.history || [];
    // L12：切回时只更新 settings，不覆盖已编辑的草稿（否则未保存的修改被静默丢弃）
    for (const [k, v] of Object.entries(settings.value)) {
      // 4（终审）：新出现的设置键（部署新增 key、页面还没刷新过）也要进 draft，
      // 否则那一行空白、保存会发 undefined
      if (!draftInited || !(k in draft)) draft[k] = v;
    }
    draftInited = true;
    const me = await apiGet('/admin/api/me');
    schema.value = me.settings_schema || {};
  } catch (e) {
    error.value = e.message || '加载失败';
  }
}

// 3（终审）：保存后 load() 不再回写 draft —— 这是有意的取舍：保住用户正在编辑的内容。
// 代价：若后端对值做了归一化/钳制，表格会显示未归一化的草稿值直到下次进页面。
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
usePageLoad(load);
</script>
