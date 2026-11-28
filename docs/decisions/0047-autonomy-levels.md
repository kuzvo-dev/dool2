# 0047. Three autonomy levels the user chooses: ask, auto, full-auto

- Status: Accepted
- Date: 2026-11-28
- Related: [0011 login vault](0011-login-vault.md), [0023 my payment methods](0023-my-pay-methods.md),
  [0030 auto-approve](0030-auto-approve.md), [0043 chip approval keys](0043-chip-approval-keys.md),
  [0045 tools are shortcuts](0045-tools-are-shortcuts.md); supersedes the single `autoApprove` switch of ADR 0030;
  threat model T2, T3, T15, T22, T25, T35, T36, T37
- Amends: ADR 0030 (auto-approve becomes level 2), ADR 0011 and ADR 0023 (a level-3 exception for the payment PIN)

## Context

ADR 0030 added one switch, `autoApprove`: off, every pay/send/delete/contact waits for a phone card; on, everything
except payment runs after a small tool-less reviewer (the 2026-11-25 amendment) that turns requests unrelated to what
the user asked back into cards. Payment always asked, in both positions of the switch.

Two kinds of user pull on that one switch. Some want the full brake back: a card before anything leaves. Others,
after living with auto-approve, want Dool2 to finish a job end to end, payment included, without being asked each
time — the way you would let a trusted assistant spend up to a set amount. A single on/off cannot hold both the
"ask me for everything" and the "handle it, within a cap" ends at once, and "handle payment too" is a bigger step
than the rest: it needs a spending cap, a signed consent, and the payment PIN somewhere Dool2 can type it.

The maintainer decided (2026-11-28) to make the choice explicit: three named levels the user picks, with the biggest
step gated hard in code and on the phone.

## Decision

One user-chosen setting, `autonomyLevel`, with three values. The daemon enforces the level in code at the one gate
every action passes (not in the prompt), exactly as the `autoApprove` switch did.

### Level 1 — 허락받기 (ask)

Every pay, send, delete and contact waits for a phone approval card, as the product did before ADR 0030. The default
for a user who turns auto off. No reviewer runs, because nothing auto-runs.

### Level 2 — 자동 (auto)

This is ADR 0030's auto-approve, renamed. Everything except payment runs without asking, with the small tool-less
reviewer (the ADR 0030 2026-11-25 amendment) in front of each auto decision: it sees only the user's own recent
messages and the normalized facts of the request, and a request that does not match what the user asked becomes a
normal phone card (fail closed). **Payment still always asks** — a `money` request or one with an amount is never
auto-approved at this level, unchanged from ADR 0030. The reviewer's "unrelated" flag is a block (it holds the action
as a card).

### Level 3 — 완전 자동 (full-auto)

Nothing asks, payment included. This level is enabled **only from the phone**, with a signature from the phone's
secure chip (ADR 0043) and a one-time consent whose wording is `결과를 보장할 수 없고 모든 책임은 사용자에게 있습니다`
("we cannot guarantee the outcome and all responsibility rests with the user"). What changes at this level:

- **A spending cap always exists.** The user sets its amount during onboarding and can change it later with a
  phone-signed request. The daemon checks every payment against the cap in code; there is no full-auto without a cap.
- **Payment runs without a card,** within the cap and the merchant rules, after the daemon confirms the stored
  full-auto consent and the cap (no person in the loop for that payment). The "payments always ask" rule of levels
  1–2 is lifted here, and only here.
- **The first payment to a new merchant still asks.** A merchant the user has never paid before raises one phone
  approval card bound to amount + merchant (ADR 0043); after that, repeat payments to that known merchant run
  within the cap without a card. This keeps a prompt injection from paying a brand-new recipient silently (T35).
- **The payment PIN is stored in the vault only in this mode.** Dool2 types it into the site's secure keypad; the
  AI never sees it (the vault fills it directly, like every other secret, T15). Turning the level off removes it.
