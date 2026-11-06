/**
 * 管理后台列表状态与分页请求（审计 / 服务器抓取 / 设备 / 令牌共用）。
 *
 * 不变量：
 *  - 每个列表一份 seq：响应回来时序号已变（切页/翻页/刷新竞态）就丢弃，不覆盖新数据；
 *  - loading 只在首次加载（未 loaded）时置真，翻页用 paging，避免整块闪成「加载中」；
 *  - 失败只写 state.error（面板显示「重试」），不抛异常打断其它面板。
 */
import { reactive } from 'vue';
import { adminRequest } from '../../api/index.js';

export function errorText(err) {
  if (err instanceof Error) return err.message || '未知错误';
  if (typeof err === 'string') return err;
  if (err && typeof err.message === 'string') return err.message;
  return String(err);
}

export function makeListState(limit = 0) {
  return reactive({
    rows: [],
    total: 0,
    limit,
    offset: 0,
    valid: 0,
    missing: [],
    loaded: false,
    loading: false,
    paging: false,
    error: '',
    seq: 0,
  });
}

export async function fetchPage(state, url, apply) {
  state.seq += 1;
  const seq = state.seq;
  state.loading = !state.loaded;
  state.error = '';
  try {
    const data = await adminRequest(url);
    if (seq !== state.seq) return false;
    apply(data);
    state.loaded = true;
    return true;
  } catch (err) {
    if (seq !== state.seq) return false;
    state.error = errorText(err);
    return false;
  } finally {
    if (seq === state.seq) {
      state.loading = false;
      state.paging = false;
    }
  }
}

export function pageNo(state) { return Math.floor(state.offset / state.limit) + 1; }
export function pageCount(state) { return Math.max(1, Math.ceil(state.total / state.limit)); }
export function pageLabel(state) { return `第 ${pageNo(state)} / ${pageCount(state)} 页`; }
