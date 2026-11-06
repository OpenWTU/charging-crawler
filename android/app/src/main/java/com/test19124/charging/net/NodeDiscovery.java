package com.test19124.charging.net;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.os.Handler;
import android.os.Looper;

import com.test19124.charging.DebugLog;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * 节点发现：让 App 不依赖单一固定服务器。
 *
 * <p>流程（init 时后台执行）：
 * <ol>
 *   <li>读本地缓存的上次成功节点（若有）作为初始值；</li>
 *   <li>从 GitHub raw 拉 nodes.json 目录；</li>
 *   <li>逐个做 /health 健康检查，选第一个通的切换过去；</li>
 *   <li>mDNS 发现局域网内 {@code _charge-http._tcp} 服务（零配置，校园网部署场景）；</li>
 *   <li>全部失败则保持内置 DEFAULT_BASE。</li>
 * </ol>
 *
 * <p>不变量：{@link #currentBase()} 永远返回一个可用的完整 URL（末尾无斜杠），
 * 最差退化为 {@link #DEFAULT_BASE}，因此调用方无需判空。</p>
 */
public final class NodeDiscovery {

    /** 内置兜底（GitHub 目录、缓存、mDNS 都不可用时用它） */
    public static final String DEFAULT_BASE = "https://charge.lizishuo.cn";

    private static final String DIRECTORY_URL =
            "https://raw.githubusercontent.com/OpenWTU/charging-crawler/main/server/p2p/nodes.json";
    private static final String MDNS_TYPE = "_charge-http._tcp.";
    private static final String PREFS = "charge_nodes";
    private static final String KEY_BASE = "node_base";
    private static final int PROBE_TIMEOUT_MS = 3000;

    private static volatile String currentBase = DEFAULT_BASE;
    private static volatile boolean initialized = false;
    private static Context appContext;
    private static NsdManager nsdManager;
    private static NsdManager.DiscoveryListener discoveryListener;
    private static final Handler mainHandler = new Handler(Looper.getMainLooper());

    private NodeDiscovery() {
    }

    /** 在 Application / MainActivity 启动时调用一次（幂等） */
    public static synchronized void init(Context context) {
        if (initialized) {
            return;
        }
        initialized = true;
        appContext = context.getApplicationContext();

        String cached = prefs().getString(KEY_BASE, "");
        if (!cached.isEmpty()) {
            currentBase = cached;
        }

        Thread t = new Thread(NodeDiscovery::discover, "node-discovery");
        t.setDaemon(true);
        t.start();
    }

    /** 当前可用节点的完整 URL（末尾无斜杠）；永不为空 */
    public static String currentBase() {
        String b = currentBase;
        if (b.endsWith("/")) {
            b = b.substring(0, b.length() - 1);
        }
        return b;
    }

    /* ---------------- 发现主流程 ---------------- */

    private static void discover() {
        // 1) 优先探测缓存（可能还活着，最快）
        String cached = currentBase;
        if (!cached.equals(DEFAULT_BASE) && healthy(cached)) {
            switchTo(cached);
            return;
        }

        // 2) GitHub 目录
        List<String> candidates = fetchDirectory();
        for (String url : candidates) {
            if (healthy(url)) {
                switchTo(url);
                return;
            }
        }

        // 3) 兜底内置
        if (healthy(DEFAULT_BASE)) {
            switchTo(DEFAULT_BASE);
        } else {
            DebugLog.add("节点发现：全部候选不可达，保持 " + currentBase);
        }

        // 4) 启动 mDNS（局域网零配置发现，异步回调）
        startMdns();
    }

    private static List<String> fetchDirectory() {
        List<String> out = new ArrayList<>();
        HttpURLConnection conn = null;
        try {
            URL url = new URL(DIRECTORY_URL);
            conn = (HttpURLConnection) url.openConnection();
            conn.setConnectTimeout(PROBE_TIMEOUT_MS);
            conn.setReadTimeout(PROBE_TIMEOUT_MS);
            conn.setRequestProperty("User-Agent", "ChargingPileApp");
            InputStream in = conn.getInputStream();
            BufferedReader reader = new BufferedReader(
                    new InputStreamReader(in, StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = reader.readLine()) != null) {
                sb.append(line);
            }
            reader.close();
            JSONObject root = new JSONObject(sb.toString());
            JSONArray arr = root.optJSONArray("nodes");
            if (arr != null) {
                for (int i = 0; i < arr.length(); i++) {
                    JSONObject n = arr.optJSONObject(i);
                    if (n == null) {
                        continue;
                    }
                    String u = n.optString("url", "").trim();
                    if (!u.isEmpty()) {
                        out.add(u);
                    }
                }
            }
        } catch (Exception e) {
            DebugLog.add("节点目录拉取失败: " + e.getMessage());
        } finally {
            if (conn != null) {
                conn.disconnect();
            }
        }
        return out;
    }

    /** 探测节点 /health；3 秒超时，HTTP 200 视为可用 */
    private static boolean healthy(String base) {
        HttpURLConnection conn = null;
        try {
            String b = base.endsWith("/") ? base.substring(0, base.length() - 1) : base;
            URL url = new URL(b + "/health");
            conn = (HttpURLConnection) url.openConnection();
            conn.setConnectTimeout(PROBE_TIMEOUT_MS);
            conn.setReadTimeout(PROBE_TIMEOUT_MS);
            conn.setRequestProperty("User-Agent", "ChargingPileApp");
            return conn.getResponseCode() == 200;
        } catch (Exception e) {
            return false;
        } finally {
            if (conn != null) {
                conn.disconnect();
            }
        }
    }

    private static void switchTo(String base) {
        String b = base.endsWith("/") ? base.substring(0, base.length() - 1) : base;
        currentBase = b;
        prefs().edit().putString(KEY_BASE, b).apply();
        DebugLog.add("节点切换: " + b);
    }

    private static SharedPreferences prefs() {
        return appContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /* ---------------- mDNS ---------------- */

    private static void startMdns() {
        try {
            nsdManager = (NsdManager) appContext.getSystemService(Context.NSD_SERVICE);
            if (nsdManager == null) {
                return;
            }
            discoveryListener = new NsdManager.DiscoveryListener() {
                @Override
                public void onDiscoveryStarted(String serviceType) {
                }

                @Override
                public void onServiceFound(NsdServiceInfo service) {
                    // 解析前先过滤服务类型
                    if (!MDNS_TYPE.equals(service.getServiceType())) {
                        return;
                    }
                    nsdManager.resolveService(service, new NsdManager.ResolveListener() {
                        @Override
                        public void onResolveFailed(NsdServiceInfo serviceInfo, int errorCode) {
                        }

                        @Override
                        public void onServiceResolved(NsdServiceInfo serviceInfo) {
                            String host = serviceInfo.getHost() != null
                                    ? serviceInfo.getHost().getHostAddress() : null;
                            int port = serviceInfo.getPort();
                            if (host == null || port <= 0) {
                                return;
                            }
                            final String base = "http://" + host + ":" + port;
                            // 健康检查放后台线程
                            new Thread(() -> {
                                if (healthy(base)) {
                                    switchTo(base);
                                }
                            }, "mdns-probe").start();
                        }
                    });
                }

                @Override
                public void onServiceLost(NsdServiceInfo service) {
                }

                @Override
                public void onDiscoveryStopped(String serviceType) {
                }

                @Override
                public void onStartDiscoveryFailed(String serviceType, int errorCode) {
                    DebugLog.add("mDNS 发现启动失败: " + errorCode);
                }

                @Override
                public void onStopDiscoveryFailed(String serviceType, int errorCode) {
                }
            };
            // NsdManager 回调需要主线程 Looper，必须 post 到主线程
            mainHandler.post(() -> {
                try {
                    nsdManager.discoverServices(MDNS_TYPE, NsdManager.PROTOCOL_DNS_SD, discoveryListener);
                } catch (Exception e) {
                    DebugLog.add("mDNS discoverServices 失败: " + e.getMessage());
                }
            });
        } catch (Exception e) {
            DebugLog.add("mDNS 初始化失败: " + e.getMessage());
        }
    }
}
