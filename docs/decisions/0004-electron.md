# 0004. Build the desktop app with Electron

- Status: Accepted
- Date: 2026-11-14

## Context

We ship the same app on Mac and Windows, and the Dool2 daemon (dool2d) is written in Node. The candidates were Electron, Tauri and native apps per OS.

## Decision

We use Electron. The Dool2 daemon runs in the same process, and the UI (renderer), with `contextIsolation` and `sandbox` on, talks to the daemon only through a local API (127.0.0.1, token authentication).

## Why

- The daemon is Node, so we can keep a single runtime. Tauri would require shipping a Node sidecar separately.
- Distribution features such as auto-update, code signing, a tray icon and start-at-login are proven.
- We can carry over the existing UI assets as they are.

## Consequences

- The installer is large (about 100 MB or more). We judge this is not a big problem for a one-touch install experience.
- We keep following Electron's security guidance (node integration off, minimal preload, blocking external navigation).
