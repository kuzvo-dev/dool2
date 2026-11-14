# @dool2/extension

사용자가 평소 쓰는 Chrome에 설치하는 **두리 확장**이에요([ADR 0006](../../docs/decisions/0006-user-chrome-extension.md)). 평소 로그인 그대로 두리가 웹 일을 할 수 있게 해요.

확장은 **판단하지 않는 얇은 손**이에요. 무엇을 해도 되는지는 두리 본체(승인 게이트)가 정하고, 확장은 시킨 일만 해요.

```
두리 본체 ─ 로컬 소켓 ─ native messaging 호스트 ─ connectNative ─ 이 확장 ─ chrome.debugger ─ 두리 탭
```

## 지키는 것

- **두리가 연 탭만 다뤄요.** 두리 탭은 따로 연 "두리" 창의 초록색 탭 그룹에 모아요. 사용자가 연 탭은 읽지도 누르지도 않아요. 두리 탭에서 새 창 링크로 열린 탭만 두리 탭으로 이어 받아요.
- **http·https 주소만 열어요.** `file:`, `chrome:`, `javascript:`, `data:`는 열지 않아요.
- **입력은 실제 입력으로 넣어요.** 클릭·키는 `chrome.debugger`(CDP `Input.*`)로 넣어요. 페이지 스크립트로 흉내 낸 클릭은 쓰지 않아요.
- **페이지가 두리 표시를 볼 수 없어요.** 페이지 읽기는 확장 전용 공간(isolated world)에서 하고, 누를 곳 표시(`e12`)도 그 안에만 둬요.
- **비밀번호 칸에는 AI가 입력할 수 없어요.** 두리 금고(`fill`)로만 채우고, 그때도 지금 페이지 주소가 저장된 사이트와 같아야 해요([ADR 0011](../../docs/decisions/0011-login-vault.md)).
- 디버거는 쓸 때만 붙이고, 2분 동안 안 쓰면 떼요. 그동안 Chrome 위에 "제어 중" 막대가 떠요. 사용자가 막대에서 **취소**를 누르면 그 탭은 다시 다루지 않아요.

## 할 수 있는 일

| 명령         | 하는 일                                                                         |
| ------------ | ------------------------------------------------------------------------------- |
| `open`       | 두리 창에 새 탭을 열고 다 뜰 때까지 기다려요                                    |
| `navigate`   | 두리 탭의 주소를 바꿔요                                                         |
| `snapshot`   | 페이지를 글로 읽어요. 누를 수 있는 것에 `[e3 버튼 "검색"]` 표시, 캡차 화면 감지 |
| `click`      | 표시한 요소를 화면 가운데로 옮겨 마우스로 눌러요. 새 탭이 열리면 알려 줘요      |
| `type`       | 표시한 칸에 글자를 넣어요(기존 글자는 바뀜). `submit`이면 Enter                 |
| `press`      | Enter·Tab·Esc·방향키 등                                                         |
| `scroll`     | 위·아래로 한 화면                                                               |
| `screenshot` | 보이는 화면을 JPEG로(가로 최대 1280px)                                          |
| `back`       | 뒤로 가기                                                                       |
| `focus`      | 사람에게 넘길 때 두리 창·탭을 앞으로 가져와요                                   |
| `fill`       | 두리 금고 값 채우기(주소·칸 확인)                                               |
| `close`      | 두리 탭 닫기                                                                    |

## 개발

```bash
pnpm build                       # → apps/extension/dist (Chrome에 올릴 폴더)
```

- 사용자 Chrome에서 시험하려면 `chrome://extensions` → 개발자 모드 → **압축해제된 확장 프로그램을 로드합니다** → `apps/extension/dist`. 그리고 두리 앱을 `DOOL2_REGISTER_HOST=1 pnpm dev:desktop`으로 켜야 Chrome이 두리 호스트를 찾아요.
- 확장 id는 `manifest.json`의 `key`(공개키)로 고정돼 있어요(`mgjjgnbhoaalicncjbbcldjffpecocah`). 본체는 이 id에만 호스트를 열어 줘요. 웹 스토어에 올리면 스토어 id를 더해요(M5).

### 끝-끝 확인

시험용 Chrome(Chrome for Testing)에 확장을 올리고 진짜 본체와 붙여서, 시험용 페이지에서 열기·읽기·입력·클릭·새 탭·스크롤·캡처·캡차 감지·금지 동작을 확인해요. 사용자 Chrome과 프로필은 건드리지 않아요. 일반 Chrome은 137부터 명령줄로 확장을 올릴 수 없어서 Chrome for Testing을 써요.

```bash
npx @puppeteer/browsers install chrome@stable --path ~/.cache/dool2-test
pnpm build
DOOL2_TEST_CHROME="<Chrome for Testing 실행 파일>" pnpm --filter @dool2/extension e2e
# → apps/extension/out/e2e-search.jpg, e2e-snapshot.txt
```

## 알려진 한계

- 아직 iframe 안은 읽지 못해요(결제창·지도 등). 필요해지면 프레임별로 넓혀요.
- 두리 창이 다른 창에 가려져 있으면 Chrome이 화면을 그리지 않아요. 그래서 마우스 이동·스크롤 확인을 오래 기다리지 않게 해 뒀어요.
