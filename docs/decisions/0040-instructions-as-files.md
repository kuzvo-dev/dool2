# 0040. Dool2's instructions live in text files and can arrive in a connector pack

- Status: Accepted
- Date: 2026-11-25
- Related: [0029 language and region](0029-language-and-region.md), [0032 pinned instructions](0032-pinned-instructions.md),
  [0038 task sessions](0038-task-sessions.md), [0039 connector packs](0039-connector-packs.md), threat model T2, T12

## Context

Dool2's instructions were a template string in `packages/engine/src/persona.ts` and per-language voices in
`locales/persona.ts`. They change more than any other file: `persona.ts` changed 83 times in the 14 days to 11-25.
Every change, even a single phrasing example, waited for an app release. Connector packs (ADR 0039) already carry
signed data to installed apps, but the instructions were code.

## Decision

- **The text moves to `prompts/`**: `persona.md` (the shared rules, English, ADR 0029) and `voice/<lang>.md` (how
  Dool2 sounds, split into parts by `<!-- name -->` lines). A small template fills them in: `{{value}}`,
  `{{#flag}}…{{/flag}}` (only when set) and `{{^flag}}…{{/flag}}` (only when not). The parts that differ by kind of
  session (ADR 0038) and by the user's settings are sections; markers other code parses (`답`, `사진`) are values.
- **The money and contact rules stay in code** (`MONEY_RULES`). `persona.md` holds a `{{money}}` slot exactly once,
  and a set of files without it, or with any part left unfilled, is refused. Approval is enforced by the daemon
  anyway (T2, T12); this keeps the instructions from contradicting it.
- **The engine carries the files** (`locales/prompts.gen.ts`, made by `pnpm prompts`; a test fails while it differs
  from `prompts/`). A connector pack also carries `prompts/`; the daemon takes the set only if `checkPromptFiles`
  finds no problem, and switches with `setPromptFiles`. The instructions are pinned per segment (ADR 0032), so the
  next segment gets the new ones. Putting the pack back returns to the carried files.
- **The move changed no word**: a test compares the hash of the instructions for all 108 combinations (2 languages,
  3 kinds, 3 tones, 3 lengths, with and without a name) with what the code made before the move.
- **Test PCs first, then everyone.** A change to `prompts/` builds a beta pack like a connector change. The nightly
  eval on the test PC reads it before a maintainer promotes the pack (`.github/workflows/packs.yml`). The repo CI does
  not run the AI evals on each change (they need real AI runs).

## Consequences

- Phrasing and working rules reach installed apps without a release. A change that also needs a new tool still ships
  with the app (the tool and its line in the instructions go together).
- Editing the instructions means editing `prompts/` and running `pnpm prompts`. `prompts/` is left out of the code
  formatter (it would change the text the AI reads).
- AGENTS.md still applies: fix by sharpening tools before adding a rule to `prompts/persona.md`.
