import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath, URL } from 'node:url';

// 产物同时供服务器网页与 App WebView 使用
export default defineConfig({
  plugins: [vue()],
  base: './',
  build: {
    outDir: fileURLToPath(new URL('../cloud/web/dist', import.meta.url)),
    emptyOutDir: true,
    assetsDir: 'assets',
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        admin: fileURLToPath(new URL('./admin.html', import.meta.url)),
        app: fileURLToPath(new URL('./app.html', import.meta.url)),
      },
      output: {
        // 第三方库拆成独立 chunk：
        // - echarts 只在分析页真正画图时由 App.vue 动态 import('./charts.js') 拉取，实时页不下载
        // - vant 独立：实时页只需 App + vant + vue
        // - vue 也单列：否则 Rollup 会把 vue 并进 vant chunk，导致 admin 页连带下载整个 vant
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('echarts') || id.includes('zrender')) return 'echarts';
          if (id.includes('/vant/') || id.includes('@vant/')) return 'vant';
          if (id.includes('/@vue/') || id.includes('/vue/')) return 'vue';
          return undefined;
        },
      },
    },
  },
  server: { port: 5173 },
});
