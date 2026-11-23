# 0019. Proactive check: look at connected services twice a day and tell the user only what needs attention

> 2026-11-20: the interval and order of checking were changed by [0025](0025-know-ledger.md) (every hour from 6 a.m. to 10 p.m., starting with the item that is due).

- Status: Accepted
- Date: 2026-11-17

## Context

The Feed in [0016](0016-five-tabs-life.md) only held "what Dool2 did" and the Feed posts the user asked for. An assistant should look after things before being asked:
"The running shoes you ordered yesterday arrive tomorrow", "Congratulations on finishing, 1h52m, 312th place", "Saturday is Mom's birthday, shall I pick out a gift?"
Saying such things first, without a request. We also promised "it looks after you first" on the landing page (dool2.com).

Users will not know what to turn on. So we do not offer "pick the items to watch and turn them on".

## Decision

1. **The basis is connected services.** Only services whose connection was completed on the connect screen (`settings.connections`) are opened and looked at. If nothing is connected, nothing is done.
2. **Twice a day.** Once after 8:30 and once after 18:30, Korea time. Not at night (22:00 to 7:00). If the PC was off in between, it runs once it is on again (if it is daytime).
3. **In the Feed-only conversation.** Dool2 is asked in a separate conversation (Feed only), like the idea search. The main conversation is not cluttered.
4. **Only when there is something to tell.** Dool2 posts only news it has confirmed itself, with `feed_tell`. Only what is posted goes to the top of the Feed and to a phone notification.
   The answer to the check itself ("No news") is not announced.
5. **Each item only once.** If the `key` (service-target-state) is the same, it is not posted again within 30 days. Items announced in the last 14 days are included in the request so Dool2 can see them.
   At most 3 per check.
6. **Suggestions are buttons.** What Dool2 can do next is attached as `ask` (the request that is sent when tapped). The [Do it] button on screen only sends that request to the main conversation,
   and paying and sending still go through approval as always. While checking, Dool2 does not pay, send or delete.
7. **It is also left in the conversation.** What was posted is also left in the main conversation as a Dool2 card (a `tool` record `{kind:'tell'}`). The AI is not called, and if Dool2 is answering, the card is left after it finishes (within 5 minutes).
   The card's answer (asked / handed over) is read from the Feed post and changes together with the Feed card. The AI does not know about this card, so for the user's next message, "what was announced first" is added as background
   for that turn only (`aside` in `ThreadService.send`, not kept in the history or on screen). Tapping a phone notification opens the conversation.
8. **Turning it off.** On by default. Turn it off with `watchOff` in the life records (the `watch` action). `watch-now` runs a check right now.

## Why

- If users had to pick items, most would turn nothing on. A connection is already the user saying "Dool2 may look at this service", so it is a fitting basis.
- Checking every few minutes uses a lot of subscription quota and is a burden on the sites. Morning and evening catch most deliveries, schedules and mail.
- If notifications are useless, people switch them off right away. So "only newly confirmed things, only once, only a few" is enforced at the tool level (not left to what the AI says).

## Consequences

- Once per-service connectors ([ADR 0018 proposal](https://github.com/kuzvo-dev/dool2/pull/154)) exist, checking gets faster and more accurate. Until then it looks with the browser.
- Services whose login has expired are skipped (no login window is opened during a check). We will consider a "Please reconnect" notification later.
- Until push notifications arrive in the native phone app, phone notifications go only through web push.
