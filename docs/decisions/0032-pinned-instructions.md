# 0032. Instructions are pinned per segment; what changes rides on the next message

- Status: Accepted
- Date: 2026-11-24 (tool list pinned too: 2026-11-25)
- Related: [0015 one conversation](0015-one-conversation.md), [0018 service connectors](0018-service-connectors.md),
  [0033 tools on demand](0033-tools-on-demand.md)

## Context

The AI provider caches the start of every request: the instructions, then the conversation so far. A request whose
start matches the last one is read cheaply; from the first byte that differs, everything after it is read again at
full price, including the whole conversation.

Dool2 rebuilt its instructions on every turn, and they hold things that change during a conversation: what Dool2
remembers, what it knows (with today's date), and which services are connected. Any change there (a new memory, a
connection, the next day) made every later turn of the segment pay for the whole conversation again. The current time
was already sent with the message for this reason; the rest was not.

A study of another agent harness (2026-11-24) showed the same fix: sections are pinned until the next compaction and
changes arrive as notes in a new user turn.

## Decision

1. The instructions are **pinned at the first turn of a segment** and sent byte-identical for the rest of it
   (`packages/engine/src/pinned-prompt.ts`, `ThreadService.promptFor`). The segment summary turn uses the same copy.
2. When the instructions built now differ from what the AI was last told, the next message carries an **update note**
   with only the sections that changed (matched by `## ` heading, ignoring the explanation in parentheses), and the
   names of sections that no longer apply. Each version is told once.
3. A new segment (ADR 0015: long, idle past the cache's life per ADR 0036, or a different AI) pins a fresh copy, so notes do not pile up.
4. **The service tool list is pinned per segment too.** The tool definitions come before the instructions in every
   request, so a change there breaks the cache for everything after it. It changed during a segment whenever a service
   was connected or disconnected, a login-free service tool was used for the first time (it then joins the visible
   list), or a tool definition was fixed. Now the engine gives each tool server its segment id (`DOOL2_TOOLSET`), the
   server asks for the service tools of that segment, and the daemon answers with the list it gave that segment first
   (`Connectors.catalogFor`). Tools that appear later are used through `service_find` / `service_call` until the next
   segment; the update note already tells the AI that a service is now connected. An empty first list is not kept,
   so a segment that starts before the browser extension is up still gets its tools.
5. To see the effect, every turn's first AI call writes its input and the part read from cache to the work log
   (`cache`: `input`, `cached`, `share`, `noted`). Claude Code only for now.

## Why

- Memory and connections change a few times a day, but a segment has many turns. A note costs a few hundred
  characters once; a broken cache costs the whole conversation on every later turn.
- The AI still sees the current state: the note says it replaces the sections with the same heading.

## Consequences

- Within a segment the AI reads the old section plus a note. If notes confuse it (it follows the old section), shorten
  segments or move that section out of the instructions into a tool.
- After the daemon restarts, the first turn pins again (one cache miss). The same goes for the tool list.
- A service connected in the middle of a segment is one step further away (`service_call` instead of its own tool)
  until the next segment. A disconnected service keeps its tools in the list; calling one says it needs connecting.
- Check the `cache` lines in the work log: `share` should stay high within a segment, apart from its first turn.
