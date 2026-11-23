# Dool2 services

This is where Dool2 learns to work **without getting blocked, all the way to the end** on Korean services (restaurant reservations, parcel tracking, grocery shopping, train tickets …).

- License: **CC BY-SA 4.0** ([LICENSE](LICENSE), [ADR 0008](../docs/decisions/0008-skills-cc-by-sa.md)). This differs from the repository's code (Apache-2.0).
- One service = one `skills/<service-id>/` folder. Start by copying [`_template/`](_template/).

| File | What | Required |
| --- | --- | --- |
| `connect.json` | **The connect card.** The name, domain, category, intro, conversation example, and abilities shown on the connect screens (list and detail) ([ADR 0014](../docs/decisions/0014-connect-cards.md)) | Yes |
| `tools.json` | **Service tools (connector).** What can be done on that service, written as typed tools. The AI calls these tools directly, like `catchtable_search` ([ADR 0018](../docs/decisions/0018-service-connectors.md)) | After actually running it |

The steps for creating and fixing connectors are in the repository skill [`.claude/skills/connector`](../.claude/skills/connector/SKILL.md). If you tell a coding agent (Claude Code, Codex) "make a connector for X", it follows those steps.

Note: the JSON examples and Korean strings in this guide are service text and keep their Korean values, with an English gloss. The `tier` values will become the English keys `lookup` | `fill` | `pay` | `contact` (ADR 0029); this guide uses those keys in prose.

## connect.json

