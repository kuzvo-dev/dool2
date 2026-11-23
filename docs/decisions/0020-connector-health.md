# 0020. A pipeline to notice and fix broken service tools quickly

- Status: Accepted
- Date: 2026-11-17
- Related: [0018 service tools (connectors)](0018-service-connectors.md)

## Context

Connectors do not call a site's API directly. They open the page and read the screen like a person (the amendment to 0018). So when a site changes its screen, the connector breaks. It breaks in two ways.

- **Loud failure**: the expected list never appears or the button to click is missing. The runner reports "stuck at step N".
- **Silent failure**: a result comes back but its fields are empty. Every price is blank, or the list has 0 rows. Nobody notices and a wrong answer is given.

A user should never be the first to find out. And no person can open 80+ services every day to check.

## Decision

Catch and fix it in three stages.

### 1. Avoid it right away in real use (user's PC, automatic)

- Every time the daemon runs a tool it records the outcome: worked / blocked (loud failure) / empty (silent failure) / stopped (a normal outcome such as login required or sold out).
  - "Empty" means the tool's `expect.filled` (fields that must be filled) is below 80% of the result rows.
- If the same tool is blocked or empty **3 times in a row** within a day, that tool **rests for 6 hours**.
  - While resting it is hidden from the AI. If it is called anyway, it returns "The site has changed recently and this tool is resting, please use the browser tools".
  - After 6 hours it is tried once again on the next request, and if it works it comes right back.
  - The user does not keep running into a blocked tool, and Dool2 finishes the job with the generic browser.
- The records stay only on the user's PC. Sending anything out (an anonymous breakage report) will be built separately later, only when the user turns it on in Settings, and it sends only the tool name, step and reason.

### 2. A real-site check every night (maintainer's PC, automatic)

- `pnpm connector canary --json report.json --issues` runs every `lookup` tool with its `examples` inputs. It runs in a real Chrome on a home connection (sites block data-center IPs).
- It catches silent failures as well as loud ones.
  - It checks whether a list has fewer rows than `expect.rows` (1 by default).
  - It checks whether the `expect.filled` fields are more than 80% filled.
- For each broken tool it opens or updates one GitHub issue (`[connector] tool name`, label `connector-broken`). When it works again it leaves a comment and closes the issue.
- Results are also kept as an HTML report.

### 3. Draft repair (maintainer's PC, automatic, then a person merges)

- For a few of the tools found broken by the check (3 by default), a coding agent (Claude Code, repo skill `.claude/skills/connector`) does the fix.
  - It reproduces the problem in a separate working folder, looks at the screen, and edits only `tools.json`.
  - After checking with `pnpm connector try` and `check`, it opens a draft PR.
- A person merges, after seeing CI pass. The agent edits nothing except `skills/<id>/tools.json`.

## Why

- The automatic rest on the user's side immediately stops a broken tool from bothering the same user over and over. Because the generic browser is the floor underneath, the job still gets done while the tool rests.
- The nightly check finds problems before users do, and catches silent failures. Sites usually do not deploy overnight, so there is time to fix it in the morning.
- Most fixes (changing a selector or an address pattern) are repetitive work already written down in the connector skill, so an agent can make the draft. The person only reviews.

Alternatives considered: running the check in CI (GitHub Actions), because many sites block data-center IPs and test Chrome, so the results cannot be trusted. Sending breakages collected on users' PCs straight to a server, because it needs privacy consent and a server, so it is postponed to a later stage.

## Consequences

- The maintainer's PC has to be on every night (a Mac runs what it missed during sleep when it wakes up). To switch it off or move to another machine, only `scripts/connector-nightly.sh` and the install script have to be moved.
- Draft repair uses the maintainer's AI subscription quota. The number of repairs per night is capped (`DOOL2_FIX_MAX`).
- The more each tool states its `expect` (fields that must be filled, minimum row count), the better silent failures are caught. The connector authoring skill asks for it.

## Fixes from the first run (2026-11-18)

- On the first night, 5 of 88 tools showed up as broken, but 3 were draft tools not yet verified and 1 was a browser delay. So **a failure is retried once after 30 seconds**, and **issues and repairs are created only when a `verified` tool breaks**. Results for draft tools go only into the report.
- Fixed the problem where the repair stage did only the first tool and stopped (the agent read the remaining list as input).
- Unattended runs lose the AI login every few weeks. On the maintainer's PC, set up an unattended token with `claude setup-token`.

## When a site blocks (2026-11-18)

- In real use the AI called the Coupang search four times at once. The four calls moved the same tab (one per service) at the same time and got Coupang's block page ("요청하신 페이지의 사용권한이 없습니다", "you do not have permission for the requested page"). The block lasted for a while in that tab.
- Fix: the daemon runs **calls to the same service one at a time**, starting 1.5 seconds after the previous call ends (different services still run concurrently). This also removes the problem of results getting mixed up over the same tab.
- `stop_if`, which catches block pages, gets `blocked: true`. The result carries `structuredContent.blocked`, the health record counts it as `blocked` (not as a failure that triggers a rest), and the nightly check counts it separately as "blocked by the site" and creates no issue or repair. Before this, the check treated a block as a "normal stop", so it showed a check mark even when the test browser was blocked.
- We do not work around blocks. The AI gets "do not call again right away; tell the user".
- Even so, about an hour later Coupang again blocked going **straight** to the search address (in a new tab too). It opens when you first open the home page like a person and then go to the search address. So Coupang product search and order preparation open in this order: home page, (1.2 s), then the search or product address. That is the same route a person takes, and we do not retry by knocking on a blocked page again.
