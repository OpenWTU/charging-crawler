import { computed, onMounted, onUnmounted, ref } from 'vue';

// 统一的「页面是否可见」判定：浏览器标签页可见 && App 侧当前 tab 在前台。
// 供 Token / Settings 的轮询使用：不可见时彻底停表，避免后台空转。
// isActive: () => boolean，App 通过 props 传入当前 tab 是否命中该页。
export function usePageVisible(isActive) {
  const docVisible = ref(typeof document === 'undefined' ? true : !document.hidden);

  function onVisibilityChange() {
    docVisible.value = typeof document === 'undefined' ? true : !document.hidden;
  }

  onMounted(() => {
    onVisibilityChange();
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityChange);
    }
  });

  onUnmounted(() => {
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibilityChange);
    }
  });

  return computed(() => docVisible.value && (typeof isActive === 'function' ? !!isActive() : true));
}
