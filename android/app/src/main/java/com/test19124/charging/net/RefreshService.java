package com.test19124.charging.net;

import android.app.Activity;
import android.util.Log;

import com.test19124.charging.ApiClient;
import com.test19124.charging.Area;
import com.test19124.charging.Cloud;
import com.test19124.charging.DebugLog;
import com.test19124.charging.Store;
import com.test19124.charging.TokenStore;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;

/**
 * 数据刷新编排：抓平台 → 落本地快照 → 补全端口 → 上传云端；上传失败保留 pending，下次刷新优先补传。
 *
 * <p>不变量（与重构前 MainActivity 的同名方法逐行一致）：</p>
 * <ul>
 *   <li>{@code busy} 互斥 + {@code uploading} 阶段互斥 + 15 秒去抖，避免连点放大上游请求；</li>
 *   <li>抓取节奏最低 200ms/请求（合规边界，不得下调）；</li>
 *   <li>先落 pending 再上传，失败/进程被杀都能原样补传；换账号不得补传旧账号快照；</li>
 *   <li>进度与结果一律经 {@code window.__onRefresh*}/{@code __onUploadDone} 回传，原生不重复 Toast。</li>
 * </ul>
 */
public final class RefreshService {

    /** 宿主提供的依赖（MainActivity 实现）。 */
    public interface Host {
        /** Activity 上下文（上传要读版本号，需真实 Activity，不是 Application）。 */
        Activity activity();

        /** 刷新链路专用单线程池。 */
        ExecutorService refreshPool();

        Store store();

        TokenStore tokens();

        /** getState 载荷（与桥的 getState 同源），用于组装上传快照。 */
        String snapshotStateJson();

        void postJs(String js);

        /** 数据已上传云端：清 overview 缓存并立刻重拉，让顶部健康条拿到新的 token_pool 状态。 */
        void invalidateOverview();
    }

    /** 两次上游请求的最小间隔：合规边界（README「每请求间隔 0.25s」），不得下调。 */
    private static final long MIN_FETCH_SPACING_MS = 200;
    /** 连点刷新的去抖窗口：数据比这更新就直接用本地缓存，不打上游。 */
    private static final long REFRESH_DEBOUNCE_MS = 15000;

    private final Host host;

    private volatile boolean busy = false;
    /** 端口补全 + 上传阶段：上传未结束前拒绝新的刷新，避免两轮上传交错。 */
    private volatile boolean uploading = false;
    private volatile boolean refreshRunning = false;
    private volatile String refreshProgress = "";

    public RefreshService(Host host) {
        this.host = host;
    }

    /** 刷新是否在跑（getState.refresh.running）。 */
    public boolean running() {
        return refreshRunning;
    }

    /** 刷新进度文案（getState.refresh.progress）。 */
    public String progress() {
        return refreshProgress;
    }

