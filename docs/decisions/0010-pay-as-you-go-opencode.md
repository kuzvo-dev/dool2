# 0010. Without a subscription, or if one is a burden, use API keys and pay as you go (OpenCode)

- Status: Accepted (to be implemented)
- Date: 2026-11-14

## Context

Dool2 runs on Claude and ChatGPT subscriptions ([ADR 0002](0002-official-agent-binaries.md)). But for people for whom the monthly fee is a burden, or who use it only occasionally, **paying only for what they use** fits better. It would be even better to be able to choose among many AIs (Anthropic, OpenAI, Google, OpenRouter, and local models on my PC).

## Decision

Add the open-source agent **OpenCode** (MIT) as a third runner, used with **API keys only**.

- Package `packages/agent-opencode`, implementing the common `AgentRuntime` interface
- Pinned version: the v2 line (`@opencode/cli`). We do not use the old v1 (`opencode-ai`) because its config keys and server address differ
- Running: start `opencode serve --stdio` in a Dool2-specific folder (config, data, state and cache folders all separate, auto-update off, user and project config not read), with a new password for each run. It shuts down together with Dool2
- **Only Dool2 tools allowed** ([ADR 0003](0003-dool2-tools-only.md)): the permission rules block every tool and open only `dool2_*`. The feature that wraps MCP tools into a code-execution tool (`codemode`) is turned off. Permission requests of the ask type are always refused
- Event flow: text chunks (`session.text.delta`), tool calls and results, **tokens and cost (USD)** for each step, and success, failure and abort are converted into the common `AgentEvent`
- Installation: like Claude Code, download from the official GitHub release on first use and verify with `SHA256SUMS`. It is not put in the installer
- The API key is kept in the OS keychain (`safeStorage`) and passed only as an environment variable at run time

## What we do not do

- **We do not use a Claude Pro/Max subscription login through OpenCode.** Anthropic does not allow using subscription login anywhere other than Claude Code and its own apps. The subscription is used only through the official Claude Code
- We do not use OpenCode's ChatGPT login either. The ChatGPT subscription is used through the official Codex
- We do not use OpenCode's "run the user's claude" style provider either

## Why

- It already supports many AI providers and local models, and has MCP and fine-grained permission rules, so it can be fitted to Dool2's principle (only Dool2 tools)
- It reports per-step cost, so we can show things like "this request cost 120 won"
- It is MIT, so we may ship it together with Dool2

## Consequences

- In the wizard's "Which AI subscription do you use?", add **"No subscription, pay only for what I use"**. When chosen, we ask for the provider and API key
- Show this conversation's and this month's spend on screen, and let users set a monthly limit (when exceeded, it stops and asks)
- OpenCode v2 changes quickly. We pin the version and verify the server protocol with tests before upgrading
- Dool2 cannot block system-wide managed settings (such as on a company PC). We note this in the threat model
