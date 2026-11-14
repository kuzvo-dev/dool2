# @dool2/browser

두리의 브라우저 손이에요. **Chrome 확인·설치**와, 사용자 Chrome의 **두리 확장 ↔ 두리 본체 연결**을 맡아요([ADR 0006](../../docs/decisions/0006-user-chrome-extension.md)).

- `detectChrome()`: Chrome이 설치돼 있는지, 위치와 버전을 알려 줘요.
  - 맥: `/Applications`, `~/Applications`
  - 윈도우: Program Files, 사용자 폴더(LOCALAPPDATA)
- `installChrome()`, `ChromeInstall`: Google 공식 주소에서 설치 파일을 받아요. **Google 서명을 확인한 뒤에만** 설치해요.
  - 맥: 공식 dmg → 읽기 전용으로 열기 → `codesign --verify --deep` + 팀 ID `EQHXZ8M8AV` + Gatekeeper 공증(`spctl`, "Notarized Developer ID, Google LLC") → `/Applications`에 복사(권한이 없으면 `~/Applications`) → 정리
  - 윈도우: 공식 설치 프로그램 → Authenticode 서명이 `Valid`이고 서명자가 `O=Google LLC`인지 확인 → `/silent /install`(관리자 권한이 없으면 Google 설치 프로그램이 사용자 폴더에 설치해요)

`codesign --strict`는 Google 공식 dmg의 도우미 파일 하나에서 늘 실패해서 쓰지 않아요. 대신 Gatekeeper 공증 확인을 더했어요.

## 두리 확장과 본체 잇기 (native messaging)

```
두리 확장 (Chrome 안)
   │ chrome.runtime.connectNative('com.dool2.host')
   ▼
native messaging 호스트 (host.ts, Chrome이 띄움)   ← 메시지를 옮기기만 해요
   │ 로컬 소켓 (맥·리눅스: 유닉스 소켓 0600, 윈도우: 이름 있는 파이프) + 토큰
   ▼
두리 본체 BrowserBridge (bridge.ts)                 ← 판단·승인은 여기서만
```

- `BrowserBridge`: 본체가 소켓을 열고, 켤 때마다 새 토큰을 `browser-bridge.json`(0600)에 적어요. 첫 줄로 그 토큰을 보내지 않은 연결은 5초 안에 끊어요. `call('open', { url })`처럼 확장에 일을 시키고 답을 기다려요.
- `runHost()`: Chrome 쪽은 [길이 4바이트 + JSON], 본체 쪽은 줄 단위 JSON이에요. 본체가 꺼져 있으면 10초 기다렸다가 확장에 `daemon-offline`을 알리고 끝나요.
- `registerNativeHost()`: 실행 스크립트(`dool2-host.sh` / `.bat`)와 등록 파일을 데이터 폴더의 `native-host/`에 만들고, 사용자 위치에만 등록해요(관리자 권한 없음).
  - 맥: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`
  - 윈도우: `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.dool2.host`
  - Chromium·Edge는 설치돼 있을 때만 같이 등록해요.
- 배포 앱은 켤 때마다 등록해요. 개발 중에는 `DOOL2_REGISTER_HOST=1`일 때만 사용자 Chrome에 등록하고, 점검 모드는 등록하지 않아요. 시험용 Chrome 프로필에만 두려면 `DOOL2_HOST_DIRS=<프로필>/NativeMessagingHosts`를 써요.
