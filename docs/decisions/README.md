# Decision records (ADR)

We record decisions that affect the structure of the project, together with why we made them. This keeps outside contributors from repeating the same discussions, and shows what to re-examine when a decision is changed later.

| No. | Decision | Status |
|---|---|---|
| [0001](0001-record-decisions.md) | Record decisions as ADRs | Accepted |
| [0002](0002-official-agent-binaries.md) | Run the official Claude Code and Codex unmodified | Accepted |
| [0003](0003-dool2-tools-only.md) | Turn off the agents' built-in tools and allow only Dool2 tools | Accepted |
| [0004](0004-electron.md) | Build the desktop app with Electron | Accepted |
| [0005](0005-no-containers.md) | Install as an all-in-one app, without containers | Accepted |
| [0006](0006-user-chrome-extension.md) | Use the browser through the user's own Chrome plus the Dool2 extension | Accepted |
| [0007](0007-pc-first.md) | Finish the PC side first and attach the phone last | Accepted |
| [0008](0008-skills-cc-by-sa.md) | Publish skills under CC BY-SA 4.0 | Accepted |
| [0009](0009-node-sqlite.md) | Store records in Node's built-in SQLite | Accepted |
| [0010](0010-pay-as-you-go-opencode.md) | Without a subscription, use API keys and pay as you go (OpenCode) | Accepted |
| [0011](0011-login-vault.md) | Keep login details in the Dool2 vault, and have Dool2, not the AI, fill them in | Accepted (M2) |
| [0012](0012-phone-link.md) | Phone ↔ PC link: browser-native encryption, signed devices only, the relay sees only ciphertext | Accepted (M6) |
| [0013](0013-hands-mac-swift.md) | The PC-control helper is written per OS in that OS's own language (Swift on Mac) | Accepted (M4) |
| [0014](0014-connect-cards.md) | Add each service connection from a template (connect card `connect.json`) | Accepted (the procedure-doc part is superseded by 0018) |
| [0015](0015-one-conversation.md) | There is one conversation with Dool2 (one AI session carried across segments; tasks are cards inside the conversation) | Accepted |
| [0016](0016-five-tabs-life.md) | Five tabs (Chat, Feed, Ideas, Goals, Library) and Dool2's life record (goals, library, memory, feed) | Accepted |
| [0017](0017-phone-native-app.md) | The phone app is a store app only (Capacitor): drop the web app, and the official relay does not serve the app | Accepted |
| [0018](0018-service-connectors.md) | Services attach as connectors (per-service tools in `tools.json`): fixed extension engine, show only connected services' tools, retire `SKILL.md` | Accepted |
| [0019](0019-proactive-watch.md) | Proactive check: look at connected services twice a day and notify only what needs attention | Accepted |
| [0020](0020-connector-health.md) | Watching for broken service tools: auto-rest on real-use failures, nightly checks against the real sites with issues, draft fix PRs | Accepted |
| [0021](0021-connect-agent-takeover.md) | Connecting: when automatic login stalls, Dool2 takes over in the chat, and what it does is always visible in the chat | Accepted |
| [0022](0022-pc-file-tools.md) | PC files are only found, read and newly created, through Dool2 tools | Accepted |
| [0023](0023-my-pay-methods.md) | My payment methods: remember only what to pay with, never card numbers or payment passwords | Accepted |
| [0024](0024-pc-file-move-convert-print.md) | Moving PC files, converting photo formats and printing go through Dool2 tools with approval and undo | Accepted |
| [0025](0025-know-ledger.md) | What Dool2 knows: keep looked-up facts and past actions, and let the AI judge whether to use them | Accepted |
| [0026](0026-vault-view-edit.md) | Users can view and edit vault passwords on the phone or PC | Accepted (amends ADR 0011) |
| [0027](0027-finish-check.md) | Before finishing a task, Dool2 checks once more and, if something is left, continues on its own | Accepted (back on 2026-11-25 with drafts) |
| [0028](0028-web-release-update.md) | The desktop app is downloaded from the web, and new versions are fetched by the app itself from a signed notice | Accepted |
| [0029](0029-language-and-region.md) | Language and region are separate settings; the repo is English, the product is multilingual | Accepted |
| [0030](0030-auto-approve.md) | Auto-approve: everything except payments without an approval card | Accepted (review added 2026-11-25) |
| [0031](0031-quick-check-watch.md) | Quick checks: watches check every minute without the AI, and wake it only on a change | Accepted |
| [0032](0032-pinned-instructions.md) | Instructions are pinned per segment; what changes rides on the next message | Accepted |
| [0033](0033-tools-on-demand.md) | Rarely used tools are found and run on demand | Accepted |
| [0034](0034-remembered-routes.md) | Remembered routes: walk a known path on a site without the AI at each click | Accepted |
| [0035](0035-resident-agent-session.md) | One resident Claude Code program per conversation segment | Accepted |
| [0036](0036-cache-aware-segments.md) | Cache-aware segments: switch after an hour away, with the handoff made while the cache lives | Accepted |
| [0037](0037-model-profiles.md) | Model profiles and role routing: side jobs on a small model, one table for what differs per model | Accepted |
| [0038](0038-task-sessions.md) | The conversation hands longer work to a task session: split tools, steering through the next tool result, one result per task | Accepted |
| [0039](0039-connector-packs.md) | Service cards and connectors arrive as signed packs, without a new app version: never older, unreadable files fall back, test PCs first | Accepted |
| [0040](0040-instructions-as-files.md) | Dool2's instructions live in prompts/ text files and can arrive in a connector pack; the money rules stay in code | Accepted |
| [0041](0041-connection-is-an-account.md) | A connection is a specific account: Dool2 reads which account a service shows, asks when Chrome holds another one, and lets the person pick Google accounts instead of typing a password | Accepted |
| [0042](0042-recipes.md) | Recipes: keep the steps that got a request done, and offer them on the next request like it | Accepted |
| [0042](0042-store-app-push.md) | Store app notifications go through FCM via the official relay, with the content encrypted by the PC with the phone's own key | Accepted |
| [0043](0043-chip-approval-keys.md) | Approvals are signed by keys in the phone's security chip; payments and transfers only after the phone lock (can be turned off, with the lock) | Accepted |

## How to write a new decision

1. Create a file named `NNNN-short-english-name.md` with the next number.
2. Fill in the template below. It does not have to be long. The **Why** matters most.
3. Open a PR. When you overturn an existing decision, change the old document's status to "Superseded by NNNN" and do not delete it.

```markdown
# NNNN. Decision title

- Status: Proposed | Accepted | Superseded by NNNN
- Date: YYYY-MM-DD

## Context
What had to be decided, and what constraints applied?

## Decision
What did we decide?

## Why
Why was this the best option? What other options did we consider?

## Consequences
The benefits of this decision, what we accept as costs, and the conditions under which to revisit it.
```
