# 0041. A connection is a specific account

- Status: Accepted
- Date: 2026-11-25
- Related: [0011 login vault](0011-login-vault.md), [0014 connect cards](0014-connect-cards.md), [0018 service connectors](0018-service-connectors.md),
  threat model T29

## Context

A connection meant "some account is signed in". The connect flow opened the site, and when it saw a signed-in page
(no sign-in fields, or "log out" text) it marked the service connected. Nothing checked which account it was.

Measured on the test PC (2026-11-25): Gmail was connected with an ID and password while Chrome was already signed
in to another Google account. The flow saw that inbox, ended "signed in" in 4 seconds and never used the typed
account. Every Gmail tool then opened `/mail/u/<typed account>/` and met Google's "Temporary Error (404)". The AI
asked for the connect card again, but a service connected within 10 minutes shows no card, so the person saw the
same 404 over and over. On a site without the account in the address the same mistake is silent: Dool2 would read
or order in someone else's account.

Google also keeps several accounts side by side in one browser, and signing in to Google with a typed password from
a script is what its security checks are built to stop.

## Decision

- **Cards say where the account shows.** `account` in `connect.json`: `url` (a page that shows the signed-in account;
  `{{account}}` fills in the account for services that address one account in the address, like Gmail's
  `/mail/u/<email>/`), `pattern` (group 1 is the account as typed on the sign-in form) and, for Google-style
  services, `pick`.
- **After a sign-in ends "signed in", the daemon reads the account** on that page (`connect-account.ts`). It only
  counts on the service's own site, never on a chooser or sign-in page. The same account (also masked or ID-only)
  → connected, and the account is kept (setting `connectAccounts`). Another account → a phone question "Chrome is
  signed in as X. Connect with this account?"; no → the connection stops and says how to switch (the AI does not
  take that screen over). The typed account not in Chrome (Gmail's 404) → stops and says to pick or add it. No
  account readable → as before.
- **Google accounts are picked on the phone, not typed.** Cards with `pick` (Google account, Gmail, Google Calendar)
  do not show the PC screen. Dool2 opens Google's account chooser in a background tab, reads the accounts signed in to
  Chrome and asks on the phone which one, as buttons on the connect card (`connect_ask` starts this at once). It then
  presses that account's row, so Google goes on to the service as that account, and keeps the full address the page
  shows. An account connected before that is still in Chrome is used again without asking. Only a signed-out or new
  account needs Google's own sign-in (with its two-step checks), and only that screen goes to the person. Dool2 never
  types a Google password: re-login with the vault and the keep-connected check skip these cards.
- **Tools use the account that was read.** `{{account}}` in a tool comes from `connectAccounts` first, then the
  vault ID. Calendar tools now pass `authuser`, like Gmail's `/mail/u/`.
- **A tool's sign-in screen beats the connected mark.** When a tool stops at a sign-in screen (`stop_if` with
  `login`), the daemon takes the mark off (also from the service it shares a sign-in with), so the next
  `connect_ask` shows a real card instead of "just connected".
- **The phone shows which account it is**: "Gmail is connected · m***@gmail.com".

## Consequences

- The wrong-account case now stops with a question instead of quietly working in another account.
- Only cards with `account` are checked. Google cards and Kakao have it (patterns measured on real pages); other
  cards get it as connector work measures their signed-in pages (`.claude/skills/connector`).
- Reading the account opens one more page after connecting (about 2–6 seconds).
- Older apps fall back to their bundled cards when a connector pack carries a card with `account` (ADR 0039).

## Alternatives considered

- **Fill in Google's sign-in form with the vault password ("add account").** Google treats scripted password entry
  as suspicious and asks for identity checks or blocks it; it would also put a Google password through Dool2.
- **Read the account list from Google's internal endpoints.** Undocumented and can change without notice; the
  chooser screen is Google's supported way for a person to pick.
- **Keep the boolean mark and only fix Gmail.** The same mistake stays silent on every other site.
