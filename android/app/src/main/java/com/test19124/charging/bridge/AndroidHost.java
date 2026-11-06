package com.test19124.charging.bridge;

import android.webkit.JavascriptInterface;

/**
 * WebView 里的 {@code window.AndroidHost}：全部 {@code @JavascriptInterface} 方法的集合。
 *
 * <p><b>契约（不可变更）</b>：方法名、参数列表、返回值字符串格式必须与重构前
 * {@code MainActivity#Bridge} 逐一相同，前端 {@code webui/src/api/*.js} 依赖它。
 * 本类不含业务逻辑，所有调用原样转交给 {@link BridgeHost}。</p>
 */
public final class AndroidHost {

    /** 注册到 WebView 的全局名，前端以 window.AndroidHost 访问。 */
    public static final String NAME = "AndroidHost";

    private final BridgeHost host;

    public AndroidHost(BridgeHost host) {
        this.host = host;
    }

    @JavascriptInterface
    public String getState() {
        host.pingOverview();
        return host.stateJson();
    }

    /** /api/overview 透传（token_pool/health）：返回缓存，后台异步刷新，完成时 post __onOverview。 */
    @JavascriptInterface
    public String getOverview() {
        host.pingOverview();
        String cached = host.overviewJson();
        return cached == null ? "{}" : cached;
    }

    @JavascriptInterface
    public void refresh() {
        host.requestRefresh();
    }

    @JavascriptInterface
    public void captureToken() {
        host.captureToken();
    }

    /** 兜底错误页上的「重新加载」。 */
    @JavascriptInterface
    public void reloadPage() {
        host.reloadPage();
    }

    @JavascriptInterface
    public void showLog() {
        host.showLog();
    }

    @JavascriptInterface
    public String getSettings() {
        return host.settingsJson();
    }

    @JavascriptInterface
    public void setUploadToken(boolean on) {
        host.saveUploadToken(on);
    }

    @JavascriptInterface
    public void clearToken() {
        host.clearToken();
    }

    @JavascriptInterface
    public void checkUpdate() {
        host.checkUpdate();
    }

    @JavascriptInterface
    public void startDiagnose() {
        host.startDiagnose();
    }

    @JavascriptInterface
    public void stopDiagnose() {
        host.stopDiagnose();
    }

    @JavascriptInterface
    public String getLocation() {
        return host.locationJson();
    }

    @JavascriptInterface
    public void openAmap(String name, double lat, double lng,
                         double slat, double slon) {
        host.navAmap(name, lat, lng, slat, slon);
    }

    @JavascriptInterface
    public String getAreaCoords() {
        return host.areaCoordsJson();
    }

    /** 空闲时段（/api/free-rate?days=N）：回调 window.__onFreeRate(json)。 */
    @JavascriptInterface
    public void getFreeRate(int days) {
        host.freeRate(days);
    }

    /** 单台桩详情（/api/pile/&lt;device_hex&gt;）：回调 window.__onPile(json)。 */
    @JavascriptInterface
    public void getPile(String deviceHex) {
        host.pile(deviceHex);
    }

    @JavascriptInterface
    public void getNowWithCoords(double lat, double lng) {
        host.nowWithCoords(lat, lng);
    }

    @JavascriptInterface
    public void getAreasPorts() {
        host.areasPorts();
    }

    @JavascriptInterface
    public void getAreaPorts(String area) {
        host.areaPorts(area);
    }

    @JavascriptInterface
    public void getNow() {
        host.now();
    }

    @JavascriptInterface
    public void getAnalytics() {
        host.analytics();
    }

    /** 单区历史（/api/history?area=&limit=）：回调 window.__onHistory(json)。 */
    @JavascriptInterface
    public void getHistory(String area, int limit) {
        host.history(area, limit);
    }

    /** 公开状态页（/status）：回调 window.__onStatus(json)。 */
    @JavascriptInterface
    public void getStatus() {
        host.status();
    }

    /** 手动切换连接的服务器节点（状态页卡片确认后调用） */
    @JavascriptInterface
    public void setNodeBase(String url) {
        host.setNodeBase(url);
    }

    @JavascriptInterface
    public void startUpdate(String apkPath, String sha256) {
        host.startUpdate(apkPath, sha256);
    }

    @JavascriptInterface
    public String saveToken(String token) {
        return host.saveToken(token);
    }
}
