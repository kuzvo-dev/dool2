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

# 데모 대화를 열어 둔 화면
node apps/daemon/scripts/seed-demo.mjs /tmp/dool2-demo
DOOL2_DATA_DIR=/tmp/dool2-demo DOOL2_SMOKE_OPEN=latest pnpm --filter @dool2/desktop smoke
```

| 환경 변수          | 설명                                        |
| ------------------ | ------------------------------------------- |
| `DOOL2_DATA_DIR`   | 데이터 폴더 (기본: OS 표준 위치)            |
| `DOOL2_SMOKE_OUT`  | 캡처를 저장할 폴더                          |
| `DOOL2_SMOKE_OPEN` | `latest`면 가장 최근 대화를 열어 둔 채 캡처 |