    /** 触发一次刷新：去抖/在途/令牌校验全部在这里收口。 */
    public void start() {
        final Store store = host.store();
        final TokenStore tokens = host.tokens();
        if (busy) {
            return;
        }
        // 上一轮的端口补全/上传还没结束：拒绝本轮刷新，避免两次上传交错。
        // 原因随 __onRefreshDone 透传，由前端统一 Toast（原生不再重复提示）。
        if (uploading) {
            postRefreshDone(false, "上一轮上传尚未完成，请稍候");
            return;
        }
        // 去抖：本地数据比窗口新时直接回完成信号，不打上游（避免连点放大请求频率）
        long updated = store.updatedAt();
        if (updated > 0 && System.currentTimeMillis() - updated < REFRESH_DEBOUNCE_MS) {
            // 上次上传失败留下的快照：去抖窗口内也要优先补传，不能直接回“成功”
            String pending = store.pendingUpload();
            if (pending != null) {
                if (System.currentTimeMillis() < store.pendingRetryAt()) {
                    // 退避期内不重试，避免失败后每次点刷新都打上游
                    postRefreshDone(false, "上次上传仍在重试冷却，将自动补传");
                } else {
                    retryPendingUpload(pending);
                }
            } else {
                postRefreshDone(true, "");
            }
            return;
        }
        String token = tokens.get();
        final ApiClient.Jwt jwt = ApiClient.parseJwt(token);
        if (jwt == null || jwt.expiresAt * 1000 < System.currentTimeMillis()) {
            postRefreshDone(false, "登录令牌已失效，请到「令牌」页重新获取");
            return;
        }
        busy = true;
        refreshRunning = true;
        refreshProgress = "加载中";
        host.refreshPool().execute(() -> {
            try {
                ApiClient api = new ApiClient(token, jwt.userId);
                JSONObject user = api.userInfo();
                int projectId = user.optInt("projectId", 0);
                String projectName = user.optString("projectName", "");
                if (projectId == 0) {
                    throw new IllegalStateException("账号未绑定小区");
                }
                JSONArray rawAreas = api.areaList(projectId);
                int total = rawAreas.length();
                postProgress("抓取充电区 0/" + total);
                List<Area> list = new ArrayList<>();
                for (int i = 0; i < total; i++) {
                    // 合规节奏：仅在上游响应快于 250ms 时补足间隔；响应本身够慢就不再叠加等待
                    long began = System.currentTimeMillis();
                    JSONObject item = rawAreas.getJSONObject(i);
                    String id = item.optString("id", "");
                    Area a = new Area();
                    a.id = id;
                    a.name = item.optString("areaName", id);
                    try {
                        JSONObject st = api.areaStatus(id);
                        if (st != null) {
                            a.total = st.optInt("totalPort", 0);
                            a.idle = st.optInt("idlePort", 0);
                            a.charging = st.optInt("chargingPort", 0);
                            a.fault = st.optInt("faultPort", 0);
                            a.address = st.optString("address", "");
                            list.add(a);
                        }
                    } catch (ApiClient.TokenExpired e) {
                        throw e;
                    } catch (Exception ignored) {
                    }
                    postProgress("抓取充电区 " + (i + 1) + "/" + total);
                    long spent = System.currentTimeMillis() - began;
                    if (spent < MIN_FETCH_SPACING_MS) {
                        Thread.sleep(MIN_FETCH_SPACING_MS - spent);
                    }
                }
                if (list.isEmpty()) {
                    throw new IllegalStateException("没有抓到任何充电区");
                }
                store.save(list, System.currentTimeMillis(), projectName);
                // 先立上传标志再放 busy，避免新一轮刷新插进收尾窗口
                uploading = true;
                busy = false;
                // 注意：这里**不**发 postRefreshDone——端口补全与上传还在继续，
                // 提前发会让前端提前结束「刷新中」，进度条随即消失，
                // 等端口阶段再发进度时又出现（表现为闪没一次）。
                // 完成信号统一由 attachPortsAndUpload 的 finally 发出。
                postProgress("区域数据已保存");
                attachPortsAndUpload(token, api);
            } catch (Exception e) {
                Log.w("RefreshService", "刷新失败: " + e);
                String msg = e.getMessage() == null ? e.toString() : e.getMessage();
                postRefreshDone(false, msg);
                // 必须在这里复位：否则 finally 的 `if (busy || refreshRunning)` 仍为真，
                // 会再发一条「刷新异常中断」，把真实原因覆盖掉（前端会连吃两条 Toast）
                busy = false;
                refreshRunning = false;
            } finally {
                if (busy || refreshRunning) {
                    busy = false;
                    refreshRunning = false;
                    refreshProgress = "";
                    postRefreshDone(false, "刷新异常中断");
                }
            }
        });
    }

