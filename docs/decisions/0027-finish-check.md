# 0027. Dool2 double-checks before finishing a task, and continues on its own if something is left

- Status: Accepted (turned off 2026-11-24, back on 2026-11-25 with the draft design)
- Date: 2026-11-22

## Context

In the second joint test, most points were lost for the same reason: Dool2 stopped too early and handed off to the person.

- It guessed the attendance address and gave up.
- It looked at only 3 car insurance providers and ended with "please call".
- It handed a health checkup booking off to a phone call.
- While doing youth-discount paperwork, it asked the user for company information that could be obtained from a connected place.

There are also 27 places where a tool result says "end this answer". So once it got stuck, it was easy to end the answer right there.

User decision (11-22): "Even if answers get slower, going back and forth many times actually takes longer. I want to hand it off, go do something, and come back to find it all done."

## Decision

Make it work like a human assistant: make a plan, take another route when stuck, and report the result once at the end. As the first step, add a **check before finishing**.

1. **When is the check done?** Every time a turn in which Dool2 used tools ends.
   - It is not done while waiting on an approval, login or "please do it yourself" card.
   - It is not done if the user stopped it, it ended with an error, or a new message came in meanwhile.
2. **Who judges?** A separately called AI judges. It does not use tools.
   - This AI judges seeing only "the request, the last answer and the tools used this time". The verdict comes back as `{done, why, next}`.
   - Only these may be handed to a person: payment approval, identity verification, approval to send outward (inquiries, applications, mail, posting), and facts that only the user truly knows.
   - Even a fact only the user knows counts as Dool2's job if there is a way to find or estimate it from connected places, mail or memory.
3. **What happens if it is not finished?** A notice is sent into the same conversation so that Dool2 continues. The notice says "Still left: X. Do not repeat the same method, take another route, and when finished give only the result at once".
   - The screen shows only one line: "I looked again before finishing and something is left, so I'll continue" (끝내기 전에 다시 보니 남은 게 있어서 이어서 할게요).
4. **How many times?** The count depends on the task.
   - By default it is sent back up to 2 times.
   - If it used a tool not tried in the previous turn, that counts as progress and the limit is raised to 4.
   - If it gets stuck twice for the same reason, it stops immediately.
   - It stops once 10 minutes have passed since the request (20 until 2026-11-24, see below).
5. **When does the notification go?** The phone's "done" notification is sent only once, after the check passed or it stopped.
6. **Payment and contact approvals stay as they are.** The check only makes Dool2 do more work; it never makes it pay or send without approval.
7. **Keep a record.** The activity log (`finish-check`) records the verdict, the count and the reason. It is used when comparing the A and B rates in tests.

## Why

- Just adding to the instructions was followed less the longer they got. So having a separate AI look at the result after the work and judge is more reliable. The judgment is made by the AI, not by rules (judge AI).
- If you ask the same AI "Are you done?", it tries to stand by what it just said. So the verdict is made in a fresh session.
- Three things stop it from looping forever: count, time and the same failure.

Other options were considered too.

- **Forcing a plan table within a turn:** it needs a big change to the tool structure, so we postponed it to the next stage.
- **Fixing all 27 "end this answer" places:** those mostly mean "wait after showing a card", so most are needed. When the check sends it back, it takes another route after that.

## Consequences

- Answers get slower. The verdict takes 10 to 20 seconds, and the number of continuing turns grows. The user chose to accept this.
- Cost goes up. The verdict is short text, so it is small.
- Intermediate answers are still shown in the conversation as they are. Whether to fold them away is decided after seeing test results.
- Conditions to revisit: run the same items again with the second-round group (2) as the baseline. If the A and B rate does not rise, or many turns spin their wheels, look again.

## First measurement (2026-11-22, 33 clarification items of round 2, group 2)

The same 33 requests were run twice in the same way. When Dool2 asked back, we sent "모르겠어, 할 수 있는 데까지 해 줘" ("I don't know, just do what you can") once.

| | A | B | C | D | A+B |
|---|---|---|---|---|---|
| Before the check | 3 | 13 | 15 | 2 | 16 (48%) |
| After the check | 7 | 24 | 2 | 0 | 31 (94%) |

- 17 went up and none went down.
- It judged 94 times: done 34 times, sent back 59 times, stopped once.
- The time for the 33 grew from 57 to 72 minutes (+26%).
- Fixed together with it:
  - It no longer sends a quote request with made-up values.
  - It no longer uses a guessed value as fact for the next task.
  - It no longer says "it's done" before seeing the completion screen.
