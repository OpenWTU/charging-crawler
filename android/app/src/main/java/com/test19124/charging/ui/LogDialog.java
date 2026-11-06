package com.test19124.charging.ui;

import android.app.Activity;
import android.app.AlertDialog;
import android.widget.ScrollView;
import android.widget.TextView;

import com.test19124.charging.DebugLog;

/**
 * 抓包日志弹窗：把 {@link DebugLog} 的内存环形日志原样展示出来（可选中复制）。
 * 必须在 UI 线程调用。
 */
public final class LogDialog {

    private LogDialog() {
    }

    public static void show(Activity a) {
        TextView tv = new TextView(a);
        tv.setText(DebugLog.dump());
        tv.setTextSize(11);
        tv.setTypeface(android.graphics.Typeface.MONOSPACE);
        tv.setTextIsSelectable(true);
        tv.setPadding(dp(a, 12), dp(a, 8), dp(a, 12), dp(a, 8));
        ScrollView sv = new ScrollView(a);
        sv.addView(tv);
        new AlertDialog.Builder(a)
                .setTitle("抓包日志")
                .setView(sv)
                .setPositiveButton("关闭", null)
                .show();
    }

    private static int dp(Activity a, int v) {
        return Math.round(a.getResources().getDisplayMetrics().density * v);
    }
}
