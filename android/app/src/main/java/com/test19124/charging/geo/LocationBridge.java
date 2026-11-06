package com.test19124.charging.geo;

import android.app.Activity;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Handler;
import android.util.Log;

import org.json.JSONObject;

/**
 * 定位桥：{@code AndroidHost.getLocation()} 的同步返回 + 异步 {@code window.__onLocation} 回填。
 *
 * <p>不变量：</p>
 * <ul>
 *   <li>返回串只能是 {@code {"lat":..,"lng":..}}、{@code {}} 或 {@code {"error":"no_permission"}}；</li>
 *   <li>无权限时同时申请权限并补发 {@code __onLocation('{}')}，避免前端等满 10 秒；</li>
 *   <li>只有 5 分钟内的 last-known 才直接返回；单次定位请求 20 秒节流、15 秒后自动解锁，避免常开 GPS。</li>
 * </ul>
 */
public final class LocationBridge {

    /** 宿主提供的依赖（MainActivity 实现）。 */
    public interface Host {
        Activity activity();

        Handler ui();

        boolean isGone();

        void postJs(String js);
    }

    /** 定位权限的 requestCode。 */
    public static final int REQ_LOCATION = 42;
    private static final long LAST_KNOWN_MAX_AGE_MS = 300000;
    private static final long FRESH_REQ_THROTTLE_MS = 20000;
    private static final long FRESH_REQ_UNLOCK_MS = 15000;

    private final Host host;

    private volatile boolean locReq = false;
    private volatile long lastLocReqAt = 0;

    public LocationBridge(Host host) {
        this.host = host;
    }

    /** 同步返回最近已知位置，并在需要时后台请求一次单次定位。 */
    public String syncJson() {
        try {
            Activity a = host.activity();
            android.location.LocationManager lm =
                    (android.location.LocationManager) a.getSystemService(Context.LOCATION_SERVICE);
            boolean fine = a.checkSelfPermission(android.Manifest.permission.ACCESS_FINE_LOCATION)
                    == PackageManager.PERMISSION_GRANTED;
            boolean coarse = a.checkSelfPermission(android.Manifest.permission.ACCESS_COARSE_LOCATION)
                    == PackageManager.PERMISSION_GRANTED;
            if (!fine && !coarse) {
                // 权限申请必须在 UI 线程；同时回一个空定位，避免前端等满 10s
                host.ui().post(this::requestPermission);
                host.postJs("window.__onLocation && window.__onLocation('{}')");
                return "{\"error\":\"no_permission\"}";
            }
            long now = System.currentTimeMillis();
            android.location.Location best = null;
            for (String p : new String[]{
                    android.location.LocationManager.GPS_PROVIDER,
                    android.location.LocationManager.NETWORK_PROVIDER,
                    android.location.LocationManager.PASSIVE_PROVIDER}) {
                try {
                    android.location.Location l = lm.getLastKnownLocation(p);
                    if (l != null && (best == null || l.getTime() > best.getTime())) {
                        best = l;
                    }
                } catch (Exception ignored) {
                }
            }
            if (best != null && now - best.getTime() <= LAST_KNOWN_MAX_AGE_MS) {
                if (!locReq) {
                    final android.location.LocationManager lmf = lm;
                    host.ui().post(() -> requestFresh(lmf));
                }
                JSONObject o = new JSONObject();
                o.put("lat", best.getLatitude());
                o.put("lng", best.getLongitude());
                return o.toString();
            }
            // 没有 5 分钟内的定位：异步请求一次单次定位，通过 __onLocation 回填
            if (!locReq) {
                final android.location.LocationManager lmf = lm;
                host.ui().post(() -> requestFresh(lmf));
            }
            return "{}";
        } catch (Exception e) {
            return "{}";
        }
    }