- Remaining:
  - If identity verification (KakaoTalk) is not approved within 3 minutes, the check sometimes lets it try the same verification again. When the person is away, the verification request may go out several times.

## Addition (2026-11-23): loop guard inside a turn

The check above looks at a turn after it ends. Inside a turn, the agent's own loop decides what to call next, and
that loop belongs to the official program we do not change. But every tool call of every agent passes through the
daemon's tool address, so the daemon can see when Dool2 is going around in circles.

- When the **same tool is called with the same input and returns the same text result** for the 3rd time within
  15 minutes, the daemon adds one line to that result: calling again will not change anything, take another route,
  or say in one sentence what is blocked (`apps/daemon/src/loop-guard.ts`).
- It does not block or stop the call. It only sharpens the result the AI reads, so the AI still decides.
- A page that changed between reads is not a repeat, and waiting tools (`*wait*`) are not counted.
- The window spans turns, so a turn the check sent back that repeats the same dead end is caught as well.
- Each note is recorded in the activity log (`loop-guard`, tool and count), so we can see how often it fires.

## Change (2026-11-24): 10 minutes, and stop ends the check

A tester said Dool2 "kept thinking forever and could not be stopped". Two causes, both in this check:

- Stop on the PC did not end a verdict in progress, and a late "not done" verdict started the work again. Every
  stop now drops the request and aborts the judge (#436).
- A request could be sent back for up to 20 minutes. In 5 days of logs the check sent work back 87 of 163 times;
  reading the reasons, most were right (a claimed send with no send action, "call them" while the web was still
  open), so the rounds stay. The time a request may take is cut to **10 minutes**: past that, it is better to
  report what is left than to keep the person waiting.

## Turned off (2026-11-24)

The check is off by default; the daemon no longer asks a judge unless a test passes one (`finishJudge`).

- What people saw: an answer appeared, then vanished and Dool2 started working again. Testers and the maintainer read
  it as Dool2 thinking forever, and the stop fix (#436) and the 10-minute limit (#442) did not change that feeling.
- Each judge call was a separate AI request on the user's quota, and a "not done" round repeated the whole work.
- What it caught (a claimed send with no send action, "please call" while the web was still open) goes back to the
  tools: their results say what was not done and what to try next, which is how Dool2 fixes mistakes (AGENTS.md
  "Fix by sharpening tools").

The code stays so it can be turned on again for evals; revisit only with a design that never takes back an answer
the person already saw.

## Change (2026-11-25): a small judge with evidence, a code check, and simple requests skipped

Groundwork for bringing the check back (still off by default until the screens keep the answer as a draft, see below).

- **The judge runs on the agent's small model** (`haiku` for Claude Code, ADR 0037), in a fresh session on the same
  agent as the conversation, with a 60-second limit.
- **Evidence the daemon already knows** goes into the judging text as facts, not claims: how many approval requests
  were created since the request began (auto-approved ones too), the last page read (title and address without the
  query), whether any page read showed a finished action, and how many tool calls failed this turn.
- **False completion is caught by code, without the AI.** If the answer says it booked, applied, sent, ordered or paid
  (Korean and English patterns, denials such as "could not send" excluded, `claimsDone`) but nothing in this request
  asked for approval and no page read showed a finished action (`donePage`, or `browser_order_done`), the work is sent
  back at once with "check on the result page that it really went through". It uses the same round limits.
- **Simple requests are not judged**: one or two lookups (lookup-tier service tools or Dool2's read-only tools, never
  the browser) and nothing else. In the work log of 11-19 to 11-25, 12 of 169 judged requests were like this.
- **Why it sent work back is counted.** The judge also returns a `kind` from a fixed list (`asked-user`, `handed-off`,
  `unverified`, `missing-part`, `blocked`, `other`); the work log keeps it with `source` (judge or code) and the judge
  time. `node apps/daemon/scripts/finish-reasons.mjs` prints the top kinds per week, counts only. Reading the 99
  "not done" reasons of 11-19 to 11-25 by hand gave roughly: asked the person for something findable 26%, handed off
  ("call them", "check it yourself") 24%, part missing 21%, stopped at a blocker 15%, claimed without doing or
  checking 13%.

## Back on (2026-11-25): the answer is a draft until the check passes

The check is on again by default for chats with the user (never feed posts or scheduled tasks), with a design that
never takes back an answer the person already saw. The stop fix (#436) and the 10-minute limit (#442) stay.

- **The answer before the verdict is a draft** inside one progress card titled "마무리 확인 중" ("checking before I
  finish"); tapping opens the draft. The daemon says "checking" (live `checking` event, `checking` in the
  conversation state) *before* the answer is sent to the screens, so it never shows as a message first. Text written
  after tools were used streams into the card too, not into a bubble.
- **Pass**: the card goes away and the draft becomes the result message as it was.
- **Sent back**: the draft folds into the card, whose title becomes the judge's `next`, for example "빠진 부분 이어서
  하는 중: 보험사 2곳 더 비교". The daemon keeps the conversation "working" between rounds (`continuing`), so the
  draft never flashes as an answer between them. The person receives exactly one result message per request.
- **"여기까지만 받기" (take it as is)** is always on the card while there is a draft: the draft becomes the result,
  judging stops, and a round already running stops without keeping its half-written answer
  (`ThreadService.cancel(…, { discard: true })`). Stop still only stops.
- **At the round or time limit** the answer stands and a `left` record goes below it: "아직 남은 것" (what is left)
  and an [이어서 하기] (continue) button, only in this case. Continue starts the same request again with a fresh check.
- The "done" notification still goes out once, on the final answer.
- The screen part is the ProgressCard component (`docs/design/system/components/ProgressCard`).

What the person pays: a request that needed no more work is shown as final only after the verdict. The small judge
(ADR 0037) and skipping simple requests keep that short; the work log keeps the judge time (`ms`) to watch it.
Revisit when send-backs become rare (the "answer first, judge in parallel" option of the research becomes cheaper),
or if testers still read the card as "thinking forever".

## Change (2026-11-25, round 2): fix the causes in the tools, and skip the judge when the code already knows

The top send-back kinds (asked the person for something findable 26%, handed off 24%, stopped at a blocker 15%) came
from tool results more than from the AI: many results only said "end this reply", so neither the AI nor the judge
could tell a real wait from a step that should have been tried. The causes are fixed in the tools:

- **Every result that ends a turn says what was done, what is left, who acts next and that the turn waits**
  (`apps/daemon/src/hand-back.ts`). They all start with the same mark.
- **Asking and handing off carry what is easy to forget**: `browser_request_profile` needs `looked` (where the values
  were looked for first), `browser_handoff` needs `blocker` and `tried`, and a hand-off with nothing tried is refused
  when the site has service tools or a remembered route.

And the check uses what the code already knows:

- **A turn whose tool result ended it to wait for the person is not judged** (logged as `skip`, reason `waiting`),
  like approval, sign-in, connection and hand-off records before. The code evidence is conclusive there: the judge was
  only asked to confirm "an approval card is shown and waiting", or sent back a wait it could not tell apart.
- **Hand-offs go to the judge as facts**: what blocked and what was tried first.

The rule for removing the check stays as written: replay the same recorded requests with the check off; if A+B with it
off comes close to A+B with it on, remove it or keep only the code check. That needs the real-app run (round 2, WP7).

## Update 2026-11-26: one answer per question in the conversation

The test PC loop (11-26) counted the replies people see. In 10 questions, 4 got two to four replies: the first answer
showed, the judge sent it back, and Dool2 answered again or handed a browser task over ("reading it now", then the
result). Two of the four send-backs were wrong (a pre-market stock price, a booking-rate answer to "box office"), and
the other two first answers were already useful, with the rest better asked than added.

- **In the conversation session, the judge no longer sends an answer back.** What it finds left becomes a quick reply
  under that one answer (`offer` in the verdict, written as the person would say it). The log says `offered`.
- **Tasks still go round** (ADR 0038): their result is one task card, and "done" there must be seen on screen. The code
  check that catches a claimed action with nothing behind it still sends back everywhere.
- **A hand-over reply is replaced by the task's result** on screen (`interimAnswers`): "I'm looking it up" folds under
  the answer that the task brought back, as earlier answers did.
- The global instructions stay as they are (ADR 0040): the button comes from the verdict, not from a new rule.

## Update 2026-11-27: keep going while a way is left

The family certificate task on the test PC (11-27) stopped after 2 rounds on Sonnet and on Opus alike. The judge's last
verdict said "saving to Downloads instead of Documents is still left", and the turn before it had called no tool and
only rewritten the answer. The person asked that Dool2 keep trying until there really is no way left.

- **A new way counts as progress.** When the judge gives a way to try (`next`) that it has not given before, the
  request goes on to the maximum, even after a turn with no new tool, and a repeated blocker does not stop it then.
- **The maximum is 6 rounds** (was 4). The 10-minute limit still ends a request that goes in circles.
- **A turn that tried nothing is told so.** If the answer after a send-back called no tool, the next note says nothing
  new was tried, to try the way now, and that "everything was tried" holds only when each way was tried and failed.
