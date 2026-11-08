import { createApp } from 'vue';
import './design.css';
import './styles/admin.css';
import AdminBoot from './AdminBoot.vue';

// 管理后台独立入口：不依赖 Vant/App 侧逻辑，避免影响 App 页面体积。
// AdminBoot 负责「未登录 → 登录页 / 需改密 → 改密页 / 已登录 → 主界面」。
createApp(AdminBoot).mount('#app');
