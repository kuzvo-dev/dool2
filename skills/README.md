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
| `alsoSites` | (선택) 같은 서비스가 쓰는 다른 도메인 (예: Gmail 화면은 `mail.google.com`). 서비스 도구가 열 수 있어요 |
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
| `expect` | 건강 기준 (ADR 0020): `rows` 매일 점검에서 적어도 몇 줄, `filled` 결과 줄의 80% 넘게 채워져야 하는 칸. 못 미치면 "조용한 고장"으로 봐요 |
| `minIntervalSec` | 같은 입력으로 다시 부를 수 있는 간격(초). 사이트에 자주 묻지 않게 |
| `cards` | (선택) `false`면 카드로 보여 줄 후보 목록이 아님 (극장 목록·상영 시간·가사·택배 단계 등). 쇼핑·장보기·패션·여행·예매·영상·책 분야의 찾아보기 목록은 **사진(`image`)·링크(`link`) 칸이 있어야** 검사를 통과해요 |

### 동작 (steps)

| 동작 | 하는 일 |
| --- | --- |
| `open` | 주소 열기. 그 서비스 `site`의 https 주소만 |
| `wait` | 글(`text`)·목록(`items`)이 나올 때까지, 또는 글이 사라질 때까지(`gone`) |
| `require` + `say` | 그 글이 끝내 안 나오면 이유를 말하고 멈춤 ("그 시간은 마감이에요") |
| `stop_if` + `say` | 그 글이 보이면 멈춤. `login: true`면 연결 안내로. 한 번만 보니, 화면이 넘어가길 기다릴 땐 앞에 `wait`(예: `"로그인|주문 내역"`). 사이트가 이 브라우저를 막은 화면(Access Denied·비정상 접근 차단)이면 `blocked: true` — 점검에서 고장이 아니라 '사이트가 막음'으로 따로 센다. 막은 화면이 로봇 확인(보안 확인·캡차)이면 본체가 탭을 열어 두고 AI에게 폰 카드(`browser_request_code` captcha·`browser_request_tap`)로 풀고 같은 도구를 다시 부르라고 알려요(다른 단계에서 로봇 확인이 떠도 같아요) |
| `find` | 화면 글에서 정규식으로 찾기 |
| `click` | 화면 글자로 누르기. **두리 승인 게이트를 그대로 거쳐요** (찾아보기 도구는 '구매' 같은 버튼에서 멈춰요) |
| `type` | 입력칸(이름·안내 글 정규식)에 쓰기 |
| `press` `sleep` | 키 누르기, 잠깐 기다리기 |
| `extract` | 화면 목록 뽑기: 줄 선택자 + 칸마다 `css`·`attr`·`line`·`match`·`list`. **사진 칸은 `{"image": true}`** — 줄에서 가장 그럴듯한 사진 하나(늦게 그리는 사진·`data-src`·`srcset`·배경 그림까지, 아이콘·로고·작은 그림은 빼고, http는 https로). 사진이 비면 엔진이 목록을 한 번 훑어 내려 다시 읽는다 |
| `capture` | **그 화면이 스스로 받은 응답(JSON)** 읽기. 두리는 요청을 보내지 않아요: 주소가 `url`(정규식)에 맞는 응답을 듣고 `pick`으로 필요한 부분만 꺼내요. `append: true`면 앞에서 같은 이름(`as`)으로 모은 목록 뒤에 붙여요 |
| `embedded` | 화면에 박혀 있는 데이터(JSON) 읽기 (`script#__NEXT_DATA__` 등, 서버가 결과를 화면과 함께 보내는 사이트). `append: true`면 앞 목록 뒤에 붙여요 (여러 기간·여러 쪽을 한 목록으로) |
| `map` | 목록 모양 바꾸기 (경로, `*`로 모으기, `{{…}}` 채우기 — 줄 안 값이 먼저, 없으면 입력값). 여러 묶음으로 나뉜 목록(`groups.*.items`)은 한 줄로 펼쳐요. 줄 안 목록에서 조건에 맞는 것만 세려면 `chargers[powerType=급속|초급속][status=충전가능].length` (`|`는 그중 하나) |
| `filter` | 목록 거르기: `where`(줄 안 경로) `op`(eq·ne·lt·lte·gt·gte·contains·has·not) `value`. **value가 비면(입력을 안 줬으면) 거르지 않아요** — "3만 원 이하"처럼 선택 입력에 써요 |
| `approve` | 돈 내기·연락하기 도구의 마지막: 그 버튼을 누를지 **사용자 승인**을 받아요 |
| `handoff_to_agent` | 정해진 순서로 하기 어려운 곳: 여기까지 데려온 탭을 AI에게 넘기며 할 일을 알려요 |

