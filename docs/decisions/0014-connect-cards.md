# 0014. Add each service connection from a template (connect card)

- Status: Accepted
- Date: 2026-11-15

## Context

For Dool2 to handle the services users rely on, such as shopping, groceries, travel, ticketing and mobile carriers, users need a screen where they can see "which services I can hand to Dool2" and connect them. There are more than 80 services and the number keeps growing. Building separate screen code for each service makes contributing hard, and the text on screen ("payments are done after approval") can easily drift from what actually happens.

## Decision

- One service = one `skills/<id>/` folder. This folder holds the **connect card `connect.json`**.
  - Name, domain, category, connection method, login method, a short introduction, one chat example, and 2 to 6 things it can do (title, what users would say, permission tier)
  - The format is validated against the schema in `@dool2/protocol/connect`, and a repo test validates every card.
- The procedure doc `SKILL.md` is added starting with services that have actually been run. Services with only a card still show in the connection list.
- There are four connection methods: `browser` (log in once in the user's Chrome), `official` (official integrations such as mail and calendar), `open` (no login), `device` (phone permission).
- The approval notice on the detail screen is not written in the card but **generated from the tier of the things it can do.** If there is a `pay` or `contact` tier, "things like ... are done only after you approve on the phone" is added automatically.
- Service logo files are not put in the repo. For icons, the connection screen fetches the service site's icon on the user's PC, and if it cannot, it draws the first letter of the name.

## Why

- A contributor only has to fill in one JSON file and the service appears in the connection list. The screen code stays the same.
- The "things it can do" shown on screen and what the AI sees through `skill_find` come from the same file.
- Generating the approval text from the tier prevents mismatches such as a card saying "done after confirmation" while its tier is `lookup`. Actual approval is still enforced by the Dool2 daemon as now (the card is only reading material).
- Putting other companies' logos in an open-source repo raises trademark issues. Identifying by name and domain is fine.

Other options considered: putting it in the `SKILL.md` front matter (YAML) — with many fields people make mistakes easily and validation is hard. Keeping screen data in code (TypeScript) — the barrier to contribute is high.

## Consequences

- The connection screens (desktop app and phone app) only draw the card list. There is no per-service code.
- A card's list of things it can do is guidance, not a promise. Only things that have actually been run are written as procedures in `SKILL.md`, with the status raised to `verified`.
- Until an official integration exists, the `official` connection method behaves like `browser`.
