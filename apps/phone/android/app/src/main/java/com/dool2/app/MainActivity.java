package com.dool2.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Phone lock check (viewing vault passwords, ADR 0026)
        registerPlugin(DeviceAuthPlugin.class);
        // Save library files on the phone or send them to another app
        registerPlugin(FileSavePlugin.class);
        // Send a text from my number (only what was approved on an approval card)
        registerPlugin(SmsPlugin.class);
        // Store app notifications: FCM token, this phone's notification key, taps (ADR 0042)
        registerPlugin(PushPlugin.class);
        // Approval keys in the security chip; payments sign only after the phone lock (ADR 0043)
        registerPlugin(ApproveKeyPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
