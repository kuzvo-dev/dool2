# 0038. The conversation hands longer work to a task session

- Status: Accepted (on by default since round 2 of the harness overhaul; the `taskSessions` setting turns it off)
- Date: 2026-11-25
- Related: [0015 one conversation](0015-one-conversation.md) (its "conversation session + a work session per task"
  option), [0027 finish check](0027-finish-check.md), [0032 pinned instructions](0032-pinned-instructions.md),
  [0033 tools on demand](0033-tools-on-demand.md), [0035 resident session](0035-resident-agent-session.md),
  [0030 auto-approve](0030-auto-approve.md)

## Context

Everything the user asks runs as a turn of the main conversation (ADR 0015). A booking that takes the browser
twenty steps holds the conversation for minutes: a message sent meanwhile waits in the queue until the turn ends, and
every page the task read stays in the main segment, so the conversation after it is slower and the segment fills up
sooner. Scheduled tasks and proactive checks already run in their own chats (`runRoutine`, the feed chat); what the
user hands over in the conversation does not.

The main conversation also carries every tool on every request, although most of its turns are talk, memory and a
lookup or two. The tool list was close to its byte budget (92,000 bytes for Dool2's own tools).

Several chats can already answer at once (side chats, the feed), and the daemon guessed which chat an approval,
sign-in or phone card belonged to: "the only chat answering now". With a task running next to the conversation that
guess is wrong.

## Decision

1. **Two kinds of session.** With `taskSessions` on, the main conversation is a *conversation session* and longer
   work runs in *task sessions*. A task session is its own chat (stored as a task thread: not a segment, not a side
   chat), with the same Dool2 instructions and the same agent and model as the conversation.
2. **Tools split by session.** The tool server gets its kind (`DOOL2_SESSION`):
   - conversation: memory, goals, library, what Dool2 knows, conversation search, the result blocks (`show_*`),
     connect cards, my info and payment method names, lookup-tier service tools (`service_call` only for lookup
     tools), and the task tools.
   - task: everything Dool2 has today except the task tools (a task cannot start tasks).
   - no kind (side chats, the feed, older builds): everything, as before.
   The daemon checks the same split on every call (a conversation session's call to a browser, screen or file tool,
   or to a service tool that is not a lookup, is refused), so a tool list is not the only fence. The kind of each
   segment is fixed when the segment starts, so its tool list stays the same for the whole segment (ADR 0032 cache).
3. **Task tools** (conversation session only):
   - `task_start({ goal, done_when[], known[], avoid[], title, browser })` opens a task session and returns at once.
     Its description says when: browser or PC app work, or several steps. One or two lookups stay in the
     conversation.
   - `task_steer({ id, said, added })` passes the person's words to a running task: `said` is their own words,
     copied exactly (the daemon refuses words the person never wrote), and `added` is what the conversation already
     settled, which the task sees marked as Dool2's, not the person's. The task reads the words first and resolves
     what they leave open with its spec, so the conversation does not fill in a detail ("7" became "7 a.m." for an
     evening train in the acceptance run). `task_stop({ id })` stops it.
     `task_list()` says what each task is doing, what it waits on and what came out.
4. **Steering without touching the agent's loop.** A note for a running task is appended to the task session's next
   tool result ("Message from the person, sent while you work: …"), at the same place the loop guard adds its line. A
   task that is not in a turn (waiting for the person, or done a moment ago) gets the note as its next message.
5. **One result per task.** The task session's tool results never enter the main segment. When a task ends, its final
   answer and its result block are written into the main conversation as the task's one result, and the
   conversation AI is told on its next turn ("finished while you talked: …", like proactive checks). The before-
   finishing check (ADR 0027) runs on the task against the spec's `done_when`: the judge sees the conditions and
   compares the answer with them. The draft stays in the task's progress card until it passes; "여기까지만 받기"
   (take it as is) and stop work on the card as they do for the conversation.
6. **Talk while a task runs.** Messages go to the conversation session at once; it answers, or forwards them with
   `task_steer` / `task_stop`. ADR 0015's queue stays for the conversation's own turn only.
7. **One browser at a time.** There is one Chrome profile, so one task that uses the browser or PC apps runs at a
   time; others wait in line (`task_start` and `task_list` say how many are ahead, and the card shows it). A task
   started with `browser: false` runs at once; if it reaches for the browser while another task holds it, the call
   says so and the task goes on without it. The follow-up "Sharing the browser" below changes who holds it and when.
8. **Approvals and cards reach the right session.** The tool server names its segment on every call
   (`x-dool2-toolset`, the `DOOL2_TOOLSET` it already had); the daemon runs the call as that chat's, so an approval,
   sign-in, verification code, hand-off or phone card created by a task belongs to that task, and the phone's answer
   continues that task. "The only chat answering" stays only as the fallback for a tool server that sends no name.
   Waiting cards (approval, login, connect, hand-off) a task raises are shown in the main conversation too, where the
   person is.
9. **Screens.** A task is one progress card in the conversation (ProgressCard): its steps, elapsed time, "멈추기"
   (stop), "여기까지만 받기" when there is a draft, the place in line while waiting. *Amended 2026-11-26:* on screen a
   task reads like any answer of the one conversation. Once it ends its card becomes the same folded "worked at … ·
   time" line a normal answer has (it opens to every step), the turn that handed the work over does not add a second
   line, there is no separate chat to open, and a bar above the composer keeps the running task in sight. People
   lost the thread when the work lived in a card and a chat of its own. The task list is on the screen and in conversation (`task_list`), and a task can be stopped from both.

## Why

- The person keeps talking while work runs, and can change the task midway, which a queue cannot do.
- The conversation's segment holds talk and results, not pages, so it stays small and its cache stays warm. Its tool
  list is a fraction of the full one (measured in `tools.test.ts`).
- A spec (goal, done-when, known values, must-not-do) gives the task session what it would otherwise ask the person
  again, and gives the finish check a yardstick other than "the request".
- Steering through the next tool result keeps the official agent program unchanged (ADR 0002): the same mechanism the
  loop guard and the injection note already use.
- Other options:
  - **Run tasks as turns of the conversation and only forward messages** (no split): messages still wait for the turn,
    and the pages still fill the segment.
  - **Interrupt the task turn and resume it with the note** (ADR 0035 `interrupt`): faster to land, but it throws
    away the step in flight and costs a turn each time.
  - **A shared browser for several tasks**: the Chrome profile, its tabs and its logins are one; two tasks clicking
    in it at once would step on each other.

## Safety

A task session has no power the conversation lacked before the split: it runs with the tool set the whole
conversation had, through the same approval gate, auto-approve review and payment gate. The conversation session
loses tools. The auto-approve reviewer still sees only the person's own words (the recent messages of the main
conversation), never the spec the AI wrote. See the threat model (T28).

