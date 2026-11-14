# @dool2/browser

두리의 브라우저 손이에요. 지금은 **Chrome 확인·설치**를 맡고, M2에서 두리 Chrome 확장과 연결해요([ADR 0006](../../docs/decisions/0006-user-chrome-extension.md)).

- `detectChrome()`: Chrome이 설치돼 있는지, 위치와 버전을 알려 줘요.
  - 맥: `/Applications`, `~/Applications`
  - 윈도우: Program Files, 사용자 폴더(LOCALAPPDATA)
- `installChrome()`, `ChromeInstall`: Google 공식 주소에서 설치 파일을 받아요. **Google 서명을 확인한 뒤에만** 설치해요.
  - 맥: 공식 dmg → 읽기 전용으로 열기 → `codesign --verify --deep` + 팀 ID `EQHXZ8M8AV` + Gatekeeper 공증(`spctl`, "Notarized Developer ID, Google LLC") → `/Applications`에 복사(권한이 없으면 `~/Applications`) → 정리
  - 윈도우: 공식 설치 프로그램 → Authenticode 서명이 `Valid`이고 서명자가 `O=Google LLC`인지 확인 → `/silent /install`(관리자 권한이 없으면 Google 설치 프로그램이 사용자 폴더에 설치해요)

`codesign --strict`는 Google 공식 dmg의 도우미 파일 하나에서 늘 실패해서 쓰지 않아요. 대신 Gatekeeper 공증 확인을 더했어요.
