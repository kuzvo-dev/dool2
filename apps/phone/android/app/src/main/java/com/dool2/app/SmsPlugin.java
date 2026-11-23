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
 * 문자 보내기 (내 번호로). 사용자가 두리 승인 카드에서 승인한 문자만 보낸다 (main.ts smsCard).
 * - find: 연락처에서 이름으로 번호를 찾는다. 번호는 폰 밖(PC·AI)으로 보내지 않는다
 * - send: SmsManager로 바로 보낸다 (다른 앱을 열지 않는다). 긴 글은 나눠 보내고 모두 나갔는지 확인한다
 */
@CapacitorPlugin(name = "Sms")
public class SmsPlugin extends Plugin {
    private static final String SENT = "com.dool2.app.SMS_SENT";
    private static final long TIMEOUT_MS = 30_000;

    /** 이 폰이 문자를 보낼 수 있는지 (유심·전화 기능이 없는 태블릿은 false) */
    @PluginMethod
    public void available(PluginCall call) {
        JSObject r = new JSObject();
        r.put("ok", getContext().getPackageManager().hasSystemFeature(PackageManager.FEATURE_TELEPHONY_MESSAGING));
        call.resolve(r);
    }

    private boolean granted(String perm) {
        return ContextCompat.checkSelfPermission(getContext(), perm) == PackageManager.PERMISSION_GRANTED;
    }

    /** 연락처·문자 권한이 있는지 (묻는 창의 결과는 콜백 대신 이걸 다시 불러 확인한다: 창이 떠 있는 동안 앱이 얼려져 콜백이 사라졌다) */
    @PluginMethod
    public void permissions(PluginCall call) {
        JSObject r = new JSObject();
        r.put("contacts", granted(Manifest.permission.READ_CONTACTS));
        r.put("sms", granted(Manifest.permission.SEND_SMS));
        call.resolve(r);
    }

    /** 연락처·문자 권한을 한 번에 묻는다 (기다리지 않고 바로 돌아온다) */
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
        String query = call.getString("query", "").trim().replaceAll("님$", "").trim();
        JSObject r = new JSObject();
        JSArray people = new JSArray();
        if (query.isEmpty()) {
            r.put("people", people);
            call.resolve(r);
            return;
        }
        // 이름 전체로 먼저, 없으면 띄어 쓴 낱말을 모두 담은 이름 ("김 팀장" → "김민수 팀장")
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
            fail(call, "denied", "문자 보내기 권한이 없어 보내지 않았어요. 권한을 허용한 뒤 다시 눌러 주세요");
            return;
        }
        doSend(call);
    }

    private void doSend(PluginCall call) {
        String to = call.getString("to", "").replaceAll("[^0-9+]", "");
        String text = call.getString("text", "");
        if (to.length() < 3 || text.isEmpty()) {
            fail(call, "bad", "받는 번호나 글이 비어 있어요");
            return;
        }
        if (!getContext().getPackageManager().hasSystemFeature(PackageManager.FEATURE_TELEPHONY_MESSAGING)) {
            fail(call, "no-phone", "이 기기는 문자를 보낼 수 없어요 (전화 기능이 없어요)");
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
                if (code != Activity.RESULT_OK && error[0] == null) error[0] = reason(code);
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
                } else fail(call, "send", error[0]);
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
            fail(call, "send", "보내지 못했어요: " + e.getMessage());
            return;
        }
        // 통신사 응답이 오래 없으면 (보냈을 수도 있다) 그대로 알린다
        main.postDelayed(
            () -> {
                if (done[0]) return;
                done[0] = true;
                try {
                    ctx.unregisterReceiver(receiver);
                } catch (Exception ignored) {}
                fail(call, "timeout", "보냈는지 30초 안에 확인하지 못했어요. 폰 문자 앱의 보낸 문자를 봐 주세요");
            },
            TIMEOUT_MS
        );
    }

    private static String reason(int code) {
        switch (code) {
            case SmsManager.RESULT_ERROR_NO_SERVICE:
                return "신호가 없어 못 보냈어요";
            case SmsManager.RESULT_ERROR_RADIO_OFF:
                return "비행기 모드라 못 보냈어요";
            case SmsManager.RESULT_ERROR_NULL_PDU:
                return "글을 만들지 못해 못 보냈어요";
            default:
                return "통신사가 받지 않아 못 보냈어요 (코드 " + code + ")";
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
