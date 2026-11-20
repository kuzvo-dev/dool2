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
 * 폰 잠금 확인 (지문·얼굴·PIN·패턴). 금고 비밀번호를 보기 전에 부른다 (ADR 0026).
 * 화면 잠금이 없는 폰이면 ok:false, reason:"no-lock"
 */
@CapacitorPlugin(name = "DeviceAuth")
public class DeviceAuthPlugin extends Plugin {
    private static int authenticators() {
        // 안드로이드 11부터는 생체 인증과 기기 PIN을 함께 받는다
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
        // 안드로이드 10 이하는 미리 묻지 않고 PIN 대체(setDeviceCredentialAllowed)로 띄운다.
        // 잠금이 아예 없으면 창이 ERROR_NO_DEVICE_CREDENTIAL로 끝난다
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
