// 无头浏览器冒烟：Vant 已注册、底部导航可见、分析页能渲染图表
// 用法：node tools/smoke_web.mjs [url] [cdpPort]
const url = process.argv[2] || 'https://charge.example.com/';
const port = process.argv[3] || '9222';

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find((t) => t.type === 'page');
if (!page) { console.error('no page target'); process.exit(2); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}) => new Promise((r) => {
  const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params }));
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  return r.result && r.result.result ? r.result.result.value : undefined;
};

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await send('Page.navigate', { url });
await sleep(3500);

const tabbar = await evaluate(`(() => {
  const t = document.querySelector('.van-tabbar');
  const items = document.querySelectorAll('.van-tabbar-item');
  return { exists: !!t, display: t ? getComputedStyle(t).display : '', items: items.length };
})()`);

const clicked = await evaluate(`(() => {
  const items = [...document.querySelectorAll('.van-tabbar-item')];
  const target = items.find((el) => el.textContent.includes('分析'));
  if (!target) return false;
  target.click();
  return true;
})()`);
await sleep(1200);
const canvas = await evaluate(`document.querySelectorAll('canvas').length`);
const errors = await evaluate(`window.__smokeErrors || []`);

console.log(JSON.stringify({ tabbar, clicked, canvas }, null, 2));
const ok = tabbar.exists && tabbar.display === 'flex' && tabbar.items >= 2 && clicked && canvas > 0;
ws.close();
process.exit(ok ? 0 : 1);
