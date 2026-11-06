package com.test19124.charging.bridge;

import android.app.Activity;
import android.os.Handler;

import com.test19124.charging.Store;
import com.test19124.charging.TokenStore;
import com.test19124.charging.capture.CaptureFlow;
import com.test19124.charging.geo.LocationBridge;
import com.test19124.charging.net.BridgeNetClient;
import com.test19124.charging.net.RefreshService;
import com.test19124.charging.net.Updater;
import com.test19124.charging.state.OverviewCache;
import com.test19124.charging.state.SecureState;
import com.test19124.charging.state.StateBuilder;
import com.test19124.charging.ui.LogDialog;

/**
 * {@link BridgeHost} 的装配实现：把 JS 桥调用分派到各子模块。
 *
 * <p>不变量（与原 MainActivity#Bridge 的内联实现逐条对齐）：</p>
 * <ul>
 *   <li>需要 UI 线程的动作（Toast/弹窗/页面重载/抓包/导航/下载）一律经 {@code ui.post(...)}，
 *       因为 JS 桥方法跑在 WebView 的 JavaBridge 线程；</li>
 *   <li>{@code getState} 先触发 overview 刷新再取载荷；{@code getOverview} 无缓存回 {@code "{}"}；</li>
 *   <li>本类只做分派，不含任何抓取/上传/解析逻辑。</li>
 * </ul>
 */
public final class ActivityBridgeHost implements BridgeHost {

    /** MainActivity 提供的本地能力（只暴露装配所需的最小面）。 */
    public interface Env {
        Activity activity();

        Handler ui();

        boolean isGone();

        TokenStore tokens();

        Store store();

        /** 重新加载入口页（内部自行检查 gone/web）。 */
        void reloadPage();

        /** 「Token 已保存」提示（UI 线程）。 */
        void notifyTokenSaved();
    }

    private final Env env;
    private final OverviewCache overview;
    private final RefreshService refresh;
    private final BridgeNetClient net;
    private final Updater updater;
    private final CaptureFlow capture;
    private final LocationBridge location;

    public ActivityBridgeHost(Env env, OverviewCache overview, RefreshService refresh,
                              BridgeNetClient net, Updater updater, CaptureFlow capture,
                              LocationBridge location) {
        this.env = env;
        this.overview = overview;
        this.refresh = refresh;
        this.net = net;
        this.updater = updater;
        this.capture = capture;
        this.location = location;
    }

    @Override
    public void pingOverview() {
        overview.maybeFetch();
    }

    @Override
    public String stateJson() {
        return StateBuilder.build(env.store(), env.tokens(),
                refresh.running(), refresh.progress(), overview);
    }

    @Override
    public String overviewJson() {
        return overview.cachedOrNull();
    }

    @Override
    public void requestRefresh() {
        refresh.start();
    }

    @Override
    public void captureToken() {
        env.ui().post(capture::startToken);
    }

    @Override
    public void reloadPage() {
        env.ui().post(env::reloadPage);
    }

    @Override
    public void showLog() {
        env.ui().post(() -> {
            if (!env.isGone()) {
                LogDialog.show(env.activity());
            }
        });
    }

    @Override
    public String settingsJson() {
        return SecureState.settingsJson(env.activity(), env.tokens());
    }

    @Override
    public void saveUploadToken(boolean on) {
        SecureState.setUploadToken(env.activity(), on);
    }

    @Override
    public void clearToken() {
        env.tokens().clear();
        env.ui().post(env::reloadPage);
    }

    @Override
    public String saveToken(String token) {
        String result = SecureState.saveToken(env.tokens(), token);
        if ("ok".equals(result)) {
            env.notifyTokenSaved();
        }
        return result;
    }

    @Override
    public void checkUpdate() {
        updater.check();
    }

    @Override
    public void startDiagnose() {
        env.ui().post(capture::startDiagnose);
    }

    @Override
    public void stopDiagnose() {
        capture.stop();
    }

    @Override
    public String locationJson() {
        return location.syncJson();
    }

    @Override
    public void navAmap(String name, double lat, double lng, double slat, double slon) {
        // startActivity/Toast 必须在 UI 线程
        env.ui().post(() -> location.navAmap(name, lat, lng, slat, slon));
    }

    @Override
    public String areaCoordsJson() {
        return net.areaCoordsJson();
    }

    @Override
    public void freeRate(int days) {
        net.freeRate(days);
    }

    @Override
    public void pile(String deviceHex) {
        net.pile(deviceHex);
    }

    @Override
    public void nowWithCoords(double lat, double lng) {
        net.nowWithCoords(lat, lng);
    }

    @Override
    public void areasPorts() {
        net.areasPorts();
    }

    @Override
    public void areaPorts(String area) {
        net.areaPorts(area);
    }

    @Override
    public void now() {
        net.now();
    }

    @Override
    public void analytics() {
        net.analytics();
    }

    @Override
    public void history(String area, int limit) {
        net.history(area, limit);
    }

    @Override
    public void status() {
        net.status();
    }

    @Override
    public void setNodeBase(String url) {
        net.setNodeBase(url);
    }

    @Override
    public void startUpdate(String apkPath, String sha256) {
        env.ui().post(() -> updater.download(apkPath, sha256));
    }
}
