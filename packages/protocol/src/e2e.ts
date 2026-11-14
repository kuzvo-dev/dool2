// 폰 ↔ PC 종단 간 암호화 (ADR 0012). 브라우저와 Node에 들어 있는 WebCrypto만 쓴다.
// 중계 서버는 봉투의 머리(누가·누구에게·종류·순번)만 보고, 내용은 볼 수 없다.
//
//   X25519 공유 비밀 → HKDF-SHA256 → AES-256-GCM (메시지마다 새 IV, 머리는 AAD로 묶음)
//   Ed25519: PC는 중계 서버에 자기 방임을 증명, 폰은 승인에 서명

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

/** 키 순서를 정렬한 JSON. 서명·AAD가 양쪽에서 같은 바이트가 되게 */
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
  /** 기기 id: 서명 공개키에서 나온다 */
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

/** 기기 키를 만든다. 폰은 extractable=false(브라우저 밖으로 꺼낼 수 없음), PC는 키체인에 보관하려고 true */
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
  // 공개키는 JWK의 x 값이다
  const boxPub = s.box.x ?? ''
  const signPub = s.sign.x ?? ''
  return { id: await deviceId(signPub), boxPub, signPub, boxPriv, signPriv }
}

async function sharedBits(myBoxPriv: CryptoKey, theirBoxPub: string): Promise<ArrayBuffer> {
  const pub = await subtle().importKey('raw', fromB64u(theirBoxPub), { name: 'X25519' }, false, [])
  return subtle().deriveBits({ name: 'X25519', public: pub }, myBoxPriv, 256)
}

/** 두 기기 사이의 암호 키. 두 기기 id를 정렬해 넣어서 양쪽이 같은 키를 만든다 */
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

/** 페어링 확인 코드 6자리. PC와 폰이 같은 공유 비밀에서 만들어, 사람이 눈으로 비교한다 */
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

/** 중계 서버가 볼 수 있는 머리. 내용은 ct에 암호문으로 */
export interface EnvelopeHeader {
  v: number
  from: string
  to: string
  kind: string
  /** 보내는 쪽마다 1씩 느는 번호 (재전송 막기) */
  seq: number
  /** 페어링 요청에만: 보내는 쪽 X25519 공개키 (받는 쪽이 키를 만들 수 있게) */
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

/** 열지 못하면(키가 다르거나 머리·내용이 바뀌었으면) 예외 */
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

/** 받는 쪽: 보내는 기기마다 마지막 순번을 기억해, 같거나 작은 순번은 버린다 */
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
