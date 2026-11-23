# 0009. Store records in Node's built-in SQLite

- Status: Accepted
- Date: 2026-11-14

## Context

Conversations, completed tasks and approval history must be stored only on the user's PC. Using a native module such as `better-sqlite3` in an Electron app means rebuilding for each Electron version, and it is a common cause of install failures on Windows and Mac.

## Decision

We use `node:sqlite` (`DatabaseSync`), which ships with Node 24. We turn on WAL mode and foreign keys, and manage migrations with `user_version`.

## Why

- No native module build is needed, so installation and CI are simpler.
- The data is a single file, which makes backup and deletion easy. Users can check "my records stay only on my PC" themselves.

## Consequences

- `node:sqlite` is still an experimental API, so we need to check it when updating Node versions.
- Storage is accessed only through `packages/store`, which limits the impact if we change engines later.
