# 0028. The desktop app is downloaded from the web, and new versions are fetched by the app itself from a signed notice

- Status: Accepted
- Date: 2026-11-23

## Context

The desktop app (Mac and Windows) beta is distributed from the web, without an app store. We do not use an Apple developer certificate (with an individual registration, the real name shows in the signature) or a Windows code-signing certificate in this beta. Even so, the following must hold.

- The beta is fixed often: users must get new versions easily, and we must be able to block old versions
- Even if the place where the installer is hosted changes or the file is swapped, it must not get installed (the same reason we retired the phone PWA)
- Mac: after an update, the Accessibility and Screen Recording permissions and the password vault (Keychain) must carry over

## Decision

- **Distribution**: put the Mac dmg (first install) and zip (in-app update) and the Windows installer exe on GitHub Releases (public repository).
  Run `.github/workflows/release.yml` by hand (version, what changed, minimum version) to build Mac arm64 and x64 and Windows x64, and on each OS
  start the app and take a first-screen capture before uploading.
- **Version notice**: `version.json` = `{ payload: base64(Release JSON), signature }`. The Release has the version, minimum version, what changed, and per platform the file address, sha256 and size. It is signed with an
  **ed25519 private key** (release CI secret `DOOL2_UPDATE_KEY`), and the app holds only the public key (`apps/desktop/src/update.ts`). The notice address is `releases/latest/download/version.json`.
- **App**: it reads the notice 20 seconds after start and every 6 hours. If there is a new version, the upper-left banner shows [Update]; if the version is below the minimum version, the whole screen is blocked and only updating is allowed. When pressed, it downloads, checks sha256 and size, then installs.
  - Mac: unpack the zip next to the current app, verify the signature, swap in the app bundle and relaunch. A file the app downloads itself does not get the "downloaded from the internet" mark, so the "Open anyway" of the first install does not appear again.
  - Windows: run the downloaded installer silently with `/S --force-run` and quit the app (it starts again when the install finishes).
- **Mac signing**: sign the whole app with our **fixed self-made certificate** ("Dool2 Release", 10 years). The Mac remembers the app as "the app of this name signed with this certificate"
  (designated requirement = identifier + certificate root), so permissions and the Keychain carry over even when the build changes.
  An ad-hoc signature changes its fingerprint with every build, so permissions were reset on every update (measured on M4).

## Why

- A beta can ship right away without Apple or Windows certificates. What users go through is only once at the first install (Mac "Open anyway", Windows SmartScreen "More info, Run anyway"), and the download page explains it with pictures.
- With a signed notice plus checksums, we do not have to trust where it is hosted. Without the private key, nobody can make a fake update.
- electron-updater (Squirrel.Mac) needs an Apple developer signature to run on Mac. Swapping in the bundle ourselves is smaller and uses our own signing key.

## Consequences

- The private keys (update signing key, certificate) exist only in `~/.config/dool2-release/` on the maintainer's PC and in GitHub secrets. If lost, we cannot send updates to existing users (they would not match the app's public key), so back them up separately.
- On a Mac, a user who cannot write to /Applications (standard account) will fail the in-app update, so we point them to the download page.
- When Apple developer signing and notarization are added later, the first-install warning goes away. The certificate changes then, so permissions have to be granted once again.
- The Chrome extension is updated separately through the Web Store (store review). The extension version the app expects is `MIN_CONNECTOR_EXTENSION`.
