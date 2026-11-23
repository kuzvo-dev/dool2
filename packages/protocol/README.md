# @dool2/protocol

The types and protocol shared by the Dool2 desktop app, the daemon (dool2d), and the phone app that will be added later. It does not depend on any other `@dool2/*` package.

| Export                                                  | Description                                                                                                                           |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `AgentId`, `AGENT_LABEL`                                | The supported AIs (`claude`, `codex`) and the names shown on screen                                                                   |
| `AgentStatus`                                           | Whether it is installed, version, login status, subscription type                                                                     |
| `AgentEvent`                                            | The common events from one agent turn: `started`, `text`, `tool`, `tool_result`, `usage`, `limit_reached`, `error`, `done`            |
| `AgentErrorCode`                                        | `not_installed`, `not_logged_in`, `rate_limited`, `tools_unsafe`, `process_failed`, `aborted`, `unknown`                              |
| `ThreadSummary`, `StoredMessage`                        | The conversation list and messages                                                                                                    |
| `CreateThreadRequestSchema`, `SendMessageRequestSchema` | Local API input validation (zod)                                                                                                      |
| `DaemonStreamEvent`                                     | Events of the send-message response stream (SSE)                                                                                      |

This is a security-critical area. PRs that change the protocol follow the review standards in [CONTRIBUTING](../../CONTRIBUTING.md#review-levels).
