/**
 * Signed resource packs.
 *
 * A pack ships a set of files (today: skills) apart from the app, downloaded and
 * verified at runtime so the skill library can grow daily without a store
 * review. The trust model mirrors how the v1 repo signed connector packs: a
 * manifest lists every file with its sha256 and size, plus the app-version
 * window the pack is meant for, and an ed25519 signature is taken over the
 * manifest. Verifying re-checks the signature and then re-hashes every blob, so
 * neither the file list nor any file byte can change without detection.
 *
 * Why ed25519: small keys and signatures, no parameter choices to get wrong, and
 * it is what `node:crypto`'s `sign(null, ...)`/`verify(null, ...)` use directly.
 * Private keys are never embedded; the signer passes one in as a PEM string
 * (from an env var or a file), and tests generate an ephemeral keypair.
 */

import { createHash, sign, verify } from 'node:crypto'

/** The signature algorithm. Recorded in the pack so a future change is explicit. */
export const PACK_ALG = 'ed25519' as const
/** The manifest format version. Bump when the manifest shape changes. */
export const PACK_FORMAT = 1 as const

/** One file in a pack: its path, content hash and byte size. */
export interface PackFileEntry {
  /** Forward-slash path relative to the pack root, e.g. `skills/gov24/SKILL.md`. */
  path: string
  /** Lowercase hex sha256 of the file's bytes. */
  sha256: string
  /** Byte size of the file. */
  size: number
}

/** The signed part of a pack: everything the signature covers. */
export interface PackManifest {
  format: typeof PACK_FORMAT
  /** Pack number; higher is newer. The app only takes a pack newer than its own. */
  pack: number
  /** Short pack name, e.g. `skills`. */
  name?: string
  /** Oldest app version that may install this pack (inclusive). */
  minApp?: string
  /** Newest app version that may install this pack (inclusive). */
  maxApp?: string
  /** ISO timestamp the pack was built. */
  createdAt: string
  /** Every file in the pack, sorted by path. */
  files: PackFileEntry[]
}

/** A built, signed pack: the manifest, its signature, and the file blobs. */
export interface SignedPack {
  alg: typeof PACK_ALG
  manifest: PackManifest
  /** base64 ed25519 signature over the canonical JSON of {@link manifest}. */
  manifestSig: string
  /** Path → base64 file content, one entry per manifest file. */
  blobs: Record<string, string>
}

/** The result of {@link verifyPack}: ok, with a reason when it is not. */
export type PackVerifyResult = { ok: true; manifest: PackManifest } | { ok: false; why: string }

/** Options for {@link buildPack}. */
export interface BuildPackOptions {
  /** Short pack name, e.g. `skills`. */
  name?: string
  /** Pack number; defaults to the current Unix seconds. */
  pack?: number
  /** Oldest app version that may install this pack. */
  minApp?: string
  /** Newest app version that may install this pack. */
  maxApp?: string
  /** Build timestamp; defaults to now. Set it for reproducible builds. */
  createdAt?: string
}

/** Options for {@link verifyPack}. */
export interface VerifyPackOptions {
  /** Current app version; when set, `minApp`/`maxApp` gating is enforced. */
  appVersion?: string
}

/** The files to pack, as path → bytes. Used by {@link buildPackFromFiles}. */
export type PackInput = Record<string, Uint8Array>

const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

/**
 * Deterministic JSON with object keys sorted recursively, so the signer and the
 * verifier hash the exact same bytes. Arrays keep their order (the manifest's
 * file list is already sorted by path at build time).
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key])
    }
    return out
  }
  return value
}

/**
 * Build a signed pack from an in-memory map of path → bytes.
 *
 * Paths are normalized to forward slashes and sorted. Each file's sha256 and
 * size go into the manifest; the manifest is signed; the bytes are stored as
 * base64 blobs. The private key is an ed25519 PEM string, never embedded.
 */
