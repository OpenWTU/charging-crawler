package com.test19124.charging;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/** 本地缓存：最后一次抓取结果，不联网也能看。 */
public class Store {

    private static final String PREFS = "charging_data";
    private static final String K_SNAP = "snapshot";
    private static final String K_TIME = "updated_at";
    private static final String K_PROJECT = "project";
    private static final String K_PENDING = "pending_upload";
    private static final String K_PENDING_AT = "pending_next_at";
    private static final String K_PENDING_FAILS = "pending_fails";

    private final SharedPreferences prefs;

    public Store(Context context) {
        prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    public void save(List<Area> areas, long updatedAt, String project) {
        JSONArray arr = new JSONArray();
        for (Area a : areas) {
            arr.put(a.toJson());
        }
        prefs.edit()
                .putString(K_SNAP, arr.toString())
                .putLong(K_TIME, updatedAt)
                .putString(K_PROJECT, project)
                .apply();
    }

    public List<Area> load() {
        List<Area> list = new ArrayList<>();
        try {
            JSONArray arr = new JSONArray(prefs.getString(K_SNAP, "[]"));
            for (int i = 0; i < arr.length(); i++) {
                list.add(Area.fromJson(arr.getJSONObject(i)));
            }
        } catch (Exception ignored) {
        }
        return list;
    }

    public long updatedAt() {
        return prefs.getLong(K_TIME, 0);
    }

    public String project() {
        return prefs.getString(K_PROJECT, "");
    }

    // ---- 待上传快照：上传失败时保留，下次刷新优先补传 ----

    public void savePendingUpload(String stateJson) {
        prefs.edit().putString(K_PENDING, stateJson == null ? "" : stateJson).apply();
    }

    /** 没有待补传快照时返回 null。 */
    public String pendingUpload() {
        String s = prefs.getString(K_PENDING, null);
        return (s == null || s.isEmpty()) ? null : s;
    }

    public void clearPendingUpload() {
        if (prefs.contains(K_PENDING)) {
            prefs.edit()
                    .remove(K_PENDING)
                    .remove(K_PENDING_AT)
                    .remove(K_PENDING_FAILS)
                    .apply();
        }
    }

    /** 下一次允许补传的时间点（指数退避，防止失败后每次刷新都打上游）。 */
    public long pendingRetryAt() {
        return prefs.getLong(K_PENDING_AT, 0);
    }

    /** 记录一次补传/上传失败，返回累计失败次数。 */
    public int notePendingFailure() {
        int n = prefs.getInt(K_PENDING_FAILS, 0) + 1;
        long delay = Math.min(10 * 60 * 1000L, 30000L * (1L << Math.min(n - 1, 4)));
        prefs.edit()
                .putInt(K_PENDING_FAILS, n)
                .putLong(K_PENDING_AT, System.currentTimeMillis() + delay)
                .apply();
        return n;
    }
}
