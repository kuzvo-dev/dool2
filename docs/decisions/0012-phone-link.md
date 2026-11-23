# 0012. Phone ↔ PC link: browser-native encryption, signed devices only, the relay sees only ciphertext

- Status: Accepted
- Date: 2026-11-14

## Context

Dool2's promise is "ask from the phone, and my PC does the work". The phone and the PC are on different networks, so a relay is needed. We do not trust the relay (it must not be able to see the content), and yet the phone app has to be usable immediately without installation (PWA).

The draft design ([architecture.md, chapter 6](../architecture.md)) specified libsodium (XChaCha20) and a Noise handshake. But both require loading extra libraries into the phone browser, and a hand-written handshake has many places for mistakes.

## Decision

**We use only the standard cryptography built into browsers and Node (WebCrypto).** We add no external crypto libraries.

- Keys
  - PC: X25519 (encryption) + Ed25519 (proves to the relay "I am this PC")
  - Phone: X25519 (encryption) + Ed25519 (approval signatures). The keys are created **non-extractable** in the phone browser
- Encryption: X25519 shared secret → HKDF-SHA256 → **AES-256-GCM**. A fresh IV for every message, and the sender, receiver, kind and sequence number are bound as authenticated data (AAD)
- Replay protection: each sender's sequence number (seq) must keep increasing, and messages with the same or a smaller number are discarded
- **Pairing**
  1. A QR code on the PC screen: PC public key, PC id, a one-time secret (5 minutes), relay address
  2. The phone creates its keys and sends a pairing request containing the one-time secret, **encrypted with the PC public key**. The relay cannot read it
  3. The PC and phone each derive a **6-digit confirmation code** from the same shared secret and show it on their screens. The user checks that they match and presses [Connect] **on the PC** to finish
  4. There is no other way to attach a new phone
- **Approvals by phone signature**: the phone signs the content of an approval request (the button to press, the address, what and how much, expiry time, nonce) with Ed25519, and **the PC verifies it directly with the public key it received at pairing**. The relay takes no part in this
- **Relay** (`apps/relay`): connects each PC room (id), and holds ciphertext addressed to a PC that is off only briefly (7 days). The PC proves it owns its room with an Ed25519 signature. We build the Node version first (for self-hosting and development), and attach the Cloudflare Durable Objects version using the same protocol when we deploy (M5)
- The phone app (`apps/phone`) is a PWA, served by the relay
- **Notifications while the app is closed = Web Push** (RFC 8030, 8291, 8292). **The PC sends directly to the phone's push service (Apple, Google)**, not through the relay
  - The PC creates a VAPID key (P-256) and tells the phone the public key. After the user presses [Turn on notifications], the phone subscribes with that key and sends the subscription info to the PC in an encrypted message
  - The notification content (approval request, please do it yourself, a task requested from the phone has finished) is **encrypted so that only the phone browser can decrypt it** (aes128gcm), so even the push service cannot read it. We do the encryption ourselves with `node:crypto`, and test that it matches the example in RFC 8291 Appendix A byte for byte
  - The PC sends only to known push service addresses (https; fcm.googleapis.com, push.apple.com, mozilla, windows). This is so that even if the phone gives a bogus address, the PC does not send requests to places like an internal network
  - iPhone can receive notifications only from an app added to the home screen (iOS 16.4 or later, https required). So checking on a real phone happens after the official relay is up over https (M5)
- **Remote screen**: the phone can see and tap a tab that Dool2 handed off to a person (login, robot check and so on)
  - When the phone asks for the screen, the PC captures that tab small (860 px wide, JPEG), encrypts it and sends it, and while the phone is watching it asks again about once a second (one still at a time, not a screen-sharing stream)
  - Only the tapped position (as a fraction of the image), typed characters and a few keys (delete, enter, next field, scroll) are passed to that tab
  - It works **only for the tab Dool2 handed off, and only for 30 minutes after the hand-off**. Other tabs and the user's own tabs can be neither seen nor tapped
  - Characters typed here (such as passwords) do not remain in the conversation history or reach the AI. The relay does not store remote screen messages

## Why

- WebCrypto's X25519, Ed25519 and AES-GCM ship in current Chrome, Safari and Node. This reduces library supply-chain risk and the size of the phone app.
- Instead of writing a new handshake, we start from both sides already knowing each other's public keys (QR + a code the person confirmed) and use only static key agreement. It is simple and easy to review.

## Consequences

- **A cost we accept: there is no forward secrecy.** If a phone or PC key is stolen, past messages encrypted with that key could also be decrypted. We limit the range by not leaving past messages on the relay for more than 7 days. We will revisit adding ephemeral keys per connection (such as a double ratchet) as the user count grows.
- The phone signing key is not tied to biometrics (it is a browser key). Strengthening pay approvals with passkeys (WebAuthn) or native secure-chip keys happens after the official domain is settled (M5), in the native app. We write this down in the threat model as it is.
- Old phone browsers (without X25519 support) cannot be used. We provide a notice screen.
