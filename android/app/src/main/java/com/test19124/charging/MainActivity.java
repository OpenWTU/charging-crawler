package com.test19124.charging;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.ViewGroup;
import android.webkit.WebView;
import android.widget.Toast;

import com.test19124.charging.bridge.ActivityBridgeHost;
import com.test19124.charging.bridge.AndroidHost;
import com.test19124.charging.capture.CaptureFlow;
import com.test19124.charging.capture.CaptureReceiver;
import com.test19124.charging.geo.LocationBridge;
import com.test19124.charging.net.BridgeNetClient;
import com.test19124.charging.net.RefreshService;
import com.test19124.charging.net.Updater;
import com.test19124.charging.state.OverviewCache;
import com.test19124.charging.state.SecureState;
import com.test19124.charging.state.StateBuilder;
import com.test19124.charging.ui.LogDialog;
import com.test19124.charging.web.AppWebShell;
import com.test19124.charging.web.WebErrorPages;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * WebView 壳：界面是本地网页，数据与 Token 全部由 App 本地提供（JS 桥），不连任何服务器。
 *
 * <p>本类只做 Activity 生命周期 + WebView 装配 + 线程池归属，并实现各子模块的 Host 接口；
 * 其余职责由 2026-11-03 重构拆出（{@code window.AndroidHost} 的 24 个方法名/参数/返回格式冻结不变）：</p>
 * <ul>
 *   <li>{@link AndroidHost} / {@link ActivityBridgeHost}（bridge/）—— JS 桥与分派；</li>
 *   <li>{@link AppWebShell} / {@link WebErrorPages}（web/）—— WebView 配置、本地资产站点、崩溃恢复与兜底页；</li>
 *   <li>{@link RefreshService} / {@link BridgeNetClient} / {@link Updater}（net/）—— 刷新上传、只读云请求、更新；</li>
 *   <li>{@link CaptureFlow} / {@link CaptureReceiver}（capture/）—— 抓包编排与结果广播；</li>
 *   <li>{@link LocationBridge}（geo/）—— 定位与高德导航；</li>
 *   <li>{@link StateBuilder} / {@link OverviewCache} / {@link SecureState}（state/）—— getState 载荷、overview 缓存、令牌页；</li>
 *   <li>{@link LogDialog}（ui/）—— 抓包日志弹窗。</li>
 * </ul>
 */
