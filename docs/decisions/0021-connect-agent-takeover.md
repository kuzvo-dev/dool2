# 0021. Connecting: when automatic login stalls, Dool2 takes over in the conversation, and what it does is always visible in the conversation

- Status: Accepted
- Date: 2026-11-18

## Context

Connecting (logging in on the user's behalf) followed an order fixed by the daemon: find the login link, fill the fields, press the button, judge the result from the screen text.
It is fast (around 10 seconds) and uses no AI quota, but if the screen differed even slightly from that order it ended with "Could not find the login fields".

- Real-site check (2026-11-18, 74 connect cards, only finding the fields without typing or clicking): found 60, not found 9, human turn 2, failed to open 3.
  One in five fails before the ID and password are even entered.
- Connecting ran in the background and only text steps were visible. The user could not see what was happening now or why it stopped.
- What users said after trying it: "Connecting a service has never worked on the first try", "I can only tell what it is doing if it happens in the chat".

## Decision

1. **Automatic login first; when it stalls, Dool2 takes over.** When automatic login stops because it does not recognize the screen (`unknown`: does not know the login fields or the result),
   it does not end with a failure card. The daemon sends an app notice to the main conversation so that Dool2 (the AI) takes over that tab. Dool2 reads the screen and logs in, adjusting as it goes.
   Wrong ID or password (`wrong`) and a human turn (`human`: robot check, identity verification) are not taken over. They go to re-entering or handing off the screen, as before.
2. **Only once every 10 minutes per service.** If that still fails, the user finishes with [Do it myself on screen] (once done, the side that was watching marks it as connected on its own).
3. **Accounts still go from the vault to the fields only.** Dool2 only tells `browser_login` which fields, and the daemon passes the values straight to the extension ([0011](0011-login-vault.md)).
   For a taken-over tab only, the account entered when connecting is used even if the login screen is another address of that service's site (`login.site`).
   It is not entered on a screen that moved to a different site (such as a social login provider). If the vault holds several accounts for the same site, it gives the most recently added one.
4. **What Dool2 does is visible in the conversation.** The connect card shows the login screen live in small size (tap to open it large and do it yourself),
   and after the takeover it shows as the work screen and steps in the conversation. The same screen appears when working with service tools (announced the moment the daemon opens the tab).
5. **When connecting ends, back to the conversation.** Whether the user finished on screen or Dool2 did, it returns to the conversation and sends the deferred request (start right after connecting) onward.

## Why

- Matching the login screens of 81 sites with rules never ends. They go out of step again every time a site changes.
  Keeping the rules as the fast path, and letting the side that can read the screen take over when they fall out of step, raises the rate of connecting on the first try.
- Using the AI from the start is slow (30 to 60 seconds) and uses subscription quota. Where it works, it should still finish within 10 seconds as now.
- People can wait with confidence only if they can see what is being done. With hidden background work, even the reason for a failure is unknown.

## What we weighed

- **Log in with the AI from the start**: matches best, but is slow every time and uses quota. Not chosen.
- **Add more rules**: the approach so far. The fixing per site never ends, so not chosen (kept as the fast path).
- **Loosen the vault's address matching on a taken-over tab**: we allowed only other addresses of the same site. Going wider risks entering it on a phishing screen.

## Remaining work

- Measure the "connects on the first try" rate per service with real accounts and keep it as a table (`scripts/connect-test.mjs`).
- Record the takeover outcome (done, handed to the person, could not) per service, and fix the automatic login rules for services that are taken over often.
