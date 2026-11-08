package com.test19124.charging.net;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.widget.Toast;

import com.test19124.charging.Cloud;
import com.test19124.charging.DebugLog;
import com.test19124.charging.UpdateProvider;

import org.json.JSONObject;

import java.util.concurrent.ExecutorService;

/**
 * 版本检查 / 更新包下载与安装（APK 只从自家域名下载并校验 sha256）。
 *
 * <p>不变量：检查结果经 {@code window.__onUpdateChecking/__onUpdateInfo/__onUpdateError}
 * 回传；下载与安装全部在 UI 线程之外准备、UI 线程内触发；Activity 已销毁（gone）时不再弹提示。</p>
 */
public final class Updater {

    /** 宿主提供的依赖（MainActivity 实现）。 */
    public interface Host {
        Activity activity();

        /** 检查更新专用单线程池。 */
        ExecutorService checkPool();

        /** 下载更新包专用单线程池。 */
        ExecutorService updatePool();

        Handler ui();

        boolean isGone();

        void postJs(String js);
    }

    private final Host host;

    public Updater(Host host) {
        this.host = host;
    }

    /** 检查更新：先通知前端「检查中」，再拉 /api/version 并带上本地版本号。 */
    public void check() {
        host.ui().post(() -> {
            host.postJs("window.__onUpdateChecking && window.__onUpdateChecking()");
            try {
                host.checkPool().execute(() -> {
                    try {
                        Activity a = host.activity();
                        JSONObject o = Cloud.fetchVersion();
                        o.put("ok", true);
                        o.put("currentCode", Cloud.versionCode(a));
                        o.put("currentName", Cloud.versionName(a));
                        host.postJs("window.__onUpdateInfo && window.__onUpdateInfo("
                                + JSONObject.quote(o.toString()) + ")");
                    } catch (Exception e) {
                        host.postJs("window.__onUpdateError && window.__onUpdateError()");
                    }
                });
            } catch (java.util.concurrent.RejectedExecutionException e) {
                // Activity 已销毁（线程池 shutdownNow）：前端 upChecking 不能一直停在 true
                host.postJs("window.__onUpdateError && window.__onUpdateError()");
            }
        });
    }

    /** 下载更新包并在校验通过后拉起系统安装器（必须在 UI 线程调用）。 */
    public void download(String apkPath, String sha256) {
        final Activity a = host.activity();
        if (host.isGone()) return; // Activity 已销毁：别弹一个没人看的 Toast
        Toast.makeText(a, "开始下载…", Toast.LENGTH_SHORT).show();
        try {
            host.updatePool().execute(() -> {
                try {
                    DebugLog.add("开始下载更新: " + apkPath);
                    java.io.File apk = Cloud.downloadApk(apkPath, a.getCacheDir(), sha256);
                    DebugLog.add("更新包下载完成: " + apk.length() + "B");
                    host.ui().post(() -> {
                        if (!host.isGone()) {
                            install(apk);
                        }
                    });
                } catch (Exception e) {
                    DebugLog.add("更新下载失败: " + e.getMessage());
                    host.ui().post(() -> {
                        if (!host.isGone()) {
                            Toast.makeText(a, "下载失败：" + e.getMessage(),
                                    Toast.LENGTH_LONG).show();
                        }
                    });
                }
            });
        } catch (java.util.concurrent.RejectedExecutionException e) {
            // M8：MainActivity.onDestroy 会 shutdownNow 线程池；
            // 这里 isGone() 判定与提交之间被销毁就会抛未捕获异常（UI 线程闪退）
            android.util.Log.w("Updater", "线程池已关闭，取消下载", e);
        }
    }

    private void install(java.io.File apk) {
        Activity a = host.activity();
        if (Build.VERSION.SDK_INT >= 26
                && !a.getPackageManager().canRequestPackageInstalls()) {
            Toast.makeText(a, "请允许安装未知应用后再试", Toast.LENGTH_LONG).show();
            try {
                a.startActivity(new Intent(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:" + a.getPackageName())));
            } catch (Exception ignored) {
            }
            return;
        }
        Uri uri = UpdateProvider.uriFor(a, apk);
        Intent i = new Intent(Intent.ACTION_VIEW)
                .setDataAndType(uri, "application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                        | Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            a.startActivity(i);
        } catch (Exception e) {
            Toast.makeText(a, "无法启动安装器：" + e.getMessage(), Toast.LENGTH_LONG).show();
        }
    }
}
