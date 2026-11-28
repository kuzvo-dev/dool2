// Sign an approval card in the browser: hash the exact envelope with WebCrypto (hashEnvelopeBytes) and ask the device
// keystore to sign those bytes. This is the browser twin of @dool2/phone's signCard — same bytes, same base64 Ed25519
// output — kept here so the phone app and its tests share one path. The private key never leaves the keystore; this
// returns only the signature, which (with the public key the daemon stored at pairing) is all the wire ever carries.

import type { ApprovalNeeded, KeyStore } from '@dool2/phone'
import { hashEnvelopeBytes } from './webcrypto.js'

/** Base64 Ed25519 signature over the card's envelope hash. Verifies on the daemon via @dool2/approvals verifyApproval. */
export async function signCardWeb(card: ApprovalNeeded, keystore: KeyStore): Promise<string> {
  return keystore.sign(await hashEnvelopeBytes(card.envelope))
}