- **The reviewer's "unrelated" flags become notifications, not blocks.** The reviewer still runs and still names
  what looked unrelated, but at this level that is told to the user as a notification instead of holding the action.
- **CAPTCHA default stays a phone hand-off.** Only at this level may the user turn on `캡차도 알아서` ("handle
  CAPTCHAs too") with a separate consent that says it may get the site blocked or the account flagged. Default,
  and every other level, hands CAPTCHAs and identity checks to the person (T8).

### What holds at every level

These do not change with the level, because safety sits at the action, not at the capability (ADR 0045):

- **Secrets never reach the AI.** Passwords, card numbers and the payment PIN are filled by the vault straight into
  the page or the secure keypad; the AI gets masked labels or references, never the value (T15, T22).
- **A big STOP on the phone and the PC** cancels the chat's turn and every running task (ADR 0030 2026-11-26).
- **A full activity log** keeps one line per decision (what, where, how much, the level, and for full-auto the cap
  check), with no secret or message content.
- **The daemon enforces the gate in code,** not the prompt. The level is a daemon setting the AI cannot change; a
  change to a more permissive level is a phone-signed action.
- **The phone signature binds to the exact action** — recipient, amount, merchant, and the action hash — and the
  daemon re-checks that the action it executes matches the signed one before pressing (T2, T10, ADR 0043). At level
  3, where a given payment carries no fresh per-action signature, the stored consent, the cap, and the first-use
  merchant rule below stand in for it.

## Why

- **One switch could not carry three intents.** "Ask me for everything", "handle everything but money", and "handle
  money too, up to a cap" are three points, not two. Naming them lets the UI state each one's trade in plain words
  and lets the daemon gate the biggest step hardest.
- **Full-auto payment is the one step that removes the person from money.** So it is the one that gets the most
  code: a cap that always exists, a phone-chip signature to turn on, a one-time consent in the user's own words, and
  the PIN stored only here and only for the vault to type. The reviewer stays (as notifications), the log stays, the
  secrets stay out of the AI.
- **Options considered and rejected:**
  - *Keep the single `autoApprove` switch and add "allow payment" as a second toggle.* Rejected: two independent
    toggles hide that "allow payment" is a different kind of step (cap, consent, stored PIN) and make the dangerous
    combination look like just another checkbox.
  - *Let full-auto run without a cap.* Rejected: an unbounded spend with no person in the loop is the worst failure
    of a prompt injection (T35). The cap is the floor under the mode.
  - *Store the payment PIN in the vault always, gated only at use.* Rejected: the PIN is stored only when the mode
    that needs it is on, so a user who never enables full-auto never has a stored PIN to leak (ADR 0011, ADR 0023).

## Consequences

- **ADR 0030 is extended:** its auto-approve becomes level 2 unchanged, including the reviewer and "payments always
  ask". The single `autoApprove` boolean is replaced by `autonomyLevel` (ask/auto/full-auto); a user who had
  auto-approve on maps to `auto`, off maps to `ask`.
- **ADR 0011 and ADR 0023 get a level-3 exception:** "the payment PIN is never stored in the vault" now reads "never
  stored in the vault except in 완전 자동, where the vault types it into the site's secure keypad and the AI never
  sees it". This ADR records the exception; the code change that stores and types the PIN lands in a later PR.
- **New threat rows** T35 (full-auto payment driven by injection), T36 (payment PIN in the vault, level 3 only) and
  T37 (`캡차도 알아서`) are added to the threat model.
- **The author's recorded caution:** full-auto payment and CAPTCHA self-solving carry real risk to the user's
  account — a site may block or flag an account that solves its own CAPTCHA, and an automated payment removes the
  person from the one action that is hardest to undo. Both are opt-in, each behind its own explicit consent, and
  neither is ever the default.
- **Revisit** if the spending cap or the first-use merchant rule proves too loose on the test PC (tighten the rule
  and update T35), or if a way is found to reach the stored PIN outside the vault (then level 3 is reworked and T36
  updated).
