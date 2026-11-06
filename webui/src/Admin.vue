<template>
  <AdminView />
</template>

<script setup>
/**
 * 管理后台入口（兼容层）。
 *
 * 原 1717 行单文件已拆到：
 *   views/AdminView.vue          布局与装配（顶栏/统计/页签/全局提示 + 8 个面板）
 *   components/admin/Admin*.vue  顶栏、统计卡、页签、提示条、分页条
 *   components/admin/*Panel.vue  8 个业务面板（各自按 active 懒加载、按 refreshToken 刷新）
 *   components/admin/adminFormat.js / useAdminList.js / adminUi.js  格式化、列表状态、提示通道
 *   styles/admin.css             原 <style> 原样迁出
 *
 * admin.js 仍然 import './Admin.vue'，产物入口与文件名规则不变。
 */
import AdminView from './views/AdminView.vue';
</script>