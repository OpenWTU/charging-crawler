package com.test19124.charging.net;

import com.test19124.charging.Cloud;

import org.json.JSONObject;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * 桥触发的只读云请求：区域坐标、空闲时段、单桩详情、实时预测、端口、分析页。
 *
 * <p>不变量：所有结果都通过 {@code window.__onXxx} 回调回传（同步返回值只用于缓存命中或空占位，
 * 与重构前逐字一致）；预测请求按 seq 只回传最新一次。</p>
 */
public final class BridgeNetClient {

    /** 宿主提供的线程池与回传能力（MainActivity 实现）。 */
    public interface Host {
        /** 端口/坐标/空闲时段/桩详情并发读池（互不排队）。 */
        ExecutorService portsPool();

        /** 预测/推荐专用池：避免刷新/抓包占用主池导致超时。 */
        ExecutorService nowPool();

        /** 分析页专用池：长刷新/抓包不影响图表。 */
        ExecutorService analyticsPool();

        void postJs(String js);
    }

    private static final long COORDS_CACHE_TTL_MS = 5 * 60 * 1000;

    private final Host host;

    /** 只回传最新一次 getNow 请求的结果，防止排队中的旧响应覆盖新数据。 */
    private final AtomicInteger nowRequestSeq = new AtomicInteger();
    private volatile String coordsCache = null;
    private volatile long coordsCacheAt = 0;
    private volatile boolean coordsLoading = false;

    public BridgeNetClient(Host host) {
        this.host = host;
    }

    /** 区域坐标：5 分钟缓存，命中直接返回；未命中后台拉取后经 __onAreaCoords 回填。 */
    public String areaCoordsJson() {
        long now = System.currentTimeMillis();
        String cached = coordsCache;
        if (cached != null && now - coordsCacheAt < COORDS_CACHE_TTL_MS) {
            return cached;
        }
        if (!coordsLoading) {
            coordsLoading = true;
            host.portsPool().execute(() -> {
                String json;
                boolean ok = false;
                try {
                    json = Cloud.fetchAreaCoords().toString();
                    ok = true;
                } catch (Exception e) {
                    json = "{\"areas\":[]}";
                }
                // 失败不写缓存：一次网络抖动不能让距离功能整场失效
                if (ok) {
                    coordsCache = json;
                    coordsCacheAt = System.currentTimeMillis();
                }
                coordsLoading = false;
                host.postJs("window.__onAreaCoords && window.__onAreaCoords("
                        + JSONObject.quote(json) + ")");
            });
        }
        return "{\"areas\":[]}";
    }

    /** 空闲时段（/api/free-rate?days=N）：回调 window.__onFreeRate(json)。 */
    public void freeRate(int days) {
        host.portsPool().execute(() -> {
            String json;
            try {
                json = Cloud.fetchFreeRate(days).toString();
            } catch (Exception e) {
                json = "{\"ok\":false,\"error\":\"空闲时段加载失败\"}";
            }
            host.postJs("window.__onFreeRate && window.__onFreeRate("
                    + JSONObject.quote(json) + ")");
        });
    }

    /** 单台桩详情（/api/pile/&lt;device_hex&gt;）：回调 window.__onPile(json)。 */
    public void pile(String deviceHex) {
        host.portsPool().execute(() -> {
            String json;
            try {
                String hex = deviceHex == null ? "" : deviceHex.trim();
                if (hex.isEmpty()) {
                    json = "{\"ok\":false,\"error\":\"缺少设备号\"}";
                } else {
                    json = Cloud.fetchPile(hex).toString();
                }
            } catch (Exception e) {
                json = "{\"ok\":false,\"error\":\"桩详情加载失败\"}";
            }
            host.postJs("window.__onPile && window.__onPile("
                    + JSONObject.quote(json) + ")");
        });
    }

