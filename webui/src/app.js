import { createApp } from 'vue';
import Vant from 'vant';
import 'vant/lib/index.css';
import './design.css';
import './styles/app.css';
import App from './App.vue';

createApp(App).use(Vant).mount('#app');
