/**
 * 主题（system / light / dark）。
 *
 * 不变量：
 *  - 网页端跟随系统深浅色；App 内用本地设置（localStorage: charge_theme）；
 *  - 深色同时挂 <html>.theme-dark（弹层/body 也变深），并由 design.css 的 body 变量驱动；
 *  - 主题变化后 <meta name="theme-color"> 内的浏览器配色随之同步；
 *    App 内再经 JS 桥通知原生同步系统状态栏（WebView 不认 theme-color）。
 */
import { computed, nextTick, onUnmounted, ref, watch } from 'vue';
import { isApp, setDarkMode } from '../api/index.js';

const THEME_KEY = 'charge_theme';

function loadThemePref() {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return (v === 'light' || v === 'dark' || v === 'system') ? v : 'system';
  } catch { return 'system'; }
}

function readSystemDark() {
  try { return window.matchMedia('(prefers-color-scheme: dark)').matches; } catch { return false; }
}

/**
 * @param {() => void} [onChange] 主题生效后的副作用（例如通知图表按新配色重绘）
 */
export function useTheme(onChange) {
  const themePref = ref(loadThemePref());
  const systemDark = ref(readSystemDark());
  const theme = computed(() => {
    // 网页端跟随系统深浅色（不固定浅色）；App 内继续用本地设置
    if (!isApp) return systemDark.value ? 'dark' : 'light';
    return themePref.value === 'system'
      ? (systemDark.value ? 'dark' : 'light')
      : themePref.value;
  });
  const themeLabel = computed(() => ({ system: '跟随系统', light: '浅色', dark: '深色' }[themePref.value] || '外观'));

  function setThemePref(v) {
    themePref.value = (v === 'light' || v === 'dark') ? v : 'system';
    try { localStorage.setItem(THEME_KEY, themePref.value); } catch { /* ignore */ }
  }

  function cycleTheme() {
    const order = ['system', 'light', 'dark'];
    setThemePref(order[(order.indexOf(themePref.value) + 1) % order.length]);
  }

  let mediaQuery = null;
  function onSchemeChange(e) {
    systemDark.value = !!e.matches;
  }

  function watchSystem() {
    try {
      mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      systemDark.value = mediaQuery.matches;
      if (typeof mediaQuery.addEventListener === 'function') {
        mediaQuery.addEventListener('change', onSchemeChange);
      } else if (typeof mediaQuery.addListener === 'function') {
        mediaQuery.addListener(onSchemeChange);
      }
    } catch { /* 无 matchMedia 时保持浅色 */ }
  }

  function unwatchSystem() {
    if (!mediaQuery) return;
    try {
      if (typeof mediaQuery.removeEventListener === 'function') {
        mediaQuery.removeEventListener('change', onSchemeChange);
      } else if (typeof mediaQuery.removeListener === 'function') {
        mediaQuery.removeListener(onSchemeChange);
      }
    } catch { /* ignore */ }
    mediaQuery = null;
  }

  watch(theme, (t) => {
    const dark = t === 'dark';
    try {
      // 深色令牌同时挂在 <html>（App 内是 Vant provider，网页端需要 body/弹层也变深）；
      // 背景/文字色统一由 design.css 的 body 变量驱动，不再写内联色值。
      document.documentElement.classList.toggle('theme-dark', dark);
      document.body.style.background = '';
      document.body.style.color = '';
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute('content', dark ? '#0f172a' : '#047857');
    } catch { /* ignore */ }
    // App 内让系统状态栏跟随页面底色（网页端空操作；旧 APK 无该桥时静默跳过）
    setDarkMode(dark);
    // 主题切换后按新配色重绘图表（图表尚未初始化时是空操作）
    nextTick(() => { if (typeof onChange === 'function') onChange(); });
  }, { immediate: true });

  onUnmounted(unwatchSystem);

  return {
    themePref, systemDark, theme, themeLabel,
    setThemePref, cycleTheme, watchSystem, unwatchSystem,
  };
}