export function buildPackFromFiles(
  files: PackInput,
  privateKeyPem: string,
  options: BuildPackOptions = {},
): SignedPack {
  const entries: PackFileEntry[] = []
  const blobs: Record<string, string> = {}
  const paths = Object.keys(files)
    .map((p) => p.replace(/\\/g, '/'))
    .sort()
  for (const path of paths) {
    const bytes = files[path] ?? files[path.replace(/\//g, '\\')]
    if (!bytes) continue
    entries.push({ path, sha256: sha256Hex(bytes), size: bytes.byteLength })
    blobs[path] = Buffer.from(bytes).toString('base64')
  }

  const manifest: PackManifest = {
    format: PACK_FORMAT,
    pack: options.pack ?? Math.floor(Date.now() / 1000),
    createdAt: options.createdAt ?? new Date().toISOString(),
    files: entries,
  }
  if (options.name !== undefined) manifest.name = options.name
  if (options.minApp !== undefined) manifest.minApp = options.minApp
  if (options.maxApp !== undefined) manifest.maxApp = options.maxApp

  const manifestSig = sign(null, Buffer.from(canonicalJson(manifest), 'utf8'), privateKeyPem).toString(
    'base64',
  )
  return { alg: PACK_ALG, manifest, manifestSig, blobs }
}

/**
 * Verify a pack against a public key (ed25519 PEM), and optionally gate it on
 * the current app version.
 *
 * Checks, in order: shape, algorithm, the signature over the canonical
 * manifest, then for every manifest file that its blob exists, decodes, and its
 * size and sha256 match. Extra blobs not in the manifest are rejected. When
 * `appVersion` is given, the pack must sit within `[minApp, maxApp]`.
 *
 * Returns `{ ok: true, manifest }` or `{ ok: false, why }`. It never throws for
 * untrusted input: a malformed pack is a failed verification, not a crash.
 */
export function verifyPack(
  pack: unknown,
  publicKeyPem: string,
  options: VerifyPackOptions = {},
): PackVerifyResult {
  if (!pack || typeof pack !== 'object') return { ok: false, why: 'pack is not an object' }
  const { alg, manifest, manifestSig, blobs } = pack as Partial<SignedPack>
  if (alg !== PACK_ALG) return { ok: false, why: `unsupported alg: ${String(alg)}` }
  if (typeof manifestSig !== 'string') return { ok: false, why: 'missing manifestSig' }
  if (!manifest || typeof manifest !== 'object') return { ok: false, why: 'missing manifest' }
  if (!blobs || typeof blobs !== 'object') return { ok: false, why: 'missing blobs' }
  if (manifest.format !== PACK_FORMAT) {
    return { ok: false, why: `unsupported manifest format: ${String(manifest.format)}` }
  }
  if (!Array.isArray(manifest.files)) return { ok: false, why: 'manifest.files is not an array' }

  let sigOk = false
  try {
    sigOk = verify(
      null,
      Buffer.from(canonicalJson(manifest), 'utf8'),
      publicKeyPem,
      Buffer.from(manifestSig, 'base64'),
    )
  } catch (err) {
    return { ok: false, why: `signature check errored: ${(err as Error).message}` }
  }
  if (!sigOk) return { ok: false, why: 'manifest signature does not verify' }

  const manifestPaths = new Set(manifest.files.map((f) => f.path))
  for (const path of Object.keys(blobs)) {
    if (!manifestPaths.has(path)) return { ok: false, why: `blob not in manifest: ${path}` }
  }
  for (const entry of manifest.files) {
    const b64 = blobs[entry.path]
    if (typeof b64 !== 'string') return { ok: false, why: `missing blob: ${entry.path}` }
    const bytes = Buffer.from(b64, 'base64')
    if (bytes.byteLength !== entry.size) {
      return { ok: false, why: `size mismatch for ${entry.path}` }
    }
    if (sha256Hex(bytes) !== entry.sha256) {
      return { ok: false, why: `sha256 mismatch for ${entry.path}` }
    }
  }

  if (options.appVersion !== undefined) {
    const gate = versionGate(options.appVersion, manifest.minApp, manifest.maxApp)
    if (!gate.ok) return { ok: false, why: gate.why }
  }

  return { ok: true, manifest }
}

/** Decode a verified pack's blobs back to path → bytes. Verify first. */
export function unpackToFiles(pack: SignedPack): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {}
  for (const entry of pack.manifest.files) {
    const b64 = pack.blobs[entry.path]
    if (b64 !== undefined) out[entry.path] = new Uint8Array(Buffer.from(b64, 'base64'))
  }
  return out
}

// --- app-version gating ------------------------------------------------------

type GateResult = { ok: true } | { ok: false; why: string }

function versionGate(appVersion: string, minApp: string | undefined, maxApp: string | undefined): GateResult {
  if (minApp !== undefined && compareVersions(appVersion, minApp) < 0) {
    return { ok: false, why: `app ${appVersion} is older than minApp ${minApp}` }
  }
  if (maxApp !== undefined && compareVersions(appVersion, maxApp) > 0) {
    return { ok: false, why: `app ${appVersion} is newer than maxApp ${maxApp}` }
  }
  return { ok: true }
}

/**
 * Compare two dotted numeric versions (e.g. `0.6.0`). Returns -1, 0 or 1.
 * Missing parts count as 0, so `0.6` equals `0.6.0`. Non-numeric suffixes on a
 * part are ignored (a pre-release tag does not change the gate).
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.')
  const pb = b.split('.')
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const na = Number.parseInt(pa[i] ?? '0', 10) || 0
    const nb = Number.parseInt(pb[i] ?? '0', 10) || 0
    if (na < nb) return -1
    if (na > nb) return 1
  }
  return 0
}
