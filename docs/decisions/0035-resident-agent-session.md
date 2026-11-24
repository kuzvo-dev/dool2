# 0035. One resident Claude Code program per conversation segment

- Status: Accepted
- Date: 2026-11-25
- Related: [0002 official agent programs](0002-official-agent-binaries.md), [0003 Dool2 tools only](0003-dool2-tools-only.md),
  [0015 one conversation](0015-one-conversation.md), [0032 pinned instructions](0032-pinned-instructions.md)

## Context

Each message of the conversation started a new `claude -p --input-format text`. Each start meant the CLI booting,
checking the sign-in, starting the Dool2 tool server (which then asked the daemon for the service tool list and waited
up to 3 s), and, if the tool server was late, a retry 1.5 s and 3 s later. The journal shows the program ready
(`startMs`) at p50 542 ms and up to 900 ms on an idle PC, before the AI is even asked. A busy PC was worse, and that was
where the "started without Dool2 tools" retries came from.

`docs/architecture.md` section 3.2 already sketched the stream-json form. We checked it on the installed CLI
(2.1.325, haiku, a stub tool server; lines saved in `packages/agent-claude/fixtures/stream-*.jsonl`):

- `--input-format stream-json` takes one `{"type":"user",...}` line per message, and each turn ends at its `result`
  line. Several turns on one program keep the conversation.
- The tool server starts with the program, before the first message.
- A `control_request` with `subtype: "interrupt"` ends the running turn within about 0.1 s (`result` subtype
  `error_during_execution`), and the same program takes the next message.
- `--resume <id>` with stream-json input continues the same session id.
- Through the runtime class: first event 8–64 ms after the message on a running program, 260 ms on a fresh one.

## Decision

1. `AgentRuntime` gets an optional `openSession(input)` returning an `AgentSession`: `send(text, signal)` yields one
   turn's events, `interrupt()` ends the current turn, `close()` ends the program. `runTurn` stays for everything
   else (side chats, the feed, scheduled tasks in side chats, summaries) and for runtimes without sessions.
2. Claude Code implements it (`ClaudeSession`): one `claude -p --input-format stream-json` per session, the same
   flags as before (`--tools ""`, `--strict-mcp-config`, Dool2 tools only). The program starts when the session opens,
   so it and its tool server are up when the message arrives.
3. `ThreadService` keeps one session per thread for the threads the daemon marks resident: the current segment of the
   main conversation, unless the `residentAgent` setting is `false`. The session is keyed by what it was opened with
   (agent, pinned instructions, tool servers, folder, model). A change opens a new one with `--resume`.
4. Life rules:
   - Segment closed (length, idle, AI change): the session is closed.
   - 30 minutes without a message (`RESIDENT_IDLE_MS`): closed. The next message opens it again with `--resume`.
   - The program ended between messages (crash, killed): the next message starts it again with `--resume`.
   - Stop button: `interrupt`. If the turn does not end in 5 s, the program is ended and starts again on the next
     message. Either way the turn ends as "stopped" at once and the conversation goes on.
   - The program came up without Dool2 tools: ended and started once or twice more, as `runTurn` did.
   - A turn its reader left partway: the program is ended, so its leftover lines never reach the next turn.
   - The daemon stops: every session is closed.
5. Summaries run as a separate `runTurn` with `--resume <id> --fork-session`, so the summary request and the handoff
   stay out of the session the user keeps talking in.
6. The daemon writes the segment's service tool list to a file before a program starts (#459), so the tool server
   answers at once. With one program per segment this is the list at segment start, the one ADR 0032 pins.

## Why

- Time to first word loses the program start, the sign-in check and the tool server start on every message after the
  first of a segment, and the tool-server race that caused the retries goes away after the first message.
- The CLI is still the official one, unmodified, signed in by the user (ADR 0002). Only its input format changes.
- Security stays the same: the program's tool list is still checked on every turn (`started` lists only `mcp__dool2__`
  tools or the turn stops), and the approval gate lives in the daemon, not in the program.
- Other options:
  - The daemon serving the tools over local HTTP instead of a child tool server. It would remove the child process
    too, but it depends on CLI support we have not checked. The tool list file already removes the wait.
  - Keeping programs for side chats too. Side chats are short and many; their memory cost is not worth it now.
  - Codex. Its adapter still starts `codex app-server` per turn; it can implement `openSession` the same way later
    (`thread/start` once, `turn/start` per message, `turn/interrupt` for stop). OpenCode stays on `runTurn`.

## Consequences

- One idle program holds about 210 MB plus its tool server (measured on macOS) for up to 30 minutes after the last
  message. The idle limit is a constant, easy to change.
- A CLI update could change the stream-json input or the interrupt request. The session tests replay the captured
  lines, and `residentAgent: false` in settings goes back to one program per message without a release.
- Instruction changes still ride on the next message (ADR 0032); a resident program never needs a new system prompt
  within a segment.
- Revisit when Codex gets a session, or if the journal's `startMs` / `textMs` do not drop for resident turns.
