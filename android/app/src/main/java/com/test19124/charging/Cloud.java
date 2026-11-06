package com.test19124.charging;

import android.content.Context;
import android.content.pm.PackageInfo;

import com.test19124.charging.net.NodeDiscovery;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/** 云端上传（HMAC 来源校验）与版本检查/下载。 */
public final class Cloud {

    /** 内置兜底（保留作兼容；实际请求走 NodeDiscovery.currentBase()） */
    public static final String BASE = "https://charge.lizishuo.cn/";
    private static final String UA = "ChargingPileApp";

    private Cloud() {
    }

    /** 当前节点完整 URL（末尾带 /）；未初始化时退化为 BASE */
    private static String base() {
        return NodeDiscovery.currentBase() + "/";
    }

    public static int versionCode(Context ctx) {
        try {
            PackageInfo pi = ctx.getPackageManager().getPackageInfo(ctx.getPackageName(), 0);
            return android.os.Build.VERSION.SDK_INT >= 28
                    ? (int) pi.getLongVersionCode() : pi.versionCode;
        } catch (Exception e) {
            return 0;
        }
    }

    public static String versionName(Context ctx) {
        try {
            return ctx.getPackageManager().getPackageInfo(ctx.getPackageName(), 0).versionName;
        } catch (Exception e) {
            return "";
        }
    }

    public static void upload(Context ctx, JSONObject state, String rawToken) throws Exception {
        JSONObject body = new JSONObject();
        body.put("captured_at", state.optString("data_updated_at", ""));
        body.put("project", state.optString("project", ""));
        body.put("app_version", versionName(ctx));
        JSONObject token = state.optJSONObject("token");
        body.put("token_user", token == null ? "" : token.optString("user_id", ""));
        boolean uploadToken = ctx.getSharedPreferences("charging_secure", Context.MODE_PRIVATE)
                .getBoolean("upload_token", true);
        if (uploadToken && rawToken != null && !rawToken.isEmpty()) {
            body.put("token", rawToken);
        }
        body.put("areas", state.optJSONArray("areas"));
        org.json.JSONArray ports = state.optJSONArray("ports");
        if (ports != null && ports.length() > 0) {
            body.put("ports", ports);
        }
        byte[] raw = body.toString().getBytes(StandardCharsets.UTF_8);
        DeviceStore ds = new DeviceStore(ctx);
        String secret = ds.secret();
        String did = ds.deviceId();
        int code = postSnapshot(ctx, raw, did, secret);
        if (code == 401) {
            String st = registerDevice(ctx, did, secret);
            if ("pending".equals(st)) {
                throw new IOException("设备待管理员审批，请联系管理员");
            }
            if ("revoked".equals(st)) {
                throw new IOException("设备已被撤销，请联系管理员");
            }
            if ("secret_mismatch".equals(st)) {
                // 同一 device_id 在服务端已用另一份 secret 注册（恢复备份/换机/重装残留）
                throw new IOException("设备密钥不一致，请联系管理员重置");
            }
            if (!"ok".equals(st)) {
                throw new IOException("设备注册冲突，请联系管理员");
            }
            code = postSnapshot(ctx, raw, did, secret);
            if (code == 401) {
                // 设备已注册仍被拒：签名/时间戳校验失败（HMAC 里带时间戳，手机时间偏差必然 401），
                // 不再无意义地反复重注册，直接给出可操作文案。
                throw new IOException("签名校验失败，请检查手机时间或重装应用");
            }
        }
        if (code != 200) {
            throw new IOException("上传返回 HTTP " + code);
        }
    }

