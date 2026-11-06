package com.test19124.charging;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.security.KeyStore;
import java.security.SecureRandom;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** 每台设备独立的 device_id 与 secret；secret 用 Keystore 加密存本地。 */
public class DeviceStore {

    private static final String PREFS = "charging_device";
    private static final String ID = "device_id";
    private static final String SECRET = "device_secret";
    private static final String ALIAS = "charging_device_key";
    private static final Object LOCK = new Object();

    private final SharedPreferences prefs;

    public DeviceStore(Context ctx) {
        prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    public String deviceId() {
        synchronized (LOCK) {
            String id = prefs.getString(ID, "");
            if (id.isEmpty()) {
                byte[] b = new byte[16];
                new SecureRandom().nextBytes(b);
                id = hex(b);
                prefs.edit().putString(ID, id).apply();
            }
            return id;
        }
    }

    public String secret() {
        synchronized (LOCK) {
            String enc = prefs.getString(SECRET, "");
            if (enc.startsWith("plain:")) {
                return enc.substring(6);
            }
            if (!enc.isEmpty()) {
                try {
                    String[] parts = enc.split(":");
                    byte[] iv = Base64.decode(parts[0], Base64.NO_WRAP);
                    byte[] ct = Base64.decode(parts[1], Base64.NO_WRAP);
                    Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
                    c.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, iv));
                    return new String(c.doFinal(ct), "UTF-8");
                } catch (Exception ignored) {
                    // Keystore 失效：连 device_id 一起作废，按新设备重新注册
                    prefs.edit().remove(SECRET).remove(ID).apply();
                }
            }
            byte[] b = new byte[32];
            new SecureRandom().nextBytes(b);
            String secret = hex(b);
            try {
                Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
                c.init(Cipher.ENCRYPT_MODE, key());
                byte[] ct = c.doFinal(secret.getBytes("UTF-8"));
                prefs.edit().putString(SECRET,
                        Base64.encodeToString(c.getIV(), Base64.NO_WRAP) + ":"
                                + Base64.encodeToString(ct, Base64.NO_WRAP)).apply();
            } catch (Exception ignored) {
                // 加密不可用时明文落盘（应用私有目录），避免每次调用都换 secret
                prefs.edit().putString(SECRET, "plain:" + secret).apply();
            }
            return secret;
        }
    }

    private SecretKey key() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        if (!ks.containsAlias(ALIAS)) {
            KeyGenerator kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,
                    "AndroidKeyStore");
            kg.init(new KeyGenParameterSpec.Builder(ALIAS,
                    KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .build());
            kg.generateKey();
        }
        return ((KeyStore.SecretKeyEntry) ks.getEntry(ALIAS, null)).getSecretKey();
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
