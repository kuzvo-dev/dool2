---

name: connector
description: Use when creating or fixing a Dool2 service tool (connector, skills/<id>/tools.json). For requests like "make a connector for X", "fix the CatchTable tool", "add a Coupang order lookup tool", "the connector is blocked".
---

# Creating and fixing service tools (connectors)

Dool2 works with typed per-service tools (`catchtable_search` …) ([ADR 0018](../../../docs/decisions/0018-service-connectors.md)). A connector is data, not code (`skills/<id>/tools.json`). The Dool2 daemon runs it with fixed engine actions and keeps the approval gate intact. The format and the list of actions are in [skills/README.md](../../../skills/README.md).

Note: the JSON examples here keep Korean values because they are service text. `tier` is one of the English keys `lookup` | `fill` | `pay` | `contact` (ADR 0029); `status` stays Korean (`초안`, `검증됨(…)`, `막힘(…)`).

**What a good connector is measured by: seconds.** A person asks in a few words ("택배 어디쯤이야", "금요일 저녁 부산 가는 비행기") and a lookup tool should answer in seconds where a browser task takes one to three minutes. Most fixes from the test PC loop (`.claude/skills/self-improve`) were about that: the tool was not found, opened sites it did not need, waited on a page that would never come, or returned so much that the answer went wrong. Sections 1, 3 and 5 say how to avoid each.

## 0. Preparation

```bash
pnpm install && pnpm build
export DOOL2_TEST_CHROME=".../Google Chrome for Testing"   # if you don't have it: npx @puppeteer/browsers install chrome@stable
```

- When testing tools that need login, keep using the same profile with `DOOL2_DEV_PROFILE=<folder>`, and have a **person log in themselves** in that Chrome window. Add `--connected` to `try`. Never write passwords in the conversation or in files.
- Do not do payments, booking confirmations, orders, or sending, even in tests. Check only up to the point where an approval request (approve) appears.

## 1. Decide what to make into tools

