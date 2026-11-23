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
