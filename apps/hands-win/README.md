# @dool2/hands-win

The Dool2 **PC screen control helper (Windows)** — the counterpart of [`@dool2/hands-mac`](../hands-mac/README.md)
([architecture 5.2](../../docs/architecture.md)). The Dool2 daemon starts it as a child process and drives it with
one-line JSON over stdin/stdout, the **same protocol the macOS helper speaks**, so the daemon talks to either helper
with a single adapter. Decisions (which apps are allowed, which buttons are risky, approval) are made by the daemon
([ADR 0047](../../docs/decisions/0047-three-autonomy-levels.md)).

Where the macOS helper is a Swift binary over the Accessibility (AX) APIs, this helper is a TypeScript package over
Windows **UI Automation (UIA)**. The protocol, ref-marking and safety logic are platform-independent and fully tested
in CI; the native UIA calls sit behind one injectable seam (`src/backend.ts`), implemented when building on Windows.

```bash
pnpm --filter @dool2/hands-win build
# offline smoke with the in-memory fake (no Windows, no UIA):
DOOL2_HANDS_FAKE=1 node apps/hands-win/dist/cli.js
printf '%s\n' '{"id":1,"cmd":"apps"}' | DOOL2_HANDS_FAKE=1 node apps/hands-win/dist/cli.js
```

## Protocol

Line-delimited JSON, identical to hands-mac:

```
→ {"id":1,"cmd":"snapshot","args":{"bundleId":"slack.exe"}}
← {"id":1,"ok":true,"result":{…}}      or      {"id":1,"ok":false,"error":"…"}
```

The app selector is passed under `bundleId` exactly like the macOS helper (also accepted as `app`). On Windows the value
is the **process image name** (e.g. `slack.exe`) or an **AUMID** for a packaged app — the Windows analog of a macOS
bundle id. The daemon treats it as an opaque string, so the command and result shapes are the same on both platforms.

| Command              | What it does                                                                                                            |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `status`             | UIA availability (`accessibility`), window capture (`screenRecording`), whether the workstation is `locked`, `platform` |
| `request`            | The seam for a consent prompt; first-time per-app approval is the daemon's job. Returns `status`                        |
| `apps` · `installed` | Running apps, and installed apps (`bundleId`, `name`)                                                                   |
| `open`               | Launches an app and brings it to the front                                                                              |
| `snapshot` (`read`)  | The front window's UIA tree as text like `[e12 버튼 "저장"]` (button "Save"). Password field values are **not** emitted |
| `click`              | Invokes an element by `ref`, or clicks a point by `x,y`                                                                 |
| `type`               | Focuses a field and sets its text. **Password/secure fields are refused**                                               |
| `key`                | Enter, Tab, arrows, Ctrl+… . **Destructive combos are refused** (Alt+F4, any Windows-key shortcut, Task Manager, C-A-D) |
| `screenshot`         | Captures the app's largest window (JPEG, base64)                                                                        |

Interactive elements are marked `[eN role "name"]` with the **same Korean role vocabulary** hands-mac and the web
browser use (버튼 button, 입력칸 input, 비밀번호칸 password, 체크박스 checkbox, 라디오 radio, 선택 상자 select, 탭 tab,
메뉴 menu, 링크 link, 항목 item). The daemon matches them with the same ref regex it uses for the page
(`/\[((?:f\d+)?e\d+)\s+…\]/`). The words live as data in `src/locales/roles.ts`; the code is English (ADR 0029).

## Safety (enforced in the helper, not just the daemon)

- **Blocked apps.** Browsers, password managers and Dool2 itself are never driven by PC screen control, whatever the
  daemon asks (browsers go through the hidden-Chromium browser tools, [ADR 0046](../../docs/decisions/0046-built-in-browser.md)).
  See `HARD_BLOCKED` in `src/safety.ts`.
- **Secure fields.** A password/secure field's value is never read or emitted in a snapshot, and `type` refuses it. The
  daemon's vault fills credentials host-side; values never pass through the AI.
- **Destructive key combos.** `key` refuses Alt+F4, any Windows/meta-key shortcut, Ctrl+Shift+Esc and Ctrl+Alt+Delete.

The **owner/consent model** (first-time per-app approval before Dool2 may touch an app) is the daemon's responsibility,
surfaced through the `request` command seam — the helper does not keep its own allow-list beyond the hard blocks above.

## The native UIA seam

`src/backend.ts` declares `UiaBackend`: enumerate apps/installed, launch, get the window tree, click an element or a
point, focus, set a value, type, send a key, capture a window, and report status. `InMemoryUiaBackend`
(`src/in-memory-backend.ts`) is a full fake that the tests and the offline smoke use. The real backend, to be written
when building on Windows, implements `UiaBackend` with one of:

- a native N-API addon over `IUIAutomation` (COM), or
- a bundled PowerShell / C# helper over `System.Windows.Automation`.

It is loaded at runtime by `src/cli.ts` as `./native-backend.js`; until it exists, the CLI runs only with
`DOOL2_HANDS_FAKE=1`. Because the backend is the single Windows-only part, the rest of the helper builds, type-checks
and tests on any platform — no `onlyBuiltDependencies` native build is needed in CI.

## What still needs a real Windows machine

- Implement `native-backend.ts` (`createNativeUiaBackend(): UiaBackend`) and verify it against real apps (a messenger,
  a native settings window, a login form with a real password field).
- Confirm the UIA ControlType → role mapping in `src/roles.ts` against those apps and extend it where a control type is
  missing.
- Wire the daemon's `pc` bridge (`apps/agentd/src/bridges.ts`, a stub today) to spawn this helper and translate the
  `PcBridge` calls to these commands — the same adapter that will serve hands-mac.
