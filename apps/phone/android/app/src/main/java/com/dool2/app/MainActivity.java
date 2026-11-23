package com.dool2.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 폰 잠금 확인 (금고 비밀번호 보기, ADR 0026)
        registerPlugin(DeviceAuthPlugin.class);
        // 보관함 파일을 폰에 저장·다른 앱으로 보내기
        registerPlugin(FileSavePlugin.class);
        // 내 번호로 문자 보내기 (승인 카드에서 승인한 것만)
        registerPlugin(SmsPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
