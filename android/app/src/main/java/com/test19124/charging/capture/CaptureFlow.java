package com.test19124.charging.capture;

import android.app.Activity;
import android.content.Intent;
import android.net.VpnService;
import android.os.Build;
import android.os.Handler;
import android.util.Log;
import android.widget.Toast;

import com.test19124.charging.CaptureVpnService;
import com.test19124.charging.DebugLog;

import java.net.Inet4Address;
import java.net.InetAddress;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;

/**
 * 抓包流程编排：解析平台域名 → 申请 VPN 授权 → 启动 {@link CaptureVpnService}（含诊断模式）。
 *
 * <p>不变量：先解析出 IPv4 白名单再启动服务（解析失败不发 Intent）；Android 13+ 抓包前请求
 * 通知权限；VPN 授权走 {@code startActivityForResult(REQ_VPN)}，结果由宿主回灌
 * {@link #onActivityResult(int, int)}。抓包本身的报文解析仍在 CaptureVpnService / Packets。</p>
 */
public final class CaptureFlow {

    /** 宿主提供的依赖（MainActivity 实现）。 */
    public interface Host {
        Activity activity();

        /** 域名解析与后续异步动作使用的单线程池。 */
        ExecutorService capturePool();

        Handler ui();

        boolean isGone();
    }

    private static final int REQ_VPN = 1001;
    private static final int REQ_NOTIF = 43;

    private final Host host;

    private String[] pendingIps;
    private boolean pendingDebug;

    public CaptureFlow(Host host) {
        this.host = host;
    }

    /** 抓取 token（普通模式）。 */
    public void startToken() {
        start(false);
    }

    /** 诊断抓包（保留更多日志）。 */
    public void startDiagnose() {
        start(true);
    }

    /** 停止抓包（服务自身负责收尾广播）。 */
    public void stop() {
        final Activity a = host.activity();
        host.ui().post(() -> a.startService(new Intent(a, CaptureVpnService.class)
                .setAction(CaptureVpnService.ACTION_STOP)));
    }

    /** 进入抓包：把已解析的 IP 白名单与调试标志交给服务。 */
    public void begin() {
        Activity a = host.activity();
        Intent i = new Intent(a, CaptureVpnService.class);
        i.setAction(CaptureVpnService.ACTION_START);
        i.putExtra(CaptureVpnService.EXTRA_IPS, pendingIps);
        i.putExtra(CaptureVpnService.EXTRA_DEBUG, pendingDebug);
        a.startService(i);
        Toast.makeText(a, "抓包已开启，请到微信打开快充页面", Toast.LENGTH_LONG).show();
    }

    /** VPN 授权回调（requestCode 必须匹配本次流程）。 */
    public void onActivityResult(int requestCode, int resultCode) {
        if (requestCode == REQ_VPN) {
            if (resultCode == Activity.RESULT_OK) {
                begin();
            } else {
                Toast.makeText(host.activity(), "未授权 VPN", Toast.LENGTH_SHORT).show();
            }
        }
    }

    /** 权限回调：只关心通知权限（结果不影响抓包，仅记日志）。 */
    public void onRequestPermissionsResult(int requestCode, int[] grantResults) {
        if (requestCode == REQ_NOTIF) {
            // 通知权限结果不影响抓包（服务仍启动，只是通知可能不可见）
            DebugLog.add("通知权限结果: " + (grantResults.length > 0 && grantResults[0] == 0));
        }
    }

    private void start(boolean debug) {
        final Activity a = host.activity();
        pendingDebug = debug;
        host.ui().post(this::requestNotificationPermissionIfNeeded);
        host.ui().post(() -> Toast.makeText(a, debug ? "正在开启诊断抓包…" : "正在解析平台地址…",
                Toast.LENGTH_SHORT).show());
        host.capturePool().execute(() -> {
            List<String> ips = new ArrayList<>();
            for (String hostName : new String[]{"ap3202.haokuaichong.cn",
                    "ai.zhinengchongdian.com"}) {
                try {
                    for (InetAddress ia : InetAddress.getAllByName(hostName)) {
                        if (ia instanceof Inet4Address) {
                            ips.add(ia.getHostAddress());
                        }
                    }
                } catch (Exception ignored) {
                }
            }
            host.ui().post(() -> {
                if (ips.isEmpty()) {
                    Toast.makeText(a, "解析平台地址失败", Toast.LENGTH_SHORT).show();
                    return;
                }
                pendingIps = ips.toArray(new String[0]);
                Intent prep = VpnService.prepare(a);
                if (prep != null) {
                    a.startActivityForResult(prep, REQ_VPN);
                } else {
                    begin();
                }
            });
        });
    }

    /** Android 13+：首次抓包前请求通知权限（否则抓包前台通知不可见）。 */
    private void requestNotificationPermissionIfNeeded() {
        Activity a = host.activity();
        if (Build.VERSION.SDK_INT < 33 || host.isGone()) {
            return;
        }
        if (a.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)
                == android.content.pm.PackageManager.PERMISSION_GRANTED) {
            return;
        }
        try {
            a.requestPermissions(new String[]{
                    android.Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIF);
        } catch (Exception e) {
            Log.w("CaptureFlow", "申请通知权限失败: " + e);
        }
    }
}
