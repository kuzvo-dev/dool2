# 0015. There is one conversation with Dool2

- Status: Accepted
- Date: 2026-11-15

## Context

Today each request creates a chat room (thread), and each room has its own AI session (`--resume` id). Rooms pile up on the left of the desktop app, and on the phone you pick a room to enter.

The new design ([docs/design](../design/README.md)) is **"one conversation"**. We do not create a room per topic. Everyday chat and delegated tasks continue in one conversation in date order. Dool2 speaks first ("It's already 1 o'clock, what about lunch?"), and the user continues with quick replies. A delegated task becomes a card inside that conversation, and even on other tabs a "task in progress" bar follows you.

There were two ways. One shows a single conversation on screen but splits the records and AI sessions by day. The other really links everything into one AI session. The user chose the latter (2026-11-15), because the conversation only feels like one if earlier remarks are remembered, as in "that gukbap place from before".

## Decision

1. **One conversation.** There is no room list between the user and Dool2. The PC and phone show the same conversation.
2. **Stored as segments.** The old `threads` table is used as the conversation's **segments (session)**. The conversation = the messages of all segments joined in time order. Exactly one segment is open at any time (the current segment), and new remarks continue the current segment's AI session with `--resume`.
3. **Change segments when it gets long.** At the next turn we move to a new AI session.
   - When the segment has grown long (when the number of turns, the character count, or the number of tokens the AI actually reads exceeds a threshold)
   - When a long time has passed since the last remark (for example, 12 hours; ADR 0036 ties it to the provider's cache life)
   - When the AI (Claude Code, Codex, OpenCode) is changed in settings

   When moving over, the previous segment's **summary**, the last few remarks and the state of tasks in progress go into the new session's first instructions. The summary is made by asking that AI briefly once when the segment is closed, and is stored with the segment. Segment boundaries are not visible on the user's screen (only date dividers are).
4. **One turn at a time.** Because there is one AI session, two turns do not run at once. If the user speaks while Dool2 is working, the remark is **queued** and delivered right after the current turn finishes (the same way as continuing to talk on the phone). Dool2 ends its turn at approvals, logins and the person's turn, so it does not stay blocked for long. There is a **Stop** button that halts the current turn.
5. **Delegated tasks are cards in the conversation.** From the turn where browser or PC tools start being used until it ends is grouped as a **task**. A task has a name, a site, a status (working / needs you / done / stopped) and steps, and is shown in the conversation as Dool2's screen card, and in the "Tasks" tab as a list. Approval, login and hand-off records are stored with the task id. (Today we can match which room an approval belongs to only "when exactly one room is open". With one conversation this guess is not needed.)
6. **Choosing the AI is per conversation.** We do not choose the AI per room. We talk using the one default AI in settings. When it is changed, we move to a new segment as in point 3.
7. **Daemon API.** `GET /api/conversation` (load earlier remarks with `before`), `POST /api/conversation/messages` (turn over SSE; queued if working), `POST /api/conversation/cancel`. The phone link's `ask` goes to the conversation without a `threadId`. The old `/api/threads…` stays only while screens are moved over and is then removed.
8. **Old records stay as they are.** Existing rooms are not migrated. They are treated as segments and shown joined in time order. From the next remark, a new segment starts.

## Why

- When Dool2 speaks first (morning briefing, lunch notification, parcel arrival), it cannot decide which room to speak in if there are several. With one conversation it is natural.
- To understand "that thing from before" or "like last time", the earlier remarks must be in the same session. Merging only the screens makes Dool2 forget earlier remarks every time the task changes.
- Linking one session endlessly makes it slow and raises usage. So we change segments and link them with a summary. A human assistant also remembers yesterday in shortened form and does not reread every remark.
- It becomes certain which task an approval or login card belongs to, which strengthens the approval gate's connections.

Other options considered:

- **One screen only** (records and sessions per day): little to change and several tasks can run at once, but memory breaks between tasks. The user did not choose it.
- **One session to the end**: the simplest structure, but after a few weeks a turn becomes slow, and we would leave memory to each CLI's automatic compaction.
- **Conversation session + a work session per task**: a lightweight session handles the conversation, and long tasks are handed to a separately started work session. It allows concurrent work, but it is too big to do from the start. We note it under "conditions to revisit" below.

## Consequences

- Benefits: screens exactly as designed (menu / one conversation / Dool2's screen, four phone tabs). Speaking first. Approval and login records tied to tasks.
- Costs we accept:
  - A remark that comes in while Dool2 is working is answered after that turn ends. The screen shows "I'll continue in a moment".
  - When changing segments, small details can be lost in the summary. For remarks that matter, we open a tool so Dool2 can look through the stored records again (see "Additions" below).
  - When a segment is closed, the summary turn uses a little usage.
  - The name `threads` remains on the storage table (segments). In code we gradually call it `session`.
- Conditions to revisit: if the need to hand off several tasks at once grows, switch to "conversation session + a work session per task". If summaries are often wrong, fix the thresholds (turns and time) and the summary method.

## Additions (2026-11-16)

### Also change segments by real size (tokens)

The turn count and stored character count only count the remarks of the user and Dool2. But the AI session also accumulates tool results such as browser page content, so a segment with a lot of web work can fill the session, slow it down and raise usage, even when it is far below 40 turns or 60,000 characters.

- The runner reports **how much the current session reads (tokens)** when a turn ends (a `context` event). It is the input tokens of the turn's **last AI call** (including cache reads and writes). The total at the end of the turn is the sum over calls, so we do not use it.
  - Claude Code: the `usage` of the `assistant` message (`input_tokens + cache_read_input_tokens + cache_creation_input_tokens`)
  - Codex: `last.inputTokens` of the `thread/tokenUsage/updated` notification (including cached input)
  - OpenCode: `tokens.input + cache.read + cache.write` of the last `session.step.ended`
- The daemon stores this value on the segment (`threads.context_tokens`), and before the next remark, **if it has exceeded 120,000 tokens**, it gets a summary and moves to a new segment, exactly like the turn and character criteria.

### Tool for searching past conversation

We added the Dool2 tool `conversation_search` (the word to find, up to 20 results). It searches the user's and Dool2's remarks in the earlier segments of the main conversation and returns them briefly with the date (Korean time) and who said it. It ignores spaces, and when there are several words it returns remarks matching more words first, and the most recent first among equals. It leaves out the current segment because the AI already knows it, and also leaves out separate conversations (such as feed posts) and tool records (approval and login cards). We added "If the user brings up something from before and you do not remember it, look it up first instead of guessing" to Dool2's instructions.

## Addition (2026-11-24): the summary is a handoff with fixed headings

A free summary of "what to keep remembering" tended to keep preferences and lose where tasks stood. The summary
request now asks for a handoff under fixed headings: **Now, Done, In progress (step and what it waits on), Promised,
About the user, Did not work, Next**, up to 20 bullet lines, only what the conversation shows. The next segment gets
it as "Handoff from the earlier conversation" (up to 3,500 characters). Modeled on another harness's compaction
handoff (intent, facts, errors and fixes, pending tasks, next step).
