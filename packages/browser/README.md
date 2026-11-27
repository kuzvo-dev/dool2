# @dool2/browser

Dool2's browser hand. It handles **checking and installing Chrome**, and the **link between the Dool2 extension in the user's Chrome and the Dool2 daemon** ([ADR 0006](../../docs/decisions/0006-user-chrome-extension.md)).

- `detectChrome()`: tells you whether Chrome is installed, and its location and version.
  - macOS: `/Applications`, `~/Applications`
  - Windows: Program Files, the user folder (LOCALAPPDATA)
- `installChrome()`, `ChromeInstall`: downloads the installer from Google's official address. It installs **only after verifying Google's signature**.
  - macOS: official dmg → open read-only → `codesign --verify --deep` + team ID `EQHXZ8M8AV` + Gatekeeper notarization (`spctl`, "Notarized Developer ID, Google LLC") → copy to `/Applications` (to `~/Applications` if there is no permission) → clean up
  - Windows: official installer → check that the Authenticode signature is `Valid` and the signer is `O=Google LLC` → `/silent /install` (without admin rights, Google's installer installs into the user folder)

`codesign --strict` always fails on one helper file in Google's official dmg, so it is not used. Instead, a Gatekeeper notarization check was added.

## Connecting the Dool2 extension and the daemon (native messaging)

```
Dool2 extension (inside Chrome)
   │ chrome.runtime.connectNative('com.dool2.host')
   ▼
native messaging host (host.ts, started by Chrome)   ← only relays messages
   │ local socket (macOS/Linux: Unix socket 0600, Windows: named pipe) + token
   ▼
Dool2 daemon BrowserBridge (bridge.ts)                ← decisions and approval happen only here
```

- `BrowserBridge`: the daemon opens the socket and writes a new token to `browser-bridge.json` (0600) every time it starts. A connection that does not send that token as its first line is closed within 5 seconds. It gives the extension work like `call('open', { url })` and waits for the answer.
- `runHost()`: the Chrome side is [4-byte length + JSON]; the daemon side is line-delimited JSON. If the daemon is off, it waits 10 seconds, tells the extension `daemon-offline`, and exits.
- `registerNativeHost()`: creates the launch script (`dool2-host.sh` / `.bat`) and the registration file in `native-host/` of the data folder, and registers only in the user location (no admin rights).
  - macOS: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`
  - Windows: `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.dool2.host`
  - Chromium and Edge are registered too, only when installed.
- The distributed app registers every time it starts. During development, it registers in the user's Chrome only when `DOOL2_REGISTER_HOST=1`, and smoke mode does not register. To put it only in a test Chrome profile, use `DOOL2_HOST_DIRS=<profile>/NativeMessagingHosts`.

## Dool2's own browser (ADR 0046)

Dool2 is moving to a Chromium of its own, hidden, with no extension ([ADR 0046](../../docs/decisions/0046-built-in-browser.md)). This package has the first part; nothing uses it yet.

- `installChromium()`, `ChromiumInstall`: downloads the pinned open-source Chromium snapshot from `chromium-manifest.ts` into `<data>/chromium/<revision>` on first use. The zip must match the pinned size and SHA-256 before it is unpacked; network trouble is retried (3 tries), a wrong file is not. macOS: unpacked with `ditto`, and the quarantine attribute is cleared only on that folder. Progress uses the same `InstallStatus` as the AI runners.
- `launchChromium()`: starts it with its own profile `<data>/browser-profile` (0700), DevTools over a pipe (no port), no window at start, no automation flag, and on macOS a mock keychain, basic password store and no OS notification center (each of these popped something on the test Mac). Pages open in their own inactive window pushed to the screen corner behind other windows. The browser closes after 5 idle minutes.
- `CdpPipe`, `ChromiumPage`: a small DevTools client over the pipe (flat sessions): open a page, wait for its text, evaluate an expression.
- Real run: `DOOL2_CHROMIUM_IT=1 pnpm --filter @dool2/browser test` downloads (~180 MB) and opens example.com. `DOOL2_CHROMIUM_IT_DIR=<folder>` keeps the download between runs.
- Moving the build forward: pick a snapshot position that exists on every platform, download each zip once, and write its size and `shasum -a 256` in `chromium-manifest.ts`.
