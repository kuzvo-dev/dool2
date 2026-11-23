# 0002. Run the official Claude Code and Codex unmodified

- Status: Accepted
- Date: 2026-11-14

## Context

Dool2 has to work with the AI subscriptions users already pay for (Claude, ChatGPT). There are several ways to do this.

- Take the subscription login token and call the API directly
- Wrap it with a library such as an Agent SDK
- Run the official CLI as it is

Anthropic does not allow third-party apps to handle claude.ai login on a user's behalf or to handle subscription credentials. It does allow using **unmodified Claude Code** that the user has logged in to themselves. OpenAI has officially opened a path for open-source local apps to use the Codex app-server through "Sign in with ChatGPT".

## Decision

- **Claude**: run the official `claude` binary, which the user installed and logged in to, headlessly with `claude -p`. Dool2 never reads or stores Claude login information or tokens. We do not use options such as `--bare` that ignore the subscription login.
  - **Login button**: Dool2 launches the official `claude auth login`. The user pastes the code from the browser, and Dool2 only passes it on to that program unchanged. The code and tokens are not stored or logged, and login success is checked only with `claude auth status`.
- **Codex**: bundle a pinned version (`@openai/codex`, Apache-2.0) with the app and run it with `codex app-server` (JSON-RPC). It uses a Dool2-specific `CODEX_HOME` so it does not mix with the user's own Codex.
- Both agents sit behind a common interface (`AgentRuntime`) in `packages/engine`.

## Why

- It is the safest way to use the user's subscription within each company's policy.
- We get the official binary's updates (models, security fixes) as they are.
- Because of the common interface, if one side's policy changes we can keep working with the other.

## Consequences

- The adapters can break when a CLI's output format changes. We pin real output in `fixtures/`, pin the Codex version, and run compatibility tests before updating.
- If Claude Code is missing, Dool2 has to help install it through the official install path (M1).
- If a policy changes, API-key mode is the fallback.
