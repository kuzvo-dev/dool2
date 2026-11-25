# 0030. Auto-approve: everything except payments without a card

- Status: accepted
- Date: 2026-11-23

## Context

Every action that sends something, deletes something, changes something on the PC, or lets Dool2 control a new app
waits for an approval card on the phone (ADR 0006, ADR 0012). That is the right default, but some users want Dool2 to
just get things done and only stop when money leaves their account. Asking them to approve every message and every
app makes Dool2 feel like a form, not a secretary.

## Decision

Add one setting, `autoApprove` (off by default). When it is on:

- Approval requests are still created the same way, through the one gate every tool uses (`Approvals.create`). The
  gate marks the ones auto-approve takes (`auto: true`), and the tool route approves them before it answers the AI.
  The AI gets "done" instead of "ask the user", so the conversation does not stop.
- **Payments always ask.** A request with kind `money` or an amount is never auto-approved, whatever the setting.
- Auto-approved requests are not sent to the phone as cards (no push). They stay in the conversation as a line that
  says Dool2 did it on its own, and in the activity log (`auto-approve`).
- A text (SMS) is sent by the phone, so the phone sends it on its own when its app is open and the recipient is
  clear. If several contacts match, the phone still asks which one.
- It can be turned on in the PC settings or on the phone. A change from the phone is signed with the phone key and
  checked by the PC (`autoApproveSignText`), so the relay cannot turn the gate off.

## Consequences

- The phone key no longer signs each non-payment action while auto-approve is on. Users choose this trade, and the
  settings say so in plain words.
- Payment flows are unchanged.
- New approval kinds are covered automatically. Anything that must always ask has to be a payment, or the gate needs
  a new exception here.

## Amendment: a review before every auto decision (2026-11-25)

With auto-approve on, a web page, mail or file with hidden instructions could make Dool2 send, forward or delete
things the user never asked for, and nothing stood between that request and the button. The gate stays, and one
layer goes in front of the auto decision.

- **What is reviewed.** Every request auto-approve would take (everything except payments). Payments never reach
  the review; they always ask, as before.
- **Who reviews.** A small AI call with no tools and no Dool2 instructions: a fresh Claude Code session on a small
  model (`haiku`), only when the chat runs on Claude (the user's own sign-in, same as the agent). It sees only:
  - the user's last few messages in the chat that is working (what they typed, no app notes), and
  - the normalized facts of the request: kind, site (host only), button, recipient, amount, file list, and the
    one-line "what it does".
  It never sees the agent's explanation, tool results or page content. Its answer is one line, `{"related": bool}`.
- **Fail closed.** If the action does not match what the user asked, or the review cannot run (another agent,
  no request to compare with, an error, no answer within 45 seconds, an answer it cannot read), auto-approve does
  not take the request: it becomes a normal card on the phone with one line saying why
  (`ApprovalView.held`: `unrelated` or `unchecked`). The AI is told the same and asked to tell the user what the
  card is for. A text (SMS) is only handed to the phone to send on its own after the review passes.
- **Pause.** After 3 blocks in a row or 20 in a day (only `unrelated` counts), auto-approve pauses until the next
  day, a restart, or the user turning it on again in settings. The user gets one notification, and the AI is told
  to say it in the chat. The switch itself is not changed.
- **Not a replacement.** The review is one more layer in front of the gate, not a replacement for it: a published
  study of the same kind of classifier found it missed about 17% of overreaching actions. Payments still always ask,
  the daemon still presses only the one button that was approved, and every other rule of the gate stays.

### Consequences

- Each auto-approved request costs one small AI call on the user's subscription and adds a few seconds before the
  tool answers. Requests that would have asked anyway (auto-approve off, payments) cost nothing.
- Users on Codex or pay-as-you-go got a card for every request even with auto-approve on, until the review ran on
  every agent (change of 2026-11-25 below).
- A request that is a clear step of the user's task but is phrased far from their words can come as a card. That
  is the safe direction; the card says why.
- The work log keeps one line per decision (`auto-approve`: kind, ok, `held`, review time) and the pause
  (`auto-approve-paused`), with no message content.

## Change (2026-11-25): the review runs on every agent

The review no longer needs the chat to run on Claude. It runs on the agent of the chat that is working, with the
user's own sign-in or key, on that agent's small model (ADR 0037 role `review`), as a side job: a fresh program with
no tools at all and no Dool2 instructions.

- **Claude Code**: as before (`--tools ""`, no tool server, `haiku`).
- **Codex**: `codex app-server` with no tool server, the review instructions in place of Codex's own
  (`baseInstructions`), Codex's permission, environment, apps and collaboration notes left out, a thread that is not
  saved (`ephemeral`), the lightest thinking, and the catalog's small model (`gpt-6-luna` in the pinned 0.169.0, or
  Codex's default if the catalog does not list it). Any tool-like item in the answer (a Dool2 tool, a sub-agent, a
  plan, an image) stops it, and a stopped review is an unchecked one.
- **Pay-as-you-go (OpenCode)**: a session with every tool denied and no tool server, on the small model of the
  provider the user picked when one is known (Anthropic and OpenAI keys); otherwise their chosen model. The call is
  billed to their key like every other call.

The facts sent are the same, and they go to the same AI provider that already runs the chat. Fail closed is
unchanged: no working chat, an error, no answer in 45 seconds or an unreadable answer is a card on the phone.

## Change (2026-11-25): the review waits up to 45 seconds

It waited 25 seconds. In the round 2 acceptance run a request the user had asked for in so many words ("leave this
comment") came back unchecked after 25.0 seconds and became a card. A fresh review program measured 21 s when cold
and 2.7 to 3 s when warm on the same PC; with a task's own turn running beside it, 25 s was not enough. The wait is
now 45 seconds (`REVIEW_TIMEOUT_MS`); fail closed is unchanged, only fewer requests the user asked for end up as cards.
