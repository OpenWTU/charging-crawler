import { createApp } from 'vue';
import Vant from 'vant';
import 'vant/lib/index.css';
import './design.css';
import './styles/app.css';
import App from './App.vue';

const app = createApp(App);
app.config.errorHandler = (err, instance, info) => {
  console.error('[vue-error]', info, err);
};
window.addEventListener('error', (e) => console.error('[window-error]', e.message));
window.addEventListener('unhandledrejection', (e) => console.error('[unhandled]', e.reason));
app.use(Vant).mount('#app');
