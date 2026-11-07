package com.test19124.charging.ui;

import android.os.Build;
import android.view.View;
import android.view.Window;
import android.view.WindowInsetsController;

/**
 * 系统状态栏配色跟随网页深浅色。
 *
 * <p>WebView 不识别 {@code <meta name="theme-color">}（那是浏览器工具栏的约定），
 * 深色页面必须由网页经 JS 桥显式通知原生；否则深色页面顶部会留一条浅色状态栏，
 * 而状态栏图标仍是浅色，几乎看不清。</p>
 *
 * <p>颜色与 {@code webui/src/design.css} 的 {@code --page-bg} 两套取值一致
 * （浅色 {@code #f3f5f9} / 深色 {@code #0f172a}），状态栏与页面底色无缝衔接。
 * 只改状态栏；导航栏保持系统默认（手势导航下本就透明）。</p>
 */
public final class StatusBarTheme {

    /** design.css 浅色 --page-bg。 */
    private static final int LIGHT = 0xFFF3F5F9;
    /** design.css 深色 --page-bg。 */
    private static final int DARK = 0xFF0F172A;

    private StatusBarTheme() {
    }

    /** 必须在 UI 线程调用。 */
    public static void apply(Window window, boolean dark) {
        if (window == null) {
            return;
        }
        // 底色：深色页面用深色状态栏，浅色页面用页面底色（不再沿用系统主题的浅灰）。
        window.setStatusBarColor(dark ? DARK : LIGHT);
        // 图标明暗：深色底配浅色图标，浅色底配深色图标。
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            WindowInsetsController controller = window.getInsetsController();
            if (controller != null) {
                int mask = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS;
                controller.setSystemBarsAppearance(dark ? 0 : mask, mask);
                return;
            }
            // 窗口尚未挂到 WindowManager 时 controller 可能为空：退回下面的旧标志，
            // 避免出现「深色底 + 深色图标」的不可读状态。
        }
        View decor = window.getDecorView();
        if (decor == null) {
            return;
        }
        int flags = decor.getSystemUiVisibility();
        if (dark) {
            flags &= ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
        } else {
            flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
        }
        decor.setSystemUiVisibility(flags);
    }
}
