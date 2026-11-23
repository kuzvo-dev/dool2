# 0001. Record decisions as ADRs

- Status: Accepted
- Date: 2026-11-14

## Context

Dool2 is developed in a public repo, where outside contributors and coding agents work together. If decisions about structure live only in conversations or commit messages, the same question ("Why don't you use Docker?") keeps coming back.

## Decision

Decisions that affect the structure are recorded as short ADRs (Architecture Decision Records) in `docs/decisions/NNNN-name.md`. The big picture of the design lives in the [architecture document](../architecture.md). An ADR holds only one decision and its reason.

## Why

- The "why" of a decision cannot be read from the code.
- It keeps a record of what to re-examine when a decision changes.

## Consequences

- A PR that changes the structure includes an ADR or updates an existing one.
- Old decisions are not deleted. They are marked "Superseded".