    /**
     * 刷新成功后的收尾（跑在刷新线程，调用方已置 uploading=true）：补全端口 → 落 pending → 上传。
     * 上传失败时保留 pendingUpload，下一次刷新会优先补传同一份快照。
     */
    private void attachPortsAndUpload(String token, ApiClient api) {
        final Store store = host.store();
        try {
            JSONObject state = new JSONObject(host.snapshotStateJson());
            JSONArray stateAreas = state.optJSONArray("areas");
            if (stateAreas == null || stateAreas.length() == 0) {
                // 中性提示：不是上传失败，不写 pending、不发失败事件
                DebugLog.add("本地没有充电区数据，跳过上传");
                return;
            }
            // ★ 区域数据已就绪：先推一版给前端渲染，不等端口补全和上传。
            // 补全 39 个设备端口要 sleep 200ms × n（约 8 秒），再上传 1~2 秒，
            // 用户按下刷新后原本要干等十几秒才看到数据。
            pushLocalState(state);
            try {
                JSONObject cj = Cloud.fetchControllers();
                JSONArray cs = cj.optJSONArray("controllers");
                JSONArray portArr = new JSONArray();
                int n = cs == null ? 0 : cs.length();
                if (n > 0) {
                    for (int i = 0; i < n; i++) {
                        JSONObject ci = cs.getJSONObject(i);
                        String code = ci.optString("code", "");
                        if (code.isEmpty()) {
                            continue;
                        }
                        java.util.Map<String, String> pp = new java.util.HashMap<>();
                        pp.put("fromType", "3");
                        pp.put("deviceId", code);
                        JSONObject resp = api.get("charge/ports", pp);
                        JSONObject data = resp.optJSONObject("data");
                        JSONArray ports = data == null ? null
                                : data.optJSONArray("ports");
                        if (ports != null) {
                            JSONArray norm = new JSONArray();
                            for (int k = 0; k < ports.length(); k++) {
                                JSONObject p = ports.optJSONObject(k);
                                if (p == null) {
                                    continue;
                                }
                                JSONObject o = new JSONObject();
                                o.put("port", String.valueOf(p.opt("port")));
                                o.put("status", String.valueOf(p.opt("status")));
                                norm.put(o);
                            }
                            if (norm.length() > 0) {
                                JSONObject e = new JSONObject();
                                e.put("device_hex", ci.optString("device_hex", ""));
                                // ★ 带上区域与编号：前端要按区域归组渲染，
                                // 只给 device_hex 的话前端无法把本地端口挂到区域卡片下。
                                // 字段名与 /api/controllers 的返回保持一致（area_name/code）。
                                e.put("area", ci.optString("area_name", ""));
                                e.put("code", code);
                                e.put("ports", norm);
                                portArr.put(e);
                            }
                        }
                        if ((i + 1) % 5 == 0 || i == n - 1) {
                            postProgress("补全端口 " + (i + 1) + "/" + n);
                        }
                        Thread.sleep(200);
                    }
                }
                state.put("ports", portArr);
            } catch (Exception ex) {
                DebugLog.add("端口获取失败: " + ex.getMessage());
            }
            // ★ 端口明细已补全：再推一版，前端可立即显示端口级状态（仍不等上传）
            pushLocalState(state);
            // 先落 pending 再上传：上传失败或进程被杀，下次刷新都能原样补传
            store.savePendingUpload(state.toString());
            try {
                postProgress("上传数据中");
                Cloud.upload(host.activity(), state, token);
                store.clearPendingUpload();
                // 数据已落云端：overview 里的 token_pool / error_count 需要立即重读
                host.invalidateOverview();
                DebugLog.add("数据已上传云端");
                postUploadDone(true, "");
            } catch (Exception ex) {
                String msg = ex.getMessage() == null ? "上传失败" : ex.getMessage();
                DebugLog.add("上传失败: " + msg);
                store.notePendingFailure();
                postUploadDone(false, msg);
            }
        } catch (Exception ex) {
            // 组装 state 就失败（极少见）：按上传失败上报，保留旧的 pending
            String msg = ex.getMessage() == null ? "上传准备失败" : ex.getMessage();
            DebugLog.add("上传准备失败: " + msg);
            postUploadDone(false, msg);
        } finally {
            // 唯一的完成信号：无论端口补全成功与否都必须发，
            // 否则前端会一直停在「刷新中」直到 60 秒兜底超时。
            refreshRunning = false;
            refreshProgress = "";
            postRefreshDone(true, "");
            uploading = false;
        }
    }

