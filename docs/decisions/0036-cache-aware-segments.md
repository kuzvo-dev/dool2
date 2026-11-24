# 0036. Cache-aware segments: switch after an hour away, with the handoff made while the cache lives

- Status: Accepted
- Date: 2026-11-25
- Related: [0015 one conversation](0015-one-conversation.md), [0032 pinned instructions](0032-pinned-instructions.md),
  [0035 resident agent session](0035-resident-agent-session.md)

## Context

The conversation is split into segments (ADR 0015). A segment switched after 12 hours without a message, and only then
carried the recent messages over; a summary was made only when switching for length, at the moment of the switch.

The provider caches a conversation for a while after each AI call, and a turn that hits the cache reads its long
history cheaply and quickly. On the subscription CLI Dool2 cannot choose how long. We measured it from the token usage
the official CLI keeps per AI call for this app's sessions on the maintainer's PC (aggregate numbers only; the journal
now records the gap too, `gapMs` in `cache` records):

| gap since previous AI call | turns | median share from cache | share ≥ 50% |
|---|---:|---:|---:|
| < 1 min | 699 | 100% | 100% |
| 1–5 min | 112 | 100% | 100% |
| 5–10 min | 61 | 100% | 100% |
| 10–30 min | 73 | 100% | 100% |
| 30–60 min | 45 | 100% | 100% |
| 60–61 min | 19 | 99% | 74% |
| 61 min – 3 h | 10 | 0% | ~20% |
| 3–12 h | 11 | 0% | 9% |

A second data folder (155 turns) shows the same cliff. The CLI writes 1-hour cache entries
(`ephemeral_1h_input_tokens`). Median input on these turns was 110–165K tokens, so a message after an hour away
re-read the whole segment at full price and waited for it, and kept doing so for every pause until the 12-hour switch.

## Decision

1. `CACHE_LIFE_MS` = 60 minutes. The idle switch (`idleMs`) is 65 minutes: just past the cache's life.
2. After 65 minutes, a segment switches only when the switch loses nothing:
   - a handoff summary was made ahead for it (below), or
   - it has fewer than 4 user turns (`HANDOFF_MIN_TURNS`): the 8 recent messages carried over hold all of it.
   Otherwise it switches after 12 hours (`staleMs`), as before.
3. The handoff is made ahead (`ConversationService.handoffLater`, called after each reply of the main conversation):
   - 50 minutes after the last reply (`HANDOFF_AFTER_MS`), while the cache still holds the segment, so the summary
     reads it at the cached price and the switch on the next message needs no AI call.
   - Once per segment, never for segments under 4 turns, cancelled when a new message arrives (also mid-summary),
     skipped if the PC slept past the cache's life.
   - It runs with `--resume <id> --fork-session` (ADR 0035), so the request stays out of the live session.
   - Stored in the settings table with the segment's `updatedAt` at that moment. A message after it makes it stale.
   - At the switch it is used whatever the reason (idle, length, AI change) and then cleared.
   - The journal records `handoff` (made or not, how long, turns).
4. Constants live in `packages/engine/src/conversation.ts` and are easy to change when the provider changes its cache.
5. The eval bank's memory type gets "continue what we did yesterday" scenarios (`mem.continue_yesterday`,
   `mem.continue_pending`, `mem.continue_promise`): with shorter segments, the handoff carries more.

## Why

- After an hour away, continuing the old segment costs the full read anyway. A new segment with a handoff reads the
  instructions plus a short summary instead, which is cheaper, faster and leaves room.
- 50 minutes rather than "a few minutes": most pauses end within half an hour (812 of 1,030 measured turns came within
  5 minutes, 207 within 5–60 minutes, 40 after an hour). A summary made 5 minutes after every reply would mostly be
  thrown away and cost quota each time; at 50 minutes almost only the pauses that do switch pay for one.
- The old rule stays as the fallback, so a PC that slept or a failed summary is never worse than before.
- Other options:
  - Switch at 65 minutes always, carrying only recent messages: loses the morning's work in long segments.
  - Summarize at the switch (as length switches do): the cache is gone by then, so it reads everything at full price
    and makes the user wait 10–20 s for the first word.
  - Keep the cache alive with pings: costs quota for every pause, and depends on CLI behavior we do not control.

## Consequences

- More segments; the AI relies more on the handoff and `conversation_search`. The new scenarios watch for that.
- A handoff made ahead and then not needed (the user returns between 50 and 65 minutes) is one summary's worth of
  cached reads.
- Revisit if the journal's `cache` records (`gapMs`, `share`) show a different cache life, or if `handoff` records show
  many made and not used.