    /** 申请定位权限（必须在 UI 线程调用）。 */
    public void requestPermission() {
        if (host.isGone()) {
            return;
        }
        try {
            host.activity().requestPermissions(new String[]{
                    android.Manifest.permission.ACCESS_FINE_LOCATION,
                    android.Manifest.permission.ACCESS_COARSE_LOCATION}, REQ_LOCATION);
        } catch (Exception e) {
            Log.w("LocationBridge", "申请定位权限失败: " + e);
        }
    }

    /** 权限回调：拿到权限后立即请求一次单次定位。 */
    public void onPermissionResult() {
        try {
            requestFresh((android.location.LocationManager)
                    host.activity().getSystemService(Context.LOCATION_SERVICE));
        } catch (Exception ignored) {
        }
    }

    private void requestFresh(android.location.LocationManager lm) {
        long now = System.currentTimeMillis();
        if (locReq || now - lastLocReqAt < FRESH_REQ_THROTTLE_MS) {
            return; // 20 秒节流：避免 5 秒轮询把 GPS 常开
        }
        lastLocReqAt = now;
        locReq = true;
        new Handler(host.activity().getMainLooper()).postDelayed(() -> locReq = false,
                FRESH_REQ_UNLOCK_MS);
        for (String p : new String[]{
                android.location.LocationManager.GPS_PROVIDER,
                android.location.LocationManager.NETWORK_PROVIDER}) {
            try {
                lm.requestSingleUpdate(p, new android.location.LocationListener() {
                    @Override
                    public void onLocationChanged(android.location.Location l) {
                        locReq = false;
                        try {
                            JSONObject o = new JSONObject();
                            o.put("lat", l.getLatitude());
                            o.put("lng", l.getLongitude());
                            host.postJs("window.__onNativeLocation && window.__onNativeLocation("
                                    + JSONObject.quote(o.toString()) + ");"
                                    + "window.__onLocation && window.__onLocation("
                                    + JSONObject.quote(o.toString()) + ")");
                        } catch (Exception ignored) {
                        }
                    }

                    @Override
                    public void onStatusChanged(String s, int i, android.os.Bundle b) {
                    }

                    @Override
                    public void onProviderEnabled(String s) {
                    }

                    @Override
                    public void onProviderDisabled(String s) {
                    }
                }, host.activity().getMainLooper());
            } catch (Exception ignored) {
            }
        }
    }

    /** 高德导航：先尝试原生 URI（含我的位置），失败退化到网页 URI。必须在 UI 线程调用。 */
    public void navAmap(String name, double lat, double lng, double slat, double slon) {
        Activity a = host.activity();
        String enc = android.net.Uri.encode(name == null ? "" : name);
        String web = "https://uri.amap.com/navigation?to=" + lng + "," + lat + ","
                + enc + "&callnative=1";
        boolean hasStart = !(slat == 0 && slon == 0);
        String startPart = hasStart
                ? "&slat=" + slat + "&slon=" + slon
                  + "&sname=" + android.net.Uri.encode("我的位置")
                : "";
        String[] tries = new String[]{
                "amapuri://route/plan/?sourceApplication=charge" + startPart
                        + "&dlat=" + lat + "&dlon=" + lng + "&dname=" + enc
                        + "&dev=0&t=0",
                "androidamap://route?sourceApplication=charge" + startPart
                        + "&dlat=" + lat + "&dlon=" + lng + "&dname=" + enc
                        + "&dev=0&t=0",
        };
        for (String uri : tries) {
            try {
                android.content.Intent i = new android.content.Intent(
                        android.content.Intent.ACTION_VIEW, android.net.Uri.parse(uri));
                i.setPackage("com.autonavi.minimap");
                i.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
                a.startActivity(i);
                return;
            } catch (Exception ignored) {
            }
        }
        try {
            a.startActivity(new android.content.Intent(android.content.Intent.ACTION_VIEW,
                    android.net.Uri.parse(web))
                    .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK));
        } catch (Exception e) {
            android.widget.Toast.makeText(a, "未安装高德地图", android.widget.Toast.LENGTH_SHORT).show();
        }
    }
}
