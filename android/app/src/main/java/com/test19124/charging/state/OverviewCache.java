package com.test19124.charging.state;

import com.test19124.charging.Cloud;
import com.test19124.charging.DebugLog;

import org.json.JSONObject;

import java.util.concurrent.ExecutorService;

/**
 * /api/overview 缓存（token_pool/health 的唯一来源）。
 *
 * <p>不变量：拉取 30 秒节流 + 单飞；成功才写缓存，失败仅在 DebugLog 留痕；
 * getState 合并窗口 120 秒；成功拉取后向前端补发 {@code window.__onOverview}。</p>
 */
public final class OverviewCache {

    /** 宿主提供的执行与回传能力（MainActivity 实现）。 */
    public interface Host {
        boolean isGone();

        /** 承载 overview 拉取的线程池（与原实现一致：portsPool）。 */
        ExecutorService overviewPool();

        void postJs(String js);
    }

    private static final long FETCH_THROTTLE_MS = 30000;
    /**
     * 缓存可合并进 getState 的最长年龄。应略大于 FETCH_THROTTLE_MS：
     * 太长的话服务器掉线后健康条会继续显示最多 2 分钟的旧令牌状态。
     */
    private static final long MERGE_TTL_MS = 40000;
    /** 最近一次成功拉取的「在线有效期」：超过即视为服务器不可达 */
    private static final long ONLINE_TTL_MS = 120000;

    private final Host host;

    /** 不可变缓存快照：json 与时间戳一起发布、一起读取，避免「新 json + 旧时间」的竞态 */
    private static final class Snapshot {
        final String json;
        final long at;

        Snapshot(String json, long at) {
            this.json = json;
            this.at = at;
        }
    }

    private volatile Snapshot snapshot = null;
    private volatile boolean loading = false;
    /** 是否已经尝试过至少一次拉取（没试过时乐观认为在线，避免首屏闪离线态） */
    private volatile boolean everFetched = false;
    /** 最近一次成功时间。与 cacheAt 分开记：invalidateAndRefetch 清缓存时不清它 */
    private volatile long lastOkAt = 0;

    public OverviewCache(Host host) {
        this.host = host;
    }

    /** 拉取 /api/overview（token_pool/health），30 秒节流；完成后缓存并通知前端。 */
    public void maybeFetch() {
        if (host.isGone()) {
            return;
        }
        long now = System.currentTimeMillis();
        Snapshot cur = snapshot;
        if (cur != null && now - cur.at < FETCH_THROTTLE_MS) {
            return;
        }
        if (loading) {
            return;
        }
        loading = true;
        host.overviewPool().execute(() -> {
            try {
                String json = Cloud.fetchOverview().toString();
                long at = System.currentTimeMillis();
                snapshot = new Snapshot(json, at);
                lastOkAt = at;
                everFetched = true;
                host.postJs("window.__onOverview && window.__onOverview("
                        + JSONObject.quote(json) + ")");
            } catch (Exception e) {
                everFetched = true; // 明确失败：此后 isOnline() 按 lastOkAt 老化判定
                DebugLog.add("overview 获取失败: " + e.getMessage());
                // 失败也要通知前端：否则前端 serverOnline 停在初始 true，
                // 飞行模式下「分析」「历史」tab 不会隐藏（离线降级失效）。
                host.postJs("window.__onOverview && window.__onOverview("
                        + JSONObject.quote("{\"server_online\":false}") + ")");
            } finally {
                loading = false;
            }
        });
    }

    /**
     * 服务器是否可达。前端据此决定是否显示「分析」「历史」等高阶页签。
     *
     * <p>判定：还没试过时乐观认为在线（避免首屏闪一下离线态）；试过之后只看
     * 「最近 2 分钟内是否成功拉取过 overview」。用 lastOkAt 而不是 cache 判断，
     * 这样上传成功后 {@link #invalidateAndRefetch()} 清缓存不会让页签闪动。</p>
     */
    public boolean isOnline() {
        if (!everFetched) {
            return true;
        }
        return lastOkAt > 0 && System.currentTimeMillis() - lastOkAt < ONLINE_TTL_MS;
    }

    /** 缓存原文；从未成功拉取时返回 null（桥据此回 "{}"）。 */
    public String cachedOrNull() {
        Snapshot s = snapshot;
        return s == null ? null : s.json;
    }

    /**
     * 主动失效缓存并立刻重拉（token 保存 / 数据上传成功后调用）。
     *
     * <p>不清缓存的话，{@link #maybeFetch()} 的 30 秒节流会直接返回，
     * 顶部卡片继续沿用旧的 {@code token_ready=false}，表现为「令牌已更新但仍显示不可用」。
     * 拉取成功后 {@code maybeFetch} 会 post {@code window.__onOverview} 通知前端。</p>
     */
    public void invalidateAndRefetch() {
        snapshot = null;
        maybeFetch();
    }

    /** 把 /api/overview 的健康/令牌池字段合并进 getState（前端现有 getOverview 直接读取）。 */
    public void mergeInto(JSONObject root) {
        Snapshot s = snapshot; // 一次读取，json 与时间戳保证配套
        if (s == null || System.currentTimeMillis() - s.at > MERGE_TTL_MS) {
            return;
        }
        try {
            JSONObject o = new JSONObject(s.json);
            // 服务器数据是权威：token_pool/token_ready/earliest_exp 等一律覆盖本地值，
            // 否则本地 token 的过期时间会被误显示成「服务器令牌覆盖到」。
            for (String key : new String[]{"uploads", "received_at", "generated_at",
                    "last_scan_at", "token_ready", "token_valid", "earliest_exp",
                    "interval", "error_count", "token_pool"}) {
                if (o.has(key)) {
                    root.put(key, o.get(key));
                }
            }
        } catch (Exception ignored) {
        }
    }
}
