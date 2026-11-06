<template>
  <section
id="admin-panel-areas" class="panel"
           role="tabpanel" aria-labelledby="admin-tab-areas" tabindex="0">
    <div class="panel-head">
      <div>
        <h2>区域</h2>
        <p>上传/抓取只接受这里登记过的充电区；新增区域后 App 才能上报；设置坐标后 App 按距离推荐</p>
      </div>
      <span class="muted">{{ areas.length }} 个区域</span>
    </div>
    <div class="account">
      <div class="form">
        <h3>新增区域</h3>
        <input v-model="areaName" placeholder="区域名称（与平台一致）" />
        <button class="btn" @click="addArea">添加</button>
      </div>
    </div>
    <ul class="list">
      <li v-for="a in areas" :key="a.area_id" class="item">
        <div class="item-head area-row-head">
          <b>{{ a.name }}</b>
          <span class="muted">{{ a.samples }} 条样本 · {{ a.area_id }}</span>
          <span class="coord" :class="{ unset: !areaCoord(a) }">{{ coordLabel(a) }}</span>
          <span class="row-actions">
            <button class="btn ghost sm" @click="startCoordEdit(a)">
              {{ coordEdit === a.name ? '取消' : '设置坐标' }}
            </button>
            <button v-if="!a.samples" class="btn ghost sm" @click="deleteArea(a)">删除</button>
          </span>
        </div>
        <div v-if="coordEdit === a.name" class="coord-form">
          <label class="coord-field">
            纬度
            <input
v-model="coordLat" type="number" step="0.000001" min="-90" max="90"
                   placeholder="如 30.123456" />
          </label>
          <label class="coord-field">
            经度
            <input
v-model="coordLng" type="number" step="0.000001" min="-180" max="180"
                   placeholder="如 114.234567" />
          </label>
          <button class="btn success sm" :disabled="coordSaving" @click="saveCoords(a)">
            {{ coordSaving ? '保存中…' : '保存' }}
          </button>
        </div>
      </li>
    </ul>
  </section>
</template>

<script setup>
/**
 * 区域面板：新增区域、设置/修改坐标、删除无样本区域。
 * 坐标校验在前端先拦一次（纬度 -90~90、经度 -180~180 且非空），失败文案与旧版一致。
 */
import { ref, watch } from 'vue';
import { adminRequest, adminPost } from '../../api/index.js';
import { areaCoord, coordLabel } from './adminFormat.js';
import { useAdminUi } from './adminUi.js';
import { errorText } from './useAdminList.js';

const props = defineProps({
  active: { type: Boolean, default: false },
  refreshToken: { type: Number, default: 0 },
});

const ui = useAdminUi();

const areas = ref([]);
const areaName = ref('');
const coordEdit = ref('');
const coordLat = ref('');
const coordLng = ref('');
const coordSaving = ref(false);
let areasSeq = 0;

async function loadAreas() {
  areasSeq += 1;
  const seq = areasSeq;
  try {
    const d = await adminRequest('/admin/api/areas');
    if (seq !== areasSeq) return false;
    areas.value = Array.isArray(d.rows) ? d.rows : [];
    return true;
  } catch (e) {
    if (seq !== areasSeq) return false;
    areas.value = [];
    ui.showError(e);
    return false;
  }
}

function startCoordEdit(a) {
  if (coordEdit.value === a.name) { coordEdit.value = ''; return; }
  const c = areaCoord(a);
  coordLat.value = c ? String(c.lat) : '';
  coordLng.value = c ? String(c.lng) : '';
  coordEdit.value = a.name;
}

async function saveCoords(a) {
  if (coordSaving.value) return;
  const latRaw = String(coordLat.value == null ? '' : coordLat.value).trim();
  const lngRaw = String(coordLng.value == null ? '' : coordLng.value).trim();
  const lat = Number(latRaw);
  const lng = Number(lngRaw);
  if (!latRaw || !lngRaw || !Number.isFinite(lat) || !Number.isFinite(lng)
      || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    ui.showError(new Error('经纬度不合法：纬度 -90~90，经度 -180~180，且都不能为空'));
    return;
  }
  coordSaving.value = true;
  ui.clearAlerts();
  try {
    await adminPost('/admin/api/areas/coords', { name: a.name, lat, lng });
    await loadAreas();
    coordEdit.value = '';
    ui.showOk(`「${a.name}」坐标已保存`);
  } catch (err) {
    ui.showError(new Error('保存坐标失败：' + errorText(err)));
  } finally {
    coordSaving.value = false;
  }
}

async function addArea() {
  ui.clearAlerts();
  try {
    await adminPost('/admin/api/areas', { name: areaName.value });
    areaName.value = '';
    await loadAreas();
    ui.showOk('区域已添加');
  } catch (err) {
    ui.showError(err);
  }
}

async function deleteArea(a) {
  if (!confirm(`确认删除区域「${a.name}」？`)) return;
  ui.clearAlerts();
  try {
    await adminPost('/admin/api/areas/delete', { area_id: a.area_id });
    await loadAreas();
    ui.showOk('区域已删除');
  } catch (err) {
    ui.showError(err);
  }
}

watch(() => props.active, (v) => { if (v) loadAreas(); }, { immediate: true });
watch(() => props.refreshToken, () => { if (props.active) loadAreas(); });
</script>
