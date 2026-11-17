# 두리 서비스

두리가 한국 서비스(식당 예약, 택배 조회, 장보기, 기차 예매 …)에서 **막히지 않고 끝까지** 일하게 하는 곳이에요.

- 라이선스: **CC BY-SA 4.0** ([LICENSE](LICENSE), [ADR 0008](../docs/decisions/0008-skills-cc-by-sa.md)). 레포의 코드(Apache-2.0)와 달라요.
- 서비스 하나 = `skills/<서비스-id>/` 폴더 하나예요. [`_template/`](_template/)를 복사해서 시작하세요.

| 파일 | 무엇 | 필수 |
| --- | --- | --- |
| `connect.json` | **연결 카드.** 연결 화면(목록·상세)에 보일 이름·도메인·분류·소개·대화 예시·할 수 있는 일 ([ADR 0014](../docs/decisions/0014-connect-cards.md)) | 예 |
| `tools.json` | **서비스 도구(커넥터).** 그 서비스에서 할 수 있는 일을 타입 있는 도구로 적은 것. AI는 `catchtable_search`처럼 이 도구를 바로 불러요 ([ADR 0018](../docs/decisions/0018-service-connectors.md)) | 실제로 돌려 본 뒤 |

커넥터를 만들고 고치는 순서는 레포의 스킬 [`.claude/skills/connector`](../.claude/skills/connector/SKILL.md)에 있어요. 코딩 에이전트(Claude Code·Codex)에게 "○○ 커넥터 만들어 줘"라고 하면 그 순서를 따라요.

## connect.json

| 칸 | 내용 |
| --- | --- |
| `id` | 폴더 이름과 같게. 영어 소문자·숫자·`-` |
| `name` | 화면에 보일 이름 |
| `site` | 도메인만, `https://` 없이 (예: `coupang.com`). 폰 권한(`device`)이면 생략 |
| `category` | `shopping` 쇼핑 · `grocery` 장보기·배달 · `fashion` 패션·뷰티 · `travel` 여행·숙소 · `flight` 항공 · `tickets` 예매·예약 · `media` 영상·음악 · `books` 책 · `social` SNS · `work` 업무 · `mail` 메일·일정 · `telecom` 통신 · `life` 생활 · `device` 휴대폰 |
| `how` | `browser` 사용자 Chrome에서 한 번 로그인 · `official` 공식 연동(준비 전엔 browser처럼) · `open` 로그인 없이 · `device` 폰 권한 |
| `login` | 연결할 때 하는 로그인 (예: `아이디·비밀번호`, `카카오·네이버 간편 로그인`). `browser`면 필수 |
| `summary` | 상세 화면 첫 문단, 한두 문장 |
| `example` | 대화 예시 하나: `ask` 사용자 부탁, `working` 일하는 동안 보이는 말, `reply` 두리의 답 |
| `abilities` | 할 수 있는 일 2~6개: `title` 짧은 이름, `say` 사용자가 할 법한 말(따옴표 없이), `tier` 권한 등급 |
| `signedIn` | (선택) 로그인한 사람에게만 보이는 말 1~5개. 연결할 때 이 말이 보이면 로그인을 마친 걸로 봐요 |
| `hints` | (선택) 커넥터가 아직 없을 때 브라우저로 일하는 짧은 요령 1~3줄 (검색 주소 등). 커넥터가 생기면 지워요 |

- "결제는 승인받고 해요" 같은 안내는 적지 않아요. `tier`가 `돈 내기`·`연락하기`인 일이 있으면 화면이 알아서 붙여요.
- 로고 파일은 넣지 않아요. 문구는 [두리 페르소나](../docs/persona.md) 말투로, 다른 회사 제품 이름은 넣지 않아요.

## tools.json (서비스 도구)

도구 하나에 이것을 적어요. AI가 보는 것은 이름·설명·입력 칸·결과뿐이고, 사이트를 어떻게 돌아다니는지는 `steps`가 알아요.

| 칸 | 내용 |
| --- | --- |
| `name` `title` | 서비스 안의 이름(`search`)과 짧은 제목. 실제 도구 이름은 `<서비스>_<이름>` (`catchtable_search`) |
| `description` | **언제 쓰는지, 무엇을 돌려주는지, 다음에 무엇을 하면 되는지.** 사이트 요령도 여기와 입력 칸 설명에 |
| `tier` | 찾아보기 · 채워 두기 · 돈 내기 · 연락하기 |
| `login` | 로그인(연결)해야 쓸 수 있으면 `true`. 연결 전이면 두리가 실행 대신 연결 안내를 돌려줘요 |
| `status` | `초안` / `검증됨(YYYY-MM-DD, 무엇까지)` / `막힘(사유)` |
| `input` | 입력 칸 (`string` `integer` `number` `boolean`, `format: date·time`, `enum`, `pattern`, 범위, 기본값). `required`가 곧 "사용자에게 먼저 물을 것" |
| `output` | 돌려주는 모양 (목록은 `list` + `fields`) |
| `examples` | 입력 예시 1~3개. AI 안내에 붙고 실제 사이트 시험(카나리)의 입력이 돼요 |
| `steps` | 실행 순서 (아래 동작만) |
| `result` | 출력 칸 → 채우기 (`"{{shops}}"`처럼 하나면 값을 그대로) |
| `next` | 결과 끝에 붙는 다음 할 일 안내 |
| `minIntervalSec` | 같은 입력으로 다시 부를 수 있는 간격(초). 사이트에 자주 묻지 않게 |

