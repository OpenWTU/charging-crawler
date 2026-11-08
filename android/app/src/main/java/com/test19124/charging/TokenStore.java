package com.test19124.charging;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** token 用 Android Keystore 的 AES/GCM 加密后存本地，不落明文、不外传。 */
public class TokenStore {

    private static final String PREFS = "charging_secure";
    private static final String KEY = "token_enc";
    private static final String ALIAS = "charging_token_key";
    private static final Object LOCK = new Object();

    private final SharedPreferences prefs;

    public TokenStore(Context context) {
        prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    public void save(String token) throws Exception {
        synchronized (LOCK) {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key());
            byte[] iv = cipher.getIV();
            byte[] ct = cipher.doFinal(token.getBytes("UTF-8"));
            String enc = Base64.encodeToString(iv, Base64.NO_WRAP) + ":"
                    + Base64.encodeToString(ct, Base64.NO_WRAP);
            prefs.edit().putString(KEY, enc).commit();
        }
    }

    public String get() {
        synchronized (LOCK) {
            String enc = prefs.getString(KEY, "");
            if (enc.isEmpty()) {
                return "";
            }
            try {
                String[] parts = enc.split(":");
                byte[] iv = Base64.decode(parts[0], Base64.NO_WRAP);
                byte[] ct = Base64.decode(parts[1], Base64.NO_WRAP);
                Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, iv));
                return new String(cipher.doFinal(ct), "UTF-8");
            } catch (Exception e) {
                // M5：这里原来 return ""，与"从未设置"无法区分 ——
                // 恢复备份/换机/锁屏策略变更导致 Keystore 密钥失效时，前端会显示
                // 「本地尚未设置令牌…去获取才能刷新」，而真实原因是密文解不开。
                // 返回 null 让调用方标记 corrupt。
                return null;
            }
        }
    }

    public void clear() {
        synchronized (LOCK) {
            prefs.edit().remove(KEY).commit();
        }
    }

    private SecretKey key() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        if (!ks.containsAlias(ALIAS)) {
            KeyGenerator kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            kg.init(new KeyGenParameterSpec.Builder(ALIAS,
                    KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .build());
            kg.generateKey();
        }
        return ((KeyStore.SecretKeyEntry) ks.getEntry(ALIAS, null)).getSecretKey();
    }
}