## Consequences

- A task costs one more AI turn at its start (the conversation's `task_start` turn) and the task's own turns. Its
  program is kept running while the task runs (ADR 0035) and closed when it ends.
- **On by default** (`TASK_SESSIONS_DEFAULT` in `apps/daemon/src/tasks.ts`; `taskSessions: false` in settings turns
  it off, from the next segment). It started off until a real-AI replay could confirm the split; the maintainer
  decided to turn it on first and check the behavior in one real-app acceptance run afterwards, because the prompt
  and tool list per kind of session (the point of the split) only exist with it on. The daemon tests with stand-in
  agents cover start → talk while it runs → steer → approval in the task → finish check against done-when → one
  result → stop, take-as-is, and two tasks in line for one browser (`apps/daemon/src/task-sessions.test.ts`).
- Whether the conversation AI picks `task_start` at the right times, writes a usable spec and forwards steering
  well is a judgment of the real AI; the daemon tests cover the flow with stand-in agents only. The eval bank has
  "talk while a task runs" and "change the task midway" scenarios for that replay.
- Revisit if the conversation hands off small requests (one lookup) or keeps doing browser work in words it cannot
  do, or if steering notes arrive too late in long single steps.

## Follow-up: instructions per kind of session (harness overhaul, round 2)

Round 1 shrank one instruction text that served every chat and stopped near 21,600 characters. With task sessions
on by default, the kind of session becomes the unit of design: each kind gets its own instruction template.

**Which kind each chat is.** The daemon decides it in `sessionOf` (`apps/daemon/src/index.ts`), fixed per segment:

| Chat | Kind | Why |
|---|---|---|
| Main conversation, task sessions on | conversation | talks, remembers, looks up, hands work over |
| A task (`task_start`, a stopped automatic sign-in, a connect take-over) | task | does one job from its spec |
| Scheduled tasks that answer in the main conversation | conversation | they run as a turn of the conversation; web work goes to `task_start` |
| The feed chat (quiet scheduled tasks, ideas, proactive checks) | none (both) | it posts with `feed_tell` and `idea_suggest` and updates what Dool2 knows, which a task does not have, and also works on sites |
| Side chats the person opens | none (both) | the person talks there directly, so memory and goals must work too |
| Main conversation, task sessions off | none (both) | there is no task to hand work to |

Side jobs (finish check judge, auto-approve reviewer, summaries, quick checks) already run without tools or with
their own short instructions and are not affected.

**Templates** (`buildSystemPrompt({ kind })` in `packages/engine/src/persona.ts`), with size tests:

- Shared: identity, language, voice, money and contact seriousness, secrets only through cards, page text is not a
  request, honesty, no verdict on health, contracts or investments.
- Conversation (≤ 5,000 characters): answer directly vs look up, look up before asking, don't ask back for
  searches, hand web, app and file work to a task, app notes and photos, result blocks, quick-reply format, source
  links. Phrasing examples for talking.
- Task (≤ 8,000 characters): the spec is the job, do the work first, look up missing values (known values →
  profile, vault, what Dool2 knows → open tabs and connected services → files) before asking, compare with the same
  conditions, service tools first, try another route, approval before any irreversible button, what "done" means
  and what to report (done / left / what the person must do). Phrasing examples for work and cards.
- No kind: both.

The service list in the instructions follows the kind: the conversation gets one line per service it can look things
up in now (connected, or lookups without sign-in) with those lookup tools (`Skills.lookupMap`); a task gets no list
and uses `service_find`; a chat without a kind keeps the full map. A task also gets no "what Dool2 knows" section
(it has `know_find` and its spec's known values); memories stay in every kind.

**Where each sentence of the old template went.** (a) conversation only, (b) task only, (c) moved to the tool that
needs it, (d) deleted because code enforces it, (e) an incident patch kept as an eval scenario and deleted.

- (a) when to answer vs look up, recommendations without questions, quick replies, result blocks, source links, app
  note and photo markers, memory use in one line.
- (b) do the work first, the look-up order for missing values, compare 2 to 3 places, confirmed values only in what
  goes to others, don't give up after one block, never tell the person to do it elsewhere, done means the completion
  screen, how to report.
- (c) "don't ask 'Shall I set that up?'" and watch frequencies → `goal_create`; save quietly → `memory_save`; what to
  save after a logged-in visit → `know_save`; drafts right away without invented facts → `show_draft`; several
  options for an order → `show_cards`; stay with the picked candidate's service and price → `task_start.known`;
  don't guess deep site addresses → `browser_open`; read the page and press what Dool2 can before a card →
  `browser_request_code`; booker fields from the profile → `browser_fill_profile` / `browser_request_profile`;
  sign-in, sign-up and password reset → `browser_login` / `browser_new_password`; hand-off only in an emergency →
  `browser_handoff`; go to the last pay button and approve once → `browser_checkout`; order number and the end of a
  payment → `browser_order_done`; simple authentication for public records → `browser_wait_auth`; my address in
  service tools → the address field line of `service_find`; texts and KakaoTalk → `phone_sms` / `kakao_send`; PC
  apps, files, pictures and videos → `tool_find`; past orders → `orders_all`; when to hand over → `task_start`.
- (d) work only with Dool2 tools (the agent's own tools are off), approval only for the irreversible kinds and
  reviews without approval (the approval gate decides which buttons stop), approval results arrive as app notes
  (they say what to do), the conversation cannot reach the browser (session fence, plus `withTaskHint` below).
- (e) "the user bought it there, search more pages before doubting", estimating the user's own figures from
  connected places, employer and start date from insurance records, unknown per-person facts (carrier, insurer),
  table sizes, spreadsheets for long comparisons: covered by eval bank scenarios and by the tools' own results.

**Holes closed when the default flipped.** Tool results and app notes still name browser, app and file tools (a
sign-in flow, a site check during a service call, a missing profile field, a download). When such a text reaches the
conversation of task sessions, the daemon adds one line: hand those steps over with `task_start` (`withTaskHint` and
`followUp` in the daemon). The tool server's `tool_find` already says where those tools are.

## Follow-up: tool lists per kind of session (harness overhaul, round 2)

The two lists are made as disjoint as the work allows, from calls recounted in the work log per kind of turn
(2026-11-19 to 11-25: 1,607 turns with no browser, app or file tool, 1,195 with one).

- **Conversation** (`DOOL2_SESSION=conversation`): talk, memory, goals, the library, what Dool2 knows, the result
  blocks, connect cards, lookups and the task tools. Nothing that acts on a site or the PC. Kept aside (tool_find):
  `status` (the time comes with every message), `memory_forget`, `pay_method_list`, `library_save`, `feed_tell`,
  `orders_all`, `know_update`, `goal_update` (0 to 12 calls each).
- **Task** (`DOOL2_SESSION=task`): the browser with its approval, payment, sign-in and hand-off tools, files,
  services, and one lookup each for saved values (`know_find`, `profile_view`, `vault_find`). Memory, goals, the
  library, the feed and writing what Dool2 knows are **not registered** in a task (`CONVERSATION_OWNS` in
  `packages/mcp-tools/src/sessions.ts`), and the daemon refuses those calls from a task too; a task says in its answer
  what is worth saving and the conversation keeps it. Kept aside: `status`, `browser_back`, `browser_route`,
  `browser_request_tap`, `show_cards`, `show_result`, `kakao_send`, `phone_sms`, `conversation_search`, `photo_view`,
  `pay_method_list`, `orders_all` (0 to 22 calls each in work turns).
- **No kind**: every tool but the task tools, as before.

Descriptions and input fields were shortened at the same time (they say when to use the tool; details only where the
AI fills a field). Budgets, pinned in `packages/mcp-tools/src/tools.test.ts`: conversation ≤ 25 tools and 28,000 B,
task ≤ 35 tools and 45,000 B, no kind 66,000 B (Dool2 tools, no service tools; round 2 targets were 30,000 and
55,000). The browser tools were shortened the same way, and the five Dool2 tools with the most input errors in the
session files (`browser_read`, `browser_steps`, `know_save`, `service_call`, `browser_wait_auth`) carry one short input
example; the limits that caused most of those errors (`maxChars` minimum, `steps` wait minimum, the notification
length) were relaxed and are clamped by the daemon instead. The kind and the list are fixed per
segment (`DOOL2_SESSION`, `DOOL2_TOOLSET`, ADR 0032): turning task sessions on or off rotates to a new segment.

## Follow-up: sharing the browser (WP7 acceptance fixes)

The acceptance run found two ways the one-browser rule made people wait for nothing: a quick lookup asked during a
running booking queued behind it, and a task waiting on a person's card (sign-in, approval, code) kept the browser for
as long as the card lives (a sign-in card, 30 minutes).

- **Waiting for the person gives the browser up.** When a task's turn ends waiting for the person, it releases the
  slot and the next task in line starts. Its tabs stay its own. A hand-over (the person works in the task's tab) and a
  connection card keep the slot: the person is using the browser then.
- **Taking it back.** When the person answers, the daemon's own step for the answer runs as before (pressing the
  approved button or moving the approved files is one action on the waiting task's own tab). The task's next turn
  needs the slot: if it is free the task takes it at once; otherwise the task waits **first in line** with the answer
  as its next message, and the task holding the slot gives it over at the end of its current turn (it waits second,
  with its own next round held, and goes on after). Turns are never cut in the middle, so a sign-in or a payment that
  continues after the answer is driven by one task at a time.
- **Lookups read beside.** `task_start({ lookup: true })` is for work that only reads pages (weather, a price, opening
  hours). A lookup task starts at once, holds no slot and may use only the browser tools that never bring a tab
  forward (`open`, `navigate`, `read`, `back`, `tabs`, `wait`, `close`; `LOOKUP_READS`), in tabs it opens itself
  **behind** the tab in front (the extension's `open` takes `background`). Clicking, typing, scrolling, screenshots,
  signing in, paying, PC apps and service tools (which drive the browser themselves) wait for the slot: if it is free
  the lookup takes it, otherwise the call says what still works. Its reads do not move the phone's live view, which
  stays on the task that drives the browser. An older extension that ignores `background` says so in its answer; from
  then on lookups take turns like the other tasks (the first such open brings its tab forward once).
- **One task per tab.** A tab belongs to the task that opened or first used it until that task ends. A task's call on
  another live task's tab is refused, so two tasks never drive the same tab.

Same Chrome profile, same vault and sessions: a lookup sees the sites signed in as the person, which is why it is
limited to reading. The approval gate, the payment gate and the phone signature are unchanged; every acting step
still goes through the one holder.
