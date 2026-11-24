# 0037. Model profiles and role routing: side jobs on a small model, one table for what differs per model

- Status: Accepted
- Date: 2026-11-25
- Related: [0015 one conversation](0015-one-conversation.md), [0027 finish check](0027-finish-check.md), [0031 quick checks](0031-quick-check-watch.md)

## Context

Every AI call Dool2 makes used the same model. Claude Code ran with `--model sonnet` for the user's requests and for
the side jobs around them: the before-finishing judge (ADR 0027) and a quick check waking Dool2 to judge a change
(ADR 0031). The judge read a few thousand characters and answered one line of JSON, yet took 10 to 20 seconds, and with
the draft design of ADR 0027 that time is how long the person waits for the result.

The segment limits of ADR 0015 (40 turns, 60,000 characters, 120,000 tokens) were constants in the conversation code,
with nowhere to say that another model needs other values.

## Decision

1. **One profile table** in `packages/engine/src/models.ts`, keyed by agent (`claude`) or agent and model
   (`claude:opus`). A more specific key overrides only the fields it names. A profile holds:
   - the segment limits (turns, characters, tokens). `DEFAULT_LIMITS` reads them; the 12-hour idle limit stays outside
     because it is about the person, not the model;
   - the small model for side jobs;
   - an instruction variant slot, empty for now.
2. **Entries only where a difference is known.** Today there is one: Claude Code takes a model per run, so its side
   jobs can use `haiku`. Codex runs the model set up in that program and OpenCode the model the user picked with their
   key; Dool2 passes no model per call to them, so they have no small model and side jobs stay on that model.
   No per-model tuning is added ahead of a measurement (eval replays per model, below).
3. **Roles** (`modelForRole`):

   | Role | Model | Why |
   | --- | --- | --- |
   | `task`: the user's request | the model the user chose (the agent's default when none) | the work itself |
   | `judge`: the before-finishing check | small | short text in, one line of JSON out |
   | `watch`: a quick check found a change | small | judge one change against a condition in plain words, in the separate chat |
   | `summary`: segment handoff | the chosen model | see below |

   The segment summary stays on the chosen model. It resumes the session right after the last turn, while the
   provider's cache of the whole conversation is warm. Provider caches are per model, so a small model would read the
   whole conversation again uncached, which costs more and takes longer than the cached read on the chosen model.
4. **`watch` only in the separate chat.** A watch that reports into the main conversation runs on the chosen model,
   so the main session keeps one model and its cache.
5. **Evals get an agent and model axis** (`evals/run.mjs --agent`, `--model`), so the same tape can be replayed per
   model and compared on score, time and how often the finish check sent work back. The model override is accepted
   only by a test PC daemon.

## Why

- The research behind the 0.5.0 harness work found judges and summaries running on the same large model as the work,
  and recommended routing by role. A small model answers short judging prompts in a few seconds.
- Keeping one table avoids per-model `if`s spread over the code, and the "only when measured" rule keeps it small.
- Other options considered:
  - **Run the conversation itself on a faster model.** Not decided: it needs replay evals per model first, which the
    new eval axis makes possible.
  - **Summary on the small model too.** Rejected for the cache reason above.

## Consequences

- The judge and quick-check change turns use less of the user's quota and answer faster. Their quality on the small
  model has to be watched: eval replays compare verdicts, and the work log keeps every verdict (`finish-check`).
- Adding a model-specific value is a one-line change in `MODEL_PROFILES`, with the measurement that justified it noted
  next to it.
- Revisit when an agent starts taking a model per call (then give it a small model), or when replays show a model needs
  different segment limits or instructions.
