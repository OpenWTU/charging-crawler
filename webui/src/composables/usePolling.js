/**
 * 轮询基础设施。
 *
 *  1. useIntervals()：登记式定时器集合，组件卸载统一清空（避免漏清的多套表）；
 *     页面隐藏时默认空转（visibleOnly），不发无用请求。
 *  2. useAdaptiveTicker()：nowTick 节拍器 —— 数据还在「x 秒前」区间时 1s 一跳，
 *     否则降到 10s；页面隐藏时彻底停表，可见时恢复。
 *
 * 不变量：同一时刻只允许一个 tick 定时器（切换节拍必先清旧的），
 * 卸载时不留任何定时器。
 */
import { computed, onUnmounted, ref } from 'vue';

function docHidden() {
  return typeof document !== 'undefined' && !!document.hidden;
}

export function useIntervals() {
  const intervals = [];

  /**
   * 登记一个轮询：visibleOnly=true 时页面隐藏就跳过本次执行（定时器本身不停，
   * 与既有行为一致：回到前台立即恢复）。
   */
  function every(ms, fn, { visibleOnly = true } = {}) {
    const id = setInterval(() => {
      if (visibleOnly && docHidden()) return;
      try { fn(); } catch (e) { console.warn('[poll] 轮询回调异常', e); }
    }, ms);
    intervals.push(id);
    return id;
  }

  function clearAll() {
    while (intervals.length) clearInterval(intervals.pop());
  }

  onUnmounted(clearAll);

  return { intervals, every, clearAll };
}

/**
 * @param {{ dataAt: import('vue').ComputedRef<number>, onTick?: () => void }} opts
 *   dataAt：当前数据的采集时间（决定节拍）；onTick：每跳一次的回调（自动刷新判定等）
 */
export function useAdaptiveTicker({ dataAt, onTick }) {
  const nowTick = ref(Date.now());
  let timer = 0;
  let tickMs = 0;

  function needSecondTick() {
    const at = dataAt.value;
    return !!at && (Date.now() - at < 90000);
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = 0; tickMs = 0; }
  }

  function tick() {
    if (docHidden()) { stop(); return; }
    nowTick.value = Date.now();
    if (typeof onTick === 'function') onTick();
    start(); // 频率随「是否仍需要秒级文案」自动切换
  }

  function start() {
    if (docHidden()) { stop(); return; }
    const want = needSecondTick() ? 1000 : 10000;
    if (timer && tickMs === want) return;
    stop();
    tickMs = want;
    timer = setInterval(tick, want);
  }

  // 回到前台：立刻刷新一次文案基准，再恢复节拍
  function resume() {
    if (docHidden()) { stop(); return; }
    nowTick.value = Date.now();
    start();
    if (typeof onTick === 'function') onTick();
  }

  onUnmounted(stop);

  const ticking = computed(() => tickMs > 0);

  return { nowTick, start, stop, resume, ticking };
}