채우기: `{{keyword}}`, 값이 있을 때만 `{{#max_price}}&toPrice={{max_price}}{{/max_price}}`, 없을 때만 `{{^id}}…{{/id}}`(묶음 안에 다른 이름의 묶음을 넣을 수 있어요), 거르개 `|url` `|digits` `|json` `|re` `|yymmdd`(261127) `|yyyy` `|mm`·`|m`(03·3) `|dd`·`|d`(07·7) `|ms`(그날 한국 0시 밀리초) `|mmdd`(11.27) `|dow`(금) `|kday`(오늘·내일·11.27) `|ampm`(오후 7:30) `|dec`(수에서 1 빼기: `{{today|yyyy|dec}}` = 지난해). 늘 있는 이름 `today`.

모든 동작에 `if`를 붙일 수 있어요: 채운 글이 비면 그 단계를 건너뛰어요. 예: `"if": "{{#item}}{{^found.0}}1{{/found.0}}{{/item}}"` = 검색어가 있고 앞에서 아무것도 못 찾았을 때만 (쿠팡 주문 찾기가 최근 6개월 → 올해 → 지난해 … 차례로 찾다가 찾은 해에서 멈춰요).

## 안전 규칙 (테스트로 검사해요)

- 첫 단계는 `open`, 주소는 그 서비스 사이트 안에서만.
- **사이트 API를 직접 부르지 않아요.** 사람처럼 주소를 열고 화면을 읽어요. 화면이 받은 응답을 읽는 `capture`는 되지만 두리가 따로 요청을 만들어 보내지는 않아요.
- `approve`는 돈 내기·연락하기 도구의 마지막에만. 그런 도구는 `approve`나 `handoff_to_agent`로 끝나야 해요.
- 결제·주문·보내기·삭제는 화면 버튼 + 승인으로만 해요.
- 캡차·보안문자·본인인증을 풀라는 지시, 비밀번호·카드 번호·인증번호를 넣으라는 지시는 넣을 수 없어요.
- 커넥터는 승인 게이트를 끌 수 없어요. 무엇이 적혀 있든 두리 본체가 막아요.

## 시험

```bash
pnpm build
export DOOL2_TEST_CHROME=".../Google Chrome for Testing"   # npx @puppeteer/browsers install chrome@stable
pnpm connector check catchtable                            # 형식·안전 규칙
pnpm connector page "https://…" "li.item"                  # 화면 글 / 목록 선택자 시험
pnpm connector try catchtable search '{"keyword":"성수","date":"2026-11-27","people":4}'
pnpm connector canary [--json 결과.json] [--report 보고서.html] [--issues]   # 찾아보기 도구를 예시 입력으로 모두 (조용한 고장까지)
```

## 상태

서비스 92곳, 도구 326개 중 **실제 사이트에서 확인한 도구 107개**예요. 로그인 없이 되는 찾아보기 도구는 111개이고 그중 101개가 검증됐어요(매일 밤 점검 대상). 나머지(로그인·돈 내기·연락하기)는 정확한 화면까지 데려가 AI에게 넘기는 `초안`이에요. 실제 계정으로 돌려 보고 `검증됨`으로 올리는 일이 좋은 기여예요.

