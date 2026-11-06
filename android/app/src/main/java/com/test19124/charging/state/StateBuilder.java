package com.test19124.charging.state;

import com.test19124.charging.ApiClient;
import com.test19124.charging.Area;
import com.test19124.charging.Store;
import com.test19124.charging.TokenStore;

import org.json.JSONArray;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.List;
import java.util.Locale;

/**
 * {@code AndroidHost.getState()} 的载荷组装：本地快照 + 刷新状态 + token 概览 + overview 合并字段。
 *
 * <p>不变量（前端依赖，逐字段不得改动）：顶层键 {@code now/summary/areas/data_updated_at/project/
 * refresh/token}；areas 每项 {@code id/name/address/captured_at/total_port/idle_port/charging_port/
 * fault_port}；失败时返回固定兜底串。</p>
 */
public final class StateBuilder {

    private StateBuilder() {
    }

    /**
     * @param store           本地快照
     * @param tokens          token 存储
     * @param refreshRunning  刷新是否在跑
     * @param refreshProgress 刷新进度文案
     * @param overview        /api/overview 缓存（合并进顶层，无缓存时跳过）
     */
    public static String build(Store store, TokenStore tokens, boolean refreshRunning,
                               String refreshProgress, OverviewCache overview) {
        try {
            JSONObject root = new JSONObject();
            root.put("now", new SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.CHINA)
                    .format(new Date()));

            List<Area> areas = store.load();
            long updated = store.updatedAt();
            JSONArray arr = new JSONArray();
            int idle = 0, charging = 0, fault = 0, total = 0;
            String captured = updated > 0
                    ? new SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.CHINA).format(new Date(updated))
                    : null;
            for (Area a : areas) {
                JSONObject o = new JSONObject();
                o.put("id", a.id);
                o.put("name", a.name);
                o.put("address", a.address);
                o.put("captured_at", captured);
                o.put("total_port", a.total);
                o.put("idle_port", a.idle);
                o.put("charging_port", a.charging);
                o.put("fault_port", a.fault);
                arr.put(o);
                idle += a.idle;
                charging += a.charging;
                fault += a.fault;
                total += a.total;
            }
            JSONObject summary = new JSONObject();
            summary.put("areas", areas.size());
            summary.put("total", total);
            summary.put("idle", idle);
            summary.put("charging", charging);
            summary.put("fault", fault);
            root.put("summary", summary);
            root.put("areas", arr);
            root.put("data_updated_at", captured);
            root.put("project", store.project());

            JSONObject refresh = new JSONObject();
            refresh.put("running", refreshRunning);
            refresh.put("progress", refreshProgress);
            root.put("refresh", refresh);

            JSONObject token = new JSONObject();
            String t = tokens.get();
            ApiClient.Jwt jwt = ApiClient.parseJwt(t);
            boolean valid = jwt != null && jwt.expiresAt * 1000 > System.currentTimeMillis();
            token.put("present", valid);
            if (jwt != null) {
                token.put("expires_at", jwt.expiresAt);
                token.put("remaining_seconds", Math.max(0, jwt.expiresAt - System.currentTimeMillis() / 1000));
                token.put("user_id", jwt.userId);
            }
            root.put("token", token);
            // 服务器可达性：前端据此决定要不要显示「分析」「历史」这两个需要云端数据的页签。
            // 放在 mergeInto 之前，overview 里若有同名字段也不会覆盖（mergeInto 只补缺失键）。
            root.put("server_online", overview.isOnline());
            overview.mergeInto(root);
            return root.toString();
        } catch (Exception e) {
            return "{\"areas\":[],\"summary\":{\"areas\":0,\"total\":0,\"idle\":0,\"charging\":0,\"fault\":0},\"token\":{\"present\":false}}";
        }
    }
}
