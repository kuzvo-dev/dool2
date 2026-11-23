package com.dool2.app;

import android.Manifest;
import android.app.PendingIntent;
import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.ContactsContract;
import android.telephony.SmsManager;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

/**
 * Sends a text from the user's own number. Only texts the user approved on a Dool2 approval card (main.ts smsCard).
 * - find: looks up numbers by name in the contacts. Numbers never leave the phone (not to the PC or the AI)
 * - send: sends right away with SmsManager (no other app opens). Long texts are split and every part is confirmed
 * Failures come back as a reason code (denied, bad, no-phone, no-service, radio-off, carrier, timeout, error);
 * the screen turns the code into words.
 */
@CapacitorPlugin(name = "Sms")
public class SmsPlugin extends Plugin {
    private static final String SENT = "com.dool2.app.SMS_SENT";
    private static final long TIMEOUT_MS = 30_000;

    /** Whether this device can send texts (false on tablets without telephony) */
    @PluginMethod
    public void available(PluginCall call) {
        JSObject r = new JSObject();
        r.put("ok", getContext().getPackageManager().hasSystemFeature(PackageManager.FEATURE_TELEPHONY_MESSAGING));
        call.resolve(r);
    }

    private boolean granted(String perm) {
        return ContextCompat.checkSelfPermission(getContext(), perm) == PackageManager.PERMISSION_GRANTED;
    }

    /**
     * Whether contacts and SMS permissions are granted. The screen polls this after ask() instead of using a
     * permission callback: the app was frozen while the system dialog was up and the callback was lost (11-23)
     */
    @PluginMethod
    public void permissions(PluginCall call) {
        JSObject r = new JSObject();
        r.put("contacts", granted(Manifest.permission.READ_CONTACTS));
        r.put("sms", granted(Manifest.permission.SEND_SMS));
        call.resolve(r);
    }

    /** Asks for contacts and SMS permissions together (returns right away) */
    @PluginMethod
    public void ask(PluginCall call) {
        ActivityCompat.requestPermissions(
            getActivity(),
            new String[] { Manifest.permission.READ_CONTACTS, Manifest.permission.SEND_SMS },
            7301
        );
        call.resolve();
    }

    @PluginMethod
    public void find(PluginCall call) {
        if (!granted(Manifest.permission.READ_CONTACTS)) {
            JSObject r = new JSObject();
            r.put("denied", true);
            r.put("people", new JSArray());
            call.resolve(r);
            return;
        }
        doFind(call);
    }

    private void doFind(PluginCall call) {
        String query = call.getString("query", "").trim();
        JSObject r = new JSObject();
        JSArray people = new JSArray();
        if (query.isEmpty()) {
            r.put("people", people);
            call.resolve(r);
            return;
        }
        // The whole name first, then names that contain every word (a spaced query matches a longer name)
        String[] words = query.split("\\s+");
        Map<String, JSObject> found = new LinkedHashMap<>();
        collect(query, null, found);
        if (found.isEmpty() && words.length > 1) collect(words[0], words, found);
        for (JSObject p : found.values()) {
            if (people.length() >= 8) break;
            people.put(p);
        }
        r.put("people", people);
        call.resolve(r);
    }

    private void collect(String like, String[] all, Map<String, JSObject> out) {
        String[] cols = {
            ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME,
            ContactsContract.CommonDataKinds.Phone.NUMBER,
            ContactsContract.CommonDataKinds.Phone.TYPE,
            ContactsContract.CommonDataKinds.Phone.LABEL,
        };
        try (
            Cursor c = getContext()
                .getContentResolver()
                .query(
                    ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
                    cols,
                    ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME + " LIKE ?",
                    new String[] { "%" + like + "%" },
                    ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME + " ASC"
                )
        ) {
            if (c == null) return;
            while (c.moveToNext() && out.size() < 20) {
                String name = c.getString(0);
                String number = c.getString(1);
                if (name == null || number == null) continue;
                if (all != null) {
                    boolean every = true;
                    for (String w : all) if (!name.contains(w)) every = false;
                    if (!every) continue;
                }
                String key = number.replaceAll("[^0-9+]", "");
                if (key.isEmpty() || out.containsKey(key)) continue;
                CharSequence label = ContactsContract.CommonDataKinds.Phone.getTypeLabel(
                    getContext().getResources(),
                    c.getInt(2),
                    c.getString(3)
                );
                JSObject p = new JSObject();
                p.put("name", name);
                p.put("number", number);
                p.put("label", label == null ? "" : label.toString());
                out.put(key, p);
            }
        }
    }

