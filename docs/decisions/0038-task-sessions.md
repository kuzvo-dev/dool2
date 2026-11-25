# 0038. The conversation hands longer work to a task session

- Status: Accepted (behind the `taskSessions` setting, off by default; see Consequences)
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
   - `task_steer({ id, note })` passes the person's words to a running task. `task_stop({ id })` stops it.
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
   says so and the task goes on without it.
8. **Approvals and cards reach the right session.** The tool server names its segment on every call
   (`x-dool2-toolset`, the `DOOL2_TOOLSET` it already had); the daemon runs the call as that chat's, so an approval,
   sign-in, verification code, hand-off or phone card created by a task belongs to that task, and the phone's answer
   continues that task. "The only chat answering" stays only as the fallback for a tool server that sends no name.
   Waiting cards (approval, login, connect, hand-off) a task raises are shown in the main conversation too, where the
   person is.
9. **Screens.** A task is one progress card in the conversation (ProgressCard): its steps, elapsed time, "멈추기"
   (stop), "여기까지만 받기" when there is a draft, the place in line while waiting, and a way to open the task's
   detail. The task list is on the screen and in conversation (`task_list`), and a task can be stopped from both.

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
- **Off by default** (`TASK_SESSIONS_DEFAULT` in `apps/daemon/src/tasks.ts`; `taskSessions: true` in settings turns
  it on, from the next segment). The daemon tests with stand-in agents cover start → talk while it runs → steer →
  approval in the task → finish check against done-when → one result → stop, take-as-is, and two tasks in line for
  one browser (`apps/daemon/src/task-sessions.test.ts`). They cannot cover what the real AI does with the split: the
  instructions still describe browser work, and the conversation must reach for `task_start` instead. Turn the
  default on after a replay of the eval bank's run-and-approve types with the setting on keeps its score.
- Whether the conversation AI picks `task_start` at the right times, writes a usable spec and forwards steering
  well is a judgment of the real AI; the daemon tests cover the flow with stand-in agents only. The eval bank has
  "talk while a task runs" and "change the task midway" scenarios for that replay.
- Revisit if the conversation hands off small requests (one lookup) or keeps doing browser work in words it cannot
  do, or if steering notes arrive too late in long single steps.
