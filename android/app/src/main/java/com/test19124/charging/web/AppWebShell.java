package com.test19124.charging.web;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Handler;
import android.util.Log;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

/**
 * WebView 装配：本地资产站点（appassets.androidplatform.net）的加载、缓存头、外链拦截与崩溃恢复。
 *
 * <p>不变量：</p>
 * <ul>
 *   <li>入口页 {@code /www/app.html} 不缓存（避免更新后引用已删除的 hash 资源），
 *       {@code /assets/**} 长缓存；</li>
 *   <li>只对内置页面放开 JS 桥，其它 http(s) 导航交给系统浏览器；</li>
 *   <li>渲染进程崩溃：5 分钟内最多重建 3 次，超限显示静态错误页。</li>
 * </ul>
 */
public final class AppWebShell {

    /** 宿主提供的依赖（MainActivity 实现）。 */
    public interface Host {
        Activity activity();

        Handler ui();

        boolean isGone();

        /** 渲染进程重建限流（5 分钟 3 次）。 */
        boolean allowWebRecreate();

        /** 主框架加载失败兜底页。 */
        void showPageError();

        /** 连续崩溃后的静态错误页。 */
        void showFatalWebError();

        /** 重建 WebView 并重新加载入口页。 */
        void recreateWebView();

        /** 挂 JS 桥（addJavascriptInterface）。 */
        void attachBridge(WebView web);
    }

    public static final String PAGE = "https://appassets.androidplatform.net/www/app.html";
    public static final String ASSET_HOST = "appassets.androidplatform.net";
    /** 系统 WebView 主版本低于该值时页面无法正常渲染。 */
    private static final int MIN_CHROME_MAJOR = 87;

    private final Host host;

    public AppWebShell(Host host) {
        this.host = host;
    }

