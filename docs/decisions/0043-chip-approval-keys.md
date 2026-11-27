# 0043. Approvals are signed by keys in the phone's security chip; payments only after the phone lock

- Status: Accepted
- Date: 2026-11-26
- Related: [0012 phone link](0012-phone-link.md), [0017 phone native app](0017-phone-native-app.md), [0030 auto-approve](0030-auto-approve.md), [0042 store app push](0042-store-app-push.md)

## Context

The phone approves risky steps (payments, sending, deleting) by signing the approval text. The signing key was the
pairing key: an Ed25519 key made by WebCrypto, non-extractable, kept in the WebView's IndexedDB. It cannot be copied
out, but anything that runs in the app, or anyone holding the unlocked phone with the app open, could sign a payment
with a long press.

The store app can use the Android Keystore: keys made inside the TEE or a StrongBox chip, which never leave it, and
which can be made to sign only after the phone lock was checked. Keystore keys are P-256 (no Ed25519), as are iPhone
Secure Enclave keys.

## Decision

- **Two chip keys per phone** (`ApproveKeyPlugin.java`, P-256, StrongBox when present):
  - `plain` signs right away: approvals other than payments, and every rejection.
  - `pay` signs only for 5 seconds after a strong biometric or the PIN (`setUserAuthenticationParameters`). New
    fingerprints do not invalidate it. Not made on a phone with no screen lock.
- **Registration**: the app sends both public keys (SPKI) signed with the pairing key (`approveKeysSignText`). The PC
  keeps them for good; a later request cannot replace them. A missing pay key can be added later with the same plain
  key (the phone got a screen lock). A phone that lost its chip keys pairs again.
- **Once registered, the pairing key no longer signs approvals for that phone.** `decide` carries `key: 'pay'|'plain'`
  and the PC checks it with `verifyP256` (DER signature converted to r||s for WebCrypto).
- **Payments** (`kind: 'money'`, which covers transfers) need the pay key, unless the person turned the check off.
- **The setting** "Confirm it is you for payments" (on by default when a pay key exists): turning it off must be
  signed with the pay key, so it takes the phone lock too; turning it back on can be signed with either key.
- Browser pairings and older apps keep the pairing-key signature as before.

## Options considered

- **Move the pairing key itself into the chip.** The relay hello and every existing pairing use Ed25519; changing it
  means a relay protocol change and re-pairing everyone. The approval key is where the risk is.
- **One chip key that always needs the lock.** Safer, but every approval (sending a message, a hand-off) would ask for
  a fingerprint; people would turn auto-approve on to avoid it.
- **A biometric check in the screen code before signing** (the existing `DeviceAuth.confirm`). Code in the WebView could
  skip it; a key that only signs after the lock cannot be skipped.

## Consequences

- A stolen unlocked phone cannot approve a payment without the owner's finger, face or PIN.
- The PC trusts the chip keys only as much as the pairing key that registered them (no key attestation yet). Checking
  Android key attestation would prove the key is really in a chip; revisit when publishing to the store.
- iOS will make the same two keys in the Secure Enclave (`.biometryAny`/`.devicePasscode` for pay).