    /**
     * 把当前快照立即推给前端渲染（不等端口补全、也不等上传完成）。
     *
     * <p>背景：原来只有 {@code postRefreshDone} 一个完成信号，而它在「补全 39 个设备端口
     * （每个 sleep 200ms ≈ 8 秒）+ 上传（1~2 秒）」之后才发，用户按下刷新要干等十几秒。
     * 现在区域数据一到就先推一版（前端立刻显示区域列表与空闲数），端口补全后再推一版。</p>
     *
     * <p>载荷就是 {@code AndroidHost.getState()} 的同一份 JSON，前端 {@code __onLocalState}
     * 直接复用渲染逻辑，字段语义完全一致。</p>
     */
    private void pushLocalState(JSONObject state) {
        if (state == null) {
            return;
        }
        try {
            host.postJs("window.__onLocalState && window.__onLocalState("
                    + JSONObject.quote(state.toString()) + ")");
        } catch (Exception e) {
            DebugLog.add("推送本地快照失败: " + e.getMessage());
        }
    }

    /** 去抖窗口内补传上次失败的快照（不重新抓上游）。 */
    private void retryPendingUpload(String pendingJson) {
        final Store store = host.store();
        final TokenStore tokens = host.tokens();
        String token = tokens.get();
        ApiClient.Jwt jwt = ApiClient.parseJwt(token);
        if (jwt == null || jwt.expiresAt * 1000 < System.currentTimeMillis()) {
            postRefreshDone(false, "登录令牌已失效，请到「令牌」页重新获取");
            return;
        }
        final JSONObject state;
        try {
            state = new JSONObject(pendingJson);
        } catch (Exception e) {
            // 坏数据直接丢弃，下一次刷新重新抓上游
            store.clearPendingUpload();
            postRefreshDone(true, "");
            return;
        }
        JSONObject t = state.optJSONObject("token");
        String pendingUser = t == null ? "" : t.optString("user_id", "");
        if (!pendingUser.isEmpty() && !pendingUser.equals(jwt.userId)) {
            // 已换账号：不能把旧账号的落盘快照补传到新账号
            store.clearPendingUpload();
            postRefreshDone(true, "");
            return;
        }
        busy = true;
        refreshRunning = true;
        postProgress("补传中");
        host.refreshPool().execute(() -> {
            uploading = true;
            boolean ok = false;
            String msg = "";
            try {
                Cloud.upload(host.activity(), state, token);
                store.clearPendingUpload();
                ok = true;
                DebugLog.add("补传成功");
            } catch (Exception ex) {
                msg = ex.getMessage() == null ? "补传失败" : ex.getMessage();
                DebugLog.add("补传失败: " + msg);
                store.notePendingFailure();
            } finally {
                uploading = false;
                busy = false;
                refreshRunning = false;
                refreshProgress = "";
                postUploadDone(ok, msg);
                postRefreshDone(true, "");
            }
        });
    }

    /** 透传刷新结果：window.__onRefreshDone('{"ok":true|false,"msg":"..."}')。 */
    private void postRefreshDone(boolean ok, String msg) {
        String json = "{\"ok\":" + ok + ",\"msg\":"
                + JSONObject.quote(msg == null ? "" : msg) + "}";
        host.postJs("window.__onRefreshDone && window.__onRefreshDone("
                + JSONObject.quote(json) + ")");
    }

    /** 透传上传结果：window.__onUploadDone('{"ok":true|false,"msg":"..."}')。 */
    private void postUploadDone(boolean ok, String msg) {
        String json = "{\"ok\":" + ok + ",\"msg\":"
                + JSONObject.quote(msg == null ? "" : msg) + "}";
        host.postJs("window.__onUploadDone && window.__onUploadDone("
                + JSONObject.quote(json) + ")");
    }

    private void postProgress(String p) {
        refreshProgress = p;
        // 用 JSONObject.quote 转义：文案里出现 ' 或 \ 会让整条 evaluateJavascript 语法错误
        host.postJs("window.__onRefreshProgress && window.__onRefreshProgress("
                + org.json.JSONObject.quote(p) + ")");
    }
}
