# @dool2/desktop

The Dool2 desktop app (Electron). It starts the Dool2 daemon (`@dool2/daemon`) in the same process and hands the screen only the local API address and token ([ADR 0004](../../docs/decisions/0004-electron.md)).

```bash
pnpm build
pnpm dev:desktop
```

## Structure

| File              | Role                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------- |
| `src/main.ts`     | Main process: starts the daemon, the window, and smoke mode                           |
| `src/preload.cts` | The minimal bridge exposed to the screen (`window.dool2`). It does not pass Node features through |
| `src/renderer/`   | The screen (HTML, CSS, TypeScript, no framework)                                      |

The window turns `contextIsolation` and `sandbox` on and `nodeIntegration` off. External links open in the default browser, and the window never navigates to another page.

## Smoke mode (screenshots)

Screens for PRs are captured in smoke mode. It starts with the window hidden, captures once the screen has finished drawing, and exits.

```bash
DOOL2_SMOKE=1 pnpm --filter @dool2/desktop smoke
# → apps/desktop/out/smoke.png

# Load a demo conversation, goals, library and feed, then pick a tab to capture
node apps/daemon/scripts/seed-demo.mjs /tmp/dool2-demo
DOOL2_DATA_DIR=/tmp/dool2-demo DOOL2_SMOKE_OPEN=goals+panel:memory pnpm --filter @dool2/desktop smoke
```

| Environment variable | Description                                                                                                                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DOOL2_DATA_DIR`     | Data folder (default: the standard OS location)                                                                                                                                                              |
| `DOOL2_SMOKE_OUT`    | Folder to save captures in                                                                                                                                                                                   |
| `DOOL2_SMOKE_THEME`  | Capture with `dark` or `light` fixed (default: the device setting)                                                                                                                                           |
| `DOOL2_SMOKE_OPEN`   | Screen to leave open: `talk` `feed` `ideas` `goals` `goal[:id]` `library[:files]` `thread[:id]` `connections[:service]`. Followed by `+panel:section` (schedule, memory, screen, activity, approvals) or `+nopanel` |
| `DOOL2_SMOKE_SETUP`  | Capture the wizard or settings: `welcome` `choice` `check` `awake`; for settings, `settings[:section]` (general, ai, phone, vault, me, apps, about). With `DOOL2_SMOKE_UPDATE=available`, it shows a new version being available |
| `DOOL2_SMOKE_SCROLL` | Scroll until this selector is visible, then capture (for example `.page-more` = the last row of a long list). Use `DOOL2_SMOKE_SCROLL_TIMES` to repeat (when the next page loads, the last row moves down again) |

## Building an installer (unsigned, for development)

```bash
pnpm build
pnpm --filter @dool2/desktop package   # → apps/desktop/release/dool2-<version>-<arch>.dmg (.exe on Windows)
```

- The main process and the Dool2 tools server are each bundled into a single file with esbuild and collected in `stage/`. Codex, Claude Code, and the pay-as-you-go runner are not included; they are downloaded on first use.
- The internal app name is `Dool2`. With a Korean name, macOS cannot find the Electron helper ("두리 Helper") and the app quits right after launch. The name users see is "Dool2".
- Code signing, notarization, and auto-update are added in M5. The dmg built now is unsigned, so other Macs show an "unidentified developer" warning.
- The macOS dmg is about 120 MB (mostly Electron).
