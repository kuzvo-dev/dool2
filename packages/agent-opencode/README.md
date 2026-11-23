# @dool2/agent-opencode

The pay-as-you-go runner. For people who want to pay **only for what they use with an API key** and no subscription, it runs the open-source agent OpenCode v2 (MIT), confined to Dool2 tools only ([ADR 0010](../../docs/decisions/0010-pay-as-you-go-opencode.md)).

- `OpenCodeRuntime`: the `AgentRuntime` implementation. For each turn it starts `opencode serve --stdio` in a Dool2-only folder (127.0.0.1, a new password every run) and converts `GET /api/event` (SSE) into the common `AgentEvent`. Continuing a conversation uses the OpenCode session id.
- `buildOpenCodeConfig()`: blocks all tools and opens only `dool2_*`. The default agents (build, plan, general, explore) are turned off, and OpenCode's own free models, web search, skills, and other MCP servers are blocked by policy. The feature that wraps MCP tools in code execution (`codemode`) is turned off too.
- `buildOpenCodeEnv()`: redirects the config, data, state, and cache folders all to Dool2's side, does not read user or project settings, and turns off auto-update. Only the API key of the chosen provider is passed as an environment variable.
- `OpenCodeEventMapper`: text chunks, tool calls and results, **cost (USD) and tokens** per step (the `cost` event), and end, failure, and abort. If it tries to use a tool that is not a Dool2 tool, it stops immediately (`tools_unsafe`).
- `installOpenCode()`, `OpenCodeInstall`: on first use, it downloads from the official GitHub release (pinned to v2.3.0), verifies with `SHA256SUMS`, and unpacks with the OS `tar`. It is not included in the installer.

Supported providers: Anthropic, OpenAI, OpenRouter, Google (API keys). **Claude Pro/Max subscription login is not used**; a subscription is used only through the official Claude Code.

Tests use real OpenCode v2.3.0 output (`fixtures/auth-fail.jsonl`, keys and ids removed) and a success flow built from the schema (`fixtures/success.jsonl`).
