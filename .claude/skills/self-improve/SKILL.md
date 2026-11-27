---

name: self-improve
description: Use when asked to improve Dool2 by using it like a paying user — pick new scenarios, send them to the running test PC Dool2, judge the answers, fix tools, ship, re-ask. For requests like "self improve", "run scenarios on the test PC and fix what breaks", "evaluate Dool2 with N scenarios", "시나리오 돌려서 개선해".
---

# Self-improve loop

Use Dool2 the way a paying person does, one request at a time on the real test PC, and fix what a person would
complain about. The maintainer watches the same conversation live on their phone, so every request is real: never
approve anything, and clean up after.

## 0. Before you start

- A running daemon whose main conversation you may use (the test PC). You need its screen API file
  (`{"url","token"}`, written when the daemon runs with `DOOL2_API_INFO`) and its data folder for the logs.
  On the maintainer's Mac: `DOOL2_LOOP_API=~/dool2-live/api.json DOOL2_DATA_DIR="$HOME/Library/Application Support/dool2-dev"`,
  and `~/dool2-live/update.sh` puts merged main on it.
- Ask the person to be ready for phone cards (connect cards, choices). Do it only if a batch needs them.
- Safety, always: never press approve for pay, contact, booking or saving; never put real passwords anywhere (the
  person types them on the phone card); mask emails in anything you write; delete the reminders, memories and goals
  your scenarios made (the last scenario of a run says so to Dool2).

## 1. Pick scenarios from what you learned

Start from `evals/loop/scenarios.json` (past runs; `area` tags) and add new ones each run. Good scenarios:

- **Spread over areas**: lookups (weather, stocks, coins, news, box office), places (restaurants, hours, menus),
  shopping (lowest price, gifts), travel (trains, flights, hotels, routes), mail, calendar, reminders and briefings,
  files, connecting services, parcels, booking up to the approval card, small talk, cleanup.
- **Follow-ups that lean on context**: "tell me more about the second one", "what did I say earlier?".
- **Rephrased repeats** of what broke last time (a second round with new wording), and requests that need a
  connection the PC does not have yet.
- Write them as a person would type on a phone, in Korean for the Korean test PC.

Add the new ones to the bank in the same PR as the fixes they led to.

## 2. Run a batch of about 10

```bash
node scripts/loop/run.mjs evals/loop/scenarios.json /tmp/loop/run1.json --from 1 --to 10
```

Each row: seconds, tools called, finish-check verdicts, `answers` (raw replies), `visible` (replies the person
sees: a task's result replaces "I'm looking it up", a later answer replaces one the check sent back) and the
answer text. Run it in the background; a batch of 10 takes 5–10 minutes.

## 3. Judge each one as a paying user

For every row, read the answer and the daemon log (`<data>/logs/<day>.jsonl`: `turn`, `tool`, `finish-check`,
`connect-*`, `task` lines) and ask:

- **One reply?** Target: 90%+ of questions answered in one visible reply. Anything left goes as a quick-reply
  button under the answer, not a second reply.
- **Right and complete?** Does it answer what was asked (box office = audience, not booking rate; "evening" = every
  movie, not two from an earlier question)? Does it make up numbers or guess from news?
- **Fast?** Over 30 s for a lookup, look at why (a 15 s wait that timed out, a browser task, ten calls).
- **Clean?** No internal words (task ids like t16, tool names), no English thoughts, no page details nobody asked
  for, no repeating unrelated earlier topics, no "do it on the site yourself".

## 4. Fix the cause, in the tool

Follow AGENTS.md: fix by sharpening tools, not by adding rules to `prompts/persona.md` (its text is pinned by
golden-hash tests, ADR 0040). Patterns found so far:

| Symptom                            | Usual cause                                                                                               | Fix                                                                                                      |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| A 15 s wait, then "tool got stuck" | The site showed a page the `wait` does not know: a sign-in wall, "access temporarily limited", a 500 page | Add that text to the `wait` and a `stop_if` (with `blocked: true` for blocks) that says where to go next |
| An answer about part of a list     | The result was cut at 10 rows (`PAGE_ROWS`) or 6,000 characters                                           | Drop fields nobody needs, add a filter input, say in `next` to read the rest with `offset`               |
| Browser task for a simple detail   | No tool reads it (menu, hours, box office, coin price)                                                    | Add a lookup tool; prefer data the page embeds (`embedded`) or plain screen text (`find`)                |
| Several calls for one answer       | The tool lacks an input (a week range, sort by size)                                                      | Add the input and say when to use it in the description                                                  |
| "Found" with nothing in it         | A summary row counted as a result                                                                         | Filter rows on what a real row has (a time)                                                              |
| Second reply after the answer      | The finish check sent it back, or a hand-over plus its result                                             | Conversation answers are not sent back (offer instead); check tasks only                                 |
| Text vanished from an answer       | A cleanup filter matched it (English lines)                                                               | Narrow the filter and add a test with the real text                                                      |
| Nagging about other work           | A per-turn note invites it                                                                                | Say in that note when to mention it                                                                      |

Before writing a tool, look at the real page: `pnpm connector page "<url>"` and `pnpm connector try <id> <tool> '<input>'`
(see `.claude/skills/connector`). Verify with the real site, then set `status` to what you ran.

## 5. Ship and re-ask

- One PR per fix, `git commit -s`, `pnpm lint && pnpm build && pnpm typecheck && pnpm test`, merge when CI passes
  (AGENTS.md). Run independent PRs side by side in their own worktrees.
- Put the merged main on the test PC, then send the same request again (`run.mjs` on a file with only those
  scenarios) and compare. Passed → next batch.
- Phone screen changes reach the phone only with a new app build: bump `versionCode` in
  `apps/phone/android/app/build.gradle`, `pnpm build`, `npx cap sync android` and `./gradlew assembleDebug` in
  `apps/phone`, and hand over the APK.

## 6. Report

```bash
node scripts/loop/report.mjs /tmp/loop/report.html /tmp/loop/run1.json /tmp/loop/retry.json --title "Loop 11-26"
```

Tell the person, in their language: how many answered in one reply before and after, what was fixed (PR numbers),
what is still slow or wrong, and what they need to do (phone cards, connections, test data left). Then remove the
worktrees you made and the files under `/tmp`.
