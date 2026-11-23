// Phone <-> PC end-to-end encryption (ADR 0012). Uses only the WebCrypto built into browsers and Node.
// The relay server sees only the envelope header (who, to whom, kind, sequence number), never the content.
//
//   X25519 shared secret -> HKDF-SHA256 -> AES-256-GCM (new IV for every message, header bound as AAD)
//   Ed25519: the PC proves to the relay that the room is its own, the phone signs approvals

export const LINK_VERSION = 1

const enc = new TextEncoder()
const dec = new TextDecoder()

export function b64u(bytes: ArrayBuffer | Uint8Array): string {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let s = ''
  for (const b of u) s += String.fromCharCode(b)
  return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

export function fromB64u(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replaceAll('-', '+').replaceAll('_', '/'))
  const out = new Uint8Array(new ArrayBuffer(bin.length))
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** JSON with sorted keys, so signatures and AAD are the same bytes on both sides */
export function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  const o = v as Record<string, unknown>
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(',')}}`
}

export interface DeviceKeys {
  /** Device id: derived from the signing public key */
  id: string
  boxPub: string
  signPub: string
  boxPriv: CryptoKey
  signPriv: CryptoKey
}

const subtle = () => globalThis.crypto.subtle

export async function deviceId(signPub: string): Promise<string> {
  const h = await subtle().digest('SHA-256', fromB64u(signPub))
  return b64u(new Uint8Array(h).slice(0, 16))
}

/** Creates the device keys. The phone uses extractable=false (cannot be taken out of the browser); the PC uses true to keep them in the keychain */
export async function generateDevice(extractable: boolean): Promise<DeviceKeys> {
  const box = (await subtle().generateKey({ name: 'X25519' }, extractable, ['deriveBits'])) as CryptoKeyPair
  const sign = (await subtle().generateKey({ name: 'Ed25519' }, extractable, [
    'sign',
    'verify',
  ])) as CryptoKeyPair
  const boxPub = b64u(await subtle().exportKey('raw', box.publicKey))
  const signPub = b64u(await subtle().exportKey('raw', sign.publicKey))
  return { id: await deviceId(signPub), boxPub, signPub, boxPriv: box.privateKey, signPriv: sign.privateKey }
}

export interface StoredDevice {
  box: JsonWebKey
  sign: JsonWebKey
}

export async function exportDevice(k: DeviceKeys): Promise<StoredDevice> {
  return {
    box: await subtle().exportKey('jwk', k.boxPriv),
    sign: await subtle().exportKey('jwk', k.signPriv),
  }
}

export async function importDevice(s: StoredDevice, extractable = true): Promise<DeviceKeys> {
  const boxPriv = await subtle().importKey('jwk', s.box, { name: 'X25519' }, extractable, ['deriveBits'])
  const signPriv = await subtle().importKey('jwk', s.sign, { name: 'Ed25519' }, extractable, ['sign'])
  // The public key is the x value of the JWK
  const boxPub = s.box.x ?? ''
  const signPub = s.sign.x ?? ''
  return { id: await deviceId(signPub), boxPub, signPub, boxPriv, signPriv }
}

async function sharedBits(myBoxPriv: CryptoKey, theirBoxPub: string): Promise<ArrayBuffer> {
  const pub = await subtle().importKey('raw', fromB64u(theirBoxPub), { name: 'X25519' }, false, [])
  return subtle().deriveBits({ name: 'X25519', public: pub }, myBoxPriv, 256)
}

/** The encryption key between two devices. The two device ids are sorted before use, so both sides derive the same key */
export async function linkKey(
  myBoxPriv: CryptoKey,
  theirBoxPub: string,
  ids: [string, string],
): Promise<CryptoKey> {
  const ikm = await subtle().importKey('raw', await sharedBits(myBoxPriv, theirBoxPub), 'HKDF', false, [
    'deriveKey',
  ])
  return subtle().deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: enc.encode('dool2-link'),
      info: enc.encode(`dool2/v${LINK_VERSION}/${[...ids].sort().join('/')}`),
    },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

/** 6-digit pairing confirmation code. The PC and phone derive it from the same shared secret, and a person compares them by eye */
export async function pairCode(myBoxPriv: CryptoKey, theirBoxPub: string): Promise<string> {
  const ikm = await subtle().importKey('raw', await sharedBits(myBoxPriv, theirBoxPub), 'HKDF', false, [
    'deriveBits',
  ])
  const bits = await subtle().deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('dool2-link'), info: enc.encode('dool2/pair-code') },
    ikm,
    32,
  )
  const n = new DataView(bits).getUint32(0) % 1_000_000
  return String(n).padStart(6, '0')
}

/** The header the relay server can see. The content is ciphertext in ct */
export interface EnvelopeHeader {
  v: number
  from: string
  to: string
  kind: string
  /** A number that goes up by 1 for each message from the sender (stops replays) */
  seq: number
  /** Pairing request only: the sender's X25519 public key (so the receiver can derive the key) */
  pub?: string
}

export interface Envelope extends EnvelopeHeader {
  iv: string
  ct: string
}

export async function seal(key: CryptoKey, header: EnvelopeHeader, body: unknown): Promise<Envelope> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12))
  const ct = await subtle().encrypt(
    { name: 'AES-GCM', iv, additionalData: enc.encode(canonical(header)) },
    key,
    enc.encode(JSON.stringify(body)),
  )
  return { ...header, iv: b64u(iv), ct: b64u(ct) }
}

/** Throws if it cannot be opened (different key, or the header or content was changed) */
export async function open<T = unknown>(key: CryptoKey, env: Envelope): Promise<T> {
  const { iv, ct, ...header } = env
  const plain = await subtle().decrypt(
    { name: 'AES-GCM', iv: fromB64u(iv), additionalData: enc.encode(canonical(header)) },
    key,
    fromB64u(ct),
  )
  return JSON.parse(dec.decode(plain)) as T
}

export async function signText(signPriv: CryptoKey, text: string): Promise<string> {
  return b64u(await subtle().sign({ name: 'Ed25519' }, signPriv, enc.encode(text)))
}

export async function verifyText(signPub: string, text: string, sig: string): Promise<boolean> {
  try {
    const pub = await subtle().importKey('raw', fromB64u(signPub), { name: 'Ed25519' }, false, ['verify'])
    return await subtle().verify({ name: 'Ed25519' }, pub, fromB64u(sig), enc.encode(text))
  } catch {
    return false
  }
}

/** Receiver: remembers the last sequence number per sending device, and drops the same or smaller numbers */
export class SeqGuard {
  private last = new Map<string, number>()
  constructor(initial?: Record<string, number>) {
    for (const [k, v] of Object.entries(initial ?? {})) this.last.set(k, v)
  }
  accept(from: string, seq: number): boolean {
    if (!Number.isSafeInteger(seq) || seq <= (this.last.get(from) ?? 0)) return false
    this.last.set(from, seq)
    return true
  }
  snapshot(): Record<string, number> {
    return Object.fromEntries(this.last)
  }
}
