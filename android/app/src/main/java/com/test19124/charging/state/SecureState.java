package com.test19124.charging.state;

import android.content.Context;

import com.test19124.charging.ApiClient;
import com.test19124.charging.TokenStore;

import org.json.JSONObject;

/**
 * 「令牌」页相关的本地读写：上传开关、getSettings 载荷、保存 token 的校验与落盘。
 *
 * <p>不变量：getSettings 的键为 {@code upload_token/token_present/expires_at/
 * remaining_seconds/user_id}，异常时回 {@code "{}"}；saveToken 的返回值只能是
 * {@code ok} / {@code invalid} / {@code error:原因}（Toast 由调用方在 UI 线程补）。</p>
 */
public final class SecureState {

    /** token 与上传开关共用的 SharedPreferences 名（与 TokenStore 一致）。 */
    public static final String PREFS = "charging_secure";
    public static final String K_UPLOAD_TOKEN = "upload_token";

    private SecureState() {
    }

    /** 上传时是否携带 token（默认开启）。 */
    public static boolean uploadToken(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .getBoolean(K_UPLOAD_TOKEN, true);
    }

    public static void setUploadToken(Context ctx, boolean on) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit().putBoolean(K_UPLOAD_TOKEN, on).apply();
    }

    /** getSettings 载荷。 */
    public static String settingsJson(Context ctx, TokenStore tokens) {
        try {
            JSONObject o = new JSONObject();
            o.put("upload_token", uploadToken(ctx));
            String t = tokens.get();
            ApiClient.Jwt jwt = ApiClient.parseJwt(t);
            boolean valid = jwt != null && jwt.expiresAt * 1000 > System.currentTimeMillis();
            o.put("token_present", valid);
            if (jwt != null) {
                o.put("expires_at", jwt.expiresAt);
                o.put("remaining_seconds", Math.max(0, jwt.expiresAt
                        - System.currentTimeMillis() / 1000));
                o.put("user_id", jwt.userId);
            }
            return o.toString();
        } catch (Exception e) {
            return "{}";
        }
    }

    /** saveToken 的校验与落盘：ok / invalid / error:原因。 */
    public static String saveToken(TokenStore tokens, String token) {
        try {
            String t = token == null ? "" : token.trim();
            ApiClient.Jwt jwt = ApiClient.parseJwt(t);
            if (jwt == null || jwt.expiresAt * 1000 < System.currentTimeMillis()) {
                return "invalid";
            }
            tokens.save(t);
            return "ok";
        } catch (Exception e) {
            return "error:" + e.getMessage();
        }
    }
}
