# @dool2/daemon (dool2d)

This is the Dool2 daemon. It runs agents, drives conversations, and keeps the records, and it exposes these features to the screens (the desktop app, later the phone) through a local API. The desktop app starts this daemon in the same process.

```bash
pnpm build
pnpm dev:daemon   # prints the address and token
```

## Local API

It listens on `127.0.0.1` only, and every request needs `Authorization: Bearer <token>`. A new token is created on every run.

| Method              | Path                            | Description                                                                                  |
| ------------------- | ------------------------------- | -------------------------------------------------------------------------------------------- |
| GET                 | `/api/health`                   | Whether it is alive                                                                          |
| GET                 | `/api/agents`                   | Install and login status of Claude Code and Codex                                            |
| POST                | `/api/agents/codex/login`       | ChatGPT login (waits until it finishes)                                                      |
| GET / POST / DELETE | `/api/agents/codex/install`     | Codex download status / start / cancel                                                       |
| GET / POST / DELETE | `/api/agents/claude/login`      | Claude login status / start (login URL) / cancel                                             |
| POST                | `/api/agents/claude/login/code` | Pass the code shown in the browser to the official login                                     |
| GET / POST / DELETE | `/api/agents/claude/install`    | Claude Code install status (step and progress) / start / cancel                              |
| GET                 | `/api/browser`                  | Whether Chrome is installed, and its version                                                 |
| GET / POST / DELETE | `/api/browser/install`          | Chrome install status / start / cancel                                                       |
| GET                 | `/api/agents/opencode/catalog`  | AI providers and models you can pick on pay-as-you-go                                        |
| GET / PUT / DELETE  | `/api/agents/opencode/account`  | Pay-as-you-go account (provider, model, API key). The key is only stored; only the last 4 characters are shown |
| GET / POST / DELETE | `/api/agents/opencode/install`  | Pay-as-you-go runner install status / start / cancel                                         |
| GET / PATCH         | `/api/settings`                 | Read settings / save only the items that changed                                             |
| GET / POST          | `/api/threads`                  | List conversations / start a new one                                                         |
| GET                 | `/api/threads/:id`              | A conversation and its messages                                                              |
| POST                | `/api/threads/:id/messages`     | Send a message. The response is an SSE stream (`DaemonStreamEvent`)                          |
| POST                | `/api/threads/:id/cancel`       | Stop the answer in progress                                                                  |

## Data folder

| OS      | Location                              |
| ------- | ------------------------------------- |
| macOS   | `~/Library/Application Support/dool2` |
| Windows | `%APPDATA%\dool2`                     |
| Other   | `$XDG_DATA_HOME/dool2`                |

You can change it with `DOOL2_DATA_DIR`. Use a temporary folder for development and screenshots. You can create a demo conversation with `node scripts/seed-demo.mjs <folder>`.
