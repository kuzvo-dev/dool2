# @dool2/hands-mac

두리 **PC 화면 제어 도우미(맥)** 예요([ADR 0013](../../docs/decisions/0013-hands-mac-swift.md), [아키텍처 5.2](../../docs/architecture.md)). Swift 파일 하나이고, 두리 본체가 자식 프로세스로 띄워 한 줄 JSON으로 부려요. 판단(허용한 앱, 위험한 버튼, 승인)은 본체가 해요.

```bash
pnpm --filter @dool2/hands-mac build      # → dist/dool2-hands (맥에서만, Xcode 명령줄 도구의 swiftc)
printf '%s\n' '{"id":1,"cmd":"status"}' | ./dist/dool2-hands
```

| 명령                 | 하는 일                                                                          |
| -------------------- | -------------------------------------------------------------------------------- |
| `status`             | 손쉬운 사용·화면 기록 권한, 화면 잠김                                            |
| `request`            | 시스템 권한 창 띄우기 (사용자가 설정에서 직접 켠다)                              |
| `apps` · `installed` | 켜진 앱, 설치된 앱(번들 id·이름)                                                 |
| `open`               | 앱 열고 앞으로                                                                   |
| `snapshot`           | 앞 창의 접근성 트리를 `[e12 버튼 "보내기"]` 글로. 비밀번호 칸 값은 내보내지 않음 |
| `click`              | 요소를 접근성 "누르기"로, 안 되면 가운데를 마우스로                              |
| `type`               | 칸에 초점을 주고 붙여 넣기로 입력(한글), 클립보드는 되돌림. 비밀번호 칸은 거절   |
| `key`                | Enter·Tab·화살표·cmd+…                                                           |
| `screenshot`         | 앱 창 캡처(ScreenCaptureKit, JPEG)                                               |

브라우저·비밀번호 관리자·두리 자신은 본체가 시켜도 다루지 않아요.

## 맥 권한

손쉬운 사용·화면 기록 권한은 도우미가 아니라 **도우미를 띄운 앱(두리)** 이름으로 받아요. 앱 서명이 깨져 있으면 맥이 앱을 알아보지 못해서 설정에서 켜도 적용되지 않아요(실측).

- 배포 앱: 패키징할 때 앱 전체를 ad-hoc으로 다시 서명해요(`scripts/package.mjs`의 `afterPack`). 개발자 ID 서명은 M5
- 개발 중: npm으로 받은 `Electron.app`도 서명이 깨져 있어요. 한 번 `codesign --force --deep --sign - <Electron.app>`으로 다시 서명하고, `open -n Electron.app --args apps/desktop`으로 띄운 뒤 "Electron"에 권한을 켜요. 두리 코드를 고쳐도 Electron은 그대로라 다시 켤 필요가 없어요
