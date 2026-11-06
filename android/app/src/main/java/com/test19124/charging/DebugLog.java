package com.test19124.charging;

import java.text.SimpleDateFormat;
import java.util.ArrayDeque;
import java.util.Date;
import java.util.Locale;

/** 抓包过程的内存日志，方便在手机上直接看到卡在哪一步。 */
public final class DebugLog {

    private static final int MAX = 120;
    private static final ArrayDeque<String> LINES = new ArrayDeque<>();
    private static final SimpleDateFormat FMT = new SimpleDateFormat("HH:mm:ss", Locale.CHINA);

    private DebugLog() {
    }

    public static synchronized void add(String msg) {
        if (LINES.size() >= MAX) {
            LINES.removeFirst();
        }
        LINES.addLast(FMT.format(new Date()) + "  " + msg);
    }

    public static synchronized String dump() {
        if (LINES.isEmpty()) {
            return "（还没有日志）";
        }
        StringBuilder sb = new StringBuilder();
        for (String line : LINES) {
            sb.append(line).append('\n');
        }
        return sb.toString();
    }

    public static synchronized void clear() {
        LINES.clear();
    }
}
