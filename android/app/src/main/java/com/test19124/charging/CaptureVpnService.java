package com.test19124.charging;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Intent;
import android.net.VpnService;
import android.os.ParcelFileDescriptor;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * VPN 完整转发：只路由充电平台 IP，把微信发往这些 IP 的 TCP 连接
 * 原样转发到真实服务器（HTTP 顺手扫 token，HTTPS 纯字节转发）。
 * 页面能正常加载，token 抓到后自动关闭 VPN。
 */
public class CaptureVpnService extends VpnService {

    public static final String ACTION_START = "com.test19124.charging.CAPTURE_START";
    public static final String ACTION_STOP = "com.test19124.charging.CAPTURE_STOP";
    public static final String ACTION_TOKEN = "com.test19124.charging.CAPTURE_TOKEN";
    public static final String ACTION_END = "com.test19124.charging.CAPTURE_END";
    public static final String PERM_RECEIVE = "com.test19124.charging.permission.RECEIVE_TOKEN";
    public static final String EXTRA_IPS = "ips";
    public static final String EXTRA_DEBUG = "debug";
    public static final String EXTRA_TOKEN = "token";

    private static final String TAG = "CaptureVpn";
    private static final int TIMEOUT_MS = 60000;
    private static final int MAX_PAYLOAD = 30000;

    private ParcelFileDescriptor tun;
    private Thread loopThread;
    private final AtomicBoolean running = new AtomicBoolean(false);
    private final Map<String, Conn> conns = new HashMap<>();
    private final Set<Integer> targets = new HashSet<>();
    private final Object tunLock = new Object();
    private FileOutputStream tunOut;
    private long startedAt;
    private long lastCleanup;
    private volatile boolean captured = false;
    private volatile boolean debugMode = false;
    private volatile boolean ended = false;
    private Handler handler;
    private Runnable timeoutRunnable;
    private volatile int lastStartId = -1;

    private static class Conn {
        int srcIp;
        int dstIp;
        int srcPort;
        int dstPort;
        long clientNext;   // 下一个期望的客户端序号
        long ourSeq;       // 我们发出的起始序号
        long ourNext;
        int mss = 1400;
        Socket socket;
        OutputStream socketOut;
        final ByteArrayOutputStream pending = new ByteArrayOutputStream();
        final StringBuilder scan = new StringBuilder();
        boolean closed;
        boolean loggedData;
        long lastActive;

        String key() {
            return srcIp + ":" + srcPort;
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        lastStartId = startId;
        if (intent == null) {
            return START_NOT_STICKY;
        }
        if (ACTION_STOP.equals(intent.getAction())) {
            closeTunAndStop("手动停止抓包");
            return START_NOT_STICKY;
        }
        if (!ACTION_START.equals(intent.getAction())) {
            stopSelf();
            return START_NOT_STICKY;
        }
        if (running.get()) {
            return START_NOT_STICKY;
        }
        String[] ips = intent.getStringArrayExtra(EXTRA_IPS);
        debugMode = intent.getBooleanExtra(EXTRA_DEBUG, false);
        if (ips == null || ips.length == 0) {
            sendEnd();
            stopSelf();
            return START_NOT_STICKY;
        }
        targets.clear();
        for (String ip : ips) {
            int v = ipToInt(ip);
            if (v != 0) {
                targets.add(v);
            }
        }
        if (targets.isEmpty() || !startVpn()) {
            Log.w(TAG, "establish() 失败");
            sendEnd();
            stopSelf();
            return START_NOT_STICKY;
        }
        running.set(true);
        startForegroundNotice();
        startedAt = System.currentTimeMillis();
        loopThread = new Thread(this::loop, "capture-loop");
        loopThread.start();
        handler = new Handler(Looper.getMainLooper());
        int limit = debugMode ? 5 * 60 * 1000 : TIMEOUT_MS;
        timeoutRunnable = () -> {
            if (!captured) {
                DebugLog.add(debugMode ? "诊断抓包超时自动关闭" : "超时未抓到 token");
                if (!debugMode) {
                    sendEnd();
                }
            }
            closeTunAndStop("超时关闭 VPN");
        };
        handler.postDelayed(timeoutRunnable, limit);
        DebugLog.add(debugMode ? "诊断抓包已开启（手动停止）" : "抓包已开启");
        DebugLog.add("启动转发，目标 IP: " + targets.size() + " 个");
        for (int ip : targets) {
            DebugLog.add("  route " + intToIp(ip));
        }
        Log.i(TAG, "VPN 转发已启动，目标 IP 数=" + targets.size());
        return START_NOT_STICKY;
    }

