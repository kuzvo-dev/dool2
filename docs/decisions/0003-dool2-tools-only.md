# 0003. Turn off the agents' built-in tools and allow only Dool2 tools

- Status: Accepted
- Date: 2026-11-14

## Context

By default, Claude Code and Codex can run shell commands, read and write files, and search the web. With these on, the AI could send a request to a payment page or delete files without going through the approval gate. It would also be more vulnerable to prompt injection (instructions hidden in a web page).

## Decision

- **Claude**: turn off all built-in tools with `--tools ""`, connect only the Dool2 MCP server with `--strict-mcp-config`, and allow only Dool2 tools with `--allowedTools "mcp__dool2__*"`. User settings files are not read, via `--setting-sources ""`.
- **Codex**: start it with `features.shell_tool=false`, `web_search="disabled"`, `sandbox_mode="read-only"` and `approval_policy="never"`, and attach the Dool2 MCP server with `required=true` and `default_tools_approval_mode="approve"`. Dool2 tools then run without Codex's own approval step, the same as `--allowedTools` on Claude: Dool2 asks the person itself (approval cards, the phone signature). Without it, Codex 0.169.0 under `approval_policy="never"` fails every Dool2 tool call it would have asked about ("MCP tool call requires approval"), seen with a local stand-in for the model (`packages/agent-codex/fixtures/app-server-tool-approval.jsonl`).
- **Double check**: at startup, if the tool list the agent reports contains anything that is not a Dool2 tool, stop immediately (`tools_unsafe`). If Codex starts a shell, file-change or web-search item, or calls an MCP server that is not Dool2, we cut the conversation. Codex approval requests are always refused.

- **Codex's other tools (amended 2026-11-25)**: the model catalog of Codex 0.169.0 puts its newer models in "code mode" (one JavaScript tool, `exec`, from which every other tool is called inside a script; Dool2's tools were reachable only that way) and gives them sub-agent tools (`spawn_agent` and five more) that start other AI agents on their own threads. A sub-agent's work never reaches Dool2's work log, and a script is not one visible step. The maintainer's decision: block them. Dool2 writes its own copy of the pinned program's catalog (`codex debug models`) into its CODEX_HOME with `tool_mode` set to `direct`, no `multi_agent_version`, `supports_search_tool` off (Dool2's tools are offered up front, as on Claude) and no script runner or patch tool, and passes it with `model_catalog_json`. It also turns off native sub-agent tools, goals, the sleep timer, the image viewer (it reads any picture file) and asking the user through Codex (`ONLY_DOOL2_CONFIG` in `packages/agent-codex`). If the catalog cannot be written and no earlier copy exists, Codex is not started (fail closed). Behind that, a sub-agent item (`collabAgentToolCall`, `subAgentActivity`), work on another thread of the same program, or an image-viewer item stops the turn with `tools_unsafe` and says why. Checked on the pinned app-server against a local stand-in for the model (no real model call): before, the model was offered `exec`, `wait`, `request_user_input`, `sleep` and the six sub-agent tools; after, only Dool2's tools, Dool2's own MCP resources and the clock, and scripted calls to `exec`, `spawn_agent` or `view_image` are refused by Codex as unsupported (`packages/agent-codex/fixtures/app-server-tools-0.169.0.json`, `app-server-other-agents.jsonl`). The fixed part of the request also got smaller: 53,521 → 31,457 characters.

## Why

- The approval gate only means something if every risky action goes through a Dool2 tool.
- We must not trust settings alone. Rechecking real behavior keeps us safe even if a CLI update changes what an option means.

## Consequences

- Dool2 tools decide what the agent can do. When a new capability is needed, we add a Dool2 tool.
- Changes that loosen this restriction are not accepted. The related code (`packages/agent-*`) is reviewed as a security-critical area.