- The `abilities` (what it can do) in `skills/<id>/connect.json` is the starting point. If there is no card, make the card first (check with `pnpm connector check <id>`).
- While signed in to the real site, also fill the card's `account` (where the signed-in account shows, [ADR 0041](../../../docs/decisions/0041-connection-is-an-account.md)): the page address and a pattern whose group 1 is the ID or email as typed on the sign-in form. Without it Dool2 cannot tell whether Chrome is signed in to the account the person connected or to someone else's. Copy the pattern from a real page read (`browser_read`), and do not guess.
- A new card also needs `regions` (`KR`, or `global` for services that work anywhere) and `i18n.en` (English name, summary, example and abilities in the same order). See `skills/README.md`.
- **Fill `aliases`** with the words people use instead of the service name (`날씨`·`우산` for weather, `택배`·`운송장` for parcels, `비행기`·`항공권` for flights, `박스오피스` for KOBIS). A request with one of them goes to the lookup tool at once; without them only the service's own name matches, and a two-word name like `네이버 항공권` never matches a single word ("flight to Busan" went to a 93 s browser task, #586). `pnpm connector check <id>` shows a tip while they are missing.
- **One user intent = one tool.** Like "find open tables at a restaurant", "prepare a reservation", "view order history". One screen is not one tool.
- Start with **`lookup` tools that work without login**. Users can use them right away even before connecting, and they are easy to test. Before the AI opens a browser task, Dool2 points it to a lookup tool that runs now (no sign-in, or connected) for a service the request names (#553), so these are the tools that make Dool2 fast.
- **When the answer needs several sites, make one tool that tries them** rather than leaving the AI to call each site's tool. Parcel tracking tries five carriers in one call and says which one had the number (#567); Naver Flights compares fares across airlines (#584). Then point the single-site tools to it in their description ("to compare fares, use naver_flight_search first; use this for one airline's own screen", #585), or the AI starts with the first single-site tool it sees (165 s for the cheapest Gimpo–Jeju flight).

### Starting from remembered routes

Dool2 remembers the clicks it walks on a site (ADR 0034). Routes it walked often are a good place to start:

```bash
pnpm build
pnpm connector routes                       # reads routes.json in the Dool2 data folder
pnpm connector routes --from <routes.json or data folder> --out <folder>
```

It writes drafts to `out/connector-drafts/<id>/tools.json` (never into `skills/`) for routes that reached their page 3+
times in 80%+ of walks, and prints what it left out (page titles, query strings, id-like address parts). Each draft is
a `lookup` tool that opens the start, presses the same links and hands the page to the AI. It is not a connector yet:

- The `_draft` block makes the daemon and `pnpm connector check` refuse the file. Delete it only after the review.
- Check that the address and click names hold nothing personal, then rewrite the tool like any other (sections 2–3):
  a real name, Korean title, description and `next`, `login` if the page needs sign-in, and an `extract` (or
  `embedded`/`capture`) in place of `handoff_to_agent` so it returns rows. Then test it (section 5) and submit (section 7).
- Do not commit drafts made from your own routes as they are; commit only the reviewed tool.

## 2. Inspect the site (most robust first)

1. **Build state from the address**: Put the search term, date, and party size in the address and see whether that screen comes up directly (for example `?keyword=성수` (Seongsu), `?date=261127&personCount=4`, `?gnbInvcNo=…`). This reduces clicking steps.
2. **Do not call the site's API directly.** Open addresses and read the screen like a person (3 and 4 below). But if you are worried because the screen selectors are only hashed classes, read **the response the page itself received** with `capture` (check the address pattern in the developer tools Network tab, and first see whether conditions like date and party size are passed through the page address), or read the data the server embedded in the page (`script#__NEXT_DATA__` and so on) with `embedded`. Dool2 never builds and sends requests itself.
3. **Extract a list from the screen (`extract`)**: When there is no JSON. Use selectors that rarely change, such as `id`, `href*=`, table structure (`td:nth-child(2)`), and `:has()`. Avoid hashed classes like `_1h61z1e9`, which change with every redesign.
4. **Clicking (`click`)**: By the text exactly as shown on screen. If the same text also appears on a screen behind it, you may click the wrong place. Where possible, build state from the address to cut clicking steps.
5. For places that are hard to do in a fixed order (calendars, complex selection, steps that differ per site), use `handoff_to_agent` to give the tab to the AI and write the task specifically.

`pnpm connector page "<address>"` shows the screen text that the Dool2 engine reads, and `pnpm connector page "<address>" "<selector>"` shows what a list selector captures.

## 3. Tool design (so the AI does not get confused)

- **Name**: a single verb or noun, like `search`, `track`, `prepare_booking`, `orders`. The real name is `<service>_<name>`.
- **description**: (1) when to use it, (2) what it returns, (3) what to do next (the next tool's name). Put site tips here too. Within 600 characters.
- **input**: only truly needed fields are `required`. Use `format: date` for dates, `format: time` for times, `enum` for choices, and `pattern` for numbers. In the field description, give the format and an example ("Date YYYY-MM-DD (e.g. 2026-11-27)"). Use `default` when a default is natural.
- **output**: only the fields you will tell the user about, around 10. Always include the id to pass to the next tool (`shop_id`). Lists use `list` + `fields`.
- **Photo cards**: candidate lists to choose from (products, lodging, restaurants, movies, books) must have `image` and `link` fields — they become photo cards under the answer. For screen lists use `"image": {"image": true}`; for data, put the photo path in the map. For lists that cards do not suit (theaters, timetables, lyrics) use `"cards": false`. `check` verifies this in shopping, groceries, fashion, travel, ticketing, video, and books. For details see "Photo cards" in skills/README.
- **Optional inputs** (maximum price, region, and so on) go into the address like `{{#max_price}}&toPrice={{max_price}}{{/max_price}}`, or if the site cannot filter them, filter with a `filter` step (if value is empty it passes through unchanged).
- **No result is also a result**: "tracking number not yet registered" and "that time is full" return what to tell the user with `require`/`stop_if` + `say`. This is distinguished from being blocked (the site changed).
- **Wait for every page that can come, and stop at once on the wrong ones**: a `wait` for the result list sits for its full timeout when the site shows something else. List the sign-in page and the "access temporarily limited" page in the same wait and stop on them: the sign-in page with a `say` that offers the other services that can do it and to connect this one, the limit page as `blocked: true` (Naver shopping: 15–19 s failures → a 3.8 s stop, #575).
- **Screens the site blocked get `blocked: true`**: When you catch a block screen like "Access Denied" or "abnormal access" with `stop_if`, add `blocked: true`. It is not a connector problem to fix, so the nightly check does not open an issue or repair and shows it as "site blocked". Do not add workarounds that evade the block (such as going back through another address). Robot-check screens (security checks, CAPTCHAs) are also caught with `blocked: true`: instead of a dead end, the daemon keeps the tab open, has the AI solve it with a card on the user's phone (`browser_request_code` captcha for text, `browser_request_tap` for images), and then has it call the same tool again. You do not need to write only "I'll look elsewhere" in `say`. Calls to the same service are run by the daemon one at a time, 1.5 seconds apart.
- **Sites that block shortcut addresses: start from the front page**: Sites that block when you enter a search or product address directly but open it after passing through the front page (Coupang) are written in the order `open` front page → `wait` → `sleep` → the original address. That is the path people use.
- **Open only the sites that can have it (`ifMatch`)**: a tool that tries several sites in turn gives each `open` an `if` with `ifMatch`, a regular expression the filled text must match. Carriers use numbers of known lengths, so parcel_track opens Korea Post only for 13 digits and Logen for 10–11 (an unknown 13-digit number: 61 s → 5.6 s, #583).
- **Cover the asked range in one call**: if people ask for "this week" or "this month", take a `range` (or start and end) input instead of one day per call (Calendar: four calls and 36 s for a week → one call, #568).
- **Keep the result small**: what the AI gets back should stay within a few KB. A 17 KB showtime list for 19 movies made the answer pick movies from an earlier question (#571). Drop fields nobody tells the person about, take an input that narrows the list (a `movie` to filter by), and let the rest come with `offset`: lists come 10 rows at a time and the result says how to read the next ones. `try` and `canary` print the size and warn past 8 KB.
- **Count only real rows as found**: a not-found page can still have a row (a summary with the number you typed and masked names). Run the rows through a `filter` that keeps only rows with what a real hit has (a processing time, a price) before you decide "found" (#579).
- **Lists where you must go through periods or pages: keep searching inside the tool**: If the AI calls repeatedly while changing the year or page, it waits on each call and becomes very slow (measured 80 seconds for Coupang order search). Use `if` (only when nothing was found before) and `append` (attach after the earlier list) in the steps so that one call searches recent → this year → last year … in order and stops where it finds it. Put the searched period (`searched`) and the next path if not found (`tip`) in the result so the AI does not search again with the same word.
- **next**: what the AI does after the result (for example "Show 2–3 places and let them choose. To book, use catchtable_prepare_booking").
- **Never send the person to the site.** `description`, `next` and `say` never end with "book it on the site" or "사이트에서 직접 예매하세요". Dool2 offers to do it: prepare the booking with the next tool and ask for approval before paying, with the choices as quick replies (Korail, #568). If there is no tool for that step yet, say Dool2 can open the page and prepare it, and leave the last button to an approval. `check` fails a tool with these words (a sentence saying it does _not_ do this is fine).
- **tier**: read-only = `lookup`; reversible things like a cart or temporary save = `fill`; things that spend money or confirm a booking = `pay`; things sent to other people = `contact`.
- **login**: `true` only for tools that work only when logged in. If not yet connected, Dool2 returns connection guidance instead of running.
- **minIntervalSec**: so the same input is not asked too often (parcel 1800, open tables 300, and so on).
- **expect**: the standard that catches silent breakage. `filled` lists the fields that must be filled (name, price, id), and `rows` the minimum number of rows that always appear for the example input (usually 3). Both the daily check and real use notice "fields come back empty" breakage with this.
- **examples**: inputs that can actually be run. The daily live-site test (canary) uses these.

## 4. `pay` and `contact` tools

- Never just press the last button. End with `approve` (the user approves whether to press that button) or `handoff_to_agent` (the AI organizes the screen and calls `browser_request_approval`). The check enforces this rule.
- Make the approval card contain what, where, how much, and the cancellation terms exactly as written on the screen.

## 5. Test and raise the status

```bash
pnpm connector check <id>                         # format and safety rules (the repo tests run the same check)
pnpm connector try <id> <tool> '<input>' --pc      # in the real Chrome of the test PC (works for Coupang, 29CM and others that block the test Chrome)
pnpm connector canary <id> --pc                    # all lookup tools, with the counts of rows, photos, and links
pnpm connector try <id> <tool> '<input JSON>'      # once on the real site. Shows the text, structured result, and time taken
pnpm connector canary <id>                        # all lookup tools with examples
```

- Compare the result with the real screen to see if it is right (shop names, times, amounts).
- **Write down seconds.** Run the request before and after your change and put both times in the PR (and the KB if you cut a result). "Works" is not enough: a tool that answers in 60 s when it could in 6 is the next thing to fix.
- Try the not-found case too (an unregistered number, a place that does not exist): it should end quickly with the not-found `say`, not wait out a timeout or count a summary row as found.
- `--pc` passes the repo's definition to the running test PC daemon (`DOOL2_DEV_RESET=1`) and runs it in that PC's Chrome. It uses `DOOL2_TOOL_TOKEN` (the daemon's tool token) and `DOOL2_PC` (default `http://127.0.0.1:8833`). You see the fixed definition right away without installing.
- Write `status` according to how much you ran: `검증됨(2026-11-17, 검색 → 예약금 화면까지)` (verified: 2026-11-17, from search to the deposit screen). Tools you could not run stay `초안` (draft). If it does not work, leave `막힘(reason)` (blocked), and it is not shown to the AI.

## 6. Fixing blocks

- The nightly check files broken tools as GitHub issues (`[커넥터] tool name` ("[connector] tool name"), label `connector-broken`). Start by running the reproduction command in the issue.

- When Dool2 says "blocked at step N (extract)", look at that step first. Reproduce with `try` → check the current screen with `page` → fix the address, selector, or request body.
- Do not work around what the site blocks (CAPTCHAs, robot checks). The daemon has the user solve them with a phone card, so do not leave the tool as `막힘` (blocked); catch that screen with `stop_if` + `blocked: true` instead.
- For fields and select boxes in a window attached at the very end of a long screen (such as a per-store stock window), the daemon rereads once at length if it cannot find them. If the choosing field is a site-specific widget so that `choose` changes only the value and the next field (city, county, district, and so on) is not filled, drop that field and narrow down another way (searching by a word in the name).

## 7. Submitting

- One PR = one service (or one tool). Paste the `pnpm connector try` result (with personal information masked) in the PR body, with the seconds before and after.
- After the merge, no app release is needed (ADR 0039): the merge builds a signed pack for test PCs (`pack-beta.json`), and a maintainer gives it to everyone with the promote run of the Connector packs workflow (`pack.json`). Check the fix on a test PC before asking for the promote. A fix that also needs app code (a new step kind, the extension) still waits for the app release.
- A `lookup` tool that returns rows can also back a quick check on a watch (ADR 0031), so mention it in the PR when the
  tool came from remembered routes.
- `pnpm lint && pnpm build && pnpm typecheck && pnpm test`.
- Words the user sees (`say`, `next`, result field descriptions) are written in Dool2's voice and do not include other companies' product names.
- Update the status table in `skills/README.md`. `skills/` is CC BY-SA 4.0.

## Connection test with real accounts

`node scripts/connect-test.mjs --sheet sheet.csv` (or service ids) — asks the running daemon (`DOOL2_TOKEN`, `DOOL2_TOOL_TOKEN`).
For each service it checks login → if not logged in, logs in again with the vault account (`POST /api/connections/<id>/relogin`, the password does not travel in the request) or with easy login → runs the lookup tools that need login with the example inputs and leaves a table in `~/.dool2-connect-test/latest.html`.
Login attempts are limited to 2 per service per day. `fill`, `pay`, and `contact` tools run only with `--deep` (it fills text into the site), and tools that end in approval are not run.
Passwords are never received through the conversation, the sheet, or files: once the user enters it in the app's connect card, it goes only into the vault (OS keychain).