### 동작 (steps)

| 동작 | 하는 일 |
| --- | --- |
| `open` | 주소 열기. 그 서비스 `site`의 https 주소만 |
| `wait` | 글(`text`)·목록(`items`)이 나올 때까지, 또는 글이 사라질 때까지(`gone`) |
| `require` + `say` | 그 글이 끝내 안 나오면 이유를 말하고 멈춤 ("그 시간은 마감이에요") |
| `stop_if` + `say` | 그 글이 보이면 멈춤. `login: true`면 연결 안내로 |
| `find` | 화면 글에서 정규식으로 찾기 |
| `click` | 화면 글자로 누르기. **두리 승인 게이트를 그대로 거쳐요** (찾아보기 도구는 '구매' 같은 버튼에서 멈춰요) |
| `type` | 입력칸(이름·안내 글 정규식)에 쓰기 |
| `press` `sleep` | 키 누르기, 잠깐 기다리기 |
| `extract` | 화면 목록 뽑기: 줄 선택자 + 칸마다 `css`·`attr`·`line`·`match`·`list` |
| `fetch` | 그 사이트 안에서 데이터 요청(JSON). `pick`으로 필요한 부분만. 결제·주문·보내기 주소는 못 불러요 |
| `map` | 목록 모양 바꾸기 (경로, `*`로 모으기, `{{…}}` 채우기) |
| `approve` | 돈 내기·연락하기 도구의 마지막: 그 버튼을 누를지 **사용자 승인**을 받아요 |
| `handoff_to_agent` | 정해진 순서로 하기 어려운 곳: 여기까지 데려온 탭을 AI에게 넘기며 할 일을 알려요 |

채우기: `{{keyword}}`, 거르개 `|url` `|digits` `|json` `|re` `|yymmdd`(261127) `|mmdd`(11.27) `|dow`(금) `|kday`(오늘·내일·11.27) `|ampm`(오후 7:30). 늘 있는 이름 `today`.

## 안전 규칙 (테스트로 검사해요)

- 첫 단계는 `open`, 주소와 데이터 요청은 그 서비스 사이트 안에서만.
- `approve`는 돈 내기·연락하기 도구의 마지막에만. 그런 도구는 `approve`나 `handoff_to_agent`로 끝나야 해요.
- 결제·주문·보내기·삭제를 데이터 요청(`fetch`)으로 하지 않아요. 화면 버튼 + 승인으로만.
- 캡차·보안문자·본인인증을 풀라는 지시, 비밀번호·카드 번호·인증번호를 넣으라는 지시는 넣을 수 없어요.
- 커넥터는 승인 게이트를 끌 수 없어요. 무엇이 적혀 있든 두리 본체가 막아요.

## 시험

```bash
pnpm build
export DOOL2_TEST_CHROME=".../Google Chrome for Testing"   # npx @puppeteer/browsers install chrome@stable
pnpm connector check catchtable                            # 형식·안전 규칙
pnpm connector page "https://…" "li.item"                  # 화면 글 / 목록 선택자 시험
pnpm connector try catchtable search '{"keyword":"성수","date":"2026-11-27","people":4}'
pnpm connector canary                                      # 찾아보기 도구를 예시 입력으로 모두
```

## 상태

| 서비스 | 도구 | 상태 |
| --- | --- | --- |
| [catchtable](catchtable/tools.json) | `catchtable_search` 식당 빈자리 찾기 · `catchtable_prepare_booking` 예약 준비 | 검증됨(2026-11-17, 예약금 결제 방법 화면까지) |
| [cj-logistics](cj-logistics/tools.json) | `cj_logistics_track` 택배 조회 | 검증됨(2026-11-17, 등록 전 번호 안내까지) |

연결 카드(`connect.json`)는 쇼핑·장보기·여행·항공·예매·통신사 등 80여 개 서비스에 있어요. 커넥터가 없는 서비스는 두리가 범용 브라우저 도구로 일해요. 커넥터를 만들어 `검증됨`으로 올리는 일이 좋은 첫 기여예요.
