# Dool2 open-source principles

> Status: a living doc, revised as we operate. Last updated 2026-11-14.

This explains how our open-source operations keep the promises made on [dool2.com](https://dool2.com).

| Promise on the landing page | How operations keep it |
|---|---|
| "The Dool2 program is open source" | All code that touches user data is public in this repo (chapter 1) |
| "We can't see your conversations either" | The relay server code is public too, and anyone can run their own (chapters 1 and 4) |
| "It always asks before spending money" | The approval gate is enforced in code and pinned by security tests. External contributions to this part get stricter review (chapter 3) |
| "Dool2 costs 0 won" | No paid-feature locks in the public code. Running costs are covered by selling the Dool2 Box (chapter 2) |

## 1. What is public

**Principle: all code that touches users' conversations, accounts and approvals is public, with nothing left out.** If any part were not public, we could not prove "we can't see them either."

| Component | Public | Notes |
|---|---|---|
| Desktop app (Dool2 daemon, Mac and Windows) | Public | Agent execution, approval gate, browser, logs |
| Phone app | Public | Sending requests, signing approvals |
| Browser extension | Public | Anyone can check that the store build matches the public code |
| Relay server | Public | Forwards ciphertext only. Anyone can run their own |
| Protocol docs | Public | Detailed enough for others to build a compatible app |
| Skills (per-service usage) | Public | Where we expect the most community contributions |
| Landing and waitlist site | Later | Move to `apps/site` after the secret keys are sorted out. Not urgent |
| Operational secrets (signing keys, server keys, push keys) | Private | Kept only in GitHub Secrets and hardware keys |
| Dool2 Box factory setup | Public | The software in the box is the same code as for a regular PC |

### License and trademark
- Code: **Apache-2.0**. It has a patent protection clause, which suits a company-run open-source project.
- Skills (`skills/`): **CC BY-SA 4.0**. Anyone who reuses them must publish their changes under the same terms (see 3.5).
- The name "Dool2" and the logo are **protected separately as trademarks**. Forks are free, but must change the name and logo. This is written in [`TRADEMARKS.md`](../TRADEMARKS.md). It exists to stop others from distributing a malicious version under the Dool2 name.
- Contribution method: we use the **DCO**, which means adding one `Signed-off-by` line to each commit.
  - We do not use a CLA (contributor license agreement). It is a heavy burden for first-time contributors.
  - If we ever need to change the license later, a CLA would be required. We have no plan to change it now, so the DCO is enough.

## 2. How we earn money

A structure that pays the running costs while keeping the promise of zero fees.

1. **Dool2 Box sales** (main income): a small PC with Dool2 preinstalled, for people with no computer to leave on. The software is the same as the public version; the price pays for the hardware and the effort of setting it up.
2. **Official relay server**: run for free.
   - It only forwards ciphertext, so costs are small. On Cloudflare we estimate a few won per user per month (to be measured).
   - Running your own relay server is officially supported too.
3. (Later, optional) Donations via GitHub Sponsors. Things like enterprise adoption support will be considered if demand appears.

**What we will not do**
- No open-core model with paid-feature locks inside the public code. It conflicts with the landing page's "0 won" promise.
- No making money from user data.

## 3. Who decides what

- **Maintainer**: currently one person, kuzvo-dev. Under the repo protection rules, only maintainers can merge to `main`.
- **Decision records**: decisions that change the structure are recorded as ADRs in [`docs/decisions/`](decisions/README.md). Publishing why we decided something keeps outside contributors from repeating the same debate.
- **Roadmap**: published as one GitHub Projects board. Anyone can see how far the landing page's "in development" has really come.

### Review strictness by area

| Area | Example paths | Review |
|---|---|---|
| Security core | Approval gate, encryption, signature verification, updates | Maintainer required, security tests must pass. External PRs start with a design issue |
| General code | UI, tools, agent integration | Maintainer review |
| Skills | `skills/<service>/` | Format check and tier-label check (CI), then maintainer review |
| Docs | `docs/` | Light review |

The security-core paths are listed separately in CODEOWNERS. As contributors grow, we will assign dedicated reviewers to those paths only.

## 3.5 The moat: the Korea-focused harness

**Dool2's moat is one thing: the Korea-focused harness.** The harness combines skills that handle Korean services all the way through without getting blocked, a map of blockers, and approval rules.
- Remote PC control itself is being shipped directly by AI companies too.
- End-to-end encryption and the signature gate give trust, but others can copy them.
- What others cannot easily copy is **field knowledge that keeps being updated**: "how to avoid getting blocked at SRT seat selection", "how many days a Coupang login lasts", "how to handle the Hometax certificate window".

**But skills are public. Is that still a moat?**
- The skill docs themselves can be copied. But **the operation that keeps them alive** cannot be copied.
  - Anonymous success and blocked statistics from thousands of user PCs
  - Speed of fixing things the day a site changes
  - A signed skill update channel
  - A community of Korean users and contributors
- A stale skill breaks within weeks. So the moat is the system of fixing, more than the docs.
- There is also a reason to keep them public: users can trust Dool2 with their accounts only if they can verify what the AI does with them.

**The skill license needed a decision**

| Option | Terms | Pros | Cons |
|---|---|---|---|
| A. Apache-2.0 (same as code) | Anyone may use freely | Simplest, easy for contributors | A competing product can take it as is, and we cannot stop them |
| B. CC BY-SA 4.0 | Reuse is allowed, but changes must be published under the same terms | Keeps open-source terms while discouraging competitors who only take | Differs from the code license, so slightly more complex |

**Decision: B (CC BY-SA 4.0, 2026-11-14).** Skills are documents, so a CC license is a natural fit. If a competitor takes them, they must publish their improvements back, so the Dool2 harness stays the most up to date.

## 4. Where the community can contribute easily: skills

Dool2's usefulness comes down to how well it handles each service. A single maintainer cannot cover dozens of Korean services. So **we design skills as the lowest-barrier contribution path.**

- Services are added as data, not code (`tools.json`, service tools, ADR 0018). You chain together fixed actions (open, click, extract a list, request approval), and the repo skill (`.claude/skills/connector`) walks you through the steps.
- The old repo has about 40 drafts. Moving them over and promoting them from `draft` to `verified` will be opened as the first contribution task (good first issue).
- Each skill shows a status: `draft` / `verified (date)` / `blocked (reason)`. It records who actually ran it and when.
- **Skill safety rules** (checked by CI):
  - Every tool must state its approval tier (`lookup` / `fill` / `pay` / `contact`). The approval request goes only at the end of `pay` and `contact` tools.
  - Instructions such as bypassing CAPTCHAs, bypassing identity verification or typing passwords cannot be included. Payments and orders must not be made as data requests.
  - A connector cannot turn off the approval gate. The gate is enforced by code outside the connector (the Dool2 daemon).
- When a skill breaks because a site changed, the user's Dool2 reports "this skill failed" and drafts an issue. It is filed only with the user's approval, with personal information removed (later).

## 5. Distribution and trust

Because this is a "program that runs on my computer", users must be able to trust that **the program they downloaded matches the public code**.

- **Builds happen only in GitHub Actions.** Files built on a maintainer's laptop are never distributed.
- **Code signing**: Apple notarization on Mac, a code-signing certificate on Windows. Without signing, the OS blocks or warns on install.
- **Build provenance**: release files carry GitHub artifact attestations, so anyone can verify "this file was built from this commit by this workflow."
- **Auto-update**: only signed updates are accepted. The app installs only after verifying the update signature.
- **Skill updates** (connector packs, ADR 0039) are delivered separately from app updates. Only bundles signed with their own key are accepted, never one older than what the PC has, and they cannot change the approval gate. They take effect on their own, and Settings puts back the version that came with the app in one press.
- **Versions**: the README states that we make no compatibility promises during `v0.x`. Release notes are written in English, with a Korean summary.

## 6. Security operations

- Vulnerability reports are received privately (`SECURITY.md`, GitHub private vulnerability reporting is on).
- **We publish the threat model** ([`docs/security/threat-model.md`](security/threat-model.md)). It honestly states what we block and what we cannot. For example: "If the PC is infected with malware, Dool2 cannot protect you either."
- The approval gate is pinned by a **test that fails if a pay tool runs without a signature**. We do not accept PRs that delete or weaken this test.
- Dependency vulnerability alerts and secret push blocking are already on.
- We will consider a bug bounty as users grow.

## 7. Communication

- **Language**: English is the default for the repo and docs; Korean originals are archived in `docs/ko/` (ADR 0029). The main users are Korean and the services are Korean, so Korean copy remains first-class in the product.
- **Questions and ideas**: use GitHub Discussions. Issues are only for bugs and to-dos.
- **Issue templates**: four kinds: bug / skill request / skill breakage report / feature proposal.
- **Landing connection**:
  - Replace the landing FAQ's "GitHub release in preparation" with the repo link.
  - Link the "open code" cell in the landing's comparison table to the repo too.
- **Building in public**: the repo is already public. When posting progress in threads, attach commit and PR links.

## 8. Progress

1. [x] Public repo, Apache-2.0, repo protection rules, [`SECURITY.md`](../SECURITY.md), [`CONTRIBUTING.md`](../CONTRIBUTING.md)
2. [x] [Architecture doc](architecture.md) and [decision records (ADR)](decisions/README.md)
3. [x] Monorepo skeleton and CI (lint, build, type check, tests, DCO check; Mac, Windows and Linux)
4. [x] [`TRADEMARKS.md`](../TRADEMARKS.md), [code of conduct](../CODE_OF_CONDUCT.md), issue and PR templates, Discussions
5. [x] First version of the [threat model](security/threat-model.md)
6. [ ] Move over the existing skill drafts, skill format-check CI (M4)
7. [ ] Set up the signing, notarization and attestation pipeline before the first release (M5)
8. [ ] Public roadmap board (GitHub Projects)
9. [ ] Replace the landing's "GitHub release in preparation" text with the repo link
