# 0025. What Dool2 has learned: keep looked-up facts and what was done, and let the AI judge whether to use them

- Status: Accepted
- Date: 2026-11-20

## Context

In the joint test on benefits and refunds, results seen after logging in to Hometax, Gov24 and 내보험찾아줌 (Find My Insurance) could not be reused in the next request.

- The same verification was requested again and again (user fatigue).
- It asked again for things it already knew (items 5, 6, 10 and 11).
- It spoke without a source or a date.

It also did not remember the applications, bookings and deliveries Dool2 had made, so it could not look after times such as an announcement date or a free-cancellation deadline.

## Decision

1. **Keep one line at a time (`know_save`).** Two kinds are kept.
   - **Fact:** a fact from a my-information screen seen after logging in.
   - **Done:** an application, payment, booking, delivery or sign-up that Dool2 made or confirmed.
   - Each line gets what, value, where from, as-of time and the date seen, and a Done also gets when to look after it next. If the name is the same, the value is replaced by the new one.
2. **Freshness is not set by rules.** There is no fixed TTL. The instructions and the `know_find` result carry today's date together with the as-of time, and the AI judges whether to use it as is or look it up again.
   - Only a sense of it goes in the tool description: yearly data goes stale when the next year's data comes out, lists in a few days, this month's figures in a day. For anything a decision depends on, check again.
3. **Done items are not deleted.** When canceled, terminated or completed, `know_update` marks it as ended and it is looked after no more.
4. **Merge with the proactive check (amends 0019).** The checking interval changes from twice a day.
   - **Interval:** once just after the hour, every hour from 6 a.m. to 10 p.m.
   - **Order:** first the Done items that are due to be looked after, then the connected services.
   - **Gap since last time:** it is told when it last checked, so the AI skips places that are unlikely to have changed since.
   - **Even without connections:** if there is a Done item to look after, it checks.
5. **Guardrails**
   - National ID numbers, accounts, cards and passwords are not put in (the vault and My info handle them).
   - Other people's information is not put in.
   - It is stored only on this PC.
   - The user can view and delete it on the memory screen.

## Consequences

- The instructions carry up to 15 Done items in progress and the 20 most recent facts, with dates.
- Hourly checking means more AI calls. If there is nothing to look after and nothing that could have changed, it ends quickly.
