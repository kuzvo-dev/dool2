# @dool2/hands-mac

The Dool2 **PC screen control helper (macOS)** ([ADR 0013](../../docs/decisions/0013-hands-mac-swift.md), [architecture 5.2](../../docs/architecture.md)). It is a single Swift file; the Dool2 daemon starts it as a child process and drives it with one-line JSON. Decisions (which apps are allowed, risky buttons, approval) are made by the daemon.

```bash
pnpm --filter @dool2/hands-mac build      # → dist/dool2-hands (macOS only, needs swiftc from the Xcode command line tools)
printf '%s\n' '{"id":1,"cmd":"status"}' | ./dist/dool2-hands
```

| Command              | What it does                                                                                       |
| -------------------- | -------------------------------------------------------------------------------------------------- |
| `status`             | Accessibility and Screen Recording permissions, and whether the screen is locked                   |
| `request`            | Shows the system permission dialog (the user turns it on in Settings themselves)                   |
| `apps` · `installed` | Running apps, and installed apps (bundle id and name)                                              |
| `open`               | Opens an app and brings it to the front                                                            |
| `snapshot`           | The front window's accessibility tree as text like `[e12 button "보내기"]` (button "Send"). Password field values are not emitted |
| `click`              | Presses an element with the accessibility "press"; if that fails, clicks its center with the mouse |
| `type`               | Focuses a field and types by pasting (works for Korean), then restores the clipboard. Password fields are refused |
| `key`                | Enter, Tab, arrows, cmd+…                                                                          |
| `screenshot`         | Captures an app window (ScreenCaptureKit, JPEG)                                                    |

It does not operate browsers, password managers, or Dool2 itself, even if the daemon asks.

## macOS permissions

Accessibility and Screen Recording permissions are granted to the name of the **app that launched the helper (Dool2)**, not the helper. If the app's signature is broken, macOS does not recognize the app, and turning the permission on in Settings has no effect (measured).

- Distributed app: at packaging time the whole app is re-signed ad hoc (`afterPack` in `scripts/package.mjs`). Developer ID signing comes in M5.
- During development: the `Electron.app` downloaded from npm also has a broken signature. Re-sign it once with `codesign --force --deep --sign - <Electron.app>`, launch it with `open -n Electron.app --args apps/desktop`, then turn the permissions on for "Electron". Changing Dool2 code does not change Electron, so you do not need to turn them on again.
