import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath, URL } from 'node:url';

// 产物同时供服务器网页与 App WebView 使用
export default defineConfig({
  plugins: [vue()],
  // ★ 必须是绝对路径 '/'，不能用 './'。
  // 用 './' 时产物里写的是 `./assets/xxx.js`，浏览器按**当前 URL 目录**解析：
  //   /admin        → /assets/xxx.js        ✓
  //   /admin/login  → /admin/assets/xxx.js  ✗ 404（首页「管理员」按钮就指向这里 → 白屏）
  // 绝对路径对 App 也安全：WebView 走 AppWebShell 的 appassets.androidplatform.net，
  // `/assets/x` 会被 serveAsset 当成 assets/x 读出来，与 './assets/x' 等价。
  base: '/',
  build: {
    outDir: 'dist',
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
