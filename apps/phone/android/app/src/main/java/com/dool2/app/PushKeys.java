package com.dool2.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.SecureRandom;
import java.util.Arrays;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * This phone's notification key (ADR 0042). 32 random bytes, sent only to the PC over the encrypted link; the PC
 * encrypts each notification with it (AES-256-GCM), so FCM and the relay only ever see ciphertext.
 * Kept wrapped by a key in the Android Keystore, which never leaves the phone and is not in backups, so a backup copy of
 * the app data cannot open notifications.
 */
final class PushKeys {
    private static final String PREFS = "dool2_push";
    private static final String WRAPPED = "key";
    private static final String WRAP_ALIAS = "dool2-push-wrap";

    private PushKeys() {}

    private static SecretKey wrapKey() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        if (ks.containsAlias(WRAP_ALIAS)) return ((KeyStore.SecretKeyEntry) ks.getEntry(WRAP_ALIAS, null)).getSecretKey();
        KeyGenerator g = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        g.init(new KeyGenParameterSpec.Builder(WRAP_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .build());
        return g.generateKey();
    }

    private static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** The notification key (raw 32 bytes); made the first time */
    static synchronized byte[] get(Context c) throws Exception {
        String w = prefs(c).getString(WRAPPED, null);
        if (w != null) {
            try {
                byte[] b = Base64.decode(w, Base64.NO_WRAP);
                Cipher x = Cipher.getInstance("AES/GCM/NoPadding");
                x.init(Cipher.DECRYPT_MODE, wrapKey(), new GCMParameterSpec(128, Arrays.copyOfRange(b, 0, 12)));
                return x.doFinal(Arrays.copyOfRange(b, 12, b.length));
            } catch (Exception e) {
                // The Keystore key is gone (restored from a backup onto another phone, etc.): make a new one below
            }
        }
        byte[] raw = new byte[32];
        new SecureRandom().nextBytes(raw);
        Cipher x = Cipher.getInstance("AES/GCM/NoPadding");
        x.init(Cipher.ENCRYPT_MODE, wrapKey());
        byte[] iv = x.getIV();
        byte[] ct = x.doFinal(raw);
        byte[] out = new byte[iv.length + ct.length];
        System.arraycopy(iv, 0, out, 0, iv.length);
        System.arraycopy(ct, 0, out, iv.length, ct.length);
        prefs(c).edit().putString(WRAPPED, Base64.encodeToString(out, Base64.NO_WRAP)).apply();
        return raw;
    }

    /** base64url without padding (the form the PC expects) */
    static String b64u(byte[] b) {
        return Base64.encodeToString(b, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
    }

    /** Opens what the PC sealed: base64url(12-byte nonce || ciphertext || 16-byte tag) -> JSON text */
    static String open(Context c, String sealed) throws Exception {
        byte[] b = Base64.decode(sealed, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
        if (b.length < 12 + 16) throw new IllegalArgumentException("short");
        Cipher x = Cipher.getInstance("AES/GCM/NoPadding");
        x.init(Cipher.DECRYPT_MODE, new SecretKeySpec(get(c), "AES"), new GCMParameterSpec(128, Arrays.copyOfRange(b, 0, 12)));
        return new String(x.doFinal(Arrays.copyOfRange(b, 12, b.length)), StandardCharsets.UTF_8);
    }
}
