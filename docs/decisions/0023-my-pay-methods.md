# 0023. My payment methods: remember only what to pay with, never card numbers or payment passwords

- Status: Accepted
- Date: 2026-11-19

## Context

For tasks that need payment (such as Yanolja tickets), the approval card shows the payment methods on the checkout screen as chips. But Dool2 did not know what the user usually pays with, so the default was only the first slot on the screen (NOL money) or whatever was chosen last time on this site. The user's opinion:

> Let me register Naver Pay as my main payment method, let me choose while actually looking at Naver Pay, let me register Kakao Pay and cards too, and when payment is needed, let me pick what to pay with from among what that site accepts.

What has to be decided is (1) what to store, (2) where to store it, and (3) how to use it at payment. We must keep the principle that Dool2 does not handle values directly tied to money ([ADR 0011](0011-login-vault.md): payment passwords and card numbers do not go in the vault).

## Decision

**Store only the preference "what to pay with". Values (card number, expiry, CVC, payment password) are neither stored nor accepted.**

1. **What is stored**: an ordered list. The top item is the main payment method.
   - Easy-pay services: the kind (Naver Pay, Kakao Pay, Toss Pay, PAYCO, Samsung Pay, Apple Pay, Smile Pay, SSG Pay, L.PAY) plus one line for what is used inside it (for example `신한카드(1234)` (Shinhan Card (1234)), `네이버페이 머니` (Naver Pay money)). What is used inside is the display text the user chose while looking at that easy-pay screen (masked number as shown)
   - Cards: card company + nickname (optional) + last 4 digits (optional). Only up to 4 digits are accepted; anything longer is rejected, not stored
2. **Where it is stored**: the PC daemon's settings (same place as conversations and memory). It is not a secret, so it does not go in the vault. The phone asks the PC and shows it, and phone and PC exchange it over the existing encryption ([ADR 0012](0012-phone-link.md))
3. **At payment**: from the payment methods the site accepts on the checkout screen (the approval card chips), match my payment methods in order and pre-select the first one that matches. The chip gets a "My payment method" mark. If nothing matches, behave as now (what was chosen last time on this site, then what is selected on screen). **The one who chooses is still the user**, who can change it on the approval card
   - If a card was chosen and the checkout screen has a card company list, the registered card company is pre-selected
   - For what is used inside an easy-pay service (for example the Shinhan card inside Naver Pay), Dool2 (the AI) is told to choose it in the payment window. The payment password and identity check are handed to the person, as now
4. **Choosing while looking at the easy-pay service**: Dool2 opens that easy-pay service's payment method screen in the user's Chrome (if logged in), reads the registered card and account rows, shows them as chips, and the phone can watch that screen together. What is read is only the masked display shown on screen

## Why

- What the user wanted is "decide in advance what to pay with", and that judgment does not need a card number. Storing the number only adds leak risk, and the password and identity check in the payment window are done by a person anyway
- Each site accepts different methods (Yanolja: NOL money, Kakao Pay, Toss Pay...; Coupang: Coupay, cards), so it has to be an **ordered list** rather than one fixed choice, to pick "the earliest one among what the site accepts"
- Other options: (1) remember only the last choice per site (now): useless on a site visited for the first time. (2) store card numbers in the vault and have Dool2 type them: violates the principle and is out of scope

## Consequences

- Threat model T22
- Registration is in Settings > My info and payment > Payment methods (phone first, desktop app later)
- Reading easy-pay screens differs per service, so if it cannot be read the user can type that line in directly
- What was chosen last time on this site (payChoices) is kept as is, but when my payment method matches what the site accepts, it comes first
