# @dool2/agent-claude

The Claude Code adapter. It runs the official `claude` binary that the user installed and logged in to, unmodified, with `claude -p` ([ADR 0002](../../docs/decisions/0002-official-agent-binaries.md)).

- `ClaudeRuntime`: the `AgentRuntime` implementation. `detect()` checks install, login, and subscription type with `claude --version` and `claude auth status`.
- `buildClaudeArgs()`: builds launch arguments that turn off built-in tools (`--tools ""`) and connect only the Dool2 MCP server.
- `ClaudeStreamParser`: converts `stream-json` output into the common `AgentEvent`. If it sees a tool that is not a Dool2 tool, it stops with `tools_unsafe`.

- `ClaudeLogin`: the login button. It launches the official `claude auth login --claudeai`, finds the login URL, and passes along the code the user pastes as is. When login finishes in the browser, it notices through `claude auth status` even without a code.

- `installClaudeCode()`, `ClaudeInstall`: the install button. In the same order as the official install script, it downloads from the official distribution server, verifies SHA-256, and finishes with the official `claude install`.

**Dool2 never reads or stores Claude login information or tokens.** We do not accept changes that alter this principle.

Tests use [`fixtures/`](fixtures), real output saved without personal information.
