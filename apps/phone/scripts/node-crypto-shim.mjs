// Browser stand-in for `node:crypto` in the renderer bundle. @dool2/phone and @dool2/approvals are Node packages: their
// barrels pull in a handful of node:crypto names (Ed25519 sign/verify, sha256, key parsing). The phone app bundles
// those barrels for the classes it actually uses (DaemonHttpClient, buildCard, pairDevice) — but in the browser it only
// ever CALLS `randomUUID` (a device id), which exists on globalThis.crypto. The phone hashes and signs with WebCrypto
// (lib/webcrypto.ts), so every other name is a fail-loud stub: it is bundled but never reached, and would throw if it
// somehow were. esbuild aliases `node:crypto` to this file for the renderer bundle only; the Node tests use the real
// module.

export function randomUUID() {
  return globalThis.crypto.randomUUID()
}

const unavailable =
  (name) =>
  (...args) => {
    void args
    throw new Error(
      `node:crypto.${name} is not available in the phone WebView; use WebCrypto (lib/webcrypto.ts)`,
    )
  }

export const createHash = unavailable('createHash')
export const createPrivateKey = unavailable('createPrivateKey')
export const createPublicKey = unavailable('createPublicKey')
export const generateKeyPairSync = unavailable('generateKeyPairSync')
export const randomBytes = unavailable('randomBytes')
export const sign = unavailable('sign')
export const verify = unavailable('verify')
