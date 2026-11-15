# @dool2/ui — 두리 디자인 시스템

PC 앱·폰 앱·Chrome 확장이 같이 쓰는 토큰과 부품이에요. 디자인 원본은 [docs/design](../../docs/design/README.md)에 있고, 다르면 원본을 따라 여기를 고쳐요.

- `ui.css` — 토큰(색·글자·여백·모서리·그림자)과 부품
- `doori3d.js` — 3D 두리(랜딩과 같은 모양)와 표정 6개. 큰 자리(64px 이상)는 앱 빌드가 three와 함께 묶어 `mountDoori()`로 움직이게 띄워요
- `doori/` — 3D 두리를 표정마다 미리 뽑은 그림(webp)과 로고(SVG). `ui.css`의 `.doori`가 불러요. 다시 뽑을 땐 `doori-render.html`
- `fonts.css`, `fonts/` — Pretendard 가변 글꼴 ([SIL OFL 1.1](fonts/OFL.txt)). PC 앱·확장에만 넣고, 폰은 기기 글꼴을 써요
- `preview.html` — 모든 부품을 한 화면에 모은 견본. 브라우저로 열고 위에서 다크·라이트를 바꿔 봐요
- `copy.mjs` — 앱 빌드가 `ui.css`·`doori/`(와 글꼴)를 자기 `dist`로 복사하고(`copyUi`), 3D 두리를 묶을 때(`bundleDoori3d`) 써요

```js
import { copyUi } from '../../../packages/ui/copy.mjs'
copyUi('dist/renderer', { fonts: true }) // PC 앱·확장
copyUi('dist') // 폰 앱
```

```html
<html lang="ko" data-theme="auto"> <!-- 기기 설정 따라가기. "dark"·"light"로 고정, 없으면 라이트 -->
<link rel="stylesheet" href="fonts.css" /> <!-- PC 앱·확장만 -->
<link rel="stylesheet" href="ui.css" />
<link rel="stylesheet" href="style.css" /> <!-- 앱의 화면 배치 -->
```

## 원칙

**부드러운 면 위에 민트 친구 하나 (v2).** 옅은 회색 바탕 위 흰 카드·회색 말풍선, 손이 닿는 것(머리 버튼·입력칸·탭 막대·시트)만 유리처럼 떠 있어요. 귀여움은 두리 캐릭터와 "일하는 중" 표시에 모아요. 기준 화면: [docs/design/screens/soft](../../docs/design/screens/soft).

1. **하는 일이 보여야 믿는다.** 머리의 두리 이름표(`.agent-tag`)에 지금 하는 일, 대화 안에 실시간 화면 카드(`.livecard`), 단계 기록(`.log`, `.worklog`). "생각 중…" 같은 막연한 표시는 쓰지 않아요.
2. **돈과 메시지는 사람이 누른다.** 결제·전송은 승인 카드(`.approve`)에서 멈춰요. 승인 버튼(`.btn-approve`, 짙은 민트)이 화면에서 가장 무거워요.
3. **민트는 두리의 색.** 캐릭터, 일하는 중, 승인 버튼, 옅은 민트의 내 말풍선(`--me`).
4. **상자보다 면, 떠 있는 것은 유리.** 회색 면(`--raise`, `--surface-sunken`)과 0.5px 선으로 나눠요. 머리 버튼(`.fbtn`, `.fpill`)·입력칸(`.composer.float`)·탭 막대(`.tabs`)·시트만 `--glass` + `--shadow-float`로 떠 있어요. 카드 안에 카드를 넣지 않아요.
5. **상태는 색으로 약속한다.** 민트 = 일하는 중, 노랑(`--butter`) 점·배지 = 당신이 필요해요, ink 체크 = 끝났어요, 빨강 = 멈춤·오류.

그 밖의 규칙:

- 버튼은 동사로 끝내요(`승인하기`, `대신 해줘`, `내가 할게요`). 주 버튼은 한 화면에 하나, 모서리 14px, 알약 모양으로 만들지 않아요(떠 있는 탭 막대·입력칸·빠른 답만 알약).
- Pretendard 하나로 써요. 제목은 680–760, 본문 450. 큰 글자일수록 자간을 좁혀요(display −0.035em).
- 고정폭(`.mono`, `--font-mono`)은 기록·영수증·도메인처럼 줄을 맞춰야 하는 곳에만.
- 한국어는 낱말 단위로 줄을 바꾸고(`keep-all`), 숫자는 고정폭 숫자로 맞춰요. 바탕에 들어 있어요.
- 아이콘은 24 격자, 선 1.75의 SVG(`svg.i`)예요. 이모지나 `›`·`✓` 같은 글자를 아이콘으로 쓰지 않아요.
- 문구는 평소 쓰는 말로 써요. "허락" 대신 "승인", "잠긴 봉투" 대신 "암호화".
- 금지: 보라·파랑 그라데이션, 글로우, 떠 있는 것 말고 쓰는 유리 효과, 카드 안의 카드, 알약 배지 남발, 이모지 아이콘, 의미 없는 통계 블록, 스크롤마다 페이드업.

## 토큰

색은 `light-dark()` 하나로 두 테마를 가져요. 값은 [docs/design/system/tokens.json](../../docs/design/system/tokens.json)과 화면 예시를 따라요.

| 이름                                      | 라이트 / 다크                        | 쓰는 곳                                                                                                                         |
| ----------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `--bg`                                    | #ffffff / #121418                    | 앱 바탕                                                                                                                         |
| `--surface`                               | #ffffff / #1b1d23                    | 한 단 올라온 곳: 입력창, 승인 시트, 옆 판                                                                                       |
| `--surface-sunken`                        | #f4f5f7 / #0b0c0f                    | 들어간 곳: 두리의 화면, 기록                                                                                                    |
| `--raise`                                 | #f1f2f4 / #23262d                    | 두리 말풍선, 선택된 메뉴, 아이콘 칸                                                                                             |
| `--line` / `--line-strong`                | #e6e8eb / #2a2d35, #8b9099 / #5c616b | 나누는 선 / 입력·보조 버튼 테두리                                                                                               |
| `--ink` / `--ink-muted` / `--ink-inverse` |                                      | 본문·주 버튼·내 말풍선 / 설명·시각 / ink 위 글자                                                                                |
| `--brand`                                 | #4cc98f                              | 두리 민트 (`--brand-text`, `--brand-soft`)                                                                                      |
| `--butter`                                | #ffd66b                              | 당신이 필요해요 (`--butter-soft`, 위 글자는 `--on-accent`)                                                                      |
| `--danger`                                | #d0342c / #ff7a72                    | 멈추기·거절·오류. 글자로만 (`--danger-soft`)                                                                                    |
| `--space-1…12`                            | 4·8·12·16·24·32·48px                 | 같은 화자 12, 화자가 바뀌면 24                                                                                                  |
| `--radius-sm/md/lg/xl/full`               | 6·12·20·28·999px                     | 칩 / 버튼·입력 / 말풍선·카드 / 바텀시트 / 캐릭터·점만                                                                           |
| `--shadow-sheet`                          |                                      | 떠 있는 것에만                                                                                                                  |
| `--text-display` … `--text-log`           |                                      | `font:` 한 줄로 쓰는 글자 크기 (display 44, title-1 28, title-2 20, body-lg 17, body 15, label 14, caption 12.5, log 12.5 mono) |

예전 이름(`--ink2` `--sub` `--faint` `--line2` `--side` `--fill` `--duri` `--warn` …)은 앱 화면을 새 부품으로 옮기는 동안만 남겨 둬요. 새 코드에는 쓰지 않아요.

## 부품

