package com.test19124.charging;

/** 离线验证 Java 端签名算法与 JS/Python 实现一致（不依赖 Android 运行时）。 */
public class SignTest {
    public static void main(String[] args) {
        String[] parts = {"/nearArea/abc?isNearBy=Y", "12345678", "T", "", "179343954", "abcdefghijklmnop"};
        String joined = ApiClient.joinByLengthDesc(parts);
        String md5 = ApiClient.md5(joined);
        String expectedJoin = "/nearArea/abc?isNearBy=Y17934395412345678Tabcdefghijklmnop";
        String expectedMd5 = "f65994493a52a5e9f8d83345b27056c7";
        System.out.println("joined = " + joined);
        System.out.println("md5    = " + md5);
        if (!expectedJoin.equals(joined) || !expectedMd5.equals(md5)) {
            System.out.println("FAIL");
            System.exit(1);
        }
        System.out.println("OK");
    }
}
