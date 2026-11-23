# Security Policy

Dool2 is a program that pays and contacts people on your behalf from your own computer, so we treat security as the top priority.

## Reporting a vulnerability

**Please don't post in public issues, Discussions, or PRs.** Use GitHub's private reporting instead.

👉 [Report a vulnerability privately](https://github.com/kuzvo-dev/dool2/security/advisories/new)

It helps if your report includes:

- What the problem is and what impact it has
- How to reproduce it (a minimal example if possible)
- The Dool2 version or commit, your operating system, and the AI you used (Claude Code or Codex)

## How we handle reports

| Step                                | Target                                      |
| ----------------------------------- | ------------------------------------------- |
| Reply confirming receipt            | Within 3 business days                      |
| First assessment (impact, repro)    | Within 7 business days                      |
| Release of a fixed version          | As soon as possible, depending on severity  |
| Disclosure                          | After the fix ships, agreed with the reporter |

If you want, we credit you in the security advisory. We don't offer monetary rewards (a bug bounty) yet.

## What we care about most

- **Approval gate bypass**: payments, booking confirmations, or messages going out without the user's approval
- **Agent escape**: the AI getting to use shell, file, or network features outside Dool2's tools (including prompt injection)
- **Local API exposure**: another program or web page reaching the Dool2 daemon (127.0.0.1) without a token
- **Data leaks**: conversations or account details leaving the user's PC
- **Update or distribution tampering**: unsigned code being installed or run
- (After M6) problems with phone-to-PC encryption, pairing, or signature verification

## Out of scope

- A user's PC that is already infected with malware (Dool2 can't defend against that)
- Vulnerabilities in Claude Code, Codex, or Chrome themselves: please report those to the respective companies
- The results of actions the user explicitly approved

## Supported versions

Before `v1.0`, **only the latest release** receives security fixes.
