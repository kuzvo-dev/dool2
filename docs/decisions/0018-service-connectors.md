# 0018. Services are attached as connectors (per-service tools)

- Status: Accepted
- Date: 2026-11-17
- Amends: the "procedure document `SKILL.md`" part of [0014](0014-connect-cards.md) (connect cards stay as they are)

## Context

Until now Dool2 worked on every service with generic browser tools (open, read, click). Service-specific know-how was written as prose in `SKILL.md` for the AI to read. Running it for real showed:

- **It is slow and expensive.** On CatchTable, going from search to the deposit notice took 64 seconds and more than 20 screen reads and clicks. The AI reads the whole screen every time.
- **There is plenty of room for error.** Recycled lists, covered buttons, a "Next" on the payment screen: confusing a single step sends it somewhere wrong.
- **Prose cannot be enforced.** Even if it says "stop at the deposit screen", obeying it is up to the AI's judgment.
- There is no way to check that something fixed while running one site is also right on other sites.

## Decision

### 1. One service = one connector

Next to the connect card (`connect.json`), the `skills/<id>/` folder holds a **connector, `tools.json`**. A connector describes what can be done on that service as **typed tools**.

```
skills/catchtable/
  connect.json   connect-screen card (ADR 0014, unchanged)
  tools.json     tools: name, description, input, output, tier + execution order (steps)
```

A tool looks like this.

- `name` `title` `description`: the guidance the AI sees. Write **when to use it, what it returns, and what to do next**. The know-how that was in `SKILL.md` moves here and into the input field descriptions. The rest (addresses, screen order) is hidden inside steps.
- `input`: the input fields (a small subset of JSON Schema: string, number, boolean, enum, with description, format, range). The required fields are exactly "what to confirm with the user first".
- `output`: the shape of what is returned. It goes out as-is as MCP `outputSchema` / `structuredContent`.
- `tier`: the permission tier (`lookup`, `fill`, `pay`, `contact`). The MCP hints (`readOnlyHint`, `destructiveHint`, `idempotentHint`) are derived from it too.
- `login`: whether the tool needs a login.
- `examples`: example inputs. They are attached to the AI's guidance and become the inputs of the daily real-site test (canary).
- `steps`: the execution order. Only fixed actions are chained: open, wait, click by text, type, extract a list, read a response the page received, request approval, return.

### 2. The extension is a fixed engine; connectors are data

- The extension holds **only generic actions**: read the screen, click and type, plus the ones added now: **extract a list (`extract`)**, **find text (`find`)**, and **read the response the page received (`capture`)**.
- A connector is data (`tools.json`), not code. The daemon reads it and expands it into engine actions to run.
  - The Chrome Web Store forbids extensions from running code fetched from outside. And we do not need to put the extension through review again every time a site changes.
  - What a connector can do is bounded by the engine actions. **A connector has no way to switch off or bypass the approval gate.** Clicks go through the same risk check as now (`classifyRisk`), a `lookup` tool cannot click a risky button at all, and `pay` and `contact` tools can finish the last button only by requesting approval.
  - A contributor only has to edit one JSON file, and the repo's tests check its format and safety rules.

### 3. How the AI sees them (MCP)

- **Tools of connected services are visible right away.** For example `catchtable_search`, `catchtable_prepare_booking`. Tools of services that need no login (`how: open`) are visible right away too.
- **The rest are found and used.** `service_find` (find a service: what it can do, whether it is connected, its tools and input fields) and `service_call` (run a tool that was found). Handing over 86 services × 3 or 4 tools at once confuses the AI and costs many tokens every turn.
- When the connection state changes, the tool list is refreshed (`tools/list_changed`). Even for runners that cannot receive this, `service_call` always works.
- Results come back as **text plus structured data**. The text is a short table or lines; the data has the `output` shape.
- A failure comes back with **what to do next**. If a site changed and the connector cannot read it, Dool2 says "continue with the browser tools" along with the open tab number. That case is logged and the canary checks it again.

### 4. Connection guidance

- Calling a tool that needs a connection before connecting does not run it. It returns **connection guidance**: what you can do right away once connected, and an instruction to show the connect card with `connect_ask`.
- When the generic browser opens a site that has a connector, the first read gets "This site has a Dool2 connector: ..." appended, so the connector gets used.
- If the service that fits a request is not connected yet, the AI first searches with tools that work without login, and recommends connecting at the booking or ordering step (as in the persona instructions).

### 5. `SKILL.md` goes away

- The two that existed (CatchTable, CJ Logistics) move to connectors and are deleted. `service_find` replaces `skill_find` / `skill_read`.
- A service with no connector yet uses the generic browser tools with only its connect card. If a short tip is truly needed, put it in the card's `hints` (1 to 3 lines: search address and the like).

### 6. Status and verification

- Each tool records a status: `verified (YYYY-MM-DD)`, `draft`, `blocked (reason)`.
  - Draft tools still run. The result carries "This is the first time on this route, so please double-check the result."
  - Blocked tools are not shown.
- Connector-level tests: a test (repo test) that runs the steps to the end against a fake engine.
- Real-site test (canary): a script that runs `lookup` tools with their `examples` inputs. It runs daily to find broken connectors.

### 7. License

`tools.json` is also data under `skills/`, so it is CC BY-SA 4.0 ([ADR 0008](0008-skills-cc-by-sa.md)). The engine and runner code is Apache-2.0.

## Why

- **Fast and accurate.** The AI decides only "what", and a verified sequence does "how". It does not read the whole screen every time.
- **Safety rules are enforced by code.** The engine actions allowed per tier are fixed, and the approval gate is unchanged.
- **No store review when a site changes.** The engine stays put and only data changes.
- **It prevents tuning to a single site.** The canary runs every connector daily.

Alternatives considered:

- **Per-service TypeScript code**: very expressive, but in the extension every fix would need store review, and in the daemon a connector could do things outside the engine, which raises the review burden. It also raises the bar for contributors.
- **Calling a site's server API directly from the daemon**: not done, because cookies would have to leave the browser (ADR 0006, security).
- **Always showing every tool**: there are over 300 tools. We show only connected ones and let the AI search for the rest.
- **Keeping `SKILL.md`**: prose cannot be enforced, and the same content ends up written in two places along with the tool guidance.

## Consequences

- New services and fixes are done in `tools.json`. The repo's connector authoring skill (`.claude/skills/connector`) walks through the steps.
- Adding an engine action needs a new extension version (store review). So engine actions are made generous and generic, and are not changed often.
- Connectors that depend on a site's screen structure (selectors) break when the site is redesigned. The canary and "continue with the browser tools" back them up.
- Flows that are hard to express with fixed actions alone (calendars, complex selections) are handled by the connector bringing the user to the screen and then handing over to the browser tools (a `handoff_to_agent` step). If there get to be many of these, we reconsider adding engine actions.

## Amendment (2026-11-17)

- **Dool2 does not call a site's API directly.** At first we had a `fetch` that ran inside the site's tab and made the site's data requests from Dool2. Since that sends requests to the site's server in a way a person would not, we removed it. Now a connector **opens addresses and reads the screen**, like a person.
  - For sites whose screen selectors are unstable, it reads **the response the page itself received** (`capture`; the extension only listens to the tab's responses). For sites where the server sends results along with the page, it reads the data embedded in the page (`embedded`).
  - The same search gets a little slower because the page is rendered to the end (CatchTable search 2.1 s to 11.4 s). In return, what the site sees is the same as a person opening that page.
- When a connector breaks because a site changed, the monitoring pipeline in [ADR 0020](0020-connector-health.md) catches it quickly.
