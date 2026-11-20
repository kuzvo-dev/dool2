package com.dool2.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 폰 잠금 확인 (금고 비밀번호 보기, ADR 0026)
        registerPlugin(DeviceAuthPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