public class MainActivity extends Activity
        implements AppWebShell.Host, OverviewCache.Host, BridgeNetClient.Host,
                   RefreshService.Host, Updater.Host, CaptureFlow.Host, LocationBridge.Host,
                   CaptureReceiver.Host, ActivityBridgeHost.Env {

    private static final String TAG = "MainActivity";

    private final ExecutorService pool = Executors.newSingleThreadExecutor();
    private final ExecutorService updatePool = Executors.newSingleThreadExecutor();
    /** 端口/坐标/空闲时段/桩详情并发读：互不排队。 */
    private final ExecutorService portsPool = Executors.newFixedThreadPool(4);
    /** 预测/推荐独立线程池：避免刷新/抓包占用 pool 导致 loadNow 超时。 */
    private final ExecutorService nowPool = Executors.newSingleThreadExecutor();
    /** 分析页独立池，长刷新/抓包不影响图表。 */
    private final ExecutorService analyticsPool = Executors.newSingleThreadExecutor();
    /** 检查更新 / 概览拉取独立池。 */
    private final ExecutorService checkPool = Executors.newSingleThreadExecutor();
    private final Handler ui = new Handler(Looper.getMainLooper());
    /** 渲染进程重建限流：5 分钟内最多 3 次，超限显示错误页。 */
    private int webRecreateCount = 0;
    private long webRecreateWindowAt = 0;
    private volatile boolean gone = false;
    private volatile boolean pageErrorShown = false;

    private TokenStore tokens;
    private Store store;
    private WebView web;

    private AppWebShell shell;
    private OverviewCache overview;
    private BridgeNetClient net;
    private RefreshService refresh;
    private Updater updater;
    private CaptureFlow capture;
    private LocationBridge location;
    private CaptureReceiver captureReceiver;
    private ActivityBridgeHost bridgeHost;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        tokens = new TokenStore(this);
        store = new Store(this);

        shell = new AppWebShell(this);
        overview = new OverviewCache(this);
        net = new BridgeNetClient(this);
        refresh = new RefreshService(this);
        updater = new Updater(this);
        capture = new CaptureFlow(this);
        location = new LocationBridge(this);
        bridgeHost = new ActivityBridgeHost(this, overview, refresh, net, updater, capture, location);

        web = shell.create();
        showWebView(web);
        captureReceiver = new CaptureReceiver(this);
        captureReceiver.register();
        loadWebPage();
    }

    private void showWebView(WebView view) {
        setContentView(view, new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    private void loadWebPage() {
        if (gone || web == null) {
            return;
        }
        pageErrorShown = false;
        shell.loadEntryPage(web);
    }

    /** 摘除并销毁当前 WebView（渲染进程崩溃后旧实例已不可用）。 */
    private void destroyWebView() {
        WebView old = web;
        web = null;
        if (old != null) {
            ViewGroup parent = (ViewGroup) old.getParent();
            if (parent != null) {
                parent.removeView(old);
            }
            try {
                old.destroy();
            } catch (Exception ignored) {
            }
        }
    }

    @Override
    public void recreateWebView() {
        if (gone) {
            return;
        }
        destroyWebView();
        web = shell.create();
        showWebView(web);
        loadWebPage();
    }

    /** 主框架加载失败：显示可重试的本地兜底页。 */
    @Override
    public void showPageError() {
        if (gone || web == null || pageErrorShown) {
            return;
        }
        pageErrorShown = true;
        web.loadDataWithBaseURL(null, WebErrorPages.PAGE_ERROR, "text/html", "utf-8", null);
    }

    /** 渲染进程连续异常：换全新的 WebView 显示静态错误页，不再加载应用。 */
    @Override
    public void showFatalWebError() {
        if (gone) {
            return;
        }
        destroyWebView();
        try {
            web = shell.createFatalErrorView();
            showWebView(web);
        } catch (Exception e) {
            Log.w(TAG, "显示错误页失败: " + e);
        }
    }

    /** 渲染进程重建限流：5 分钟内最多 3 次。 */
    @Override
    public boolean allowWebRecreate() {
        long now = System.currentTimeMillis();
        if (now - webRecreateWindowAt > 5 * 60 * 1000L) {
            webRecreateWindowAt = now;
            webRecreateCount = 0;
        }
        if (webRecreateCount >= 3) {
            return false;
        }
        webRecreateCount++;
        return true;
    }

    @Override
    public void postJs(String js) {
        ui.post(() -> {
            if (!gone && web != null) {
                web.evaluateJavascript(js, null);
            }
        });
    }

    @Override
    public void attachBridge(WebView target) {
        target.addJavascriptInterface(new AndroidHost(bridgeHost), AndroidHost.NAME);
    }

    // ---------------- ActivityBridgeHost.Env ----------------

    @Override
    public void reloadPage() {
        loadWebPage();
    }

    @Override
    public void notifyTokenSaved() {
        ui.post(() -> Toast.makeText(this, "Token 已保存", Toast.LENGTH_SHORT).show());
        // token 刚写入：清 overview 缓存并立刻重拉，避免顶部卡片沿用旧的 token_ready=false
        ui.post(() -> {
            if (!gone && overview != null) overview.invalidateAndRefetch();
        });
    }
    @Override
    public String snapshotStateJson() {
        return bridgeHost.stateJson();
    }

    @Override
    public void invalidateOverview() {
        ui.post(() -> {
            if (!gone && overview != null) overview.invalidateAndRefetch();
        });
    }

    // ---------------- 子模块 Host：依赖与上下文 ----------------

    @Override
    public Activity activity() {
        return this;
    }

    @Override
    public Handler ui() {
        return ui;
    }

    @Override
    public boolean isGone() {
        return gone;
    }

    @Override
    public Store store() {
        return store;
    }

    @Override
    public TokenStore tokens() {
        return tokens;
    }

    @Override
    public ExecutorService overviewPool() {
        return portsPool;
    }

    @Override
    public ExecutorService portsPool() {
        return portsPool;
    }

    @Override
    public ExecutorService nowPool() {
        return nowPool;
    }

    @Override
    public ExecutorService analyticsPool() {
        return analyticsPool;
    }

    @Override
    public ExecutorService refreshPool() {
        return pool;
    }

    @Override
    public ExecutorService capturePool() {
        return pool;
    }

    @Override
    public ExecutorService checkPool() {
        return checkPool;
    }

    @Override
    public ExecutorService updatePool() {
        return updatePool;
    }

    // ---------------- 生命周期 ----------------

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) {
            web.onResume();
        }
        // 每次进入/回到 App 都触发一次更新检查（JS 侧有 20 秒去重）
        ui.post(() -> overview.maybeFetch());
        ui.postDelayed(() -> postJs("window.__onCheckUpdate && window.__onCheckUpdate()"), 1200);
        ui.postDelayed(() -> postJs("window.__onAppResume && window.__onAppResume()"), 1500);
    }

    @Override
    protected void onPause() {
        // 暂停 WebView 的 JS 定时器（预测轮询/时钟），回到前台再恢复
        if (web != null) {
            web.onPause();
        }
        super.onPause();
    }

    @Override
    public void onBackPressed() {
        if (gone || web == null) {
            super.onBackPressed();
            return;
        }
        if (web.canGoBack()) {
            web.goBack();
            return;
        }
        // 先让页面关闭弹层/面板（前端定义 __onBackPressed 返回 true 表示已处理）
        final boolean[] done = new boolean[1];
        ui.postDelayed(() -> {
            if (!done[0]) {
                done[0] = true;
                finishByBack();
            }
        }, 900);
        try {
            web.evaluateJavascript(
                    "(window.__onBackPressed && window.__onBackPressed()) === true",
                    value -> {
                        if (done[0]) {
                            return;
                        }
                        done[0] = true;
                        if (!"true".equals(value)) {
                            finishByBack();
                        }
                    });
        } catch (Exception e) {
            finishByBack();
        }
    }

    private void finishByBack() {
        if (!gone) {
            super.onBackPressed();
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        capture.onActivityResult(requestCode, resultCode);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions,
                                           int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == LocationBridge.REQ_LOCATION) {
            location.onPermissionResult();
        } else {
            capture.onRequestPermissionsResult(requestCode, grantResults);
        }
    }

    @Override
    protected void onDestroy() {
        gone = true;
        // 只有用户主动退出时才停抓包；后台被系统回收交给 service 自身超时
        if (isFinishing()) {
            stopService(new Intent(this, CaptureVpnService.class));
        }
        pool.shutdownNow();
        updatePool.shutdownNow();
        portsPool.shutdownNow();
        nowPool.shutdownNow();
        analyticsPool.shutdownNow();
        checkPool.shutdownNow();
        if (captureReceiver != null) {
            captureReceiver.unregister();
        }
        if (web != null) {
            try {
                web.stopLoading();
            } catch (Exception ignored) {
            }
            ViewGroup parent = (ViewGroup) web.getParent();
            if (parent != null) {
                parent.removeView(web);
            }
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
