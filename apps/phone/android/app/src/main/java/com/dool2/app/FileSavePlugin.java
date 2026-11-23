package com.dool2.app;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;

/**
 * Saves library files on the phone or sends them to another app.
 * Save: images go to the gallery (Pictures/<app folder>), anything else to Downloads (Download/<app folder>), no permission needed from Android 10.
 * Send: puts the file in the app cache and opens the share sheet (messenger, mail, etc.).
 */
@CapacitorPlugin(name = "FileSave")
public class FileSavePlugin extends Plugin {
    private static String safeName(String name) {
        String n = name == null ? "" : name.replaceAll("[\\\\/:*?\"<>|\\n\\r\\t]", " ").trim();
        return n.isEmpty() ? "두리 파일" : n;
    }

    @PluginMethod
    public void save(PluginCall call) {
        String name = safeName(call.getString("name"));
        String mime = call.getString("mime", "application/octet-stream");
        String data = call.getString("data", "");
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            JSObject r = new JSObject();
            r.put("ok", false);
            r.put("reason", "old-android");
            call.resolve(r);
            return;
        }
        try {
            byte[] bytes = Base64.decode(data, Base64.DEFAULT);
            boolean image = mime.startsWith("image/");
            ContentResolver cr = getContext().getContentResolver();
            ContentValues v = new ContentValues();
            v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
            v.put(MediaStore.MediaColumns.MIME_TYPE, mime);
            v.put(
                MediaStore.MediaColumns.RELATIVE_PATH,
                (image ? Environment.DIRECTORY_PICTURES : Environment.DIRECTORY_DOWNLOADS) + "/두리"
            );
            Uri collection = image
                ? MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
                : MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
            Uri uri = cr.insert(collection, v);
            if (uri == null) throw new Exception("저장할 곳을 만들지 못했어요");
            try (OutputStream out = cr.openOutputStream(uri)) {
                if (out == null) throw new Exception("파일을 열지 못했어요");
                out.write(bytes);
            }
            JSObject r = new JSObject();
            r.put("ok", true);
            r.put("where", image ? "사진첩(Pictures/두리)" : "다운로드(Download/두리)");
            call.resolve(r);
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    @PluginMethod
    public void share(PluginCall call) {
        String name = safeName(call.getString("name"));
        String mime = call.getString("mime", "application/octet-stream");
        String data = call.getString("data", "");
        try {
            byte[] bytes = Base64.decode(data, Base64.DEFAULT);
            File dir = new File(getContext().getCacheDir(), "share");
            if (!dir.exists() && !dir.mkdirs()) throw new Exception("임시 폴더를 만들지 못했어요");
            File f = new File(dir, name);
            try (FileOutputStream out = new FileOutputStream(f)) {
                out.write(bytes);
            }
            Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", f);
            Intent send = new Intent(Intent.ACTION_SEND);
            send.setType(mime);
            send.putExtra(Intent.EXTRA_STREAM, uri);
            send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            Intent chooser = Intent.createChooser(send, name);
            chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getActivity().startActivity(chooser);
            JSObject r = new JSObject();
            r.put("ok", true);
            call.resolve(r);
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }
}
