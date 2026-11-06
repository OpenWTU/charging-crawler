package com.test19124.charging;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;

/** 直连充电平台：本地算签名，不经过任何自建服务器。 */
public class ApiClient {

    public static final String BASE = "https://ap3202.haokuaichong.cn/quickuser50/";
    private static final String CHARS = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
    private static final String UA =
            "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) "
                    + "Chrome/144.0.0.0 Mobile Safari/537.36 MicroMessenger/8.0.50 XWEB/25819";

    private final String token;
    private final String userId;

    public static class TokenExpired extends IOException {
        public TokenExpired(String msg) {
            super(msg);
        }
    }

    public ApiClient(String token, String userId) {
        this.token = token;
        this.userId = userId;
    }

    public JSONObject get(String path, Map<String, String> params) throws IOException {
        String url = BASE + path;
        if (params != null && !params.isEmpty()) {
            StringBuilder sb = new StringBuilder("?");
            for (Map.Entry<String, String> e : params.entrySet()) {
                if (sb.length() > 1) {
                    sb.append('&');
                }
                sb.append(URLEncoder.encode(e.getKey(), "UTF-8"))
                        .append('=')
                        .append(URLEncoder.encode(e.getValue(), "UTF-8"));
            }
            url += sb;
        }
        return request(url);
    }

    private JSONObject request(String url) throws IOException {
        String ts = Long.toString(System.currentTimeMillis());
        String seq = randomSeq(16);
        String tail = url.substring(url.indexOf("quickuser50") + "quickuser50".length());
        String sig = md5(joinByLengthDesc(new String[]{tail, userId, token, "",
                ts.substring(0, 9), seq}));

        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setRequestMethod("GET");
        conn.setConnectTimeout(10000);
        conn.setReadTimeout(15000);
        conn.setRequestProperty("content-type", "application/x-www-form-urlencoded");
        conn.setRequestProperty("Authorization", "Bearer " + token);
        conn.setRequestProperty("X-Timestamp", ts);
        conn.setRequestProperty("X-Signature", sig);
        conn.setRequestProperty("X-seq", seq);
        conn.setRequestProperty("X-AppID", "");
        conn.setRequestProperty("User-Agent", UA);

        int http = conn.getResponseCode();
        try {
            InputStream in = http >= 400 ? conn.getErrorStream() : conn.getInputStream();
            String body = readAll(in);

            JSONObject obj;
            try {
                obj = new JSONObject(body);
            } catch (Exception e) {
                throw new IOException("返回不是 JSON（HTTP " + http + "）");
            }
            int code = obj.optInt("code", 0);
            if (code == 20001 || code == 70006 || code == 70004) {
                throw new TokenExpired(obj.optString("msg", "登录态失效"));
            }
            if (code != 200) {
                throw new IOException("接口返回 " + code + ": " + obj.optString("msg", "未知错误"));
            }
            return obj;
        } finally {
            conn.disconnect();
        }
    }

    // ---- 业务接口 ----
    public JSONObject userInfo() throws IOException {
        JSONObject o = get("user/userInfo", null);
        JSONObject data = o.optJSONObject("data");
        if (data == null) {
            throw new IOException("userInfo 缺少 data");
        }
        return data;
    }

    public JSONArray areaList(int projectId) throws IOException {
        Map<String, String> p = Collections.singletonMap("projectId", String.valueOf(projectId));
        JSONObject o = get("nearArea/list", p);
        try {
            return o.optJSONArray("data") == null ? new JSONArray() : o.getJSONArray("data");
        } catch (Exception e) {
            throw new IOException("areaList 解析失败", e);
        }
    }

    public JSONObject areaStatus(String areaId) throws IOException {
        Map<String, String> p = Collections.singletonMap("isNearBy", "Y");
        String seg = URLEncoder.encode(areaId == null ? "" : areaId, "UTF-8").replace("+", "%20");
        JSONObject o = get("nearArea/" + seg, p);
        JSONArray arr = o.optJSONArray("data");
        if (arr == null || arr.length() == 0) {
            return null;
        }
        try {
            return arr.getJSONObject(0);
        } catch (Exception e) {
            throw new IOException("areaStatus 解析失败", e);
        }
    }

    // ---- JWT（只解 payload，用于取 userId 和过期时间） ----
    public static class Jwt {
        public String userId;
        public long expiresAt;
    }

    public static Jwt parseJwt(String jwt) {
        try {
            String[] parts = jwt.split("\\.");
            if (parts.length != 3) {
                return null;
            }
            byte[] payload = java.util.Base64.getUrlDecoder().decode(parts[1]);
            JSONObject o = new JSONObject(new String(payload, "UTF-8"));
            if (!"quick_user_api".equals(o.optString("aud"))) {
                return null;
            }
            String encry = o.optString("encryId", "");
            if (encry.isEmpty()) {
                return null;
            }
            Jwt j = new Jwt();
            j.userId = new String(java.util.Base64.getDecoder().decode(encry), "UTF-8");
            j.expiresAt = o.optLong("exp", 0);
            return j.expiresAt > 0 ? j : null;
        } catch (Exception e) {
            return null;
        }
    }

    // ---- 签名工具 ----
    static String joinByLengthDesc(String[] parts) {
        List<String> list = new ArrayList<>();
        Collections.addAll(list, parts);
        Collections.sort(list, (a, b) -> b.length() - a.length()); // 稳定排序
        if (list.size() >= 3) {
            String tmp = list.get(1);
            list.set(1, list.get(list.size() - 1));
            list.set(list.size() - 1, tmp);
        }
        StringBuilder sb = new StringBuilder();
        for (String s : list) {
            sb.append(s);
        }
        return sb.toString();
    }

    static String md5(String text) {
        try {
            MessageDigest md = MessageDigest.getInstance("MD5");
            byte[] d = md.digest(text.getBytes("UTF-8"));
            StringBuilder sb = new StringBuilder();
            for (byte b : d) {
                sb.append(String.format("%02x", b));
            }
            return sb.toString();
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    private static String randomSeq(int n) {
        SecureRandom r = new SecureRandom();
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < n; i++) {
            sb.append(CHARS.charAt(r.nextInt(CHARS.length())));
        }
        return sb.toString();
    }

    private static String readAll(InputStream in) throws IOException {
        if (in == null) {
            return "";
        }
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) {
            out.write(buf, 0, n);
        }
        in.close();
        return out.toString("UTF-8");
    }
}
