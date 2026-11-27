# 0006. Use the browser through the user's own Chrome plus the Dool2 extension

- Status: Superseded by [0046](0046-built-in-browser.md)
- Date: 2026-11-14

## Context

Dool2's most important promise is "never get blocked on Korean services". The options we looked at:

| Option | Problem |
|---|---|
| Launch a new Chromium with Playwright | Logins reset every time, and automation traces trigger bot detection |
| Attach remote debugging to the user's Chrome | Since Chrome 136, remote debugging is blocked on the default profile |
| An external AI browser or a Chromium fork | The user has to log in again in a new browser, and maintaining a fork is costly |
| Import cookies from the existing browser | Risky for security and easy to break because of OS keychain encryption |

## Decision

Install the **Dool2 extension in the Chrome** the user already uses, and connect it to the Dool2 daemon with native messaging. Input is sent as real input events through `chrome.debugger`. We settle on Chrome as the one browser, and Dool2 installs it if it is missing. A dedicated-profile mode is kept as an option for those who want it.

## Why

- It uses the user's usual logins, so there is no need to log in again, and since it is a real user's browser it gets blocked the least.
- For an extension, you can check that the public code and the store build are the same.
- We can only support the skills and tests if we settle on one browser.

## Consequences

- Installing the extension needs one user click (allowing an "external extension").
- CAPTCHAs and identity verification are not bypassed. The screen is handed off to the person.
- Because this works on the user's browser, we review extension permissions and message validation as a security-critical area.

## Revisited (2026-11-14): should we switch to our own Chromium-based browser?

We also reconsidered the approach of building a browser from scratch on Chromium for AI work. Its advantages are that it gives full control over the whole browser, controls screen and input without permission prompts, and can fit screens such as the vault and the task panel naturally into the browser.

**We still keep the default option.**

| Point considered | Own Chromium browser | User's Chrome + Dool2 extension (current) |
|---|---|---|
| Usual logins | Cookies must be imported from the existing browser. On Windows this is practically blocked by Chrome's app-bound encryption, and Korean sites easily see it as a "login from a new device" and ask for verification again | Works exactly as the user usually does |
| User habits | The user has to switch browsers | No need to switch |
| Security updates | We would have to follow Chromium security patches ourselves every 2 to 4 weeks | Google does it |
| Installer size and signing | We ship one more browser | One extension |
| Security programs of banks and public sites | May need to be reinstalled and recognized per browser | Used as already installed |

What we take from it is recorded as separate decisions.
- A vault where Dool2 fills in passwords without showing them to the AI → [ADR 0011](0011-login-vault.md)
- A screen for choosing the permission level per task (read-only / protected / full) and a "final check" switch → reflected in the approval gate (M3) screen
- A **dedicated-profile mode** (running Chrome with a separate data folder, no fork) for cases where the extension is not enough stays as an option

## Follow-up (2026-11-25): opening Chrome by itself

Seen on a real PC: with Chrome closed, a mail task gave up with "extension not connected" while the screen said the
mail service was connected. Another time Chrome was running but stuck on its profile picker, so the extension never
loaded, and Dool2 could only say "not connected".

**Decision.** When a call that needs the browser (a browser tool, a service tool, or a connect the person or the AI
started) finds the extension not connected, the daemon fixes it once before failing:

- **Chrome closed**: start the user's own Chrome into the profile that has the Dool2 extension. The profile is read
  from Chrome's own files: the profile folder whose `Extensions` folder (or `Secure Preferences`, for a folder-loaded
  extension) has the Dool2 id, preferring the last used one; else the last used profile in `Local State`. macOS:
  `open -g -a "Google Chrome" --args --profile-directory=<dir>` (behind the current window). Windows: the found
  `chrome.exe` with `--profile-directory`, minimized. Then wait up to 20 s for the extension and run the call.
- **Chrome running without the extension** (profile picker, no window of that profile): wait 3 s, then hand
  `--profile-directory=<dir>` to the running Chrome once, which opens that profile's window, and wait again.
- **Still nothing**: the call fails with one plain reason about Chrome or the extension and what the person does
  ("open Chrome's '<profile>' profile and turn on the Dool2 extension"), always saying the service connection itself
  is fine. Service tools pass it on as is instead of "the tool got stuck", and it never counts against the tool's
  health.
- At most one attempt per 2 minutes after one that failed. Background work (thumbnails, keeping connections) never
  opens Chrome; only calls inside a browser, service or connect scope do. Task sessions own the browser (ADR 0038),
  so the conversation's fenced calls never get here.
- The setting **"Open Chrome automatically"** (`chromeAutoOpen`, Settings > AI · Browser) is on by default. Off: Chrome
  is never started and no window is opened; the answer says Chrome is closed.
- Each attempt writes a `chrome-launch` journal line (reason, start or window, ok, ms, whether the profile had the
  extension). Profile names are not logged.

Only plain Chrome flags are used (`--profile-directory`, with the folder name checked against a strict pattern), never
remote debugging or a separate data folder, so nothing about the extension's trust boundary changes. Only the PC app
where the native host is registered with the user's Chrome turns this on; check mode and tests use stand-ins.
