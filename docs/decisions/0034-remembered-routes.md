# 0034. Remembered routes: walk a known path on a site without the AI at each click

- Status: Accepted
- Date: 2026-11-24
- Related: [0006 user Chrome extension](0006-user-chrome-extension.md), [0018 service connectors](0018-service-connectors.md), [0033 tools on demand](0033-tools-on-demand.md)

## Context

A tester said Dool2 "thinks forever" on simple web tasks. The work log and Claude session records (11-20 to 11-24)
show why: 73% of a turn's time is the AI deciding the next step, and every browser click is one full AI round trip.
`browser_click` was 19% of all tool calls and was followed by another click 318 times. A person clicks every 1 to 3
seconds; Dool2 took about 3.5 seconds per step (1.8 s for the click, 1.7 s for the AI to pick the next one).

Most of these walks repeat: home → [My page] → [Orders] on the same shop, week after week. Service connectors
(`skills/*/tools.json`) already show what a fixed walk costs: a connector call took 3.9 s at the median, while the
same work done click by click took 20 to 70 s. But connectors are written by hand, one service at a time.

Going faster must not get Dool2 blocked: it uses the person's real Chrome, real mouse input and a person's pace.

## Decision

1. **Record.** For each tab Dool2 opened (`browser_open`, `browser_navigate`), the daemon keeps the walk: the start
   address and the names of the links and buttons pressed. Clicks that open a menu on the same page are part of the
   walk. When a click moves the tab to another page and the walk has 2 to 6 clicks, it is kept as a route named
   after the page it ends on (`apps/daemon/src/routes.ts`, `routes.json` in the data folder).
2. **What is not kept.** Typing, keys, choices, uploads or anything else that makes the page depend on what was
   entered ends the walk. Unnamed buttons, payments in progress and walks that come back to where they started are not
   kept. Only origin + path of the start address is kept (no query, no hash), and not at all if the path holds a long
   number or an email. Step names that look like numbers, addresses or emails are not kept. At most 6 routes per site;
   the least recently used go first.
3. **Offer.** When Dool2 opens or moves to a site, the page read lists that site's routes:
   `[r3] 주문목록: '마이페이지' → '주문목록'`.
4. **Walk.** `browser_route(tabId, route)` opens the start if needed and presses the same links by name, pausing 0.6
   to 1.8 s at random between clicks like a person, with no AI step in between, then returns the final page. Every
   click goes through the same path as `browser_click`, so the approval gate for payment, send and delete buttons is
   unchanged. If a link is not on the page any more, the walk stops there, returns that page for the AI to carry on,
   and the route is forgotten.

## Why

- It removes the AI round trip between clicks, the largest cost, without changing the agent program or the gate.
- It learns from what each person actually does, so it covers sites no connector exists for.
- It stays human: real Chrome, real mouse clicks, random pauses at a person's pace. A remembered walk of 3 clicks
  takes about 4 to 6 s instead of about 10 s, and the AI reads one page instead of three.
- Considered: replaying recorded coordinates (breaks on any layout change), letting `browser_steps` cross pages (the
  AI still has to know the path), and generating connectors from walks (the next step: a route used often is a good
  connector draft).

## Consequences

- One more tool (`browser_route`) and a few lines in page reads on sites with routes.
- Routes live only on the user's PC (data folder), like the work log; they hold link names and site paths, not page
  content or typed values. Threat model T24.
- A route can lead to a page that changed meaning (a renamed menu). The walk only presses links by their exact names
  and returns the final page to the AI, which still judges what it sees.
- Revisit when the work log shows how often routes are offered, taken and broken (`route` steps in `turn` records).
