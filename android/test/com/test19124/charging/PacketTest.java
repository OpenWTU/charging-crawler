package com.test19124.charging;

import java.nio.charset.StandardCharsets;

/** JVM 上验证封包校验和与 token 提取（不依赖 Android 运行时）。 */
public class PacketTest {

    public static void main(String[] args) {
        int src = ip("10.7.0.1");
        int dst = ip("192.168.1.10");

        // 1. SYN-ACK：IP 头重新求和应为 0；TCP 校验和（含伪首部）验证应为 0xFFFF
        byte[] pkt = Packets.tcp(src, dst, 80, 45678, 123456, 999, 0x12, null);
        check(Packets.checksum(pkt, 0, 20) == 0, "IP checksum");
        check(pseudoSum(pkt, src, dst) == 0xFFFF, "TCP checksum");

        // 2. 带 payload 的 ACK
        byte[] payload = "GET / HTTP/1.1\r\nHost: x\r\n\r\n".getBytes(StandardCharsets.ISO_8859_1);
        pkt = Packets.tcp(src, dst, 80, 45678, 123456, 999, 0x10, payload);
        check(Packets.checksum(pkt, 0, 20) == 0, "IP checksum payload");
        check(pseudoSum(pkt, src, dst) == 0xFFFF, "TCP checksum payload");

        // 3. token 提取
        String body = "GET /quickuser50/user/userInfo HTTP/1.1\r\n"
                + "Authorization: Bearer eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9"
                + ".eyJyb2xlIjoidXNlciIsImVuY3J5SWQiOiJNVEl6TkRVMk56Zz0ifQ.abcdefg12345\r\n"
                + "Host: ap3202.haokuaichong.cn\r\n\r\n";
        String t = TokenExtractor.find(body);
        check(t != null && t.startsWith("eyJ0eXAi"), "bearer token");
        check(TokenExtractor.find("nothing here") == null, "no token");

        String json = "{\"code\":200,\"data\":{\"token\":\"eyJ0eXAiOiJKV1QifQ.eyJhIjoxfQ.xyz123456789\"}}";
        check(TokenExtractor.find(json) != null, "json token");

        String path = "/x?t=eyJ0eXAiOiJKV1QifQ.eyJhIjoxfQ.abc123456789";
        check(TokenExtractor.find(path) != null, "path token");

        System.out.println("OK");
    }

    private static int ip(String s) {
        String[] p = s.split("\\.");
        return (Integer.parseInt(p[0]) << 24) | (Integer.parseInt(p[1]) << 16)
                | (Integer.parseInt(p[2]) << 8) | Integer.parseInt(p[3]);
    }

    private static long pseudoSum(byte[] p, int src, int dst) {
        long sum = 0;
        sum += (src >>> 16) & 0xFFFF;
        sum += src & 0xFFFF;
        sum += (dst >>> 16) & 0xFFFF;
        sum += dst & 0xFFFF;
        sum += 6;
        sum += p.length - 20;
        int i = 20;
        while (i + 1 < p.length) {
            sum += Packets.u16(p, i);
            i += 2;
        }
        if (i < p.length) {
            sum += (p[i] & 0xFF) << 8;
        }
        while ((sum >> 16) != 0) {
            sum = (sum & 0xFFFF) + (sum >> 16);
        }
        return sum;
    }

    private static void check(boolean ok, String name) {
        System.out.println((ok ? "ok   " : "FAIL ") + name);
        if (!ok) {
            System.exit(1);
        }
    }
}
