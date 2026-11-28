// @dool2/phone — the phone-side signing client that closes the human-in-the-loop safety loop (ADR 0043, 0047).
//
// The daemon's autonomy gate (@dool2/core) decides a pay/contact/delete action needs a phone signature; @dool2/approvals
// turns that into a signable ActionEnvelope the daemon mints a card for. This package is the other end of that loop,
// the part that runs on the user's phone:
//
//   - KeyStore (keystore.ts):       the secure-chip seam. The device keypair lives in iOS Secure Enclave / Android
//                                   StrongBox (native shell, later); the private key never leaves it. InMemoryKeyStore
//                                   is the reference impl for tests and dev.
//   - pairDevice (pairing.ts):      register the device public key with the daemon so it can verify later signatures.
//   - buildCard (approval-card.ts): render the human card (what/where/how much) from an approvalNeeded payload. Korean-first.
//   - signCard / respond (sign.ts): sign the exact envelope hash with the device key and send it back to the daemon.
//   - PhoneSimulator (simulator.ts):a headless phone that auto-approves/denies by tier, to drive the loop in tests.
//
// Secrets never reach this package: it sees only the public facts in the envelope (tier, label, amount, merchant,
// recipient, site), never a password, card number or PIN. The private key never leaves the keystore seam.

export { type ApprovalNeeded, buildCard, type CardView } from './approval-card.js'
export {
  DaemonHttpClient,
  type DaemonHttpClientOptions,
  type SendOverHttp,
  type TurnGateDecision,
  type TurnSummary,
} from './http-client.js'
export { InMemoryKeyStore, type KeyStore } from './keystore.js'
export type { CardCopy, CardLang } from './locales/index.js'
export { DEFAULT_CARD_LANG, locales } from './locales/index.js'
export {
  type DeviceRegistrar,
  type PairOptions,
  type PairRequest,
  type PairResponse,
  type PairResult,
  pairDevice,
} from './pairing.js'
export { RelayPhoneClient, type RelayPhoneClientOptions } from './relay-client.js'
export {
  type ApprovalTransport,
  approveCard,
  type RespondResult,
  respond,
  signCard,
  signingBytes,
} from './sign.js'
export { PhoneSimulator, type SimDecision, type SimulatorPolicy } from './simulator.js'