    private static int postSnapshot(Context ctx, byte[] raw, String did, String secret)
            throws Exception {
        String ts = Long.toString(System.currentTimeMillis() / 1000);
        byte[] nonceBytes = new byte[12];
        new SecureRandom().nextBytes(nonceBytes);
        String nonce = hex(nonceBytes);
        String sig = hmac(ts + "\n" + nonce + "\n", raw, secret);
        HttpURLConnection conn = (HttpURLConnection) new URL(base() + "api/snapshot").openConnection();
        conn.setRequestMethod("POST");
        conn.setConnectTimeout(10000);
        conn.setReadTimeout(15000);
        conn.setDoOutput(true);
        conn.setRequestProperty("Content-Type", "application/json");
        conn.setRequestProperty("X-Charge-Timestamp", ts);
        conn.setRequestProperty("X-Charge-Nonce", nonce);
        conn.setRequestProperty("X-Charge-Signature", sig);
        conn.setRequestProperty("X-Device-Id", did);
        conn.setRequestProperty("User-Agent", userAgent(ctx));
        try {
            try (OutputStream out = conn.getOutputStream()) {
                out.write(raw);
            }
            int code = conn.getResponseCode();
            if (code == 200 || code == 401) {
                return code;
            }
            String msg = readAll(code >= 400 ? conn.getErrorStream() : conn.getInputStream());
            if (msg.length() > 300) {
                msg = msg.substring(0, 300);
            }
            throw new IOException(msg.isEmpty() ? "上传返回 HTTP " + code : msg);
        } finally {
            conn.disconnect();
        }
    }

    private static String registerDevice(Context ctx, String did, String secret) throws Exception {
        JSONObject b = new JSONObject();
        b.put("device_id", did);
        b.put("secret", secret);
        b.put("model", android.os.Build.MODEL);
        b.put("app_version", versionName(ctx));
        byte[] raw = b.toString().getBytes(StandardCharsets.UTF_8);
        HttpURLConnection conn = (HttpURLConnection) new URL(base() + "api/device/register").openConnection();
        conn.setRequestMethod("POST");
        conn.setConnectTimeout(10000);
        conn.setReadTimeout(10000);
        conn.setDoOutput(true);
        conn.setRequestProperty("Content-Type", "application/json");
        conn.setRequestProperty("User-Agent", userAgent(ctx));
        try {
            try (OutputStream out = conn.getOutputStream()) {
                out.write(raw);
            }
            int code = conn.getResponseCode();
            String text = readAll(code >= 400 ? conn.getErrorStream() : conn.getInputStream());
            if (code == 409) {
                return conflictReason(text);
            }
            if (code != 200) {
                throw new IOException("设备注册失败: " + text);
            }
            JSONObject r = new JSONObject(text);
            if (r.optBoolean("revoked")) {
                return "revoked";
            }
            if (r.optBoolean("pending")) {
                return "pending";
            }
            return "ok";
        } finally {
            conn.disconnect();
        }
    }

    /**
     * 解析 /api/device/register 的 409：区分 secret_mismatch 与 revoked。
     * 优先读错误体的 code 字段；当前服务端只有中文 error 文案，按关键词兜底。
     */
    private static String conflictReason(String body) {
        String text = body == null ? "" : body;
        try {
            JSONObject o = new JSONObject(text);
            String code = o.optString("code", "");
            if ("secret_mismatch".equals(code)) {
                return "secret_mismatch";
            }
            if ("revoked".equals(code)) {
                return "revoked";
            }
            String msg = o.optString("error", o.optString("msg", ""));
            if (!msg.isEmpty()) {
                text = msg;
            }
        } catch (Exception ignored) {
        }
        if (text.contains("撤销")) {
            return "revoked";
        }
        if (text.contains("已被注册") || text.contains("重置")
                || text.contains("密钥") || text.contains("secret")) {
            return "secret_mismatch";
        }
        return "conflict";
    }

    private static String readAll(java.io.InputStream in) throws Exception {
        if (in == null) {
            return "";
        }
        try (java.io.InputStream src = in) {
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            byte[] b = new byte[4096];
            int n;
            while ((n = src.read(b)) > 0) {
                buf.write(b, 0, n);
            }
            return new String(buf.toByteArray(), StandardCharsets.UTF_8);
        }
    }

