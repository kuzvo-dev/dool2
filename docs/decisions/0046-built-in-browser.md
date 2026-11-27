# 0046. Dool2's own browser: a downloaded Chromium, hidden, no extension

- Status: Accepted
- Date: 2026-11-27
- Supersedes: [0006 the user's Chrome plus the Dool2 extension](0006-user-chrome-extension.md)
- Related: [0045 broad hands](0045-tools-are-shortcuts.md), architecture 5.1, threat model T2, T3, T15, T20, T31, T33

## Context

Dool2 works in the user's own Chrome through the Dool2 extension (ADR 0006). On the test PC (11-27) this hurt:

- **The person's Chrome flickers.** Dool2 brings its tab to the front to capture it, stretches the viewport to reach
  keypads and switches to a phone layout for the remote screen. The person sees all of it, and their own tabs are in
  the way.
- **Dool2 and the person fight over one browser.** A print window, a dialog or a tab the person touched stops Dool2,
  and Dool2's tabs land in the person's window.
- **Every new capability waits for a store review.** Printing to PDF, side-effect-free reading and self-update each
  needed an extension release and days in review (0.3.3 to 0.3.7 on one day).
- **Install has a step people trip on:** adding the extension and keeping it on.

The maintainer decided Dool2 gets its own browser, with no extension.

## Measurements (test Mac, 11-27; full report in the benchmark notes)

| | Desktop app's own engine (Electron 45, Chromium 156) | Downloaded Chromium 158 (official test build) | Reference automation browser (Chromium 158) |
|---|---|---|---|
| Coupang search, fresh profile | blocked 4 of 4 ("Access Denied"), also with a "Google Chrome" brand | blocked on the first hit, open from the second (the site's own check sets a cookie) | open 3 of 3 |
| Naver, Gov24, NHIS, Gmarket | open | open | open |
| Bot check page | 1 item failed (iframe chrome object) | passed | passed |
| Click a link → read the new page | 606 ms | not measured yet | 571 ms |
| Memory, 3 pages | ~1.3 GB (app included) | not measured yet | ~1.0 GB |
| Size | already in the app | 378 MB unpacked, ~180 MB download | n/a |

The desktop app's engine is recognized as an embedded browser by at least one large shop, whatever it calls
itself. A full Chromium is not.

## Decision

1. **Dool2 runs its own Chromium.** The desktop app downloads an open-source Chromium build on first use (like it
   downloads the AI runners), verifies its checksum, and keeps it updated. It runs with Dool2's own profile in the
   Dool2 data folder. The user's Chrome is never touched, and Chrome need not be installed.
2. **Hidden by default.** Its window is never shown to the person in normal work. Dool2 drives it over the DevTools
   protocol through a pipe (no open debugging port). Everything that would surface a window is handled inside:
   - `window.print()` and print buttons: intercepted and printed with `Page.printToPDF` (no print window, no helper
     clicking Chrome's dialog; T33 becomes simpler).
   - `alert`, `confirm`, `prompt`, `beforeunload`: answered through `Page.handleJavaScriptDialog` and reported in the
     action's result, as the extension does today.
   - Downloads: `Browser.setDownloadBehavior` into Dool2's folder.
   - Permission prompts (location, notifications, camera): denied by default; a request that needs one asks the
     person on the phone.
   - The OS keychain is not used for the profile's cookie key (it prompted for the login password on the test Mac);
     Dool2 keeps that key itself (follow-up below).
3. **The person sees it only when needed:** CAPTCHAs, identity checks and logins the vault cannot fill go to the
   phone remote screen, which already exists. On the PC, a "show Dool2's browser" button can bring the window up.
4. **Same commands as the extension.** The daemon's `BrowserCaller` gets a second implementation speaking the same
   command set (open, snapshot, click, type, screenshot, pdf, eval, cdp, input, …), so `browser-tools.ts`, the
   approval gate and every tool stay as they are. The extension stays in the repo until the built-in browser passes the
   test PC scenarios, then leaves the default install.
5. **Ideas taken from the benchmark:** each action reports the popups and dialogs it caused; snapshots of the visible
   part with stable refs; wait for the page's text, not the `load` event (Coupang, NHIS and Gmarket took ~30 s to
   `load`); errors say what happened and what is possible next (ADR 0045).
6. **Sites check new browsers.** Dool2 opens a shop's home page before deep links on a fresh profile, at human speed
   (architecture 5.1.1). It never fakes being another browser and never works around CAPTCHAs or identity checks;
   those still go to the person.

## Why

- The flicker and the fight over the person's Chrome go away only when Dool2 has a browser of its own.
- A full Chromium passes where the embedded engine is recognized and blocked, without pretending to be anything.
- No extension means no store review between a fix and the user, and one less install step.
- Options considered:
  - **The desktop app's own engine (Electron).** No download, fastest capture (5-17 ms), but blocked by Coupang 4 of 4.
    Kept as a fallback for pages that only need reading if the download is not done yet.
  - **The user's installed Chrome with a separate profile.** Real Chrome, but needs Chrome installed, and its window
    and updates are not Dool2's to manage.
  - **Embedding a third-party automation browser.** Closed source and another company's product: not an option.

## Consequences

- Logins live in Dool2's profile: each site needs one login (vault fill, phone cards). Logins in the person's Chrome
  are not used.
- A first-use download of ~180 MB, and Dool2 now owns updating a browser (security fixes). Builds are pinned and
  updated by Dool2 releases.
- Memory: a hidden Chromium costs a few hundred MB while it runs; it closes when idle.
- Security: the profile holds the person's site sessions. It sits in the Dool2 data folder with owner-only access;
  the cookie key is kept by Dool2 (follow-up). The threat model's browser entries (T2, T3, T15, T20, T31, T33) are
  revisited in the implementation PRs.
- Revisit if a large share of the sites people use block the built-in browser, or if download size becomes a problem.

## Rollout (small PRs)

1. This ADR.
2. Chromium download and launch (pipe, own profile, hidden, idle close) in the desktop app.
3. `BrowserCaller` over CDP: open, snapshot, click, type, screenshot, tabs; the daemon picks it when it is ready.
4. Dialogs, downloads, print to PDF, permission prompts handled inside.
5. Phone remote screen on the built-in browser; PC "show Dool2's browser".
6. Test PC scenarios before and after (certificates, health checkup, shopping), then the extension leaves the default
   install; setup and docs updated.
7. Cookie key held by Dool2; threat model update.
