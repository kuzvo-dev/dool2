package com.dool2.app;

import android.os.Build;
import android.view.HapticFeedbackConstants;
import android.view.View;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * The phone's own haptics for the screen (native.ts haptic). navigator.vibrate does nothing in the app (no VIBRATE
 * permission, and a plain buzz feels like a web page anyway); performHapticFeedback needs no permission and follows
 * the person's "touch feedback" setting.
 * kinds: tick (small step), key (keypad), long (long press), confirm (approved, done), reject (refused, error)
 */
@CapacitorPlugin(name = "Haptics")
public class HapticsPlugin extends Plugin {
    private static int constant(String kind) {
        boolean r = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R;
        switch (kind) {
            case "key":
                return HapticFeedbackConstants.KEYBOARD_TAP;
            case "long":
                return HapticFeedbackConstants.LONG_PRESS;
            case "confirm":
                return r ? HapticFeedbackConstants.CONFIRM : HapticFeedbackConstants.VIRTUAL_KEY;
            case "reject":
                return r ? HapticFeedbackConstants.REJECT : HapticFeedbackConstants.LONG_PRESS;
            default:
                return HapticFeedbackConstants.CLOCK_TICK;
        }
    }

    @PluginMethod
    public void tap(PluginCall call) {
        String kind = call.getString("kind", "tick");
        View v = getBridge().getWebView();
        v.post(() -> v.performHapticFeedback(constant(kind)));
        call.resolve();
    }
}
