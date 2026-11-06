package com.test19124.charging.bridge;

/**
 * JS 桥宿主：{@link AndroidHost} 把每个 {@code @JavascriptInterface} 调用原样转交给这里。
 *
 * <p>由 MainActivity 实现。线程纪律与重构前一致：需要 UI 线程的动作（Toast/弹窗/页面重载/
 * 抓包启动）由实现方自己 {@code ui.post(...)}，因为 WebView 的 JS 桥方法跑在 JavaBridge 线程。</p>
 *
 * <p>不变量：本接口只搬运，不做任何业务判断；返回值与字符串格式由实现方保持与原
 * {@code MainActivity#Bridge} 逐字一致。</p>
 */
public interface BridgeHost {

    /** 触发 /api/overview 异步刷新（30 秒节流 + 单飞），不阻塞调用线程。 */
    void pingOverview();

    /** getState 载荷：areas/summary/refresh/token + overview 合并字段。 */
    String stateJson();

    /** /api/overview 缓存原文；从未成功拉取时返回 null。 */
    String overviewJson();

    /** 触发一次数据刷新（含去抖/在途保护）。 */
    void requestRefresh();

    /** 抓取 token（微信侧抓包），内部切 UI 线程。 */
    void captureToken();

    /** 兜底错误页上的「重新加载」，内部切 UI 线程。 */
    void reloadPage();

    /** 打开抓包日志弹窗，内部切 UI 线程。 */
    void showLog();

    /** 「令牌」页设置载荷 JSON。 */
    String settingsJson();

    /** 切换「上传时携带 token」开关。 */
    void saveUploadToken(boolean on);

    /** 清除本地 token 并重载页面。 */
    void clearToken();

    /** 保存 token：返回 {@code ok} / {@code invalid} / {@code error:原因}。 */
    String saveToken(String token);

    /** 检查更新（结果走 window.__onUpdateChecking/__onUpdateInfo/__onUpdateError）。 */
    void checkUpdate();

    /** 开启诊断抓包。 */
    void startDiagnose();

    /** 停止抓包。 */
    void stopDiagnose();

    /** 定位 JSON：{@code {"lat":..,"lng":..}}、{@code {}} 或 {@code {"error":"no_permission"}}。 */
    String locationJson();

    /** 用高德地图导航，内部切 UI 线程。 */
    void navAmap(String name, double lat, double lng, double slat, double slon);

    /** 区域坐标：同步返回缓存，异步补发 window.__onAreaCoords。 */
    String areaCoordsJson();

    /** 空闲时段（/api/free-rate?days=N）→ window.__onFreeRate。 */
    void freeRate(int days);

    /** 单桩详情（/api/pile/&lt;device_hex&gt;）→ window.__onPile。 */
    void pile(String deviceHex);

    /** 带坐标的实时预测 → window.__onNow。 */
    void nowWithCoords(double lat, double lng);

    /** 全区端口 → window.__onAreasPorts。 */
    void areasPorts();

    /** 单区端口 → window.__onAreaPorts。 */
    void areaPorts(String area);

    /** 实时预测 → window.__onNow。 */
    void now();

    /** 分析页数据 → window.__onAnalytics。 */
    void analytics();

    /** 单区历史（/api/history?area=&limit=）→ window.__onHistory。 */
    void history(String area, int limit);

    /** 公开状态页（/status）→ window.__onStatus。 */
    void status();

    /** 下载并安装更新包。 */
    void startUpdate(String apkPath, String sha256);
}
