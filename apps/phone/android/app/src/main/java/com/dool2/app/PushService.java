package com.dool2.app;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;
import org.json.JSONObject;

/**
 * Receives store app notifications (ADR 0042). FCM brings only a data message whose content the PC encrypted with this
 * phone's notification key; it is opened here and shown. Anything that does not open is dropped without a trace.
 * While the app is on screen nothing is shown: the app already shows the same thing.
 */
public class PushService extends FirebaseMessagingService {
    static final String CHANNEL = "dool2";
    /** Extra on the tap intent: where to open (#a=approval id, #t=conversation, #tab=…) */
    static final String OPEN = "dool2_open";

    @Override
    public void onMessageReceived(RemoteMessage m) {
        String sealed = m.getData().get("d");
        if (sealed == null) return;
        JSONObject n;
        try {
            n = new JSONObject(PushKeys.open(this, sealed));
        } catch (Exception e) {
            return;
        }
        if (PushPlugin.foreground) return;
        show(this, n.optString("title", ""), n.optString("body", ""), n.optString("tag", ""), n.optString("url", ""));
    }

    @Override
    public void onNewToken(String token) {
        // The app sends the new token to the PC the next time it opens (PushPlugin.register compares it)
        PushPlugin.tokenChanged(this);
    }

    static void ensureChannel(Context c) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm.getNotificationChannel(CHANNEL) != null) return;
        NotificationChannel ch = new NotificationChannel(CHANNEL, c.getString(R.string.push_channel), NotificationManager.IMPORTANCE_HIGH);
        ch.setDescription(c.getString(R.string.push_channel_desc));
        nm.createNotificationChannel(ch);
    }

    static void show(Context c, String title, String body, String tag, String url) {
        if (!NotificationManagerCompat.from(c).areNotificationsEnabled()) return;
        ensureChannel(c);
        Intent open = new Intent(c, MainActivity.class)
            .setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP)
            .putExtra(OPEN, url);
        int id = (tag.isEmpty() ? title + body : tag).hashCode();
        PendingIntent pi = PendingIntent.getActivity(c, id, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        NotificationCompat.Builder b = new NotificationCompat.Builder(c, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_dool2)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(pi);
        try {
            // The same tag replaces the earlier notification (same as the web push tag)
            NotificationManagerCompat.from(c).notify(tag.isEmpty() ? null : tag, id, b.build());
        } catch (SecurityException e) {
            // Notification permission was taken away meanwhile
        }
    }
}
