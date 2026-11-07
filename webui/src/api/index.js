/**
 * 数据层统一再导出：页面只从 '../api/index.js'（或旧路径 './api.js'）取接口，
 * 不直接依赖内部模块划分。拆分后原有具名导出一个不少，调用方式零改动。
 */
export { isApp } from './transport.js';

// 区域维度
export {
  getOverview, getNow, getHistory, getAreaCoords, getAreasPorts,
  getLocation, openAmap, refreshData, refreshWeb,
} from './areas.js';

// 端口维度（含 v2 group / summary 兼容层）
export {
  getAreaPorts, getPile, portGroupOf, portStatusOf, PORT_GROUPS,
  normalizeDevices, normalizePortsPayload, summarizePorts,
} from './ports.js';

// 分析
export { getAnalytics, getFreeRate } from './analytics.js';

// App 原生桥命令
export {
  getSettings, setUploadToken, clearToken, saveToken, captureToken,
  startDiagnose, stopDiagnose, showLog, checkUpdate, startUpdate, setDarkMode,
} from './native.js';

// 管理后台（/admin/api/*）
export { request as adminRequest, postJSON as adminPost, exportCsv, logout } from './admin.js';
