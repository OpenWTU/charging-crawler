/**
 * 数据层入口（兼容层）。
 *
 * 原 526 行单文件已拆到 ./api/ 下：
 *   transport.js  传输基座（fetch 超时/错误分类/重试、JS 桥原语）
 *   areas.js      区域维度接口（overview / now / coords / history / 定位 / 刷新）
 *   ports.js      端口维度接口 + 数据契约 v2（group / summary）兼容层
 *   analytics.js  分析页接口（analytics / free-rate）
 *   native.js     App 原生桥命令（设置 / 令牌 / 更新 / 诊断 / 日志）
 *   admin.js      管理后台 /admin/api/* 请求封装
 *   index.js      统一再导出
 *
 * 保持 './api.js' 的老导入方式可用：具名导出与拆分前一致。
 */
export * from './api/index.js';