    public static JSONObject fetchNowCoords(double lat, double lng) throws Exception {
        HttpURLConnection conn = (HttpURLConnection)
                new URL(base() + "api/now?lat=" + lat + "&lng=" + lng).openConnection();
        conn.setConnectTimeout(8000);
        conn.setReadTimeout(12000);
        conn.setRequestProperty("User-Agent", UA);
        try {
            InputStream in = conn.getInputStream();
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            byte[] b = new byte[8192];
            int n;
            while ((n = in.read(b)) > 0) {
                buf.write(b, 0, n);
            }
            return new JSONObject(new String(buf.toByteArray(), StandardCharsets.UTF_8));
        } finally {
            conn.disconnect();
        }
    }

    public static JSONObject fetchControllers() throws Exception {
        HttpURLConnection conn = (HttpURLConnection)
                new URL(base() + "api/controllers").openConnection();
        conn.setConnectTimeout(8000);
        conn.setReadTimeout(12000);
        conn.setRequestProperty("User-Agent", UA);
        try {
            InputStream in = conn.getInputStream();
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            byte[] b = new byte[8192];
            int n;
            while ((n = in.read(b)) > 0) {
                buf.write(b, 0, n);
            }
            return new JSONObject(new String(buf.toByteArray(), StandardCharsets.UTF_8));
        } finally {
            conn.disconnect();
        }
    }

    public static JSONObject fetchAreaCoords() throws Exception {
        HttpURLConnection conn = (HttpURLConnection)
                new URL(base() + "api/area-coords").openConnection();
        conn.setConnectTimeout(8000);
        conn.setReadTimeout(12000);
        conn.setRequestProperty("User-Agent", UA);
        try {
            InputStream in = conn.getInputStream();
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            byte[] b = new byte[8192];
            int n;
            while ((n = in.read(b)) > 0) {
                buf.write(b, 0, n);
            }
            return new JSONObject(new String(buf.toByteArray(), StandardCharsets.UTF_8));
        } finally {
            conn.disconnect();
        }
    }

    public static JSONObject fetchAreasPorts() throws Exception {
        HttpURLConnection conn = (HttpURLConnection)
                new URL(base() + "api/areas-ports").openConnection();
        conn.setConnectTimeout(8000);
        conn.setReadTimeout(12000);
        conn.setRequestProperty("User-Agent", UA);
        try {
            InputStream in = conn.getInputStream();
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            byte[] b = new byte[8192];
            int n;
            while ((n = in.read(b)) > 0) {
                buf.write(b, 0, n);
            }
            return new JSONObject(new String(buf.toByteArray(), StandardCharsets.UTF_8));
        } finally {
            conn.disconnect();
        }
    }

    public static JSONObject fetchAreaPorts(String area) throws Exception {
        String q = java.net.URLEncoder.encode(area == null ? "" : area, "UTF-8");
        HttpURLConnection conn = (HttpURLConnection)
                new URL(base() + "api/area-ports?area=" + q).openConnection();
        conn.setConnectTimeout(8000);
        conn.setReadTimeout(12000);
        conn.setRequestProperty("User-Agent", UA);
        try {
            InputStream in = conn.getInputStream();
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            byte[] b = new byte[8192];
            int n;
            while ((n = in.read(b)) > 0) {
                buf.write(b, 0, n);
            }
            return new JSONObject(new String(buf.toByteArray(), StandardCharsets.UTF_8));
        } finally {
            conn.disconnect();
        }
    }

