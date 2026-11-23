package com.dool2.app;

import android.os.Build;
import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import androidx.fragment.app.FragmentActivity;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Phone lock check (fingerprint, face, PIN, pattern). Called before showing vault passwords (ADR 0026).
 * On a phone with no screen lock it returns ok:false, reason:"no-lock"
 */
@CapacitorPlugin(name = "DeviceAuth")
public class DeviceAuthPlugin extends Plugin {
    private static int authenticators() {
        // From Android 11, biometrics and the device PIN are accepted together
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.R
            ? BiometricManager.Authenticators.BIOMETRIC_WEAK | BiometricManager.Authenticators.DEVICE_CREDENTIAL
            : BiometricManager.Authenticators.BIOMETRIC_WEAK;
    }

    @PluginMethod
    public void confirm(PluginCall call) {
        FragmentActivity activity = getActivity();
        String title = call.getString("title", "본인 확인");
        String subtitle = call.getString("subtitle", "");
        BiometricManager bm = BiometricManager.from(activity);
        // Android 10 and below do not check beforehand and show the PIN fallback (setDeviceCredentialAllowed).
        // With no lock at all, the prompt ends with ERROR_NO_DEVICE_CREDENTIAL
        int can = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R
            ? bm.canAuthenticate(authenticators())
            : BiometricManager.BIOMETRIC_SUCCESS;
        if (can != BiometricManager.BIOMETRIC_SUCCESS) {
            JSObject r = new JSObject();
            r.put("ok", false);
            r.put("reason", "no-lock");
            call.resolve(r);
            return;
        }
        activity.runOnUiThread(() -> {
            BiometricPrompt prompt = new BiometricPrompt(
                activity,
                ContextCompat.getMainExecutor(activity),
                new BiometricPrompt.AuthenticationCallback() {
                    @Override
                    public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                        JSObject r = new JSObject();
                        r.put("ok", true);
                        call.resolve(r);
                    }

                    @Override
                    public void onAuthenticationError(int code, CharSequence msg) {
                        JSObject r = new JSObject();
                        r.put("ok", false);
                        r.put("reason", code == BiometricPrompt.ERROR_NO_DEVICE_CREDENTIAL ? "no-lock" : "cancel");
                        call.resolve(r);
                    }
                }
            );
            BiometricPrompt.PromptInfo.Builder info = new BiometricPrompt.PromptInfo.Builder().setTitle(title);
            if (!subtitle.isEmpty()) info.setSubtitle(subtitle);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) info.setAllowedAuthenticators(authenticators());
            else info.setDeviceCredentialAllowed(true);
            prompt.authenticate(info.build());
        });
    }
}
