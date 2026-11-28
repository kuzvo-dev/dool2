# @dool2/phone-app — the Dool2 phone app (v2)

A small web app (plain TypeScript + [`@dool2/ui`](../../packages/ui/README.md), no framework) that is the human end of the
approval loop (ADR 0043, 0047). It pairs with the PC over the daemon's local HTTP and signs payment/send approvals with
the phone's device key — visibly.

Screens (design source: [`docs/design/screens/src/MApprove.dc.html`](../../docs/design/screens/src/MApprove.dc.html),
`docs/design/screens/m-approve-light.png`):

- **Pair** (`?screen=pair`): enter the PC address + connect code, then `pairDevice` over `DaemonHttpClient` (`POST /pair`).
  Only the device **public** key goes on the wire; the private key never leaves the keystore.
- **Home**: the Dool2 character + a status line (a "waiting for approval" dot when a card is pending).
- **Approval sheet**: the pending card as a bottom sheet — the amount headline, the detail rows, a black Face-ID primary
  that **signs** the card's envelope hash with the device key and `POST /approve`s it, a decline that signs nothing, and a
  do-it-myself hand-off. Footer: "neither Dool2 nor we can see your card number".

## How signing works

The device key lives in a WebCrypto Ed25519 keypair ([`lib/webcrypto.ts`](src/lib/webcrypto.ts)), created
non-extractable — the browser can sign with it but this app can never read the private bytes (the native iOS/Android
shell will later back the same `KeyStore` seam with the Secure Enclave / StrongBox). The phone signs the **envelope hash**
(sha256 of the canonical envelope, computed with WebCrypto so the phone and daemon agree on the bytes), so a signature is
bound to that exact action. Only the signature + the public key ever cross the wire; no secret (card number, password) is
ever in the card — it carries masked display text only.

## Offline / demo mode

With no stored connection the app runs offline with a seeded, **generic** pending card (a train booking, no brand names),
so the whole approval screen renders with no live daemon. This is also what the smoke screenshot captures.

## Build, test, smoke

```bash
pnpm --filter @dool2/phone-app build       # esbuild bundle + @dool2/ui assets -> dist/renderer
pnpm --filter @dool2/phone-app typecheck
pnpm --filter @dool2/phone-app test        # vitest: pairing/sign/reject wire contract + WebCrypto signatures
pnpm --filter @dool2/phone-app smoke        # -> out/smoke.png (approval sheet); DOOL2_SMOKE_SCREEN=pair -> out/smoke-pair.png
```

The app's own `style.css` holds only the phone layout; every colour, corner and shadow is a `@dool2/ui` token, so the
phone reads as the same product as the desktop app.
