# @dool2/agent-codex

The Codex adapter. It **downloads a pinned version** of `@openai/codex` (Apache-2.0) **on first use** and runs it as `codex app-server` (JSON-RPC, one message per line) ([ADR 0002](../../docs/decisions/0002-official-agent-binaries.md)).

- `CodexRuntime`: the `AgentRuntime` implementation. It uses a Dool2-only `CODEX_HOME` so it does not mix with the user's own Codex settings. `login()` opens the ChatGPT login.
- `buildCodexArgs()`: turns off shell and web search, confines it to a read-only sandbox, and registers the Dool2 MCP server as required.
- `CodexEventMapper`: converts app-server notifications into the common `AgentEvent`. If it sees shell execution, file changes, web search, or an MCP tool that is not Dool2's, it stops immediately.
- `JsonRpcClient`: the minimal JSON-RPC client that talks to the app-server.
- `resolveBundledCodex()`: finds the path of the executable installed alongside, per platform.

When raising the Codex version, check with tests whether the app-server protocol changed.

- `installCodex()`, `CodexInstall`: downloads the per-platform package from the official npm registry (`@openai/codex@0.169.0-<platform>`) and unpacks it with the OS `tar` only if it matches the **SHA-512 pinned in code** (`CODEX_PACKAGES`). The helpers and data used with the executable (`vendor/<triple>`) are left as they are.
- It does not use another version of `codex` on the user's PATH. The app-server protocol differs between versions, so only the pinned version is used.
