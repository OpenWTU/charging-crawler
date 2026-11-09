package com.test19124.charging;

import android.content.Context;
import android.content.pm.PackageInfo;

import com.test19124.charging.net.NodeDiscovery;

import org.json.JSONArray;
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

    /**
     * 设备注册令牌：与服务端 REGISTER_TOKEN 保持一致。
     * 服务端未配置该变量时不校验；配置后只有带此头的客户端能注册新设备。
     */
    private static final String REGISTER_TOKEN = "chg-reg-7f3a9c21e5d84b06";

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
        // 设备注册令牌：与服务端 REGISTER_TOKEN 一致；服务端未配置时该头被忽略
        conn.setRequestProperty("x-register-token", REGISTER_TOKEN);
        try {
            try (OutputStream out = conn.getOutputStream()) {
                out.write(raw);
            }
            int code = conn.getResponseCode();
            String text = readAll(code >= 400 ? conn.getErrorStream() : conn.getInputStream());
            if (code == 409) {
                return conflictReason(text);
            }
            if (code == 403) {
                // 服务端启用了 REGISTER_TOKEN 而本机没带（或值被换过）：
                // 直接给出可执行的提示，不要把原始 JSON 抛给用户
                String msg = "服务端要求注册令牌，请更新 App 后重试";
                try {
                    String e = new JSONObject(text).optString("error", "");
                    if (!e.isEmpty()) msg = e;
                } catch (Exception ignored) {
                    // 非 JSON 响应：用上面的通用文案
                }
                throw new IOException(msg);
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

    /** 公开状态页（/status）：token 池 / worker / 节点 / 拉黑等监控数据。 */
    public static JSONObject fetchStatus() throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(base() + "status").openConnection();
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

    /**
     * 检查更新：**服务器优先**，GitHub 兜底。
     *
     * 原来是 GitHub 优先 —— 而 api.github.com 在国内经常被阻断，于是每次检查更新
     * 都要先等满 4 秒超时才回退，用户感觉「检查更新很慢/经常失败」。
     * 自己的服务器 /api/version 通常几十毫秒，镜像里就带着 version.json。
     */
    /**
     * 检查更新的取源顺序，与节点目录保持一致：**GitHub API → CDN → 节点 API**。
     *
     *   ① GitHub Releases API —— 官方源
     *   ② jsDelivr CDN —— 仓库里 deploy/version.json（CI 每次发版同步）
     *   ③ 节点 /api/version —— 自己的服务器，最后兜底
     *
     * 每源 4 秒超时，任一成功即返回；**每个源都写一条 DebugLog**
     * （成功记版本号与耗时，失败记异常类型与耗时），排查时不用猜走的哪条路。
     */
    /**
     * 最近一次 fetchVersion 的结果。下载 APK 时用它判断「version.json 是从哪个通道拿到的」，
     * 从而优先从同一通道下载安装包（用户要求：哪个通道能通就从哪个通道下）。
     */
    private static volatile JSONObject lastVersionInfo = null;

    public static JSONObject fetchVersion() throws Exception {
        long t0 = System.currentTimeMillis();
        try {
            JSONObject d = fetchVersionFromGitHub();
            d.put("_source", "github");
            lastVersionInfo = d;
            DebugLog.add("版本检查[GitHub] 成功 → " + d.optString("versionName")
                    + "，" + (System.currentTimeMillis() - t0) + "ms");
            return d;
        } catch (Exception e1) {
            DebugLog.add("版本检查[GitHub] 失败：" + e1.getClass().getSimpleName()
                    + " " + e1.getMessage() + "，" + (System.currentTimeMillis() - t0) + "ms");
        }

        t0 = System.currentTimeMillis();
        try {
            JSONObject d = fetchVersionFromCdn();
            d.put("_source", "cdn");
            lastVersionInfo = d;
            DebugLog.add("版本检查[CDN] 成功 → " + d.optString("versionName")
                    + "，" + (System.currentTimeMillis() - t0) + "ms");
            return d;
        } catch (Exception e2) {
            DebugLog.add("版本检查[CDN] 失败：" + e2.getClass().getSimpleName()
                    + " " + e2.getMessage() + "，" + (System.currentTimeMillis() - t0) + "ms");
        }

        t0 = System.currentTimeMillis();
        try {
            JSONObject d = fetchVersionFromServer();
            d.put("_source", "node");
            lastVersionInfo = d;
            DebugLog.add("版本检查[节点API] 成功 → " + d.optString("versionName")
                    + "，" + (System.currentTimeMillis() - t0) + "ms");
            return d;
        } catch (Exception e3) {
            DebugLog.add("版本检查[节点API] 失败：" + e3.getClass().getSimpleName()
                    + " " + e3.getMessage() + "，" + (System.currentTimeMillis() - t0) + "ms");
            throw new java.io.IOException("三个版本源均不可用");
        }
    }

    /**
     * 从 jsDelivr 拿仓库里的 deploy/version.json（CI 每次发版会同步到 main）。
     *
     * 第二选择：有国内节点、直出文件内容。仓库里那份的 apkPath 是
     * 服务器相对路径（`/download/app-debug.apk?v=...`），这里改写成 GitHub Release
     * 的绝对地址 —— CDN 能通通常说明 GitHub 生态也通，且该前缀在 downloadApk 白名单里。
     */
    private static JSONObject fetchVersionFromCdn() throws Exception {
        JSONObject d = httpGetJson(
                "https://cdn.jsdelivr.net/gh/OpenWTU/charging-crawler@main/deploy/version.json", 4000);
        // 仓库里的 version.json 是 CI 生成的同一份，apkPath 是服务器相对路径
        // （`/download/app-debug.apk?v=...`）。这里改写成 GitHub Release 的绝对地址：
        // CDN 能通通常说明 GitHub 生态也通，而且这个前缀在 downloadApk 白名单里。
        String apkPath = d.optString("apkPath", "");
        String name = d.optString("versionName", "").trim();
        if (apkPath.startsWith("/") && !name.isEmpty()) {
            d.put("apkPath", "https://github.com/OpenWTU/charging-crawler/releases/download/v"
                    + name + "/app-debug.apk");
        }
        return d;
    }

    /** GitHub 直读：releases/latest 拿 tag → 下载 version.json asset → apkPath 指向 GitHub。 */
    private static JSONObject fetchVersionFromGitHub() throws Exception {
        // 用 4 秒短超时：api.github.com 在国内常被阻断，卡 8 秒再回退服务器体验太差
        JSONObject latest = httpGetJson(
                "https://api.github.com/repos/OpenWTU/charging-crawler/releases/latest", 4000);
        String vjUrl = null;
        String apkUrl = null;
        JSONArray assets = latest.optJSONArray("assets");
        if (assets != null) {
            for (int i = 0; i < assets.length(); i += 1) {
                JSONObject a = assets.optJSONObject(i);
                String n = a == null ? "" : a.optString("name", "");
                if ("version.json".equals(n)) vjUrl = a.optString("browser_download_url");
                if ("app-debug.apk".equals(n)) apkUrl = a.optString("browser_download_url");
            }
        }
        if (vjUrl == null || vjUrl.isEmpty()) throw new java.io.IOException("无 version.json asset");
        JSONObject d = httpGetJson(vjUrl, 4000);
        // apkPath 指向 GitHub asset（downloadApk 白名单已放行 GitHub Release 前缀）
        if (apkUrl != null && !apkUrl.isEmpty()) d.put("apkPath", apkUrl);
        return d;
    }

    private static JSONObject fetchVersionFromServer() throws Exception {
        // 服务器通常几十毫秒；给 4 秒上限，挂了就尽快落到 GitHub 兜底
        return httpGetJson(base() + "api/version", 4000);
    }

    private static JSONObject httpGetJson(String url) throws Exception {
        return httpGetJson(url, 8000);
    }

    /** timeoutMs：连接/读取超时（GitHub 在国内常被阻断，检查更新时用较短超时快速回退服务器）。 */
    private static JSONObject httpGetJson(String url, int timeoutMs) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setConnectTimeout(timeoutMs);
        conn.setReadTimeout(timeoutMs);
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

    /**
     * S3：安装包地址白名单。
     *
     * 曾经用 `url.startsWith(base())` —— base() 是 NodeDiscovery.currentBase()，
     * 可以被状态页的节点卡片改到任意 http(s) 主机。恶意/被劫持节点同时提供
     * /api/version（决定 sha256）与 APK，校验就成了"自己跟自己比"。
     * 这里改成**常量集合**：只认官方域名与 GitHub Release，不含任何动态地址。
     */
    private static final String[] ALLOWED_APK_PREFIXES = {
        "https://github.com/OpenWTU/charging-crawler/releases/download/",
        "https://charge.lizishuo.cn/",
        // jsDelivr 的仓库文件代理。APK 用**不可变 tag 引用** @cdn-v<version>：
        //   · @main 是分支引用，jsDelivr 缓存 12h 且内容会变，必须每次 purge
        //   · @cdn-v2.5.3 是 tag 引用，永久缓存且内容固定，不会拿到上一版的包
        // 前缀只到仓库名，具体 ref 由 buildApkCandidates 拼（@cdn-v<version> 或 @main）。
        "https://cdn.jsdelivr.net/gh/OpenWTU/charging-crawler@cdn-v",
        "https://cdn.jsdelivr.net/gh/OpenWTU/charging-crawler@main/deploy/",
    };

    private static boolean isAllowedApkUrl(String url) {
        if (url == null) return false;
        for (String prefix : ALLOWED_APK_PREFIXES) {
            if (url.startsWith(prefix)) return true;
        }
        return false;
    }

    /** 下载 APK 到 cacheDir，返回本地文件。 */
    /**
     * 下载 APK：按「与 version.json 相同的来源」优先，逐个通道重试。
     *
     * 顺序规则（用户要求）：
     *   · GitHub 拿到 version.json → 先 GitHub，失败再 CDN、节点
     *   · CDN 拿到 version.json    → 先 CDN，失败再 GitHub、节点
     *   · 节点拿到 version.json    → **先试 GitHub 和 CDN**，都不行才用节点；全失败提示「更新源不可用」
     *
     * 每个候选都用同一个 sha256 校验，所以拿到旧包/坏包不会误装。
     */
    public static File downloadApk(String apkPath, File cacheDir, String expectedSha) throws Exception {
        if (expectedSha == null || !expectedSha.matches("[0-9a-fA-F]{64}")) {
            throw new IOException("缺少有效的 sha256，已拒绝下载");
        }
        java.util.List<String> candidates = buildApkCandidates(apkPath);
        StringBuilder sb = new StringBuilder();
        for (String u : candidates) {
            if (sb.length() > 0) sb.append(" → ");
            sb.append(hostOf(u));
        }
        DebugLog.add("APK 下载候选(" + candidates.size() + "): " + sb);

        Exception last = null;
        for (String u : candidates) {
            try {
                File f = downloadApkFrom(u, cacheDir, expectedSha);
                DebugLog.add("APK 下载成功[" + hostOf(u) + "]: " + f.length() + "B");
                return f;
            } catch (Exception e) {
                last = e;
                DebugLog.add("APK 下载失败[" + hostOf(u) + "]: " + e.getMessage());
            }
        }
        throw new IOException("更新源不可用：GitHub / CDN / 节点均无法下载安装包"
                + (last == null ? "" : "（最后错误：" + last.getMessage() + "）"));
    }

    /** 候选列表：与 version.json 来源一致者优先，其余按 GitHub → CDN → 节点 补齐。 */
    private static java.util.List<String> buildApkCandidates(String apkPath) {
        java.util.List<String> out = new java.util.ArrayList<>();
        JSONObject info = lastVersionInfo;
        String source = info == null ? "" : info.optString("_source", "");
        String name = info == null ? "" : info.optString("versionName", "").trim();

        String github = name.isEmpty() ? ""
                : "https://github.com/OpenWTU/charging-crawler/releases/download/v"
                + name + "/app-debug.apk";
        // 主用不可变 tag 引用（永久缓存、不会拿到旧包）；@main 作为兜底
        // （万一某个版本没打 cdn-v tag，tag 引用会 404，这时回落到 main）。
        // 仓库里那份 APK 的文件名带版本号（app-v2.5.3.apk），旧版本由同步脚本清理
        String cdnTag = name.isEmpty() ? ""
                : "https://cdn.jsdelivr.net/gh/OpenWTU/charging-crawler@cdn-v"
                + name + "/deploy/app-v" + name + ".apk";
        String cdnMain = "https://cdn.jsdelivr.net/gh/OpenWTU/charging-crawler@main/deploy/app-v"
                + (name.isEmpty() ? "debug" : name) + ".apk";
        String cdn = cdnTag.isEmpty() ? cdnMain : cdnTag;
        String node = base() + "download/app-debug.apk";

        // ① 首选：与获取 version.json 的通道一致
        if ("github".equals(source) && !github.isEmpty()) {
            out.add(github);
        } else if ("cdn".equals(source)) {
            out.add(cdn);
        } else if ("node".equals(source)) {
            // 节点拿到 version.json 时，先试 GitHub 与 CDN（节点自身反而放最后）
            if (!github.isEmpty()) out.add(github);
            out.add(cdn);
            out.add(node);
        }

        // ② 前端传来的地址也纳入（可能带 ?v= 查询串）
        if (apkPath != null && !apkPath.isEmpty()) {
            String u = apkPath.startsWith("http") ? apkPath : base() + apkPath.replaceFirst("^/", "");
            if (!out.contains(u)) out.add(u);
        }

        // ③ 其余通道补齐（cdnTag → cdnMain → 节点）
        for (String u : new String[]{github, cdnTag, cdnMain, node}) {
            if (u != null && !u.isEmpty() && !out.contains(u)) out.add(u);
        }
        return out;
    }

    /** 日志用的主机名（便于看出走的哪条通道）。 */
    private static String hostOf(String url) {
        try {
            String h = new java.net.URL(url).getHost();
            return h == null ? "?" : h;
        } catch (Exception e) {
            return "?";
        }
    }

    /** 从单个地址下载并校验 sha256。 */
    private static File downloadApkFrom(String url, File cacheDir, String expectedSha) throws Exception {
        if (!isAllowedApkUrl(url)) {
            throw new IOException("非法的安装包地址（只允许官方域名 / GitHub Release / jsDelivr）");
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
