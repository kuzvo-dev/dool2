# 0013. The PC-control helper is written per OS in that OS's own language (Swift on Mac)

- Status: Accepted (M4, Mac first. Windows next)
- Date: 2026-11-14

## Context

Tasks that exist only in apps, such as KakaoTalk PC, Notes and Hangul (HWP), cannot be done with browser tools. We need a small helper that reads the app screen (accessibility tree), clicks, types text and captures the screen (docs/architecture.md 5.2). The first design planned to build both Mac and Windows in a single Rust program.

## Decision

**The helper is kept small and written per OS in the language that OS supports best. On Mac that is Swift** (`apps/hands-mac`, a single file). For Windows we build a separate helper that uses UI Automation.

- The Dool2 daemon starts the helper as a child process and exchanges one-line JSON over standard input and output. All judgment (allowed apps, risky buttons, approval) is the daemon's. The helper is the hands.
- Mac APIs: read and click with accessibility (AXUIElement), keys and mouse with CGEvent, window capture with ScreenCaptureKit, open apps with NSWorkspace
- Hangul text is entered by **pasting** instead of keystrokes, and the original clipboard is restored (so the input method does not get tangled)
- The helper itself also refuses to touch browsers, password managers and Dool2 itself (so it does not cross the line even if the daemon makes a mistake)
- In the shipped app the Dool2 app launches the helper, so the Mac permissions (Accessibility, Screen Recording) are requested once **under the app name "Dool2"**

## Why

- Mac accessibility and ScreenCaptureKit are used directly from Swift. There is no wrapper layer to write for Rust (objc bindings), so the code is short and easy to review.
- Swift comes with the Xcode command-line tools, so there is no extra tool to download. It also builds as is on Mac CI (macos-latest).
- For Windows UI Automation, C#/.NET or the Rust windows crate is the natural choice. Using each OS's API directly causes fewer mistakes than what we would gain by tying both OSes to one language.

## Consequences

- Because the helper is separate per OS, each has to honor the same commands (status, apps, open, snapshot, click, type, key, screenshot). The daemon-side test (`screen-tools.test.ts`) pins the protocol.
- Mac permissions must be turned on by the user in System Settings (the app cannot do it for them). The [Turn on permissions] button under "PC app control" in settings opens the system window and the settings screen.
- Signing: the shipped app must be signed with a developer ID (M5) for permissions to persist after updates. Before signing, rebuilding may require turning the permissions on again.
