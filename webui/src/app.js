import { createApp } from 'vue';
import Vant from 'vant';
import 'vant/lib/index.css';
import './design.css';
import './styles/app.css';
import App from './App.vue';

// M11：APK 里加载的是 app.html（这个入口），而全局错误兜底原来只在 main.js
window.addEventListener('unhandledrejection', (e) => {
  console.error('[app] 未处理的 Promise 拒绝:', e.reason);
});
window.addEventListener('error', (e) => {
  console.error('[app] 未捕获错误:', e.message, e.filename, e.lineno);
});

const app = createApp(App).use(Vant);

app.config.errorHandler = (err, instance, info) => {
  console.error('[app] Vue 渲染异常:', err, info);
};

app.mount('#app');
