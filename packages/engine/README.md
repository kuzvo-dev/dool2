# @dool2/engine

The conversation driver and the common agent interface. The Claude Code and Codex adapters implement this interface.

| Export                                     | Description                                                                                                                       |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `AgentRuntime`                             | The agent adapter interface: `detect()` for install and login status, `runTurn()` to run one turn (an `AgentEvent` stream)        |
| `TurnInput`, `McpServerSpec`               | The input passed for one turn: text, continuation id, system instructions, the Dool2 MCP server, working folder, abort signal     |
| `ThreadService`                            | Drives one conversation. Saves the user message → runs the agent → saves the continuation id and the answer                       |
| `buildSystemPrompt`, `DOOL2_SYSTEM_PROMPT` | The [Dool2 persona](../../docs/persona.md) instructions. Both agents receive the same instructions                                |
| `findExecutable`, `runOnce`, `spawnLines`  | Helpers to find and run external programs (handling macOS and Windows path differences)                                           |

To add a new agent, implement `AgentRuntime` and confine it to Dool2 tools only, as in [ADR 0003](../../docs/decisions/0003-dool2-tools-only.md).
