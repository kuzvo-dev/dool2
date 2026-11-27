# 0042. Store app notifications: FCM through the official relay, content encrypted with the phone's own key

- Status: Accepted
- Date: 2026-11-26
- Related: [0012 phone link](0012-phone-link.md), [0017 phone native app](0017-phone-native-app.md), [0019 proactive watch](0019-proactive-watch.md)

## Context

The phone is a store app only (0017): the screens run in the app's WebView. Notifications so far were web push
(`apps/daemon/src/webpush.ts`): the PC encrypted them for the phone browser's push subscription and sent them straight
to the browser's push service. An Android WebView has no `PushManager`, so the store app never got a single
notification. Approval requests, "please do this yourself" and finished tasks reached the phone only while the app was
open, which defeats an app whose main job is to be asked.

A native app gets pushes from FCM (Android) or APNs (iOS). Sending through FCM needs the store app's Firebase service
account key. Dool2's PC app is open source and runs on the user's PC, so that key cannot be in it: anyone could take it
and send to every Dool2 phone.

## Decision

- **The phone makes its own notification key.** `PushKeys.java`: 32 random bytes, kept wrapped by an Android Keystore
  key (not in backups). The app sends the FCM token and this key to the PC over the encrypted link
  (`{kind:'app-push', reg:{token,key}}`, `null` when turned off).
- **The PC encrypts every notification with it** (`apps/daemon/src/apppush.ts`, AES-256-GCM: title, body, tag, where
  to open) and posts only `{token, data}` to `https://relay.dool2.com/push`.
- **The official relay hands it to FCM as a data message** (`apps/relay/src/push.ts`). No notification part, so FCM
  shows nothing by itself; the service account key is a Cloudflare secret (`FCM_SERVICE_ACCOUNT`). A token FCM no
  longer knows answers 410 and the PC forgets it.
- **The app opens it and shows it** (`PushService.java`). Anything that does not open with its key is dropped. Nothing
  is shown while the app is on screen.
- Notifications always go through the official relay, also for a self-hosted relay: the FCM key belongs to the store
  app, not to a relay.
- The permission (Android 13+) is asked only when the person presses [Turn on] in Settings.
- A build without `google-services.json` still builds; Settings then says notifications are not available.

## Options considered

- **Firebase key in the PC app.** Rejected: open source, so the key is public.
- **Notification part sent in plain text through FCM** (`@capacitor/push-notifications` default). Rejected: Google and
  the relay would read "Approval waiting: apple payment · 9,900 won". Web push never showed them that.
- **Fixed texts per kind** ("Approval waiting") without content. Simpler, but the person cannot tell what to approve
  from the lock screen; encrypting the real text costs about 100 lines on each side.
- **UnifiedPush / a self-run push server.** Needs another app on the phone; not something most people will install.

## Consequences

- The relay learns that a token got a notification at a given time and its size, nothing else. Same as with web push.
- Someone who learns a token can make the relay call FCM for it (rate limited to 30 per minute per token), but the
  app shows nothing it cannot open.
- Needs one human setup: a Firebase project with the app `com.dool2.app`, its `google-services.json` in the Android
  build, and the service account secret on the relay.
- iOS (APNs) will follow the same shape: FCM can deliver to iOS too, with the key in the iOS Keychain.
