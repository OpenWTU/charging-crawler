package com.test19124.charging;

/** 纯 Java 的 IPv4/TCP 封包构造与校验和（方便在 JVM 上单测）。 */
public final class Packets {

    private Packets() {
    }

    public static int u16(byte[] b, int off) {
        return ((b[off] & 0xFF) << 8) | (b[off + 1] & 0xFF);
    }

    public static long u32(byte[] b, int off) {
        return ((long) (b[off] & 0xFF) << 24) | ((b[off + 1] & 0xFF) << 16)
                | ((b[off + 2] & 0xFF) << 8) | (b[off + 3] & 0xFF);
    }

    public static void put16(byte[] b, int off, int v) {
        b[off] = (byte) (v >> 8);
        b[off + 1] = (byte) v;
    }

    public static void put32(byte[] b, int off, long v) {
        b[off] = (byte) (v >> 24);
        b[off + 1] = (byte) (v >> 16);
        b[off + 2] = (byte) (v >> 8);
        b[off + 3] = (byte) v;
    }

    /** 对一段字节做 16 位反码求和，返回主机序校验和。 */
    public static int checksum(byte[] data, int off, int len) {
        long sum = 0;
        int i = off;
        int end = off + len;
        while (i + 1 < end) {
            sum += u16(data, i);
            i += 2;
        }
        if (i < end) {
            sum += (data[i] & 0xFF) << 8;
        }
        while ((sum >> 16) != 0) {
            sum = (sum & 0xFFFF) + (sum >> 16);
        }
        return (int) (~sum) & 0xFFFF;
    }

    /** 构造一个 IPv4+TCP 包（无 payload 时用于 SYN-ACK/ACK/RST）。 */
    public static byte[] tcp(int srcIp, int dstIp, int srcPort, int dstPort,
                             long seq, long ack, int flags, byte[] payload) {
        int payloadLen = payload == null ? 0 : payload.length;
        int total = 20 + 20 + payloadLen;
        byte[] p = new byte[total];

        // IPv4
        p[0] = 0x45;
        p[1] = 0;
        put16(p, 2, total);
        put16(p, 4, 0x1234);      // id
        put16(p, 6, 0x4000);      // DF
        p[8] = 64;                // ttl
        p[9] = 6;                 // TCP
        put32(p, 12, srcIp & 0xFFFFFFFFL);
        put32(p, 16, dstIp & 0xFFFFFFFFL);
        put16(p, 10, checksum(p, 0, 20));

        // TCP
        int t = 20;
        put16(p, t, srcPort);
        put16(p, t + 2, dstPort);
        put32(p, t + 4, seq);
        put32(p, t + 8, ack);
        p[t + 12] = (byte) 0x50;  // data offset 5
        p[t + 13] = (byte) flags;
        put16(p, t + 14, 65535);  // window
        put16(p, t + 16, 0);      // checksum placeholder
        put16(p, t + 18, 0);      // urgent
        if (payloadLen > 0) {
            System.arraycopy(payload, 0, p, t + 20, payloadLen);
        }

        // TCP 校验和（伪首部 + TCP 段）
        long sum = 0;
        sum += (srcIp >>> 16) & 0xFFFF;
        sum += srcIp & 0xFFFF;
        sum += (dstIp >>> 16) & 0xFFFF;
        sum += dstIp & 0xFFFF;
        sum += 6;           // protocol
        sum += 20 + payloadLen;
        int i = t;
        int end = t + 20 + payloadLen;
        while (i + 1 < end) {
            sum += u16(p, i);
            i += 2;
        }
        if (i < end) {
            sum += (p[i] & 0xFF) << 8;
        }
        while ((sum >> 16) != 0) {
            sum = (sum & 0xFFFF) + (sum >> 16);
        }
        put16(p, t + 16, (int) (~sum) & 0xFFFF);
        return p;
    }
}
