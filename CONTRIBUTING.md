# Contributing to Dool2

Thanks for your interest in Dool2. Dool2 is an open-source AI assistant, and as much as code it needs **hands-on knowledge of how each service really works**. You don't have to be a developer to contribute.

Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

Commit messages, PR titles and bodies, and issues are written in English. Korean issues are still welcome; maintainers reply in English or Korean.

## Ways to contribute

| What you want to do                             | Where                                                                                              |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Questions, ideas, feedback                      | [Discussions](https://github.com/kuzvo-dev/dool2/discussions)                                      |
| Report a bug                                    | [Issue: Bug report](https://github.com/kuzvo-dev/dool2/issues/new?template=1-bug.yml)              |
| Suggest a feature                               | [Issue: Feature request](https://github.com/kuzvo-dev/dool2/issues/new?template=2-feature.yml)     |
| Request or write a skill (how to use a service) | [Issue: Skill request](https://github.com/kuzvo-dev/dool2/issues/new?template=3-skill-request.yml) |
| A skill broke because a site changed            | [Issue: Broken skill](https://github.com/kuzvo-dev/dool2/issues/new?template=4-skill-broken.yml)   |
| Security vulnerability                          | [Report privately](SECURITY.md), not in a public issue                                             |
| Fix code or docs                                | Pull Request (steps below)                                                                         |

If you're new, start with issues labeled [`good first issue`](https://github.com/kuzvo-dev/dool2/labels/good%20first%20issue).

## Development setup

**You need**: Node.js 24 or later ([`.nvmrc`](.nvmrc)), pnpm (corepack uses the version the repo pins), and Git.

```bash
git clone https://github.com/<your-account>/dool2.git
cd dool2
corepack enable
pnpm install
pnpm build
pnpm dev:desktop       # run the desktop app
```

Common commands:

| Command                                            | What it does                                                                        |
| -------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `pnpm build`                                       | Build all packages (Turborepo)                                                      |
| `pnpm test`                                        | Run tests (Vitest)                                                                  |
| `pnpm typecheck`                                   | Type check                                                                          |
| `pnpm lint`                                        | Lint and format check (Biome). `pnpm format` fixes formatting                       |
| `pnpm dev:desktop`                                 | Run the desktop app                                                                 |
| `pnpm dev:daemon`                                  | Run only the Dool2 daemon, without a window                                         |
| `DOOL2_SMOKE=1 pnpm --filter @dool2/desktop smoke` | Launch the desktop app, capture the screen, and exit (`apps/desktop/out/smoke.png`) |

For the repo layout see the [README](README.md#repository-layout), and for the overall design see the [architecture doc](docs/architecture.md).

### Developing without a real AI

- Tests never call the real Claude Code or Codex. We save real output to `fixtures/` after removing personal data and test against that.
- To make a conversation for screenshots, run `node apps/daemon/scripts/seed-demo.mjs /tmp/dool2-demo`, then start the app with `DOOL2_DATA_DIR=/tmp/dool2-demo`.
- Checks that call a real AI use your own subscription quota. Please do them only when you need to.

## Pull Request process

1. For a big change, talk about the direction in an issue or Discussion first. This matters most for **security-critical areas** (below), where the design has to be agreed up front.
2. Fork the repo and create a branch named `feat/...`, `fix/...`, `docs/...`, `chore/...`, or `test/...`.
3. Keep **one change per PR**. Smaller PRs get reviewed faster.
4. Before you push, run: `pnpm lint && pnpm build && pnpm typecheck && pnpm test`
5. If the UI changes, attach a screenshot to the PR. It must not show personal data.
6. After review, a maintainer merges with squash.

For a first-time contributor, a maintainer has to approve the PR before CI runs. The Mac, Windows and Linux checks and the DCO check must all pass before merging.

### Review levels

| Area              | Paths                                                                                     | Review                                                                         |
| ----------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Security-critical | `packages/gate`, `packages/protocol`, `packages/agent-*`, `packages/mcp-tools`, `.github` | Maintainer review required, security tests required. Open a design issue first |
| General code      | UI, tools, storage                                                                        | Maintainer review                                                              |
| Skills            | `skills/`                                                                                 | Format check, then review                                                      |
| Docs              | `docs/`, `*.md`                                                                           | Light review                                                                   |

## Commits

- **Every commit must be signed off (DCO).** `git commit -s` adds a `Signed-off-by` line. It means you agree to the [Developer Certificate of Origin](https://developercertificate.org/): you have the right to contribute this code. We don't ask for a CLA.
  - If you forgot, fix it with `git commit --amend -s` or `git rebase --signoff main`.
- Write commit messages in English and say what changed and why.

## Code style

- TypeScript (strict) and ES modules. Biome decides formatting and linting: single quotes, no semicolons, 110 characters per line.
- User-facing copy follows the [persona](docs/persona.md) voice: short, friendly, no technical jargon.
- Write code comments in English and explain "why".
- Include tests with new features.

## Principles to respect

We can't accept PRs that break these principles. The reasons are in the [architecture doc](docs/architecture.md).

- **The AI uses only Dool2 tools.** We won't accept changes that turn the agent's shell, file or web features back on.
- **Paying and contacting must never run without the user's approval.** We won't accept changes that weaken the approval gate or delete its tests.
- **We run the official programs unmodified.** We won't accept changes where Dool2 handles Claude Code's login data or tokens.
- **No workarounds.** We won't accept code or skills that bypass CAPTCHAs, identity verification, or bot detection. Hand off to the person instead.
- **It must stay easy for users.** If users would see a terminal or developer terms, we redesign it.

## Working with a coding agent

You're welcome to contribute with a coding agent such as Claude Code or Codex. The agent reads [AGENTS.md](AGENTS.md) and follows the same rules. The person who opens the PR is responsible for the result.

## License

Code you contribute is distributed under the [Apache License 2.0](LICENSE), and skill docs (`skills/`) under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).