| 분류 | 서비스 | 도구 | 검증된 도구 |
| --- | --- | --- | --- |
| 쇼핑 | [11번가](11st/tools.json) | 4 | `search` |
| 쇼핑 | [G마켓](gmarket/tools.json) | 4 | — |
| 쇼핑 | [다이소몰](daiso-mall/tools.json) | 4 | `search` |
| 쇼핑 | [당근](daangn/tools.json) | 1 | `search` |
| 쇼핑 | [롯데ON](lotteon/tools.json) | 4 | `search` |
| 쇼핑 | [번개장터](bunjang/tools.json) | 1 | `search` |
| 쇼핑 | [신라면세점](shilla-dfs/tools.json) | 3 | `search` |
| 쇼핑 | [신세계면세점](shinsegae-dfs/tools.json) | 3 | `search` |
| 쇼핑 | [오늘의집](ohouse/tools.json) | 4 | `search` |
| 쇼핑 | [중고나라](joongna/tools.json) | 4 | `search` |
| 쇼핑 | [코스트코](costco/tools.json) | 4 | `search` |
| 쇼핑 | [쿠팡](coupang/tools.json) | 4 | — |
| 쇼핑 | [크림(KREAM)](kream/tools.json) | 5 | `search`, `price` |
| 장보기·배달 | [CJ더마켓](cj-the-market/tools.json) | 4 | `search`, `deals` |
| 장보기·배달 | [SSG닷컴](ssg/tools.json) | 3 | — |
| 장보기·배달 | [오아시스마켓](oasis-market/tools.json) | 4 | `search` |
| 장보기·배달 | [컬리](kurly/tools.json) | 3 | `search` |
| 패션·뷰티 | [29CM](29cm/tools.json) | 4 | `search` |
| 패션·뷰티 | [W컨셉](wconcept/tools.json) | 3 | `search` |
| 패션·뷰티 | [무신사](musinsa/tools.json) | 4 | `search`, `product` |
| 패션·뷰티 | [에이블리](ably/tools.json) | 4 | `search` |
| 패션·뷰티 | [올리브영](oliveyoung/tools.json) | 4 | `search`, `ranking` |
| 패션·뷰티 | [유니클로](uniqlo/tools.json) | 5 | `search`, `stock` |
| 패션·뷰티 | [지그재그](zigzag/tools.json) | 3 | `search` |
| 여행·숙소 | [Airbnb](airbnb/tools.json) | 4 | `search` |
| 여행·숙소 | [Booking.com](booking/tools.json) | 3 | `search` |
| 여행·숙소 | [Uber](uber/tools.json) | 3 | — |
| 여행·숙소 | [마이리얼트립](myrealtrip/tools.json) | 3 | `search` |
| 여행·숙소 | [숲나들e](foresttrip/tools.json) | 4 | — |
| 여행·숙소 | [쏘카](socar/tools.json) | 2 | `search` |
| 여행·숙소 | [아고다](agoda/tools.json) | 3 | `search` |
| 여행·숙소 | [야놀자(NOL)](yanolja/tools.json) | 5 | `search` |
| 여행·숙소 | [여기어때](yeogi/tools.json) | 4 | `search`, `rooms` |
| 여행·숙소 | [캠핏](camfit/tools.json) | 3 | `search` |
| 여행·숙소 | [코레일](korail/tools.json) | 1 | `trains` |
| 여행·숙소 | [클룩](klook/tools.json) | 3 | `search` |
| 여행·숙소 | [트립닷컴](trip-com/tools.json) | 3 | `hotel_search` |
| 여행·숙소 | [호텔스닷컴](hotels-com/tools.json) | 3 | `search` |
| 항공 | [대한항공](korean-air/tools.json) | 4 | — |
| 항공 | [아시아나항공](asiana/tools.json) | 4 | — |
| 항공 | [에어부산](air-busan/tools.json) | 4 | `search` |
| 항공 | [이스타항공](eastar-jet/tools.json) | 3 | — |
| 항공 | [제주항공](jeju-air/tools.json) | 4 | `search` |
| 항공 | [진에어](jin-air/tools.json) | 3 | — |
| 예매·예약 | [CGV](cgv/tools.json) | 5 | `theaters`, `movies`, `showtimes` |
| 예매·예약 | [국립현대미술관](mmca/tools.json) | 3 | `exhibitions` |
| 예매·예약 | [롯데시네마](lotte-cinema/tools.json) | 4 | `showtimes`, `movies` |
| 예매·예약 | [메가박스](megabox/tools.json) | 5 | `theaters`, `movies`, `showtimes` |
| 예매·예약 | [서울시 공공서비스예약](seoul-yeyak/tools.json) | 3 | `search` |
| 예매·예약 | [캐치테이블](catchtable/tools.json) | 2 | `search`, `prepare_booking` |
| 예매·예약 | [티켓링크](ticketlink/tools.json) | 4 | `search`, `details` |
| 영상·음악 | [넷플릭스](netflix/tools.json) | 6 | `browse`, `top10`, `title` |
| 영상·음악 | [멜론](melon/tools.json) | 5 | `chart`, `search`, `lyrics` |
| 영상·음악 | [왓챠](watcha/tools.json) | 6 | `search`, `tag`, `content` |
| 영상·음악 | [티빙](tving/tools.json) | 6 | `search`, `browse`, `content` |
| 책 | [yes24](yes24/tools.json) | 4 | `search` |
| 책 | [교보문고](kyobo/tools.json) | 4 | `search`, `store_stock` |
| 책 | [리디](ridi/tools.json) | 3 | `search` |
| 책 | [밀리의서재](millie/tools.json) | 5 | `best`, `book` |
| 책 | [알라딘](aladin/tools.json) | 4 | `search`, `used` |
| SNS | [X(트위터)](x/tools.json) | 3 | — |
| SNS | [스레드](threads/tools.json) | 4 | — |
| SNS | [인스타그램](instagram/tools.json) | 4 | — |
| SNS | [핀터레스트](pinterest/tools.json) | 3 | — |
| 업무 | [GitHub](github/tools.json) | 4 | `commits` |
| 업무 | [링크드인](linkedin/tools.json) | 6 | `search_jobs`, `job` |
| 업무 | [마이크로소프트 365](microsoft-365/tools.json) | 4 | — |
| 업무 | [사람인](saramin/tools.json) | 5 | `search`, `job` |
| 업무 | [슬랙](slack/tools.json) | 3 | — |
| 메일·일정 | [구글 캘린더](google-calendar/tools.json) | 4 | — |
| 메일·일정 | [네이버 메일](naver-mail/tools.json) | 3 | — |
| 메일·일정 | [지메일](gmail/tools.json) | 3 | — |
| 통신 | [KT](kt/tools.json) | 5 | `plans` |
| 통신 | [KT M모바일](kt-mmobile/tools.json) | 5 | `plans` |
| 통신 | [LG유플러스](lguplus/tools.json) | 5 | `plans` |
| 통신 | [SKT T월드](skt/tools.json) | 5 | `plans` |
| 생활 | [CJ대한통운](cj-logistics/tools.json) | 1 | `track` |
| 생활 | [네이버](naver/tools.json) | 4 | `news`, `shopping`, `orders`, `bookings` |
| 생활 | [동행복권](dhlottery/tools.json) | 4 | `results` |
| 생활 | [레뷰](revu/tools.json) | 4 | `trending` |
| 생활 | [숨고](soomgo/tools.json) | 4 | `search_pros` |
| 생활 | [에브리타임](everytime/tools.json) | 4 | — |
| 생활 | [정부24](gov24/tools.json) | 1 | `resident_record` |
| 생활 | [키즈노트](kidsnote/tools.json) | 4 | — |
| 생활 | [패널나우](panelnow/tools.json) | 3 | `surveys` |

