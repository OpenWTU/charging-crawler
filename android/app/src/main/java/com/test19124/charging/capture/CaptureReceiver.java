package com.test19124.charging.capture;

import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Build;
import android.os.Handler;
import android.util.Log;
import android.widget.Toast;

import com.test19124.charging.CaptureVpnService;
import com.test19124.charging.DebugLog;

/**
 * 抓包结果广播接收器（只有持签名权限的本应用能发/收）。
 *
 * <p>不变量：抓到 token → 通知前端 {@code __onTokenCaptured}，并在 8 秒后兜底停一次 VPN；
 * 抓包结束仍无 token → 通知前端 {@code __onCaptureEnd}。注册失败只记日志，不影响启动。</p>
 */
public final class CaptureReceiver {

    /** 宿主提供的依赖（MainActivity 实现）。 */
    public interface Host {
        Activity activity();

        Handler ui();

        boolean isGone();

        void postJs(String js);
    }

    /** 抓到 token 后延迟停 VPN 的兜底时长：让页面继续把加载走完。 */
    private static final long STOP_VPN_FALLBACK_MS = 8000;

    private final Host host;

    private BroadcastReceiver receiver;

    public CaptureReceiver(Host host) {
        this.host = host;
    }

    /** 注册（onCreate 调用一次）。 */
    public void register() {
        receiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                if (CaptureVpnService.ACTION_END.equals(intent.getAction())) {
                    Toast.makeText(host.activity(), "抓包结束：未抓到 token", Toast.LENGTH_LONG).show();
                    host.postJs("window.__onCaptureEnd && window.__onCaptureEnd()");
                    return;
                }
                // 抓到 token：页面先继续加载几秒，8 秒后兜底停一次 VPN
                DebugLog.add("Activity 收到 token，8 秒后兜底停 VPN");
                host.ui().postDelayed(() -> {
                    if (!host.isGone()) {
                        Activity a = host.activity();
                        a.stopService(new Intent(a, CaptureVpnService.class));
                    }
                }, STOP_VPN_FALLBACK_MS);
                host.postJs("window.__onTokenCaptured && window.__onTokenCaptured()");
            }
        };
        IntentFilter filter = new IntentFilter(CaptureVpnService.ACTION_TOKEN);
        filter.addAction(CaptureVpnService.ACTION_END);
        Activity a = host.activity();
        try {
            if (Build.VERSION.SDK_INT >= 33) {
                a.registerReceiver(receiver, filter, CaptureVpnService.PERM_RECEIVE, null,
                        Context.RECEIVER_NOT_EXPORTED);
            } else {
                a.registerReceiver(receiver, filter, CaptureVpnService.PERM_RECEIVE, null);
            }
        } catch (Exception e) {
            Log.w("CaptureReceiver", "注册广播失败: " + e);
        }
    }

    /** 注销（onDestroy 调用；未注册或已注销时静默）。 */
    public void unregister() {
        if (receiver == null) {
            return;
        }
        try {
            host.activity().unregisterReceiver(receiver);
        } catch (Exception ignored) {
        }
        receiver = null;
    }
}
