# Dool2 v2 structure (greenfield)

The v2 rebuild follows the master plan (`~/.claude-web/exports/dool2-builtin-browser/DOOL2-MASTER-PLAN-V2.md`).
It is built on the `v2` branch; `main` and history stay intact until v2 replaces it. The old repo had no users, so
v2 does not preserve backward compatibility — it reuses the good parts (protocol, i18n, the downloaded-Chromium
browser, the skill resolver) and rebuilds the core around them.

## Target layout

```
packages/
  protocol/     shared types (kept from v1)
  i18n/         locale copy (kept from v1)
  core/         brain-agnostic core: autonomy gate (ADR 0047), the few tools, turn-loop contract   [new]
  brains/       one adapter per AI runner (claude / codex / pi fork), + a mock                       [new]
  browser/      Dool2's own hidden downloaded Chromium, driven over a pipe (ADR 0046)                [kept]
  skill-sdk/    SKILL.md frontmatter + the resolver that auto-injects a site skill by URL/keyword     [kept]
  sandbox/      the code-execution hand: a sandbox with read-only host bridges (page/vault/pc/fs)    [todo]
  vault/        secrets never reach the AI: fill/TOTP/payment-PIN into the page or secure keypad     [todo]
  skills/       the built-in skill pack + the pack format                                            [todo]
  packs/        signed resource-pack build/verify (skills ship as downloads, no store review)        [todo]
  ui/           shared UI parts                                                                       [todo]

apps/
  daemon/       owns the turn loop, the tools, the skills, and the autonomy gate                     [rebuild]
  desktop/      the app: invisible browser + chat                                                     [rebuild]
  phone/        approvals signed by the phone's secure chip; remote screen                            [rebuild]
  hands-mac/    PC-app control helper (mac)                                                           [kept]
  hands-win/    PC-app control helper (windows)                                                       [new]
  relay/        phone <-> PC relay                                                                     [kept]

chromium/       pinned Chromium build + patch set (later: our own fork)                               [todo]
```

## Principles (from the plan)

1. The browser is invisible — Dool2's own downloaded Chromium, not the user's Chrome, no extension.
2. Few tools, big hands — one `code` tool drives page/vault/PC/files; site knowledge is skills.
3. Skills are resources — signed packs, downloaded and updated apart from the app; the set grows daily
   (learn-by-watching drafts a skill; open connectivity, gated actions).
4. Safety in code + phone signature — the daemon gate (ADR 0047), not the prompt; secrets never reach the AI.
5. Three autonomy levels — ask / auto / full-auto; full-auto pays under an onboarding cap with the vault-held PIN.
6. Fast internals — the data path first (site API with the user session), diff/viewport snapshots, caching.
7. Korean-first; persona; easy install.

## Status

- `@dool2/core` — autonomy gate + tool/turn types, tested.
- `@dool2/brains` — adapter interface + mock, tested.
- Next: sandbox (code hand), vault, daemon turn loop wiring the three brains, skill pack format.