    private int ipToInt(String ip) {
        try {
            byte[] b = InetAddress.getByName(ip).getAddress();
            if (b.length != 4) {
                return 0;
            }
            return ((b[0] & 0xFF) << 24) | ((b[1] & 0xFF) << 16)
                    | ((b[2] & 0xFF) << 8) | (b[3] & 0xFF);
        } catch (Exception e) {
            return 0;
        }
    }

    private static String intToIp(int ip) {
        return ((ip >> 24) & 0xFF) + "." + ((ip >> 16) & 0xFF) + "." + ((ip >> 8) & 0xFF) + "." + (ip & 0xFF);
    }

    private boolean startVpn() {
        Builder b = new Builder();
        b.setSession("充电桩 token 抓取");
        b.addAddress("10.7.0.2", 32);
        for (int ip : targets) {
            b.addRoute(intToIp(ip), 32);
        }
        try {
            b.addAllowedApplication("com.tencent.mm");
        } catch (Exception e) {
            // Android 11+ 包可见性/未安装时会抛：记录以便确认「只路由微信」是否生效
            DebugLog.add("addAllowedApplication 失败: " + e.getClass().getSimpleName());
        }
        b.setMtu(1500);
        try {
            tun = b.establish();
        } catch (Exception e) {
            return false;
        }
        return tun != null;
    }

