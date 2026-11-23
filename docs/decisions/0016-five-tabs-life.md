# 0016. Five tabs (Chat, Feed, Ideas, Goals, Library) and Dool2's life records

- Status: Accepted
- Date: 2026-11-16

## Context

[0015](0015-one-conversation.md) made the conversation one thread, but there was still no place for the things Dool2 does on its own outside the conversation, or for the results it leaves behind.
Real-use feedback was "the features feel rough overall" and "let's bring it up to the level of a personal assistant app". What personal assistant apps have in common is
(1) one continuous conversation, (2) news that arrives before you ask, (3) suggestions for things it could do, (4) goals and schedules it looks after over time, and (5) a place to keep what it makes.

## Decision

1. **Five tabs.** Chat · Feed · Ideas · Goals · Library (a floating tab bar at the bottom on the phone, a left menu on the PC). Connections and Settings are in the menu.
2. **Dool2's life records (`life`) live only in the daemon's storage.** `apps/daemon/src/life.ts`
   - Goals and things it does on its own (routines): when (daily, by weekday, once, every N minutes, Korea time), 7 categories (health, relationships, money, work, interests, productivity, other), plan steps, progress log, and whether the result is told in the conversation or posted to the Feed.
   - Library: notes, links, products, places, files. Dool2 saves them, or the user long-presses an answer to save it.
   - Memory: what Dool2 has learned about the user. It is appended to the end of each conversation's instructions, and the user can view and delete it in the Dool2 panel.
   - Feed: finished work (turns in which tools were used), things done on its own, Feed posts, and alerts about goals and the Library. Reactions (like / dislike).
   - Feed instruction: "What news would you like to get?" produces a Feed post every day at 7:30 a.m. Personalized ideas: once a day, after 6 a.m.
   - Dool2 settings (identity): how to address the user, tone, answer length. They go at the very start of the instructions, and changing them starts a new segment from the next message in the main conversation.
3. **Creating things happens in conversation.** Dool2 tools `goal_*`, `library_save`, `memory_*`, `feed_post`, `idea_suggest`, `photo_view`. The screens only offer turn on / turn off / delete / check off / try now.
4. **The daemon checks scheduled times every 30 seconds.** Work that belongs in the conversation goes into the main conversation (queued if Dool2 is answering). Feed posts and ideas run in a **separate conversation** (Feed only) so they do not clutter the main one. Results go to the Feed plus a phone notification.
5. **Separate conversations.** Marked with `threads.side` in storage and left out of the main conversation's current segment and history. Create one from the menu with the pencil. Memory is shared.
6. **Dool2 panel (tap the character):** Schedule · Memory (including Dool2 settings) · Screen (live view of the Chrome that Dool2 operates) · Activity · Approvals.

## Guardrails

- Paying and sending always need approval (there is no broad "always allow").
- Memory, Library and Feed stay on this PC. They travel to the phone only over the end-to-end encrypted connection.
- Dool2 does not remember passwords, card numbers or national ID numbers, and does not copy them out of photos either.

## Consequences

- Phone #80, #81, #82; desktop #85; daemon #79, #86, #87, #88.
- Still to do: voice conversation, finer-grained approval scopes, files other than photos, and login tests on real Korean sites (needs user accounts).
