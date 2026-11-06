import { createApp } from 'vue';
import './design.css';
import './styles/admin.css';
import Admin from './Admin.vue';

// 管理后台独立入口：不依赖 Vant/App 侧逻辑，避免影响 App 页面体积。
createApp(Admin).mount('#app');