폰 권한 서비스(연락처·위치·폰 캘린더)는 브라우저가 아니라 폰 앱에서 다뤄서 서비스 도구가 없어요.

## 고장 감시 (ADR 0020)

- **실사용**: 두리가 도구를 쓸 때마다 결과를 기록해요. 하루 안에 3번 잇달아 막히거나 칸이 비면 그 도구는 6시간 쉬고, 그동안 두리는 브라우저로 일해요.
- **매일 밤**: 메인테이너 PC에서 `scripts/connector-nightly.sh`가 모든 찾아보기 도구를 실제 사이트에서 돌려요. 깨진 도구는 GitHub 이슈(`connector-broken`)로 올리고, 몇 개는 코딩 에이전트가 수리 PR 초안을 만들어요. 설치: `scripts/install-nightly-mac.sh`.

## 사진 카드 (show_cards)

고를 후보(상품·숙소·식당·영화·책 등)는 두리가 답 아래에 사진 카드로 붙여요. 그래서 이런 목록 도구에는 **`image`·`link` 칸**을 꼭 넣어요.

- 화면 목록(`extract`)이면 `"image": {"image": true}` 한 줄이면 돼요. 엔진이 그 줄에서 가장 그럴듯한 사진을 골라요(늦게 그리는 사진·`srcset`·배경 그림, 아이콘·로고 제외, https로). 사진이 비면 목록을 한 번 훑어 내려 다시 읽어요.
- 데이터(`capture`·`embedded`)면 `map`에 그 데이터의 사진 경로를 적어요 (예: `"image": "thumbnail"`). 경로가 `/`로 시작하는 상대 주소면 `"{{#p}}https://사이트{{p}}{{/p}}"`처럼 사이트 주소를 붙여요. 칸 묶음 안이면 `*`를 써요 (`images.main.*.image`, 여러 장이면 첫 장).
- 링크가 화면에 없으면 id로 주소를 만들어요 (`"link": "https://…/detail?id={{movie_id}}"`). 만든 주소가 실제로 열리는지 확인해요.
- 사진이 큰 것은 걱정하지 않아도 돼요. PC가 받아 긴 쪽 360px로 줄여 폰에 보내요.
- 확인은 `pnpm connector canary <id> --pc` — 줄 수와 함께 사진·링크 수가 나와요.