    @PluginMethod
    public void send(PluginCall call) {
        if (!granted(Manifest.permission.SEND_SMS)) {
            fail(call, "denied", "SMS permission is not granted");
            return;
        }
        doSend(call);
    }

    private void doSend(PluginCall call) {
        String to = call.getString("to", "").replaceAll("[^0-9+]", "");
        String text = call.getString("text", "");
        if (to.length() < 3 || text.isEmpty()) {
            fail(call, "bad", "number or text is empty");
            return;
        }
        if (!getContext().getPackageManager().hasSystemFeature(PackageManager.FEATURE_TELEPHONY_MESSAGING)) {
            fail(call, "no-phone", "this device has no telephony");
            return;
        }
        Context ctx = getContext();
        SmsManager sms = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
            ? ctx.getSystemService(SmsManager.class)
            : SmsManager.getDefault();
        ArrayList<String> parts = sms.divideMessage(text);
        String action = SENT + "." + UUID.randomUUID();
        int total = parts.size();
        int[] left = { total };
        String[] error = { null };
        boolean[] done = { false };
        Handler main = new Handler(Looper.getMainLooper());
        BroadcastReceiver receiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context c, Intent intent) {
                int code = getResultCode();
                if (code != Activity.RESULT_OK && error[0] == null) error[0] = reason(code) + ":" + code;
                left[0]--;
                if (left[0] <= 0) finish(this);
            }

            private void finish(BroadcastReceiver self) {
                if (done[0]) return;
                done[0] = true;
                try {
                    ctx.unregisterReceiver(self);
                } catch (Exception ignored) {}
                if (error[0] == null) {
                    JSObject r = new JSObject();
                    r.put("ok", true);
                    r.put("parts", total);
                    call.resolve(r);
                } else {
                    String[] parts = error[0].split(":", 2);
                    fail(call, parts[0], "result code " + parts[1]);
                }
            }
        };
        ContextCompat.registerReceiver(ctx, receiver, new IntentFilter(action), ContextCompat.RECEIVER_NOT_EXPORTED);
        ArrayList<PendingIntent> sent = new ArrayList<>();
        for (int i = 0; i < total; i++) {
            Intent it = new Intent(action).setPackage(ctx.getPackageName());
            sent.add(PendingIntent.getBroadcast(ctx, i, it, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_ONE_SHOT));
        }
        try {
            if (total > 1) sms.sendMultipartTextMessage(to, null, parts, sent, null);
            else sms.sendTextMessage(to, null, text, sent.get(0), null);
        } catch (Exception e) {
            done[0] = true;
            try {
                ctx.unregisterReceiver(receiver);
            } catch (Exception ignored) {}
            fail(call, "error", String.valueOf(e.getMessage()));
            return;
        }
        // No answer from the carrier for a while (it may still have gone out): say so
        main.postDelayed(
            () -> {
                if (done[0]) return;
                done[0] = true;
                try {
                    ctx.unregisterReceiver(receiver);
                } catch (Exception ignored) {}
                fail(call, "timeout", "no send confirmation within 30 seconds");
            },
            TIMEOUT_MS
        );
    }

    private static String reason(int code) {
        switch (code) {
            case SmsManager.RESULT_ERROR_NO_SERVICE:
                return "no-service";
            case SmsManager.RESULT_ERROR_RADIO_OFF:
                return "radio-off";
            default:
                return "carrier";
        }
    }

    private static void fail(PluginCall call, String why, String message) {
        JSObject r = new JSObject();
        r.put("ok", false);
        r.put("reason", why);
        r.put("message", message);
        call.resolve(r);
    }
}
