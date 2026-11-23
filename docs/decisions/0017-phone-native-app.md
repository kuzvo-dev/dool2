# 0017. The phone app ships only as a store app: retire the web app (PWA)

- Status: Accepted (changes the "phone app is a PWA" part of ADR 0012)
- Date: 2026-11-16

## Context

ADR 0012 decided that the phone app is a PWA and that the relay serves it at `/app/`. Messages are end-to-end encrypted, so the relay cannot read them.

But a web app **downloads its code from the server again every time it is opened.** Whoever controls the server (the Dool2 team, the hosting company, someone who breaks into the server, a law-enforcement request) could serve modified code to one particular user, pull decrypted conversations out of the phone, or make the user sign an approval for something different from what the screen shows. Making the keys non-extractable does not stop that code from **using** the keys. The promise "even the Dool2 team cannot see it" does not hold with a web app.

## Decision

- The phone app ships **only as a store app (Android and iPhone).** The screen code stays the current web code, wrapped with Capacitor, so **the code is bundled inside the app** and everyone gets the same build.
- The official relay (`relay.dool2.com`) does not serve the phone app. It only forwards messages.
- A pairing invite (QR) always carries the relay address (`r`). The app connects to the relay named in the invite, and to the official relay if none is given.
- Pairing: **[Scan QR]** inside the app (Google code scanner, no separate camera permission prompt) or a `dool2://pair#p=...` link.
- The app does not get the security headers the server used to add, so the same CSP is put in `index.html`.
- We build and test Android first. iPhone follows with the same code once Xcode and an Apple Developer account are ready.

## Why

- The web code is reused as is, so the screens do not need to be rebuilt.
- With a store app, the server cannot serve different code to different people, and the build can be checked against the public source.
- Alternatives: "keep the PWA but state its limits" was dropped because it weakens the core promise. Pinning the code with a service worker does not help either, because the browser can force an update.

## Consequences

- The screens inside the app are drawn in the phone's WebView. Encryption (X25519) and signing (Ed25519) work on **WebView 137 or newer**, so an older WebView shows an "Update in Play Store" screen.
- Next steps
  - Move the approval key into the phone's security chip (Android Keystore, Secure Enclave). Both support **P-256**, so approval signatures must accept P-256 (Ed25519 stays as a browser key, as now).
  - Notifications while the app is closed: FCM and APNs instead of web push. The sending keys cannot be put in the open-source desktop app, so the relay sends content-free notifications (or ones that are decrypted on the device).
  - Remove the leftover web app code (service worker, web push, "add to home screen" prompt) and the relay's `/app/`. The test build currently running on the Mac uses the web app, so we delete it after testing with the app is done.
