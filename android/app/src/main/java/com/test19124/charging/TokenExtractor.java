package com.test19124.charging;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** 从 HTTP 明文里提取 JWT（Authorization 头或 JSON 里的 token 字段）。 */
public final class TokenExtractor {

    private static final Pattern BEARER =
            Pattern.compile("(?i)bearer\\s+(eyJ[A-Za-z0-9_-]{5,}\\.[A-Za-z0-9_-]{5,}\\.[A-Za-z0-9_-]{5,})");
    private static final Pattern JSON_TOKEN =
            Pattern.compile("\"token\"\\s*:\\s*\"(eyJ[A-Za-z0-9_-]{5,}\\.[A-Za-z0-9_-]{5,}\\.[A-Za-z0-9_-]{5,})\"");
    // 兜底：URL/路径里也可能带 JWT（参考服务器代理的做法）
    private static final Pattern ANY_JWT =
            Pattern.compile("(eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,})");

    private TokenExtractor() {
    }

    /** 返回最近的 JWT；没有则 null。 */
    public static String find(String text) {
        if (text == null || text.isEmpty()) {
            return null;
        }
        String last = null;
        Matcher m = BEARER.matcher(text);
        while (m.find()) {
            last = m.group(1);
        }
        if (last != null) {
            return last;
        }
        m = JSON_TOKEN.matcher(text);
        while (m.find()) {
            last = m.group(1);
        }
        if (last != null) {
            return last;
        }
        m = ANY_JWT.matcher(text);
        while (m.find()) {
            last = m.group(1);
        }
        return last;
    }
}