| Field | Contents |
| --- | --- |
| `id` | Same as the folder name. Lowercase English letters, digits, and `-` |
| `name` | The name shown on screen |
| `alsoSites` | (Optional) Other domains the same service uses (for example, Gmail's screen is `mail.google.com`). Service tools can open them |
| `site` | Domain only, without `https://` (for example `coupang.com`). Omit for phone permissions (`device`) |
| `category` | `shopping` shopping · `grocery` groceries and delivery · `fashion` fashion and beauty · `travel` travel and lodging · `flight` flights · `tickets` tickets and reservations · `media` video and music · `books` books · `social` social media · `work` work · `mail` mail and calendar · `telecom` telecom · `life` daily life · `device` phone |
| `how` | `browser` log in once in the user's Chrome · `official` official integration (works like browser until it is ready) · `open` no login · `device` phone permission |
| `login` | The login done when connecting (for example `아이디·비밀번호` "ID and password", `카카오·네이버 간편 로그인` "Kakao or Naver easy login"). Required when `how` is `browser` |
| `summary` | The first paragraph of the detail screen, one or two sentences |
| `example` | One conversation example: `ask` the user's request, `working` the words shown while working, `reply` Dool2's answer |
| `abilities` | 2 to 6 things it can do: `title` a short name, `say` something the user might say (without quotes), `tier` the permission tier |
| `signedIn` | (Optional) 1 to 5 phrases visible only to logged-in people. If these phrases are visible while connecting, it counts as login finished |
| `hints` | (Optional) 1 to 3 short lines of tips for working in the browser while no connector exists yet (search addresses and so on). Remove them once a connector exists |
| `regions` | Where the service is for: `KR`, `JP`, `TW`, or `global` for services that work anywhere with the same account. Omitted = `KR`. The connect screen lists the user's region and `global` first, and the rest under "Other regions" ([ADR 0029](../docs/decisions/0029-language-and-region.md)) |
| `i18n.en` | English for the people-facing fields: `name` (official brand spelling), `login`, `summary`, `example`, and `abilities` (`title`, `say` only, same number and order as `abilities`). Write the Korean card first; maintainers can fill the English if you only write Korean |

- Do not write notices like "payment is made after approval". If there is a task whose `tier` is `pay` or `contact`, the screen adds it automatically.
- Do not include logo files. Write the wording in the [Dool2 persona](../docs/persona.md) voice, and do not include other companies' product names.

## tools.json (service tools)

Write this for each tool. The AI sees only the name, description, input fields, and result; how to move around the site is known by `steps`.

| Field | Contents |
| --- | --- |
| `name` `title` | The name inside the service (`search`) and a short title. The real tool name is `<service>_<name>` (`catchtable_search`) |
| `description` | **When to use it, what it returns, and what to do next.** Put site tips here and in the input field descriptions too |
| `tier` | `lookup` · `fill` · `pay` · `contact` |
| `login` | `true` if it can be used only after logging in (connecting). If not yet connected, Dool2 returns connection guidance instead of running |
| `status` | `초안` (draft) / `검증됨(YYYY-MM-DD, up to what)` (verified) / `막힘(reason)` (blocked) |
| `input` | Input fields (`string` `integer` `number` `boolean`, `format: date·time`, `enum`, `pattern`, ranges, defaults). `required` means "what to ask the user first" |
| `output` | The returned shape (lists use `list` + `fields`) |
| `examples` | 1 to 3 input examples. They are attached to the AI guidance and become the inputs of the live-site test (canary) |
| `steps` | The execution order (only the actions below) |
| `result` | Output fields → fill (if there is just one, like `"{{shops}}"`, the value is used as is) |
| `next` | Guidance on what to do next, appended to the end of the result |
| `expect` | Health standard (ADR 0020): `rows` at least how many rows in the daily check, `filled` fields that must be filled in more than 80% of result rows. Falling short is treated as a "silent failure" |
| `minIntervalSec` | The interval (seconds) before the same input can be called again. So the site is not asked too often |
| `cards` | (Optional) `false` means it is not a candidate list to show as cards (theater lists, showtimes, lyrics, parcel stages, and so on). `lookup` lists in shopping, groceries, fashion, travel, ticketing, video, and books **must have photo (`image`) and link (`link`) fields** to pass the check |

### Actions (steps)

| Action | What it does |
| --- | --- |
| `open` | Open an address. Only https addresses of that service's `site` |
| `wait` | Until text (`text`) or a list (`items`) appears, or until text disappears (`gone`) |
| `require` + `say` | If that text never appears, say the reason and stop ("그 시간은 마감이에요" "That time is full") |
| `stop_if` + `say` | Stop if that text is visible. With `login: true`, it goes to connection guidance. It looks only once, so when waiting for the screen to move on, put a `wait` before it (for example `"로그인|주문 내역"` "login|order history"). If it is a screen where the site blocked this browser (Access Denied, abnormal access block), use `blocked: true` — the check counts it separately as "site blocked", not as breakage. If the blocking screen is a robot check (security check, CAPTCHA), the daemon keeps the tab open and tells the AI to solve it with a phone card (`browser_request_code` captcha, `browser_request_tap`) and call the same tool again (the same applies if a robot check appears at another step) |
| `find` | Find in the screen text with a regular expression |
| `click` | Click by the screen text. **It goes through the Dool2 approval gate as is** (a `lookup` tool stops at buttons like "구매" "Buy") |
| `type` | Write into an input field (name or a regular expression of the guidance text) |
| `press` `sleep` | Press a key, wait a moment |
| `extract` | Extract a list from the screen: a row selector + for each field `css`, `attr`, `line`, `match`, `list`. **A photo field is `{"image": true}`** — the single most plausible photo in the row (including late-drawn photos, `data-src`, `srcset`, and background images; excluding icons, logos, and small images; http becomes https). If the photo is empty, the engine scrolls through the list once and reads again |
| `capture` | Read **the response (JSON) the page itself received**. Dool2 sends no requests: it listens for a response whose address matches `url` (regular expression) and takes out only the needed part with `pick`. With `append: true`, it attaches after the list gathered earlier under the same name (`as`) |
| `embedded` | Read data embedded in the page (JSON) (`script#__NEXT_DATA__` and so on, for sites where the server sends the result together with the page). With `append: true`, it attaches after the earlier list (several periods or pages into one list) |
| `map` | Reshape a list (paths, gathering with `*`, `{{…}}` filling — values inside the row first, then input values). Lists split into several groups (`groups.*.items`) are flattened into one row. To count only items that match conditions in a list inside a row, use `chargers[powerType=급속\|초급속][status=충전가능].length` (`\|` means one of them; here 급속\|초급속 "fast\|ultra-fast" and 충전가능 "available to charge" are service text values) |
| `filter` | Filter a list: `where` (path inside the row) `op` (eq, ne, lt, lte, gt, gte, contains, has, not) `value`. **If value is empty (the input was not given), it does not filter** — use it for optional inputs like "under 30,000 won" |
| `approve` | The last step of `pay` and `contact` tools: get **user approval** on whether to press that button |
| `handoff_to_agent` | For places that are hard to do in a fixed order: hand the tab brought this far to the AI and tell it what to do |

Filling: `{{keyword}}`, only when there is a value `{{#max_price}}&toPrice={{max_price}}{{/max_price}}`, only when there is none `{{^id}}…{{/id}}` (a group can contain groups of other names), filters `|url` `|digits` `|json` `|re` `|yymmdd` (261127) `|yyyy` `|mm`·`|m` (03·3) `|dd`·`|d` (07·7) `|ms` (milliseconds of Korean midnight that day) `|mmdd` (11.27) `|dow` (금, Friday) `|kday` (오늘·내일·11.27: today, tomorrow, 11.27) `|ampm` (오후 7:30: 7:30 PM) `|dec` (subtract 1 from a number: `{{today|yyyy|dec}}` = last year). The always-present name is `today`.

Every action can take an `if`: if the filled text is empty, that step is skipped. Example: `"if": "{{#item}}{{^found.0}}1{{/found.0}}{{/item}}"` = only when there is a search term and nothing was found earlier (Coupang order search looks through the last 6 months → this year → last year … and stops at the year where it finds it).

## Safety rules (checked by tests)

- The first step is `open`, and addresses stay within that service's site.
- **Do not call the site's API directly.** Open addresses and read the screen like a person. `capture`, which reads responses the page received, is fine, but Dool2 never builds and sends requests on its own.
- `approve` only at the end of `pay` and `contact` tools. Such tools must end with `approve` or `handoff_to_agent`.
- Payment, ordering, sending, and deleting are done only through screen buttons plus approval.
- You cannot include instructions to solve CAPTCHAs, security text, or identity verification, or to enter passwords, card numbers, or verification codes.
- A connector cannot turn off the approval gate. Whatever is written, the Dool2 daemon blocks it.

## Testing

```bash
pnpm build
export DOOL2_TEST_CHROME=".../Google Chrome for Testing"   # npx @puppeteer/browsers install chrome@stable
pnpm connector check catchtable                            # format and safety rules
pnpm connector page "https://…" "li.item"                  # test the screen text / a list selector
pnpm connector try catchtable search '{"keyword":"성수","date":"2026-11-27","people":4}'   # keyword "Seongsu", 4 people
pnpm connector canary [--json result.json] [--report report.html] [--issues]   # all lookup tools with example inputs (including silent failures)
```

## Status

Of 95 services and 332 tools, **113 tools have been verified on real sites**. There are 117 `lookup` tools that work without login, and 107 of them are verified (they are in the nightly check). The rest (login, `pay`, `contact`) are `초안` (draft): they take the AI to the exact screen and hand over. Running them with real accounts and raising them to `검증됨` (verified) is a good contribution.

| Category | Service | Tools | Verified tools |
| --- | --- | --- | --- |
| Shopping | [11st](11st/tools.json) | 4 | `search` |
| Shopping | [Gmarket](gmarket/tools.json) | 4 | — |
| Shopping | [Daiso Mall](daiso-mall/tools.json) | 4 | `search` |
| Shopping | [Daangn](daangn/tools.json) | 1 | `search` |
| Shopping | [Lotte ON](lotteon/tools.json) | 4 | `search` |
| Shopping | [Bunjang](bunjang/tools.json) | 1 | `search` |
| Shopping | [Shilla Duty Free](shilla-dfs/tools.json) | 3 | `search` |
| Shopping | [Shinsegae Duty Free](shinsegae-dfs/tools.json) | 3 | `search` |
| Shopping | [Ohouse](ohouse/tools.json) | 4 | `search` |
| Shopping | [Joongna](joongna/tools.json) | 4 | `search` |
| Shopping | [Costco](costco/tools.json) | 4 | `search` |
| Shopping | [Coupang](coupang/tools.json) | 4 | — |
| Shopping | [KREAM](kream/tools.json) | 5 | `search`, `price` |
| Groceries and delivery | [CJ The Market](cj-the-market/tools.json) | 4 | `search`, `deals` |
| Groceries and delivery | [SSG.COM](ssg/tools.json) | 3 | — |
| Groceries and delivery | [Oasis Market](oasis-market/tools.json) | 4 | `search` |
| Groceries and delivery | [Kurly](kurly/tools.json) | 3 | `search` |
| Fashion and beauty | [29CM](29cm/tools.json) | 4 | `search` |
| Fashion and beauty | [ABC-Mart](abcmart/tools.json) | 2 | `search`, `store_stock` |
| Fashion and beauty | [W Concept](wconcept/tools.json) | 3 | `search` |
| Fashion and beauty | [Musinsa](musinsa/tools.json) | 4 | `search`, `product` |
| Fashion and beauty | [Ably](ably/tools.json) | 4 | `search` |
| Fashion and beauty | [Olive Young](oliveyoung/tools.json) | 4 | `search`, `ranking` |
| Fashion and beauty | [Uniqlo](uniqlo/tools.json) | 5 | `search`, `stock` |
| Fashion and beauty | [Zigzag](zigzag/tools.json) | 3 | `search` |
| Travel and lodging | [Airbnb](airbnb/tools.json) | 4 | `search` |
| Travel and lodging | [Booking.com](booking/tools.json) | 3 | `search` |
| Travel and lodging | [Uber](uber/tools.json) | 3 | — |
| Travel and lodging | [MyRealTrip](myrealtrip/tools.json) | 3 | `search` |
| Travel and lodging | [Foresttrip](foresttrip/tools.json) | 4 | — |
| Travel and lodging | [Socar](socar/tools.json) | 2 | `search` |
| Travel and lodging | [Agoda](agoda/tools.json) | 3 | `search` |
| Travel and lodging | [Yanolja (NOL)](yanolja/tools.json) | 5 | `search` |
| Travel and lodging | [Yeogi](yeogi/tools.json) | 4 | `search`, `rooms` |
| Travel and lodging | [Camfit](camfit/tools.json) | 3 | `search` |
| Travel and lodging | [Korail](korail/tools.json) | 1 | `trains` |
| Travel and lodging | [Klook](klook/tools.json) | 3 | `search` |
| Travel and lodging | [Trip.com](trip-com/tools.json) | 3 | `hotel_search` |
| Travel and lodging | [Hotels.com](hotels-com/tools.json) | 3 | `search` |
| Flights | [Korean Air](korean-air/tools.json) | 4 | — |
| Flights | [Asiana Airlines](asiana/tools.json) | 4 | — |
| Flights | [Air Busan](air-busan/tools.json) | 4 | `search` |
| Flights | [Eastar Jet](eastar-jet/tools.json) | 3 | — |
| Flights | [Jeju Air](jeju-air/tools.json) | 4 | `search` |
| Flights | [Jin Air](jin-air/tools.json) | 3 | — |
| Tickets and reservations | [CGV](cgv/tools.json) | 5 | `theaters`, `movies`, `showtimes` |
| Tickets and reservations | [MMCA (National Museum of Modern and Contemporary Art)](mmca/tools.json) | 3 | `exhibitions` |
| Tickets and reservations | [Lotte Cinema](lotte-cinema/tools.json) | 4 | `showtimes`, `movies` |
| Tickets and reservations | [Megabox](megabox/tools.json) | 5 | `theaters`, `movies`, `showtimes` |
| Tickets and reservations | [Seoul Public Service Reservation](seoul-yeyak/tools.json) | 3 | `search` |
| Tickets and reservations | [CatchTable](catchtable/tools.json) | 2 | `search`, `prepare_booking` |
| Tickets and reservations | [Ticketlink](ticketlink/tools.json) | 4 | `search`, `details` |
| Video and music | [Netflix](netflix/tools.json) | 6 | `browse`, `top10`, `title` |
| Video and music | [Melon](melon/tools.json) | 5 | `chart`, `search`, `lyrics` |
| Video and music | [Watcha](watcha/tools.json) | 6 | `search`, `tag`, `content` |
| Video and music | [TVING](tving/tools.json) | 6 | `search`, `browse`, `content` |
| Books | [yes24](yes24/tools.json) | 4 | `search` |
| Books | [Kyobo Book Centre](kyobo/tools.json) | 4 | `search`, `store_stock` |
| Books | [Ridi](ridi/tools.json) | 3 | `search` |
| Books | [Millie's Library](millie/tools.json) | 5 | `best`, `book` |
| Books | [Aladin](aladin/tools.json) | 4 | `search`, `used` |
| Social | [X (Twitter)](x/tools.json) | 3 | — |
| Social | [Threads](threads/tools.json) | 4 | — |
| Social | [Instagram](instagram/tools.json) | 4 | — |
| Social | [Pinterest](pinterest/tools.json) | 3 | — |
| Work | [GitHub](github/tools.json) | 4 | `commits` |
| Work | [LinkedIn](linkedin/tools.json) | 6 | `search_jobs`, `job` |
| Work | [Microsoft 365](microsoft-365/tools.json) | 4 | — |
| Work | [Saramin](saramin/tools.json) | 5 | `search`, `job` |
| Work | [Slack](slack/tools.json) | 3 | — |
| Mail and calendar | [Google Calendar](google-calendar/tools.json) | 4 | — |
| Mail and calendar | [Naver Mail](naver-mail/tools.json) | 3 | — |
| Mail and calendar | [Gmail](gmail/tools.json) | 3 | — |
| Telecom | [KT](kt/tools.json) | 5 | `plans` |
| Telecom | [KT M Mobile](kt-mmobile/tools.json) | 5 | `plans` |
| Telecom | [LG U+](lguplus/tools.json) | 5 | `plans` |
| Telecom | [SKT T World](skt/tools.json) | 5 | `plans` |
| Life | [CJ Logistics](cj-logistics/tools.json) | 1 | `track` |
| Life | [Naver](naver/tools.json) | 5 | `news`, `shopping`, `stock`, `orders`, `bookings` |
| Life | [Donghaeng Lottery](dhlottery/tools.json) | 4 | `results` |
| Life | [Revu](revu/tools.json) | 4 | `trending` |
| Life | [Non-covered medical fees (HIRA)](hira/tools.json) | 1 | `nonpay` |
| Life | [Soomgo](soomgo/tools.json) | 4 | `search_pros` |
| Life | [Everytime](everytime/tools.json) | 4 | — |
| Life | [Lost property search (Police Civil Service 24)](lost112/tools.json) | 2 | `search`, `detail` |
| Life | [Gov24](gov24/tools.json) | 1 | `resident_record` |
| Life | [Kidsnote](kidsnote/tools.json) | 4 | — |
| Life | [PanelNow](panelnow/tools.json) | 3 | `surveys` |

Phone permission services (contacts, location, phone calendar) are handled in the phone app, not the browser, so they have no service tools.

## Breakage monitoring (ADR 0020)

- **Real use**: Dool2 records the result every time it uses a tool. If a tool is blocked 3 times in a row or comes back with empty fields within a day, that tool rests for 6 hours, and meanwhile Dool2 works through the browser.
- **Every night**: on the maintainer's PC, `scripts/connector-nightly.sh` runs every `lookup` tool on the real sites. Broken tools are filed as GitHub issues (`connector-broken`), and for some, a coding agent drafts a repair PR. Install with `scripts/install-nightly-mac.sh`.

## Photo cards (show_cards)

Candidates to choose from (products, lodging, restaurants, movies, books, and so on) are attached by Dool2 under the answer as photo cards. So list tools like these must have **`image` and `link` fields**.

- For a screen list (`extract`), one line `"image": {"image": true}` is enough. The engine picks the most plausible photo in that row (late-drawn photos, `srcset`, background images; excluding icons and logos; as https). If the photo is empty, it scrolls through the list once and reads again.
- For data (`capture`, `embedded`), write that data's photo path in `map` (for example `"image": "thumbnail"`). If the path is a relative address starting with `/`, add the site address like `"{{#p}}https://site{{p}}{{/p}}"`. Inside a group of fields, use `*` (`images.main.*.image`; with several pictures, the first).
- If the link is not on the screen, build the address from the id (`"link": "https://…/detail?id={{movie_id}}"`). Check that the built address really opens.
- Do not worry about large photos. The PC downloads them, shrinks the long side to 360px, and sends them to the phone.
- To check, use `pnpm connector canary <id> --pc` — it prints the photo and link counts along with the row count.
