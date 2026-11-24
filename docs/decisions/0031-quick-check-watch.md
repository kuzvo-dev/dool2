# 0031. Quick checks: watches check every minute without the AI, and wake it only on a change

- Status: Accepted
- Date: 2026-11-24
- Related: [0019 proactive check](0019-proactive-watch.md), [0018 service connectors](0018-service-connectors.md)

## Context

A goal that repeats "every N minutes" was limited to 15 minutes or more. The reason was never written down, but it
follows from how a run works: every run is a full AI turn.

- Each run uses subscription quota. Every 5 minutes is 288 turns a day.
- There is one conversation with one turn at a time (ADR 0015), so frequent runs make the user's messages wait.
- A turn often takes longer than a minute, so a 1-minute run would start before the last one ends.

But the things people most want watched vanish fast: cancelled tickets, open tables, restocks, flash deals. 15 minutes
is too slow for them. The user asked for 1 minute.

## Decision

1. **A watch can have a quick check**: a **lookup** service tool and its input (`check_tool`, `check_input` on
   `goal_create` / `goal_update`).
2. At each set time the **daemon runs that tool itself, without the AI**, and compares the result with the last one
   (`apps/daemon/src/routine-check.ts`).
   - The first result is only the baseline (the AI already showed what exists when the watch was made).
   - A change is judged on the tool's structured result (its rows), not its wording.
   - **Only on a change** is Dool2 (the AI) woken, with "before" and "now", to judge whether the user's condition is met
     and notify (the watch's usual `when_found` flow).
   - After 3 failures in a row (site changed, signed out), Dool2 is woken once to look the usual way.
3. **Intervals**: with a quick check, every **1 minute** or more, but never shorter than the service's own minimum
   (`minIntervalSec` in `tools.json`; for example 5 minutes for open tables). The interval is raised to it, not refused.
   Without a quick check, tasks the AI runs stay at **15 minutes** or more.
4. **Safety**:
   - Only `lookup` tools. A quick check can never book, pay or send.
   - The daemon checks the tool (exists, is a lookup, usable, signed in if needed) and attaches it. The AI cannot set the
     internal `_check` field itself; it is dropped from the AI's input.
   - Every check is written to the work log (`quick-check`: outcome, failures).

## Why

- The cost of a check without the AI is one page read in the user's Chrome, the same as a person refreshing. No quota,
  no blocked conversation.
- It keeps the "human speed, no hammering" principle: the service minimums still hold, and 1 minute is the floor the
  architecture already allows for repeated lookups (architecture 5.1.1).
- The AI still decides what the change means, so the condition in plain words ("a table for 2 after 7 pm") keeps working.

## Consequences

- Watches on services without a lookup tool still run the old way (AI, 15 minutes or more).
- A site that changes some field on every read (a timestamp, a random order) would look like a change each time. The
  AI then judges it unmet and stays quiet, but it costs a turn. If that shows up in the work log, the connector's
  `output` should drop that field.
- Checks use a tab in the user's Chrome every interval. Checking stays at the service minimum to keep this light.