    /** 创建并配置 WebView（渲染进程重建时复用）。 */
    public WebView create() {
        Activity a = host.activity();
        WebView w = new WebView(a);
        WebSettings s = w.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        w.setBackgroundColor(Color.parseColor("#f3f5f9"));
        if ((a.getApplicationInfo().flags
                & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            WebView.setWebContentsDebuggingEnabled(true);
        }
        w.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return serveAsset(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return handleExternal(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return handleExternal(Uri.parse(url));
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request,
                                        WebResourceError error) {
                if (request == null || !request.isForMainFrame()) {
                    return;
                }
                // 取消导航/未知错误（常见于 reload、跳转中断）不覆盖当前页面
                if (error != null && error.getErrorCode() == WebViewClient.ERROR_UNKNOWN) {
                    return;
                }
                host.showPageError();
            }

            @Override
            public void onReceivedHttpError(WebView view, WebResourceRequest request,
                                            WebResourceResponse errorResponse) {
                if (request == null) {
                    return;
                }
                int status = errorResponse == null ? 0 : errorResponse.getStatusCode();
                if (request.isForMainFrame()) {
                    Log.w("AppWebShell", "主框架 HTTP " + status + " " + request.getUrl());
                    host.showPageError();
                } else {
                    Log.w("AppWebShell", "子资源 HTTP " + status + " " + request.getUrl());
                }
            }

            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                boolean crashed = detail != null && detail.didCrash();
                Log.w("AppWebShell", "WebView 渲染进程退出，crashed=" + crashed);
                host.ui().post(() -> {
                    Activity act = host.activity();
                    if (host.isGone()) {
                        return;
                    }
                    if (!host.allowWebRecreate()) {
                        Toast.makeText(act, "页面多次渲染异常，请重启应用",
                                Toast.LENGTH_LONG).show();
                        host.showFatalWebError();
                        return;
                    }
                    Toast.makeText(act, "页面渲染异常，正在重新加载",
                            Toast.LENGTH_LONG).show();
                    host.recreateWebView();
                });
                return true; // 已处理，避免系统连带杀掉应用进程
            }
        });
        host.attachBridge(w);
        return w;
    }

    /** 加载入口页：WebView 主版本过低时给出可读提示，不再继续加载。 */
    public void loadEntryPage(WebView web) {
        if (web == null) {
            return;
        }
        int chrome = chromeMajor();
        if (chrome > 0 && chrome < MIN_CHROME_MAJOR) {
            web.loadDataWithBaseURL(null, WebErrorPages.lowWebView(chrome),
                    "text/html", "utf-8", null);
            return;
        }
        web.loadUrl(PAGE);
    }

    /** 渲染进程连续异常后的静态错误页容器（全新 WebView，不含 JS 桥）。 */
    public WebView createFatalErrorView() {
        WebView fatal = new WebView(host.activity());
        fatal.setBackgroundColor(Color.parseColor("#f3f5f9"));
        fatal.loadDataWithBaseURL(null, WebErrorPages.FATAL, "text/html", "utf-8", null);
        return fatal;
    }

    private int chromeMajor() {
        try {
            String ua = WebSettings.getDefaultUserAgent(host.activity());
            java.util.regex.Matcher m = java.util.regex.Pattern
                    .compile("Chrome/(\\d+)").matcher(ua);
            return m.find() ? Integer.parseInt(m.group(1)) : 0;
        } catch (Exception e) {
            return 0;
        }
    }

    /** JS 桥只对内置页面生效：任何非内置页面的导航都拦下，外链交给系统浏览器。 */
    private boolean handleExternal(Uri uri) {
        if (uri.toString().startsWith("file:///android_asset/www/")
                || ASSET_HOST.equals(uri.getHost())) {
            return false;
        }
        String scheme = uri.getScheme() == null ? "" : uri.getScheme();
        if (scheme.equals("http") || scheme.equals("https")) {
            try {
                host.activity().startActivity(new Intent(Intent.ACTION_VIEW, uri));
            } catch (Exception ignored) {
            }
        }
        return true;
    }

    /** 从 assets 提供内置页面资源，并按路径给出缓存策略。 */
    private WebResourceResponse serveAsset(Uri u) {
        if (!ASSET_HOST.equals(u.getHost())) {
            return null;
        }
        String path = u.getPath();
        if (path == null || !path.startsWith("/")) {
            return null;
        }
        try {
            java.io.InputStream in = host.activity().getAssets().open(path.substring(1));
            String mime = path.endsWith(".js") ? "application/javascript"
                    : path.endsWith(".css") ? "text/css"
                : path.endsWith(".svg") ? "image/svg+xml"
                : path.endsWith(".png") ? "image/png"
                : path.endsWith(".webp") ? "image/webp"
                : path.endsWith(".jpg") || path.endsWith(".jpeg") ? "image/jpeg"
                : path.endsWith(".gif") ? "image/gif"
                : path.endsWith(".woff2") ? "font/woff2"
                : path.endsWith(".woff") ? "font/woff"
                : path.endsWith(".ttf") ? "font/ttf"
                : path.endsWith(".json") || path.endsWith(".webmanifest") ? "application/json"
                : path.endsWith(".map") ? "application/json"
                : "application/octet-stream";
            WebResourceResponse resp = new WebResourceResponse(mime, "UTF-8", in);
            java.util.Map<String, String> headers = new java.util.HashMap<>();
            if (path.endsWith(".html")) {
                // 入口页不缓存：避免更新后 app.html 仍引用已被删除的旧 hash 资源
                headers.put("Cache-Control", "no-cache, no-store, must-revalidate");
                headers.put("Pragma", "no-cache");
            } else if (path.startsWith("/assets/")) {
                // hashed 资源可长期缓存（文件名随内容变化）
                headers.put("Cache-Control", "public, max-age=31536000, immutable");
            } else {
                headers.put("Cache-Control", "no-cache");
            }
            resp.setResponseHeaders(headers);
            return resp;
        } catch (Exception e) {
            return null;
        }
    }
}
