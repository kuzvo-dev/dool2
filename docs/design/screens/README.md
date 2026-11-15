# 화면 예시

> **v2 기준 화면은 [`soft/`](soft)예요** (부드러운 면, 2026-11-15). 아래는 v1(다크·선 위주) 화면이고, v2와 다르면 v2가 기준이에요.

디자인 도구에서 만든 실제 화면이에요. 그림(PNG)으로 보고, 정확한 값(색·크기·여백·모서리)은 `src/`의 HTML에서 읽어요. HTML은 디자인 도구용 틀(`<x-dc>`)이라 브라우저에서 바로 열리지 않아요. 앱 코드에 그대로 붙이지 말고 [`packages/ui`](../../../packages/ui) 부품으로 옮겨요.

다크가 기본이고, 라이트는 같은 화면에 라이트 테마만 바꾼 거예요(HTML의 `theme` 값).

| 화면 | 다크 | 라이트 | 원본 HTML | 무엇을 보여 주나 |
| --- | --- | --- | --- | --- |
| PC · 대화 하나 + 두리의 화면 | [pc-dark](pc-dark.png) | [pc-light](pc-light.png) | [PC.dc.html](src/PC.dc.html) | 3단: 왼쪽 메뉴·지금 하는 일·연결된 컴퓨터 / 가운데 대화 하나 / 오른쪽 "두리의 화면"(진행 중인 일, 다음 차례) |
| 모바일 · 대화 | [m-thread-dark](m-thread-dark.png) | [m-thread-light](m-thread-light.png) | [MThread.dc.html](src/MThread.dc.html) | 두리가 먼저 말 걸기, 빠른 답 버튼, 대화 안 작업 카드, 입력창의 말하기, 아래 탭 4개 |
| 모바일 · 말로 이야기하기 | [m-voice-dark](m-voice-dark.png) | [m-voice-light](m-voice-light.png) | [MVoice.dc.html](src/MVoice.dc.html) | 음성 대화 중 화면: 큰 캐릭터, 파형, 들은 말, 음소거·글로 보기·끝내기 |
| 모바일 · 결제 승인 | [m-approve-dark](m-approve-dark.png) | [m-approve-light](m-approve-light.png) | [MApprove.dc.html](src/MApprove.dc.html) | 바텀시트 승인 카드: 금액 질문, 이름·값 줄, Face ID로 승인하기 / 내가 직접 할게요 / 거절 |
| 모바일 · 맡긴 일 | [m-tasks-dark](m-tasks-dark.png) | [m-tasks-light](m-tasks-light.png) | [MTasks.dc.html](src/MTasks.dc.html) | 지금 하는 일 막대, 나를 기다리는 승인, 매일 알아서 해요(켜고 끄기), 끝낸 일 |
| 모바일 · 둘러보기 | [m-explore-dark](m-explore-dark.png) | [m-explore-light](m-explore-light.png) | [MExplore.dc.html](src/MExplore.dc.html) | 두리가 찾은 것(구독·포인트·반품), 이번 달 많이 맡기는 말, 한 번 켜 두면 알아서 해요, 직접 해야 하는 것 |
| 모바일 · 나의 두리 | [m-me-dark](m-me-dark.png) | [m-me-light](m-me-light.png) | [MMe.dc.html](src/MMe.dc.html) | 우리 집 컴퓨터 상태, 이번 주 한 일·아낀 시간, 로그인해 둔 곳, 약속(돈 쓰는 일은 먼저 물어봐요) |

`MThreadLight.dc.html`은 `MThread`를 라이트로 불러오는 틀이에요.
