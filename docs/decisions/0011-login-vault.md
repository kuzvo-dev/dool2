# 0011. Keep login details in the Dool2 vault, and have Dool2, not the AI, fill them in

- Status: Accepted (implemented in M2; per-site "ask, then fill" is M3)
- Date: 2026-11-14

## Context

In browser work, Dool2 runs into sites where the login has expired. The current principle is "never ask for or type a password, hand it off to the person". That is safe, but repeated tasks such as a morning briefing every day stop at one login.

The AI must not see or type passwords itself. They could end up in conversation logs or on the AI company's servers, and prompt injection could make it type them into the wrong site.

## Decision

We build the **Dool2 vault**.

- Only the IDs and passwords of sites the user has allowed are stored in the PC's OS keychain (Keychain on Mac, Credential Manager / `safeStorage` on Windows)
- The only thing the AI can use is a single `fill login (site)` tool. **The AI never receives the values.** The Dool2 daemon checks that the current page address matches the stored site, then types directly into the browser
- If the address differs (phishing, redirect), nothing is filled. Nothing is filled outside a password field either
- Per site, the user can choose "always / ask first / never use", and a record is kept of when and where things were filled
- One-time codes, identity verification and CAPTCHAs are handed off to the person as they are now

### Login card in the chat (added 2026-11-15)

When a site that is not in the vault needs a login, instead of handing off to the person, Dool2 shows a **login card in the chat** (`browser_request_login`).

- The card appears in both the desktop app and the phone chat. The ID and password the user enters go **straight to the daemon's vault without passing through the AI**. When entered on the phone, they travel to the PC over the phone ↔ PC encryption (ADR 0012)
- The site is fixed by the address (origin, https) that the Dool2 tab currently has open. The AI cannot choose the address
- The AI only hears "saved", and after that, as now, the daemon fills the fields with `browser_login`
- A login request expires after 30 minutes and can be used only once. Only the site name stays in the conversation history
- Robot checks, identity verification and text-message verification are still handed off to the person (`browser_handoff`, remote screen on the phone)

## Why

- Repeated tasks no longer stop at a login, and passwords are never exposed to the AI
- Code does the checking and typing, which makes it resistant to prompt injection

## Consequences

- The browser extension (M2) needs an action that puts "the value the Dool2 daemon gave it into the specified field". The value travels only between the extension and the daemon, and must not remain in logs or screen captures
- Payment passwords, card numbers and joint certificate passwords do not go into the vault. Values tied directly to money are entered by the person themselves
- Add a "vault misuse" item to the threat model