    private void startForegroundNotice() {
        try {
            if (android.os.Build.VERSION.SDK_INT >= 26) {
                NotificationManager nm = getSystemService(NotificationManager.class);
                if (nm.getNotificationChannel("capture") == null) {
                    nm.createNotificationChannel(new NotificationChannel("capture",
                            "抓包", NotificationManager.IMPORTANCE_LOW));
                }
            }
            Intent stop = new Intent(this, CaptureVpnService.class)
                    .setAction(ACTION_STOP);
            PendingIntent stopPi = PendingIntent.getService(this, 1, stop,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            Notification n = new Notification.Builder(this, "capture")
                    .setContentTitle("正在抓取登录令牌")
                    .setContentText(debugMode ? "诊断抓包中，可点「停止抓包」结束" : "抓到后会自动关闭 VPN")
                    .setSmallIcon(android.R.drawable.stat_sys_upload)
                    .setOngoing(true)
                    .addAction(android.R.drawable.ic_menu_close_clear_cancel, "停止抓包", stopPi)
                    .build();
            startForeground(1, n);
        } catch (Exception e) {
            Log.w(TAG, "startForeground 失败: " + e);
        }
    }

    private void loop() {
        try (FileInputStream in = new FileInputStream(tun.getFileDescriptor())) {
            tunOut = new FileOutputStream(tun.getFileDescriptor());
            byte[] pkt = new byte[32767];
            while (running.get()) {
                int n = in.read(pkt);
                if (n <= 0) {
                    continue;
                }
                long now = System.currentTimeMillis();
                if (!debugMode && now - startedAt > TIMEOUT_MS) {
                    Log.i(TAG, "超时，关闭 VPN");
                    break;
                }
                if (now - lastCleanup > 5000) {
                    lastCleanup = now;
                    cleanupIdle(now);
                }
                handle(pkt, n);
            }
        } catch (Exception e) {
            Log.w(TAG, "loop 结束: " + e);
        } finally {
            if (!captured) {
                sendEnd();
            }
            stopSelf();
        }
    }

    private void cleanupIdle(long now) {
        synchronized (conns) {
            java.util.Iterator<Map.Entry<String, Conn>> it = conns.entrySet().iterator();
            while (it.hasNext()) {
                Conn c = it.next().getValue();
                if (now - c.lastActive > 120000) {
                    c.closed = true;
                    closeSocket(c);
                    it.remove();
                }
            }
        }
    }

    private void handle(byte[] p, int n) {
        // 轻微3：先校验长度与头长 —— 原来直接用 u16(p, ihl+2)，ihl 异常或短包会越界，
        // 异常被 loop() 的 catch 捕获后**直接退出循环**，整个抓包会话结束（用户看到"未抓到 token"）
        if (p == null || n < 20) return;
        int ihlCheck = (p[0] & 0xF) * 4;
        if (ihlCheck < 20 || ihlCheck > n) return;
        int totalCheck = Packets.u16(p, 2);
        if (totalCheck < ihlCheck || totalCheck > n) return;
        if (((p[0] >> 4) & 0xF) != 4) {
            return;
        }
        int ihl = (p[0] & 0xF) * 4;
        int total = Packets.u16(p, 2);
        if (total > n) {
            total = n;
        }
        int src = (int) Packets.u32(p, 12);
        int dst = (int) Packets.u32(p, 16);
        if (!targets.contains(dst)) {
            return;
        }
        if ((p[9] & 0xFF) != 6) {
            if ((p[9] & 0xFF) == 17) {
                int udpDstPort = Packets.u16(p, ihl + 2);
                DebugLog.add("UDP → " + intToIp(dst) + ":" + udpDstPort + "（未转发）");
            }
            return;
        }
        int tcp = ihl;
        int sport = Packets.u16(p, tcp);
        int dport = Packets.u16(p, tcp + 2);
        long seq = Packets.u32(p, tcp + 4);
        int flags = p[tcp + 13] & 0xFF;
        int doff = ((p[tcp + 12] >> 4) & 0xF) * 4;
        int plen = total - ihl - doff;
        String key = src + ":" + sport;
        Conn c;

        synchronized (conns) {
            c = conns.get(key);
        }

        if ((flags & 0x02) != 0) { // SYN
            Log.d(TAG, "SYN -> " + intToIp(dst) + ":" + dport);
            DebugLog.add("SYN → " + intToIp(dst) + ":" + dport);
            if (c != null && !c.closed) {
                // 重复 SYN：用原始序号重发 SYN-ACK
                sendSeq(c, 0x12, null, seq + 1, c.ourSeq);
                return;
            }
            if (c != null) {
                synchronized (conns) {
                    conns.remove(key);
                }
            }
            Conn nc = new Conn();
            nc.srcIp = src;
            nc.dstIp = dst;
            nc.srcPort = sport;
            nc.dstPort = dport;
            nc.clientNext = seq + 1;
            nc.ourSeq = 1 + (long) (Math.random() * 1000000);
            nc.ourNext = nc.ourSeq + 1;
            nc.mss = parseMss(p, tcp, doff);
            nc.lastActive = System.currentTimeMillis();
            synchronized (conns) {
                conns.put(key, nc);
            }
            // SYN 本身占一个序号：SYN-ACK 的 seq 必须是 ourSeq，之后数据从 ourSeq+1 开始
            sendSeq(nc, 0x12, null, nc.clientNext, nc.ourSeq);
            startConnector(nc);
            return;
        }

        if (c == null) {
            return;
        }
        c.lastActive = System.currentTimeMillis();

        if ((flags & 0x04) != 0) { // RST
            closeConn(c);
            synchronized (conns) {
                conns.remove(key);
            }
            return;
        }

        if (plen > 0) {
            long expected = c.clientNext;
            if (seq == expected) {
                c.clientNext = seq + plen;
                send(c, 0x10, null, c.clientNext); // ACK
                byte[] payload = Arrays.copyOfRange(p, ihl + doff, ihl + doff + plen);
                if (c.dstPort == 80) {
                    if (!c.loggedData) {
                        c.loggedData = true;
                        DebugLog.add("收到 HTTP 请求 " + plen + "B");
                    }
                    scan(c, payload);
                }
                writeSocket(c, payload);
            } else if (seq < expected) {
                send(c, 0x10, null, c.clientNext); // 重传，补 ACK
            } else {
                send(c, 0x10, null, c.clientNext); // 乱序，诱使重传
            }
        }

        if ((flags & 0x01) != 0) { // FIN
            c.clientNext += 1;
            send(c, 0x11, null, c.clientNext);
            closeSocket(c);
            synchronized (conns) {
                conns.remove(key);
            }
        }
    }

    private void sendSeq(Conn c, int flags, byte[] payload, long ack, long seq) {
        byte[] pkt = Packets.tcp(c.dstIp, c.srcIp, c.dstPort, c.srcPort, seq, ack, flags, payload);
        synchronized (tunLock) {
            try {
                tunOut.write(pkt);
                tunOut.flush();
            } catch (Exception e) {
                closeConn(c);
            }
        }
    }

    /** 从 SYN 的 TCP 选项里取 MSS。 */
    private int parseMss(byte[] p, int tcp, int doff) {
        int i = tcp + 20;
        int end = tcp + doff;
        while (i + 1 < end) {
            int kind = p[i] & 0xFF;
            if (kind == 0) {
                break;
            }
            if (kind == 1) {
                i++;
                continue;
            }
            int len = p[i + 1] & 0xFF;
            if (len < 2 || i + len > end) {
                break;
            }
            if (kind == 2 && len == 4) {
                int mss = Packets.u16(p, i + 2);
                return Math.max(536, Math.min(1460, mss));
            }
            i += len;
        }
        return 536;
    }

    private void send(Conn c, int flags, byte[] payload, long ack) {
        synchronized (c) {
            byte[] pkt = Packets.tcp(c.dstIp, c.srcIp, c.dstPort, c.srcPort, c.ourNext, ack, flags, payload);
            synchronized (tunLock) {
                try {
                    tunOut.write(pkt);
                    tunOut.flush();
                } catch (Exception e) {
                    closeConn(c);
                    return;
                }
            }
            if ((flags & 0x01) != 0 || (flags & 0x04) != 0) {
                c.ourNext += 1;
            } else if (payload != null) {
                c.ourNext += payload.length;
            }
        }
    }

    private void startConnector(Conn c) {
        Thread t = new Thread(() -> {
            try {                DebugLog.add("正在连接 " + intToIp(c.dstIp) + ":" + c.dstPort);
                Socket s = new Socket();
                try {
                    // 先 bind 让 fd 生效，再 protect；失败也无妨：VPN 只允许微信，本应用流量本来就不进 VPN
                    s.bind(new InetSocketAddress(0));
                } catch (Exception ignored) {
                }
                boolean protectedOk = protect(s);
                DebugLog.add("protect=" + protectedOk);
                if (!protectedOk) {
                    DebugLog.add("protect 失败（忽略，继续直连）");
                }
                s.connect(new InetSocketAddress(intToIp(c.dstIp), c.dstPort), 8000);
                DebugLog.add("TCP 已连上");
                s.setTcpNoDelay(true);
                synchronized (c) {
                    c.socket = s;
                    c.socketOut = s.getOutputStream();
                    if (c.pending.size() > 0) {
                        c.socketOut.write(c.pending.toByteArray());
                        c.socketOut.flush();
                        c.pending.reset();
                    }
                }
                InputStream in = s.getInputStream();
                Log.i(TAG, "已连接 " + intToIp(c.dstIp) + ":" + c.dstPort);
                DebugLog.add("已连接 " + intToIp(c.dstIp) + ":" + c.dstPort);
                byte[] buf = new byte[8192];
                int n;
                while (!c.closed && (n = in.read(buf)) > 0) {
                    c.lastActive = System.currentTimeMillis();
                    int off = 0;
                    int mss = Math.min(c.mss, 1400);
                    while (off < n) {
                        int len = Math.min(mss, n - off);
                        byte[] seg = Arrays.copyOfRange(buf, off, off + len);
                        send(c, 0x10, seg, c.clientNext);
                        off += len;
                    }
                }
                if (!c.closed) {
                    send(c, 0x11, null, c.clientNext); // 服务端关闭，通知客户端
                }
            } catch (Exception e) {
                Log.w(TAG, "连接 " + intToIp(c.dstIp) + ":" + c.dstPort + " 失败: " + e);
                DebugLog.add("连接失败 " + intToIp(c.dstIp) + ":" + c.dstPort
                        + " (" + e.getClass().getSimpleName() + ")");
                closeConn(c);
            }
        }, "conn-" + c.srcPort);
        t.setDaemon(true);
        t.start();
    }

    private void writeSocket(Conn c, byte[] payload) {
        synchronized (c) {
            if (c.socketOut == null) {
                // 连接还没建立，先缓存；建立后按序发出
                if (c.pending.size() + payload.length <= 65536) {
                    c.pending.write(payload, 0, payload.length);
                } else {
                    closeConn(c); // 缓冲溢出，直接失败，避免流错位
                }
                return;
            }
            try {
                c.socketOut.write(payload);
                c.socketOut.flush();
            } catch (IOException e) {
                closeConn(c);
            }
        }
    }

    private void scan(Conn c, byte[] payload) {
        if (debugMode) {
            String s = new String(payload, java.nio.charset.StandardCharsets.ISO_8859_1);
            int e = s.indexOf("\r\n");
            String line = e > 0 ? s.substring(0, e)
                    : s.substring(0, Math.min(160, s.length()));
            if (line.startsWith("GET ") || line.startsWith("POST ")
                    || line.startsWith("PUT ")) {
                int q = line.indexOf('?');
                boolean keepQuery = true;
                if (q > 0 && !keepQuery) {
                    line = line.substring(0, q);
                }
                line = line.replaceAll("token=eyJ[^&\\s]*", "token=***");
                DebugLog.add(line);
            }
            return;
        }
        c.scan.append(new String(payload, java.nio.charset.StandardCharsets.ISO_8859_1));
        if (c.scan.length() > MAX_PAYLOAD) {
            c.scan.delete(0, c.scan.length() - MAX_PAYLOAD);
        }
        String token = TokenExtractor.find(c.scan.toString());
        if (token == null) {
            return;
        }
        ApiClient.Jwt jwt = ApiClient.parseJwt(token);
        if (jwt == null || jwt.expiresAt * 1000 <= System.currentTimeMillis()) {
            return;
        }
        if (captured) {
            return;
        }
        captured = true;
        DebugLog.add("抓到 token");
        try {
            new TokenStore(this).save(token);
        } catch (Exception e) {
            Log.w(TAG, "保存 token 失败: " + e);
            DebugLog.add("保存 token 失败");
            captured = false;
            sendEnd();
            return;
        }
        Intent i = new Intent(ACTION_TOKEN);
        i.setPackage(getPackageName());
        i.putExtra(EXTRA_TOKEN, token);
        sendBroadcast(i, PERM_RECEIVE);
        // 延迟关闭：给微信里的公众号页面留几秒加载完，避免一抓到就断网导致页面卡住
        DebugLog.add("抓到 token，6 秒后关闭 VPN");
        Log.i(TAG, "抓到 token，6 秒后关闭 VPN");
        new Thread(() -> {
            try {
                Thread.sleep(6000);
            } catch (InterruptedException ignored) {
            }
            closeTunAndStop("定时关闭 VPN");
        }, "vpn-stop").start();
    }

    private void closeTunAndStop(String reason) {
        if (!running.get() && tun == null) {
            stopSelf();
            return;
        }
        DebugLog.add(reason);
        running.set(false);
        try {
            if (tunOut != null) {
                tunOut.close();
                tunOut = null;
            }
        } catch (Exception ignored) {
        }
        try {
            if (tun != null) {
                tun.close();
                tun = null;
            }
        } catch (Exception e) {
            Log.w(TAG, "关闭 tun 失败: " + e);
        }
        DebugLog.add("tun 已关闭");
        if (lastStartId >= 0) {
            stopSelf(lastStartId);
        } else {
            stopSelf();
        }
    }

    private void sendEnd() {
        synchronized (this) {
            if (ended) {
                return;
            }
            ended = true;
        }
        Intent i = new Intent(ACTION_END);
        i.setPackage(getPackageName());
        sendBroadcast(i, PERM_RECEIVE);
    }

    @Override
    public void onRevoke() {
        if (!captured) {
            sendEnd();
        }
        running.set(false);
        stopSelf();
        super.onRevoke();
    }

    private void closeSocket(Conn c) {
        c.closed = true;
        if (c.socket != null) {
            try {
                c.socket.close();
            } catch (Exception ignored) {
            }
        }
    }

    private void closeConn(Conn c) {
        closeSocket(c);
        synchronized (conns) {
            conns.remove(c.key());
        }
    }

    @Override
    public void onDestroy() {
        DebugLog.add("VPN 服务 onDestroy，开始关闭");
        try {
            stopForeground(true);
        } catch (Exception ignored) {
        }
        running.set(false);
        if (!captured) {
            sendEnd();
        }
        if (handler != null && timeoutRunnable != null) {
            handler.removeCallbacks(timeoutRunnable);
        }
        java.util.List<Conn> all = new java.util.ArrayList<>();
        synchronized (conns) {
            all.addAll(conns.values());
            conns.clear();
        }
        for (Conn c : all) {
            c.closed = true;
            closeSocket(c);
        }
        if (tun != null) {
            try {
                tun.close();
            } catch (Exception ignored) {
            }
            tun = null;
        }
        DebugLog.add("VPN 服务已销毁，tun 已关闭");
        super.onDestroy();
    }
}