| 부품         | 클래스                                                                                                                                  | 쓰는 곳                                           |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| 두리 캐릭터  | `.doori` + `.thinking` `.working` `.asking` `.done` `.sleeping` (크기 `--s`, `.bob`)                                                    | 상태 머리, 말한 사람, 빈 화면, 승인               |
| 워드마크     | `.wordmark` (`dool<sup>2</sup> <small>두리</small>`)                                                                                    | PC 메뉴 위, 견본                                  |
| 상태         | `.dot` (`.work` `.ask` `.done` `.stop`, `.pulse`), `.spin`, `.shimmer`, `.pill` (`.ask` `.work`), `.count`                              | 연결·진행·승인 대기                               |
| 버튼         | `.btn` `.btn-ghost` `.btn-text` `.btn-danger` (`.sm` `.lg`), `.btn-link`, `.icon-btn` (`.lg`), `.send`                                  |                                                   |
| 고르기       | `.chip` (`.on` `.quiet`) `.chips`, `.seg`, `.switch`, `.field`                                                                          | 빠른 답·예시 부탁, AI 고르기, 켜고 끄기, 입력     |
| 글자         | `.display` `.title` `.title-2` `.over` `.cap` `.meta` `.mono` `.rich`                                                                   |                                                   |
| 대화         | `.who`, `.bubble` (`.me`), `.react`, `.sep`, `.done-row`, `.msg.note`, `.composer` + `.cbtn` (`.go`)                                    | 대화 하나, 입력창                                 |
| 일           | `.livebar` (`.ask`), `.workcard` (`-head` `-foot`), `.screen` + `.urlbar`, `.stepbar`, `.log` + `.log-row` (`.live` `.ask`), `.worklog` | 지금 하는 일, 두리의 화면, 단계 기록              |
| 승인         | `.approve` (`-top` `-q` `-amount` `-body` `-actions` `-note`), `.btn-approve`, `.kv` (`dd.money` `dd.host`)                             | 결제·전송 승인                                    |
| 목록·카드    | `.list` (`.boxed`), `.row` (`.row-t` `.row-d`), `.tile`, `.card` (`.quiet` `.ask`), `.task` (`.live`)                                   | 설정, 맡긴 일, 기록                               |
| 틀           | `.navi`, `.tabs` + `.tab` (`.tab-label`, `.badge`), `.sheet` (`.float`), `.drawer`, `.scrim`, `.toast`, `.rise`                         | PC 메뉴, 떠 있는 모바일 탭, 바텀시트, 메뉴 서랍   |
| 떠 있는 머리 | `.fbtn`, `.fpill`, `.agent` + `.agent-av` + `.agent-tag` (`span.ask`), `.composer.float`, `.quick`, `.typing`                           | 메뉴·두리·내 PC, 떠 있는 입력칸, 빠른 답, 대답 중 |
| 실시간 화면  | `.livecard` + `.screen` + `.urlbar` + `.live-badge`                                                                                     | 대화 안에서 두리가 PC Chrome에서 하는 일          |
| 아이콘 칸 색 | `.tile.blue` `.mint` `.amber` `.rose` `.violet`                                                                                         | 아이디어, 활동 기록                               |

자세한 모양은 [preview.html](preview.html)을 열어 보세요.

## 새 화면을 만들 때

1. [docs/design/screens](../../docs/design/screens/README.md)에 같은 화면이 있는지 보고, 값은 원본 HTML에서 읽어요.
2. 부품이 이미 있는지 [preview.html](preview.html)에서 찾아요.
3. 앱의 `style.css`에는 배치(그리드·여백·위치)만 넣어요. 색·모서리·그림자는 토큰을 써요.
4. 새 모양이 필요하면 먼저 `docs/design`에 넣고, `ui.css`로 올린 뒤 `preview.html`에도 견본을 추가해요.
5. 다크·라이트 둘 다 캡처해서 시안과 나란히 보고, 원칙에 어긋나는 게 없는지 봐요.
