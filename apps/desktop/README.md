# @dool2/desktop

두리 PC 앱(Electron)이에요. 두리 본체(`@dool2/daemon`)를 같은 프로세스에서 띄우고, 화면에는 로컬 API 주소와 토큰만 건네요([ADR 0004](../../docs/decisions/0004-electron.md)).

```bash
pnpm build
pnpm dev:desktop
```

## 구조

| 파일              | 역할                                                                      |
| ----------------- | ------------------------------------------------------------------------- |
| `src/main.ts`     | 메인 프로세스: 본체 시작, 창, 점검 모드                                   |
| `src/preload.cts` | 화면에 노출하는 최소한의 다리 (`window.dool2`). Node 기능은 넘기지 않아요 |
| `src/renderer/`   | 화면 (HTML·CSS·TypeScript, 프레임워크 없음)                               |

창은 `contextIsolation`, `sandbox`를 켜고 `nodeIntegration`을 꺼요. 외부 링크는 기본 브라우저로 열고, 창 안에서 다른 페이지로 이동하지 않아요.

## 점검 모드 (화면 캡처)

PR에 붙일 화면은 점검 모드로 찍어요. 창을 숨긴 채 띄워 화면이 다 그려지면 캡처하고 끝나요.

```bash
DOOL2_SMOKE=1 pnpm --filter @dool2/desktop smoke
# → apps/desktop/out/smoke.png

# 데모 대화·목표·보관함·피드를 넣고 탭을 골라 캡처
node apps/daemon/scripts/seed-demo.mjs /tmp/dool2-demo
DOOL2_DATA_DIR=/tmp/dool2-demo DOOL2_SMOKE_OPEN=goals+panel:memory pnpm --filter @dool2/desktop smoke
```

| 환경 변수           | 설명                                                                                                                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DOOL2_DATA_DIR`    | 데이터 폴더 (기본: OS 표준 위치)                                                                                                                                                           |
| `DOOL2_SMOKE_OUT`   | 캡처를 저장할 폴더                                                                                                                                                                         |
| `DOOL2_SMOKE_THEME` | `dark`·`light`로 고정해서 캡처 (기본: 기기 설정)                                                                                                                                           |
| `DOOL2_SMOKE_OPEN`  | 열어 둘 화면: `talk` `feed` `ideas` `goals` `goal[:id]` `library[:files]` `thread[:id]` `connections[:서비스]`. 뒤에 `+panel:칸`(schedule·memory·screen·activity·approvals)이나 `+nopanel` |

## 설치 파일 만들기 (서명 없음, 개발용)

```bash
pnpm build
pnpm --filter @dool2/desktop package   # → apps/desktop/release/dool2-<버전>-<arch>.dmg (윈도우는 .exe)
```

- 메인 프로세스와 두리 도구 서버를 esbuild로 한 파일씩 묶어 `stage/`에 모아요. Codex·Claude Code·종량제 실행기는 넣지 않고 처음 쓸 때 받아요.
- 앱 내부 이름은 `Dool2`예요. 한글 이름이면 맥에서 Electron 도우미("두리 Helper")를 못 찾고 켜자마자 꺼져요. 사용자에게 보이는 이름은 "두리"예요.
- 코드 서명·공증·자동 업데이트는 M5에서 붙여요. 지금 만든 dmg는 서명이 없어서 다른 맥에서는 "확인되지 않은 개발자" 경고가 떠요.
- 맥 dmg는 약 120MB예요 (대부분 Electron).
