package com.dool2.app;

import android.app.KeyguardManager;
import android.content.Context;
import android.os.Build;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.security.keystore.StrongBoxUnavailableException;
import android.util.Base64;
import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import androidx.fragment.app.FragmentActivity;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.nio.charset.StandardCharsets;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.Signature;
import java.security.spec.ECGenParameterSpec;

/**
 * Approval keys in the phone's security chip (ADR 0043). Two P-256 keys that never leave the chip:
 * - "plain" signs right away (approvals other than payments, and rejections)
 * - "pay" signs only within a few seconds after a fingerprint, face or PIN (payment and transfer approvals).
 *   Not made on a phone with no screen lock
 * keys: makes them the first time and returns their public keys (SPKI DER, base64url)
 * sign: signs a text with one of them; for "pay" the phone lock prompt comes first
 */
@CapacitorPlugin(name = "ApproveKey")
public class ApproveKeyPlugin extends Plugin {
    private static final String PLAIN = "dool2-approve-plain";
    private static final String PAY = "dool2-approve-pay";
    /** Seconds the pay key stays usable after the phone lock was checked */
    private static final int PAY_WINDOW = 5;

    private static String b64u(byte[] b) {
        return Base64.encodeToString(b, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
    }

    private static KeyStore store() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        return ks;
    }

    private static void make(String alias, boolean pay, boolean strongBox) throws Exception {
        KeyGenParameterSpec.Builder b = new KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
            .setAlgorithmParameterSpec(new ECGenParameterSpec("secp256r1"))
            .setDigests(KeyProperties.DIGEST_SHA256);
        if (pay) {
            b.setUserAuthenticationRequired(true);
            // A new fingerprint must not break approvals for good
            b.setInvalidatedByBiometricEnrollment(false);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R)
                b.setUserAuthenticationParameters(PAY_WINDOW, KeyProperties.AUTH_BIOMETRIC_STRONG | KeyProperties.AUTH_DEVICE_CREDENTIAL);
            else b.setUserAuthenticationValidityDurationSeconds(PAY_WINDOW);
        }
        if (strongBox && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) b.setIsStrongBoxBacked(true);
        KeyPairGenerator g = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore");
        g.initialize(b.build());
        g.generateKeyPair();
    }

    /** Makes the key if missing: StrongBox (a separate chip) when the phone has one, otherwise the TEE */
    private static String ensure(String alias, boolean pay) throws Exception {
        KeyStore ks = store();
        if (!ks.containsAlias(alias)) {
            try {
                make(alias, pay, true);
            } catch (StrongBoxUnavailableException e) {
                make(alias, pay, false);
            } catch (Exception e) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) make(alias, pay, false);
                else throw e;
            }
        }
        return b64u(ks.getCertificate(alias).getPublicKey().getEncoded());
    }

    private boolean locked() {
        KeyguardManager km = (KeyguardManager) getContext().getSystemService(Context.KEYGUARD_SERVICE);
        return km != null && km.isDeviceSecure();
    }

    @PluginMethod
    public void keys(PluginCall call) {
        try {
            JSObject o = new JSObject();
            o.put("plain", ensure(PLAIN, false));
            boolean lock = locked();
            o.put("lock", lock);
            if (lock || store().containsAlias(PAY)) o.put("pay", ensure(PAY, true));
            call.resolve(o);
        } catch (Exception e) {
            call.reject("keys", "keys");
        }
    }

    private static String signNow(String alias, String text) throws Exception {
        PrivateKey k = (PrivateKey) store().getKey(alias, null);
        Signature s = Signature.getInstance("SHA256withECDSA");
        s.initSign(k);
        s.update(text.getBytes(StandardCharsets.UTF_8));
        return b64u(s.sign());
    }

    @PluginMethod
    public void sign(PluginCall call) {
        String key = call.getString("key", "plain");
        String text = call.getString("text", "");
        if (!"pay".equals(key)) {
            try {
                JSObject o = new JSObject();
                o.put("sig", signNow(PLAIN, text));
                call.resolve(o);
            } catch (Exception e) {
                call.reject("sign", "sign");
            }
            return;
        }
        FragmentActivity activity = getActivity();
        String title = call.getString("title", "Confirm");
        String subtitle = call.getString("subtitle", "");
        activity.runOnUiThread(() -> {
            BiometricPrompt prompt = new BiometricPrompt(
                activity,
                ContextCompat.getMainExecutor(activity),
                new BiometricPrompt.AuthenticationCallback() {
                    @Override
                    public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                        try {
                            JSObject o = new JSObject();
                            o.put("sig", signNow(PAY, text));
                            call.resolve(o);
                        } catch (Exception e) {
                            call.reject("sign", "sign");
                        }
                    }

                    @Override
                    public void onAuthenticationError(int code, CharSequence msg) {
                        JSObject o = new JSObject();
                        o.put("cancel", true);
                        o.put("reason", code == BiometricPrompt.ERROR_NO_DEVICE_CREDENTIAL ? "no-lock" : "cancel");
                        call.resolve(o);
                    }
                }
            );
            BiometricPrompt.PromptInfo.Builder info = new BiometricPrompt.PromptInfo.Builder().setTitle(title);
            if (!subtitle.isEmpty()) info.setSubtitle(subtitle);
            // Only these unlock a Keystore key (a weak face unlock does not)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R)
                info.setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG | BiometricManager.Authenticators.DEVICE_CREDENTIAL);
            else info.setDeviceCredentialAllowed(true);
            prompt.authenticate(info.build());
        });
    }
}
