# Working rules for Dool2 (people and AI)

These rules apply to everyone working in this repo, both people and coding agents (Claude Code, Codex and others).

## 1. Ship small PRs, continuously

- **One PR = one thing.** One feature, one fix or one doc. Do not ship big bundles.
- When one thing is done, branch → commit → push → PR right away. Start the next thing on a new branch.
- If the previous PR is not merged yet, stack the new one on its branch and write "Stacked on #N" on the first line of the PR body.
- Branch names: `feat/…`, `fix/…`, `docs/…`, `chore/…`, `test/…`
- Merge with squash. Never push to `main` directly.
- **Merge when CI (macOS, Windows and Linux checks plus DCO) passes.** Coding agents working with the maintainer account also merge themselves, but only after checks pass. If a check fails, fix it instead of merging.
- To merge stacked PRs, follow these steps in order:
  1. Change the upper PR's base branch to `main` first. If the lower branch is deleted while it is still the base, the upper PR closes automatically.
  2. Merge the lower PR.
  3. Move the upper branch with `git rebase --onto origin/main <old lower branch tip> <upper branch>` and force-push. Squash merges make it conflict otherwise.
  4. Wait for CI to pass, then merge.

## 2. Show a visible result in every PR

- PRs that change a screen include a **screenshot of the result**.
  - Desktop app: `DOOL2_SMOKE=1 pnpm --filter @dool2/desktop smoke` → `apps/desktop/out/smoke.png`
  - Other screens (phone app, extension) get a similar check mode for screenshots.
- Changes without a screen (internal logic, docs) include test results or a summary of a real run log instead.
- If a screenshot shows personal data (email, accounts, real conversations), blur it or retake it with test data.

## 3. Language

- **The repo is English** (ADR 0029). Code, comments, identifiers, developer logs, docs, commit messages, PR
  titles and bodies are written in English. Terms follow the [glossary](docs/i18n/glossary.md).
- **User-facing copy never goes inline.** Put it in the locale files of `@dool2/i18n` and write it in at least
  Korean (the reference copy) and English. CI fails on missing keys and on Hangul outside the allowed places.
- Korean is fine where it is data: Korean locale files, Korean service cards (`skills/*`), fixtures of Korean
  pages, Korean eval scenarios and the frozen archive in `docs/ko/`.
- Enum values and keys shared between packages are English (for example tiers `lookup`, `fill`, `pay`, `contact`).

## 4. Commits

- Sign every commit with `git commit -s` (DCO). CI checks it.
- Write commit messages in English. Say what changed and why.

## 5. Check before you push

```bash
pnpm lint && pnpm build && pnpm typecheck && pnpm test
```

- Checks that call the real Claude or Codex use the user's subscription quota. Run them only when needed, and
  pin repeated checks in tests with real output saved under `fixtures/`.

## 6. Product principles (summary)

Details are in [docs/architecture.md](docs/architecture.md) and [docs/open-source.md](docs/open-source.md).

- **It must be easy for users.** If a terminal, admin rights or developer jargon reaches the user, redesign it.
- **Never get blocked in the browser.** Use the real Chrome at human speed, and hand CAPTCHAs and identity
  checks to the person. Never try to get around them.
- **The AI works through Dool2 tools, and those tools are broad.** The agent's own shell, file and web
  features are off, and `pay` and `contact` run only with a signature from the phone. Dool2's hands are general
  (reading and producing from pages, code in a sandbox, PC apps) so it can find its own way; safety sits at the
  actions that are hard to undo, not at what it may try ([ADR 0045](docs/decisions/0045-tools-are-shortcuts.md)).
- **Run official programs unmodified.** Dool2 does not handle Claude Code sign-in or tokens.
- User-facing copy follows the Dool2 persona ([docs/persona.md](docs/persona.md)) in every language, in plain
  words people already use.
- Screens are built from [`packages/ui`](packages/ui/README.md) parts, based on the design source
  ([docs/design](docs/design/README.md)). New designs or parts go into `docs/design` first, then `packages/ui`.
- **No other companies' product names or content** in app screens, docs, READMEs or the landing page. If a
  comparison is needed, describe the approach, for example "an approach that works in a browser on a cloud
  server". Names of tools we integrate with (Claude Code, Codex, Chrome and so on) are fine.
- Services are connected through service tools (connectors, `skills/<id>/tools.json`,
  [ADR 0018](docs/decisions/0018-service-connectors.md)). Follow [`.claude/skills/connector`](.claude/skills/connector/SKILL.md)
  to build and fix them. Each connect card declares its `regions` (ADR 0029).
- **Every app feature is also an AI tool.** When you build or change a feature people use on screen (vault,
  payment methods, connections, schedule, settings and so on), ship a Dool2 tool (`packages/mcp-tools`) that
  does the same thing in conversation, in the same PR or the next one. The tool uses the same daemon API as the
  screen, and the security boundaries stay the same. Secrets such as passwords and card numbers are never given
  to the AI, only masked values or names. Things that are hard to undo (money, contacting people, deleting)
  go through approval.
- **Dool2 thinks; tools are shortcuts, not limits** ([ADR 0045](docs/decisions/0045-tools-are-shortcuts.md)).
  When Dool2 gets something wrong or gives up, do not add a rule to the global prompt (`prompts/persona.md`,
  ADR 0040). First ask: "What would have let Dool2 find its own way?" Usually that is a broad capability it lacked,
  or a fact a result left out. Add a narrow tool when it makes a common path faster, and make it fall back to the
  broad hands when it fails. Tool results state what happened, why, and what is possible next; they never say
  "stop", "do not try other ways" or "tell the user to do it" (only the safety orders: approvals, hand-offs for
  CAPTCHAs and identity checks, secrets). Tool descriptions say when to use the tool, and input fields hold what is
  easy to forget. Domain tips live in that tool's or service card's description. Keep the global prompt small, and
  never let Dool2 get slower unmeasured: rerun the failures you fixed, before and after, for how often it gave up
  and how long it took.
- Changes to the architecture come with an [architecture decision record (ADR)](docs/decisions/README.md). If a security
  assumption changes, update the [threat model](docs/security/threat-model.md) too.
