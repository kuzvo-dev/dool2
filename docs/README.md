# Dool2 docs

An index of the docs on building and running Dool2. The user guide will be written separately with the first release (M5).

Korean originals of these docs, frozen as of 2026-11-23, not kept in sync, are in [ko/](ko/README.md). Shared translation terms are in the [glossary](i18n/glossary.md).

## Design

| Doc | Contents |
|---|---|
| [Architecture](architecture.md) | Overall structure, agent integration, approval gate, browser and PC control, phone connection, install, roadmap, risks |
| [Persona](persona.md) | Dool2's personality and voice. The standard for every piece of user-facing copy |
| [Design source](design/README.md) | The design system (colors, type, character, components) and 14 example screens. The standard for every screen |
| [Decision records (ADR)](decisions/README.md) | Structural decisions and why they were made |
| [Threat model](security/threat-model.md) | What we protect, what we block, and what we cannot block |

## Operations

| Doc | Contents |
|---|---|
| [Open-source operations](open-source.md) | What is public, license, revenue model, governance, skill contributions |
| [Trademark policy](../TRADEMARKS.md) | When you may use the "Dool2" name and logo |
| [Security reports](../SECURITY.md) | How to report a vulnerability privately |

## Packages

Each package folder has a README with its role and main APIs: [desktop](../apps/desktop/README.md) · [daemon](../apps/daemon/README.md) · [protocol](../packages/protocol/README.md) · [engine](../packages/engine/README.md) · [agent-claude](../packages/agent-claude/README.md) · [agent-codex](../packages/agent-codex/README.md) · [agent-opencode](../packages/agent-opencode/README.md) · [mcp-tools](../packages/mcp-tools/README.md) · [browser](../packages/browser/README.md) · [store](../packages/store/README.md) · [ui (design system)](../packages/ui/README.md)

## Contributing

| Doc | Contents |
|---|---|
| [Contributing guide](../CONTRIBUTING.md) | Dev environment, PR process, commit signing |
| [Working rules](../AGENTS.md) | Rules that people and coding agents follow together |
| [Code of conduct](../CODE_OF_CONDUCT.md) | Community standards |

## How to write docs

- The default language is English ([README.md](../README.md)); a Korean version is kept as [README.ko.md](../README.ko.md). Language and region are separate settings (ADR 0029).
- Write short sentences, and give the reason with each decision.
- Docs that show screens use captures without personal data. You can create demo data with `node apps/daemon/scripts/seed-demo.mjs <folder>`.
