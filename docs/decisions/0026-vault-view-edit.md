# 0026. The user views and edits vault passwords on the phone and PC

- Status: Accepted (amends ADR 0011)
- Date: 2026-11-20

## Context

ADR 0011 designed the vault as "put in only, cannot be taken out". But a problem came up in the joint test (benefits and refunds).

- When Dool2 made up a new password and changed it, the user was lost without knowing the new password.
- There was no way to fix a value entered wrongly.

User decision (11-20): "Let's add viewing vault passwords too, and editing. And make them visible on the phone as well."

## Decision

1. **They are taken out only on the user's screens.** They can be seen only in the phone's Settings > Vault and on the PC screen (screen token). Passwords still do not leave through Dool2 (AI) tools, conversation history or the activity log.
2. **The phone checks the phone lock every time it shows one.** It uses Android BiometricPrompt to confirm one of fingerprint, face, PIN or pattern.
   - It does not show them on a phone with no screen lock, or in a browser instead of the app.
   - The shown value is erased after 30 seconds or when the sheet is closed.
3. **The way they travel stays as it is now.** They go over the end-to-end encryption between the paired phone and PC, and the relay cannot see the content.
4. **Editing.** Change the ID and password, and leave blank fields as they are. The edited entry becomes that site's login value.
5. **Records.** The activity log records only which site was viewed or edited, never the values.

## Consequences

- Even if a paired phone is lost, the vault passwords cannot be seen without knowing the lock.
- To add the phone lock check we added androidx.biometric. Older apps (b37 and below) do not have it and show "Can only be viewed in the Dool2 app".