    public void nowWithCoords(double lat, double lng) {
        final int seq = nowRequestSeq.incrementAndGet();
        host.nowPool().execute(() -> {
            if (seq != nowRequestSeq.get()) {
                return; // 进池前已被更新的请求取代：不打网络
            }
            String json;
            try {
                json = Cloud.fetchNowCoords(lat, lng).toString();
            } catch (Exception e) {
                json = "{\"areas\":[]}";
            }
            if (seq != nowRequestSeq.get()) {
                return; // 网络期间又有新请求：丢弃旧响应
            }
            host.postJs("window.__onNow && window.__onNow("
                    + JSONObject.quote(nowPayload(json, seq)) + ")");
        });
    }

    public void areasPorts() {
        host.portsPool().execute(() -> {
            String json;
            try {
                json = Cloud.fetchAreasPorts().toString();
            } catch (Exception e) {
                json = "{\"ok\":false,\"areas\":[]}";
            }
            host.postJs("window.__onAreasPorts && window.__onAreasPorts("
                    + JSONObject.quote(json) + ")");
        });
    }

    public void areaPorts(String area) {
        host.portsPool().execute(() -> {
            String json;
            try {
                json = Cloud.fetchAreaPorts(area).toString();
            } catch (Exception e) {
                json = "{\"ok\":false,\"devices\":[]}";
            }
            host.postJs("window.__onAreaPorts && window.__onAreaPorts("
                    + JSONObject.quote(json) + ")");
        });
    }

    public void now() {
        final int seq = nowRequestSeq.incrementAndGet();
        host.nowPool().execute(() -> {
            if (seq != nowRequestSeq.get()) {
                return; // 进池前已被更新的请求取代：不打网络
            }
            String json;
            try {
                json = Cloud.fetchNow().toString();
            } catch (Exception e) {
                json = "{\"areas\":[]}";
            }
            if (seq != nowRequestSeq.get()) {
                return; // 网络期间又有新请求：丢弃旧响应
            }
            host.postJs("window.__onNow && window.__onNow("
                    + JSONObject.quote(nowPayload(json, seq)) + ")");
        });
    }

    public void analytics() {
        host.analyticsPool().execute(() -> {
            String json;
            try {
                json = Cloud.fetchAnalytics().toString();
            } catch (Exception e) {
                json = "{\"samples\":0}";
            }
            host.postJs("window.__onAnalytics && window.__onAnalytics("
                    + JSONObject.quote(json) + ")");
        });
    }

    /**
     * 单区历史 → window.__onHistory(json)。
     *
     * <p>失败时回 {@code {"ok":false,"error":"..."}}，前端据此显示错误态而不是空图。
     * 与 analytics 共用 analyticsPool（同属低频分析类请求，不挤占端口池）。</p>
     */
    public void history(String area, int limit) {
        final String a = area == null ? "" : area;
        final int n = limit;
        host.analyticsPool().execute(() -> {
            String json;
            try {
                json = Cloud.fetchHistory(a, n).toString();
            } catch (Exception e) {
                json = "{\"ok\":false,\"error\":\"历史数据加载失败\"}";
            }
            host.postJs("window.__onHistory && window.__onHistory("
                    + JSONObject.quote(json) + ")");
        });
    }

    /**
     * 公开状态页 → window.__onStatus(json)。
     *
     * <p>失败时回 {@code {"ok":false,"error":"..."}}，前端据此显示错误态。
     * 与 analytics/history 共用 analyticsPool（同属低频类请求）。</p>
     */
    public void status() {
        host.analyticsPool().execute(() -> {
            String json;
            try {
                json = Cloud.fetchStatus().toString();
            } catch (Exception e) {
                json = "{\"ok\":false,\"error\":\"状态读取失败\"}";
            }
            host.postJs("window.__onStatus && window.__onStatus("
                    + JSONObject.quote(json) + ")");
        });
    }

    /** 手动切换连接的服务器节点（状态页卡片确认后调用） */
    public void setNodeBase(String url) {
        NodeDiscovery.switchToNode(url);
    }

    /** 预测载荷带上 seq，供前端按最新请求过滤。 */
    private static String nowPayload(String json, int seq) {
        try {
            JSONObject o = new JSONObject(json);
            o.put("_seq", seq);
            return o.toString();
        } catch (Exception e) {
            return json;
        }
    }
}
