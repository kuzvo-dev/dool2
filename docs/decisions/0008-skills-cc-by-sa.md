# 0008. Publish skills under CC BY-SA 4.0

- Status: Accepted
- Date: 2026-11-14

## Context

A skill is a document describing how Dool2 carries a specific Korean service through to the end. Dool2's moat is here. We must publish them so users can check "what the AI does with my account". The remaining question was the license.

## Decision

Code is Apache-2.0, and skills (`skills/`) are **CC BY-SA 4.0**.

## Why

- Skills are closer to documents than code, so a Creative Commons license is a natural fit.
- With ShareAlike (SA), anyone who takes and modifies a skill must publish their improvements under the same terms. This holds back competing products that only take, while keeping terms that fit open source.
- Apache-2.0 would be simpler, but it could not stop someone from taking our most carefully built part as it is.

## Consequences

- Contributors need to know that code and skills have different licenses. We state this in CONTRIBUTING and the README.
- Skill documents can be copied, but the operations that keep them alive (block statistics, quick fixes, signed updates) cannot. That operation is the real moat.