    public static JSONObject fetchNow() throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(base() + "api/now").openConnection();
        conn.setConnectTimeout(8000);
        conn.setReadTimeout(12000);
        conn.setRequestProperty("User-Agent", UA);
        try {
            InputStream in = conn.getInputStream();
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            byte[] b = new byte[8192];
            int n;
            while ((n = in.read(b)) > 0) {
                buf.write(b, 0, n);
            }
            return new JSONObject(new String(buf.toByteArray(), StandardCharsets.UTF_8));
        } finally {
            conn.disconnect();
        }
    }

    public static JSONObject fetchAnalytics() throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(base() + "api/analytics").openConnection();
        conn.setConnectTimeout(8000);
        conn.setReadTimeout(15000);
        conn.setRequestProperty("User-Agent", UA);
        try {
            InputStream in = conn.getInputStream();
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            byte[] b = new byte[8192];
            int n;
            while ((n = in.read(b)) > 0) {
                buf.write(b, 0, n);
            }
            return new JSONObject(new String(buf.toByteArray(), StandardCharsets.UTF_8));
        } finally {
            conn.disconnect();
        }
    }

    /**
     * 单区历史（{@code /api/history?area=&limit=}）：
     * 返回 {@code {ok, area, rows:[{idle,total,charging,fault,t}]}}，rows 按时间升序。
     *
     * <p>limit 与后端一致夹到 1..1000（后端还有自己的 max(1,min(n,1000)) 兜底）。</p>
     */
    public static JSONObject fetchHistory(String area, int limit) throws Exception {
        int n = Math.max(1, Math.min(limit, 1000));
        String q = java.net.URLEncoder.encode(area == null ? "" : area, "UTF-8");
        HttpURLConnection conn = (HttpURLConnection)
                new URL(base() + "api/history?limit=" + n + "&area=" + q).openConnection();
        conn.setConnectTimeout(8000);
        conn.setReadTimeout(15000);
        conn.setRequestProperty("User-Agent", UA);
        try {
            InputStream in = conn.getInputStream();
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            byte[] b = new byte[8192];
            int len;
            while ((len = in.read(b)) > 0) {
                buf.write(b, 0, len);
            }
            return new JSONObject(new String(buf.toByteArray(), StandardCharsets.UTF_8));
        } finally {
            conn.disconnect();
        }
    }

    /** 服务器概览（token_pool/health 字段的唯一来源）：/api/overview。 */
    public static JSONObject fetchOverview() throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(base() + "api/overview").openConnection();
        conn.setConnectTimeout(8000);
        conn.setReadTimeout(12000);
        conn.setRequestProperty("User-Agent", UA);
        try {
            InputStream in = conn.getInputStream();
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            byte[] b = new byte[8192];
            int n;
            while ((n = in.read(b)) > 0) {
                buf.write(b, 0, n);
            }
            return new JSONObject(new String(buf.toByteArray(), StandardCharsets.UTF_8));
        } finally {
            conn.disconnect();
        }
    }

    /** 空闲时段曲线：/api/free-rate?days=N。days 由前端夹到 1..30，这里再兜底一次。 */
    public static JSONObject fetchFreeRate(int days) throws Exception {
        int d = days < 1 ? 1 : (days > 30 ? 30 : days);
        HttpURLConnection conn = (HttpURLConnection)
                new URL(base() + "api/free-rate?days=" + d).openConnection();
        conn.setConnectTimeout(8000);
        conn.setReadTimeout(12000);
        conn.setRequestProperty("User-Agent", UA);
        try {
            InputStream in = conn.getInputStream();
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            byte[] b = new byte[8192];
            int n;
            while ((n = in.read(b)) > 0) {
                buf.write(b, 0, n);
            }
            return new JSONObject(new String(buf.toByteArray(), StandardCharsets.UTF_8));
        } finally {
            conn.disconnect();
        }
    }

    /** 单台桩详情：/api/pile/&lt;device_hex&gt;。 */
    public static JSONObject fetchPile(String deviceHex) throws Exception {
        String q = java.net.URLEncoder.encode(deviceHex == null ? "" : deviceHex.trim(), "UTF-8");
        HttpURLConnection conn = (HttpURLConnection)
                new URL(base() + "api/pile/" + q).openConnection();
        conn.setConnectTimeout(8000);
        conn.setReadTimeout(12000);
        conn.setRequestProperty("User-Agent", UA);
        try {
            InputStream in = conn.getInputStream();
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            byte[] b = new byte[8192];
            int n;
            while ((n = in.read(b)) > 0) {
                buf.write(b, 0, n);
            }
            return new JSONObject(new String(buf.toByteArray(), StandardCharsets.UTF_8));
        } finally {
            conn.disconnect();
        }
    }

    public static JSONObject fetchVersion() throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(base() + "api/version").openConnection();
        conn.setConnectTimeout(8000);
        conn.setReadTimeout(8000);
        conn.setRequestProperty("User-Agent", UA);
        try {
            InputStream in = conn.getInputStream();
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            byte[] b = new byte[4096];
            int n;
            while ((n = in.read(b)) > 0) {
                buf.write(b, 0, n);
            }
            return new JSONObject(new String(buf.toByteArray(), StandardCharsets.UTF_8));
        } finally {
            conn.disconnect();
        }
    }

    /** 下载 APK 到 cacheDir，返回本地文件。 */
    public static File downloadApk(String apkPath, File cacheDir, String expectedSha) throws Exception {
        String url = apkPath.startsWith("http") ? apkPath : base() + apkPath.replaceFirst("^/", "");
        if (expectedSha == null || !expectedSha.matches("[0-9a-fA-F]{64}")) {
            throw new IOException("缺少有效的 sha256，已拒绝下载");
        }
        if (!url.startsWith(base())) {
            throw new IOException("非法的安装包地址");
        }
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setConnectTimeout(15000);
        conn.setReadTimeout(60000);
        conn.setRequestProperty("User-Agent", UA);
        File out = new File(cacheDir, "update-v" + System.currentTimeMillis() + ".apk");
        File[] olds = cacheDir.listFiles();
        if (olds != null) {
            for (File f : olds) {
                if (f.isFile() && f.getName().startsWith("update")
                        && f.getName().endsWith(".apk") && !f.equals(out)) {
                    f.delete();
                }
            }
        }
        if (out.exists() && !out.delete()) {
            throw new IOException("无法清理旧安装包");
        }
        try (InputStream in = conn.getInputStream();
             FileOutputStream fos = new FileOutputStream(out)) {
            byte[] b = new byte[8192];
            int n;
            while ((n = in.read(b)) > 0) {
                fos.write(b, 0, n);
            }
        } finally {
            conn.disconnect();
        }
        if (expectedSha != null && !expectedSha.isEmpty()) {
            String actual = sha256(out);
            if (!actual.equalsIgnoreCase(expectedSha)) {
                out.delete();
                throw new IOException("安装包校验失败，请重试");
            }
        }
        return out;
    }

    private static String sha256(File file) throws Exception {
        java.security.MessageDigest md = java.security.MessageDigest.getInstance("SHA-256");
        try (InputStream in = new java.io.FileInputStream(file)) {
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) {
                md.update(buf, 0, n);
            }
        }
        StringBuilder sb = new StringBuilder();
        for (byte b : md.digest()) {
            sb.append(Character.forDigit((b >> 4) & 0xF, 16))
              .append(Character.forDigit(b & 0xF, 16));
        }
        return sb.toString();
    }

    private static String userAgent(Context ctx) {
        return "ChargingPileApp/" + versionName(ctx) + " (Android "
                + android.os.Build.VERSION.RELEASE + "; " + android.os.Build.MODEL + ")";
    }

    private static String hmac(String prefix, byte[] body, String key) throws Exception {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(key.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        mac.update(prefix.getBytes(StandardCharsets.UTF_8));
        mac.update(body);
        return hex(mac.doFinal());
    }

    private static String hex(byte[] data) {
        StringBuilder sb = new StringBuilder(data.length * 2);
        for (byte b : data) {
            sb.append(Character.forDigit((b >> 4) & 0xF, 16))
              .append(Character.forDigit(b & 0xF, 16));
        }
        return sb.toString();
    }
}
