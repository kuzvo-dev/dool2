# Google Play and App Store: the phone app

How to submit the Dool2 phone app (`apps/phone`, `com.dool2.app`) and what the review needs. Builds: see
[apps/phone/README.md](../../apps/phone/README.md#android-builds). Store accounts: a sole proprietor; Google as an
organization (D-U-N-S, no 14-day closed test), Apple as an individual (the seller name shows the real name).

## What the app needs from review, and where it is

| Review asks | In the app |
|---|---|
| Use it without the developer's hardware | Intro → **PC 없이 둘러보기 (Look around without a PC)**: the real screens with a pretend PC (`src/app/review.ts`). Try "택배 어디쯤 왔어?" or "사과 한 박스 주문해 줘" for a payment approval |
| Say what goes to a third-party AI (Apple 5.1.2(i), Google user data) | A consent screen once before the first use (`consentView`): messages go to the person's own PC, encrypted; the PC sends them to the AI the person connected there |
| Report offensive AI output (Google AI-generated content) | Long press an answer → **이 답 신고하기 (Report this answer)** → reason; the PC sends the answer and the reason to `dool2.com/api/report` (`report-answer`, #598) |
| Ask permissions in context | Notifications: only on [Turn on] in Settings. SMS and contacts: only on a text approval card. Camera: none (Google's code scanner) |
| Account deletion | No account. Settings → "다른 PC와 다시 연결" forgets the pairing; uninstalling removes everything on the phone |

**Review notes to paste:** "Dool2 is the phone remote for the Dool2 desktop app, which runs on the user's own
computer. Reviewers can use every screen without a computer: on the first screen tap 'PC 없이 둘러보기' (Look around
without a PC). A pretend PC answers; try asking for a parcel or an apple order to see the payment approval."

## Data safety form (Google) — draft answers

- **Data shared with or collected by the developer:** only what the person sends on purpose:
  - an AI answer they report (App activity → Other user-generated content; optional, user-initiated);
  - the FCM registration token goes through the Dool2 relay to Google to deliver notifications (Device or other IDs;
    the notification content is encrypted with a key only the phone has, ADR 0042).
- **Conversations, approvals, screens:** end-to-end encrypted between the phone and the person's own PC
  (ADR 0012). The relay only passes ciphertext. To check before submitting: whether Play counts end-to-end encrypted
  relay traffic as "collected"; if so, declare it as collected, encrypted in transit, not shared.
- **Encrypted in transit:** yes. **Deletion request:** not applicable (no account); say how to forget the pairing.

## Permissions — risks to settle before the first upload

- **`SEND_SMS` is a restricted permission on Google Play.** Only default SMS apps and a short list of exceptions may
  use it, with a Permissions Declaration Form. "An assistant that sends a text the user approved" is not on that list,
  so expect a rejection. Options: (a) a Play build without `SEND_SMS` that hands the approved text to the phone's
  messages app with the recipient and text filled in (one tap to send); (b) keep direct sending only in the APK from
  dool2.com. **Decision needed.**
- `READ_CONTACTS`: allowed; the prominent disclosure is the text approval card (numbers never leave the phone).
- `POST_NOTIFICATIONS`: asked on [Turn on] only.

## App Store (iOS) — what is missing

Nothing for iOS exists yet (no Xcode on the build Mac). In order:

1. Xcode, `npx cap add ios`, bundle id `com.dool2.app`, the same screens (all of `src/` is shared).
2. Native parts, same shape as Android:
   - Push (ADR 0042): an APNs key from the Apple developer account uploaded to the Firebase project `dool2-app`;
     a Notification Service Extension that opens the encrypted payload with the key in the Keychain; the relay sends
     `apns` with `mutable-content: 1` and a placeholder alert, because iOS does not wake an app for a data-only push.
   - Approval keys (ADR 0043): two P-256 keys in the Secure Enclave; `pay` with
     `.biometryAny | .devicePasscode` access control.
   - Haptics (`UIImpactFeedbackGenerator`), phone lock check (`LAContext`), file save (share sheet), QR scan.
   - Texts: iOS cannot send an SMS silently; `MFMessageComposeViewController` with the approved text.
3. Apple 5.1.2(i): the consent screen above. Apple 4.2 (minimum functionality): the demo mode shows what the app does.
4. Sign in with Apple is not needed (no account).
