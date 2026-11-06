package com.test19124.charging.web;

/**
 * WebView 兜底页的静态 HTML（与原 MainActivity 内联字符串逐字一致，勿改文案）。
 */
public final class WebErrorPages {

    private WebErrorPages() {
    }

    /** 主框架加载失败：可重试的兜底页，按钮调 JS 桥的 reloadPage。 */
    public static final String PAGE_ERROR =
            "<html><meta name='viewport' content='width=device-width,initial-scale=1'>"
            + "<body style='font-family:sans-serif;padding:28px;background:#f3f5f9;color:#0f172a'>"
            + "<h3>页面加载失败</h3><p>本地页面未能加载，请重试。</p>"
            + "<button onclick='AndroidHost.reloadPage()' style='padding:12px 20px;border:0;"
            + "border-radius:12px;background:#047857;color:#fff;font-size:16px'>重新加载</button>"
            + "</body></html>";

    /** 渲染进程连续异常：静态提示页，不再加载应用。 */
    public static final String FATAL =
            "<html><meta name='viewport' content='width=device-width,initial-scale=1'>"
            + "<body style='font-family:sans-serif;padding:28px;background:#f3f5f9;color:#0f172a'>"
            + "<h3>页面多次异常</h3><p>WebView 渲染进程已多次异常，请完全关闭并重新打开应用。</p>"
            + "</body></html>";

    /** 系统 WebView 主版本过低（&lt; 87）：提示更新 WebView/Chrome。 */
    public static String lowWebView(int chromeMajor) {
        return "<html><meta name='viewport' content='width=device-width,initial-scale=1'>"
                + "<body style='font-family:sans-serif;padding:28px;background:#f3f5f9;color:#0f172a'>"
                + "<h3>需要更新系统 WebView</h3><p>当前 WebView 版本过低（Chrome/" + chromeMajor
                + "），页面无法正常显示。请到应用商店更新「Android System WebView」或 Chrome 后重新打开。</p></body></html>";
    }
}
