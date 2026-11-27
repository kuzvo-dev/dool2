package com.dool2.app;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import androidx.core.app.NotificationManagerCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.google.firebase.FirebaseApp;
import com.google.firebase.messaging.FirebaseMessaging;

/**
 * Store app notifications (ADR 0042), for the screen (native.ts):
 * - status: whether notifications can be on here (Firebase set up in this build) and whether they are allowed
 * - register: asks for the notification permission if needed (Android 13+), then returns the FCM token and this phone's
 *   notification key. The screen sends both to the PC over the encrypted link
 * - unregister: drops the FCM token (notifications off)
 * - event "open": a notification was tapped; {url} is where to go in the app
 */
@CapacitorPlugin(
    name = "Push",
    permissions = { @Permission(strings = { Manifest.permission.POST_NOTIFICATIONS }, alias = "notify") }
)
public class PushPlugin extends Plugin {
    /** Whether the app is on screen (PushService shows nothing then) */
    static volatile boolean foreground = false;

    private static final String PREFS = "dool2_push";

    static void tokenChanged(Context c) {
        c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean("changed", true).apply();
    }

    private boolean firebase() {
        return !FirebaseApp.getApps(getContext()).isEmpty();
    }

    private boolean allowed() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && getPermissionState("notify") != PermissionState.GRANTED)
            return false;
        return NotificationManagerCompat.from(getContext()).areNotificationsEnabled();
    }

    @Override
    public void load() {
        foreground = true;
        PushService.ensureChannel(getContext());
        Intent i = getActivity().getIntent();
        if (i != null) deliver(i);
    }

    @Override
    protected void handleOnResume() {
        foreground = true;
    }

    @Override
    protected void handleOnPause() {
        foreground = false;
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        deliver(intent);
    }

    private void deliver(Intent intent) {
        String url = intent.getStringExtra(PushService.OPEN);
        if (url == null) return;
        intent.removeExtra(PushService.OPEN);
        JSObject o = new JSObject();
        o.put("url", url);
        // Kept until the screen listens, for a tap that started the app
        notifyListeners("open", o, true);
    }

    @PluginMethod
    public void status(PluginCall call) {
        JSObject o = new JSObject();
        o.put("available", firebase());
        o.put("allowed", allowed());
        boolean denied = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && getPermissionState("notify") == PermissionState.DENIED;
        o.put("denied", denied);
        call.resolve(o);
    }

    @PluginMethod
    public void register(PluginCall call) {
        if (!firebase()) {
            call.reject("unavailable", "unavailable");
            return;
        }
        boolean ask = call.getBoolean("ask", false);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && getPermissionState("notify") != PermissionState.GRANTED) {
            if (!ask) {
                call.reject("not-allowed", "not-allowed");
                return;
            }
            requestPermissionForAlias("notify", call, "afterPermission");
            return;
        }
        fetchToken(call);
    }

    @PermissionCallback
    private void afterPermission(PluginCall call) {
        if (getPermissionState("notify") != PermissionState.GRANTED) {
            call.reject("denied", "denied");
            return;
        }
        fetchToken(call);
    }

    private void fetchToken(PluginCall call) {
        FirebaseMessaging.getInstance().getToken().addOnCompleteListener(t -> {
            if (!t.isSuccessful() || t.getResult() == null) {
                call.reject("token", "token");
                return;
            }
            try {
                JSObject o = new JSObject();
                o.put("token", t.getResult());
                o.put("key", PushKeys.b64u(PushKeys.get(getContext())));
                o.put("allowed", allowed());
                getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove("changed").apply();
                call.resolve(o);
            } catch (Exception e) {
                call.reject("key", "key");
            }
        });
    }

    @PluginMethod
    public void unregister(PluginCall call) {
        if (!firebase()) {
            call.resolve();
            return;
        }
        FirebaseMessaging.getInstance().deleteToken().addOnCompleteListener(t -> call.resolve());
    }
}
