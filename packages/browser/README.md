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
